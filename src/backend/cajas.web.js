/*
=============================================================================
MODULE: backend/cajas.web.js
VERSION: v5009-FISCAL-V20.1
BASE: v5009-FISCAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: TPV cashier ledger, daily closures, Veri*factu SHA-256
                chain integrity, fiscal persistence, M365 sync enqueue.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: constantes importadas alineadas a internalConfig V20.1.
  - V20-02: constantes internas CASH_REGISTER_ID.
  - V20-03: campos CMS en inserciones (MovimientosCaja, CajaActual,
            HistoricoCierresZ) renombrados segun matriz V20.1.
  - V20-04: funcion _buildAEATPayload renombra variables internas
            manteniendo el mismo string AEAT (integridad SHA-256).
  - V20-05: registerManualTransaction acepta payload con nombres
            antiguos O nuevos (compatibilidad de transicion).
  - V20-06: usuarioAprobador -> approverUser en HistoricoCierresZ.

FIXES APLICADOS v5009-FISCAL (heredados):
  - CONSOL-01: _getNextSequence delega en eventLog._getNextSequenceInternal.
  - CONSOL-02: _isDuplicateItemError eliminado (vive en eventLog).
  - FIX-FISCAL-01..03.
=============================================================================
*/

import { webMethod, Permissions } from "wix-web-module";
import wixData from "wix-data";
import { getSecret } from "wix-secrets-backend";

import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    HISTORICAL_COLLECTIONS,
    CONTROL_TYPE,


    SINGLETONS,
    SDK_CONFIG,
    MOVEMENT_TYPE,
    PAYMENT_METHOD,
    IVA_RATES,
    CASH_REGISTER_STATUS,
    CONCURRENCY,
    AEAT_INVOICE_TYPE,
    CORRECTION_REASON,
    IRPF_WITHHOLDING_RATE,
    VAT_ACCRUAL_STATUS,
    FISCAL_ROLE,
} from "backend/internalConfig";

import { SECRETS } from "backend/mmSecrets";
import { requireCajero, rateLimiter } from "backend/security";

import {
    hashSHA256,
    hashChain,
} from "backend/securityEngine";

import {
    makeTraceId,
    _roundMoney,
    _safeTrim,
    _cleanText,
    _stableSerialize,
    _readDate,
    _readPositiveAmount,
    withTimeout,
} from "public/mmUtils";

import { logger } from "backend/logger";
import { normalizeError } from "backend/booking/bookingCore";
import { _toPublicError } from "backend/responseUtils";

import { logAuditEvent } from "backend/audit";
import { projectLedgerMovementToAccounting } from "backend/contabilidad";

// [CONSOL-01] Secuencia unica compartida con eventLog.js
import { _getNextSequenceInternal } from "backend/eventLog";

const log = logger;

// ============================================================================
// CONSTANTS
// ============================================================================

const CASH_REGISTER_ID = SINGLETONS?.CAJA || "CAJA_PRINCIPAL";
const LEDGER_SCHEMA_VERSION = "LEDGER_V5_FISCAL";
const GENESIS_HASH = "0".repeat(64);
const MAX_LEDGER_BATCH_PAGES = 50;
const LEDGER_PAGE_SIZE = 200;

const FISCAL_SIGNER_TIMEOUT_MS = 10000;

const SECRET_CACHE_TTL_MS = 300000;
const _secretCache = new Map();

const SIGNER_FAILURE_THRESHOLD = 3;
const SIGNER_OPEN_MS = 60000;
let _signerState = { failures: 0, openUntil: 0 };

const MONTO_OBLIGA_NIF_TERCERO = 300;
const MONTO_OBLIGA_APROBADOR_Z = 500;
const MONEY_EPSILON_FISCAL = 0.02;

// ============================================================================
// HELPERS
// ============================================================================

function _normalizeLinkedBookingIds(value) {
    const values = Array.isArray(value) ? value : String(value || "").split(",");
    return Array.from(new Set(values.map((id) => String(id || "").trim()).filter(Boolean)));
}

function _linkedBookingValue(value) {
    return _normalizeLinkedBookingIds(value).join(",") || null;
}

function _rateLimitOrThrow(surface, key, traceId) {
    const rl = rateLimiter({ surface, key });
    if (!rl.allowed) {
        const e = new Error(`RATE_LIMITED: retryAfter=${rl.retryAfter}`);
        e.code = "RATE_LIMITED";
        e.meta = { retryAfter: rl.retryAfter, surface, traceId };
        throw e;
    }
}

async function _getCachedSecret(name) {
    const now = Date.now();
    const entry = _secretCache.get(name);
    if (entry && (now - entry.at) < SECRET_CACHE_TTL_MS) {
        return entry.value;
    }
    const value = await getSecret(name).catch(() => "");
    _secretCache.set(name, { value, at: now });
    return value;
}

export function _invalidateSecretCache() {
    _secretCache.clear();
}

// ============================================================================
// VALIDATION: FISCAL CONFIG
// ============================================================================

export async function validateFiscalConfig(traceId = "init") {
    const key = await _getCachedSecret(SECRETS.FISCAL_KEY);
    const nif = await _getCachedSecret(SECRETS.FISCAL_NIF_EMISOR);
    if (!key || key.length < 32) {
        log.error("CONFIGURACION_FISCAL_INVALIDA: Clave fiscal ausente o demasiado corta", { traceId });
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    if (!nif || nif.length < 9) {
        log.error("CONFIGURACION_FISCAL_INVALIDA: NIF emisor ausente o invalido", { traceId });
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    return true;
}

async function _getFiscalKeys() {
    const [key, nif] = await Promise.all([
        _getCachedSecret(SECRETS.FISCAL_KEY),
        _getCachedSecret(SECRETS.FISCAL_NIF_EMISOR),
    ]);
    if (!key || !nif) {
        throw new Error("CONFIGURACION_FISCAL_INVALIDA");
    }
    return { fiscalKey: key, issuerTaxId: _safeTrim(nif).toUpperCase() };
}

// ============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================

export async function executeLedgerWithBackoff(operationFn, maxWallTimeMs = 15000) {
    const start = Date.now();
    let attempt = 0;
    let lastErr;
    while (Date.now() - start < maxWallTimeMs && attempt < 5) {
        try {
            return await operationFn();
        } catch (err) {
            lastErr = err;
            attempt++;
            const wait = Math.min(200 * Math.pow(2, attempt), 2000) + Math.random() * 100;
            await new Promise((r) => setTimeout(r, wait));
        }
    }
    throw new Error(`LEDGER_TIMEOUT: Operacion supero el tiempo limite de ${maxWallTimeMs}ms (${lastErr?.message})`);
}

// ============================================================================
// BUILD AEAT PAYLOAD
//
// [V20.1] Esta funcion genera un string AEAT key=value&... Las CLAVES AEAT
// del output NO cambian (obligacion normativa). Solo las variables internas
// se renombran a ingles. El string resultante es IDENTICO al de v5009,
// preservando la integridad SHA-256 existente.
// ============================================================================

function _formatAEATDate(ymd) {
    const clean = _safeTrim(ymd);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
    if (!match) return clean;
    return `${match[3]}-${match[2]}-${match[1]}`;
}

function _formatAEATDateTimeMadrid(date) {
    const dt = date instanceof Date ? date : new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
    }).formatToParts(dt).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const madridOffset = (() => {
        const madridStr = dt.toLocaleString("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" });
        const m = /GMT([+-])(\d{2}):?(\d{2})/.exec(madridStr);
        if (m) return `${m[1]}${m[2]}:${m[3]}`;
        const localMadrid = new Date(dt.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
        const diffMinutes = Math.round((localMadrid - dt) / 60000);
        const sign = diffMinutes >= 0 ? "+" : "-";
        const abs = Math.abs(diffMinutes);
        return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    })();

    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${madridOffset}`;
}

function _buildAEATPayload(movement, generatedAt) {
    const fields = [
        ["IDEmisorFactura", movement.issuerTaxId || ""],
        ["NumSerieFactura", movement.invoiceNumber || ""],
        ["FechaExpedicionFactura", _formatAEATDate(movement.invoiceIssueDate)],
        ["TipoFactura", movement.invoiceType || AEAT_INVOICE_TYPE.F1],
        ["CuotaTotal", String(Number(movement.taxAmount || 0).toFixed(2))],
        ["ImporteTotal", String(Number(movement.totalAmount || 0).toFixed(2))],
        ["Huella", movement.previousRecordHash || ""],
        ["FechaHoraHusoGenRegistro", _formatAEATDateTimeMadrid(generatedAt)],
    ];

    if (movement.recipientTaxId) fields.push(["NIFDestinatario", String(movement.recipientTaxId).slice(0, 20)]);
    if (movement.recipientLegalName) fields.push(["NombreRazonDestinatario", String(movement.recipientLegalName).slice(0, 200)]);
    if (movement.bankReconciliationReference) fields.push(["ReferenciaBancaria", String(movement.bankReconciliationReference).slice(0, 60)]);

    if (movement.vatAccrualStatus === VAT_ACCRUAL_STATUS.APLICACION_ANTICIPO) {
        fields.push(["TipoRectificativa", "I"]);
        if (movement.linkedAdvanceId) {
            fields.push(["IdAnticipoVinculado", String(movement.linkedAdvanceId).slice(0, 120)]);
        }
    }

    if (Number(movement.irpfWithholdingAmount || 0) > 0) {
        fields.push(["ImporteRetencionIRPF", String(Number(movement.irpfWithholdingAmount).toFixed(2))]);
        if (movement.withholdingBase > 0) {
            fields.push(["BaseImponibleRetencion", String(Number(movement.withholdingBase).toFixed(2))]);
        }
        if (movement.fiscalRole) {
            fields.push(["RolFiscal", String(movement.fiscalRole).slice(0, 10)]);
        }
    }

    if (Number(movement.surchargeAmount || 0) > 0) {
        fields.push(["ImporteRecargoEquivalencia", String(Number(movement.surchargeAmount).toFixed(2))]);
    }

    if (movement.correctionReason) fields.push(["MotivoRectificacion", String(movement.correctionReason).slice(0, 4)]);
    if (movement.previousInvoiceId) fields.push(["IdFacturaRectificada", String(movement.previousInvoiceId).slice(0, 120)]);

    return fields.map(([key, value]) => `${key}=${value}`).join("&");
}

// ============================================================================
// FIRMA X.509
// ============================================================================

async function _computeSignature(currentHash, traceId) {
    if (Date.now() < _signerState.openUntil) {
        log.warn("Fiscal signer circuit OPEN; rejecting fast", { traceId });
        throw new Error("FISCAL_SIGN_FAIL: circuit breaker open");
    }

    try {
        const endpoint = await _getCachedSecret(SECRETS.FISCAL_SIGNER_ENDPOINT);
        const bearer = await _getCachedSecret(SECRETS.FISCAL_SIGNER_BEARER);

        if (!endpoint || !bearer) {
            log.error("FISCAL_SIGNER_NOT_CONFIGURED", { traceId });
            throw new Error("FISCAL_SIGN_FAIL: signer endpoint not configured");
        }

        const response = await withTimeout(
            fetch(endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${bearer}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    hash: currentHash,
                    hashAlgorithm: "SHA-256",
                    signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                }),
            }),
            FISCAL_SIGNER_TIMEOUT_MS,
            "fiscal_signer"
        );

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`FISCAL_SIGNER_HTTP_${response.status}: ${errBody.slice(0, 200)}`);
        }

        const data = await response.json();
        if (!data?.signature) throw new Error("FISCAL_SIGNER_INVALID_RESPONSE");

        _signerState.failures = 0;
        _signerState.openUntil = 0;

        return data.signature;
    } catch (err) {
        _signerState.failures++;
        if (_signerState.failures >= SIGNER_FAILURE_THRESHOLD) {
            _signerState.openUntil = Date.now() + SIGNER_OPEN_MS;
            log.error("Fiscal signer circuit OPEN", {
                failures: _signerState.failures,
                openUntilMs: SIGNER_OPEN_MS,
                traceId,
            });
        }
        log.error("_computeSignature failed", { error: err?.message, traceId });
        throw new Error(`FISCAL_SIGN_FAIL: ${err?.message}`);
    }
}

// ============================================================================
// QR DE VERIFICACION
// ============================================================================

function _generateVerificationQR(invoiceNumber, issuerTaxId, invoiceIssueDate, totalAmount) {
    const baseUrl = "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR";
    const params = [
        `nif=${encodeURIComponent(issuerTaxId)}`,
        `numserie=${encodeURIComponent(invoiceNumber)}`,
        `fecha=${encodeURIComponent(invoiceIssueDate)}`,
        `importe=${encodeURIComponent(String(totalAmount))}`,
    ];
    return `${baseUrl}?${params.join("&")}`;
}

// ============================================================================
// HASH CHAIN
// ============================================================================

async function _computeCurrentHash(previousHash, payloadStr) {
    return await hashChain(previousHash, payloadStr);
}

// ============================================================================
// SEQUENCE COUNTER (delega en eventLog._getNextSequenceInternal)
// ============================================================================

async function _getNextSequence(traceId) {
    return await _getNextSequenceInternal(traceId);
}

// ============================================================================
// GET LAST MOVEMENT
// ============================================================================

async function _getLastMovement() {
    const res = await wixData
        .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
        .descending("sequenceNumber")
        .limit(1)
        .find({ suppressAuth: true, consistentRead: true });
    return res?.items?.[0] || null;
}

// ============================================================================
// CHECK PERIOD CLOSED
// ============================================================================

async function _assertPeriodNotClosed(operationDate, traceId) {
    const existingZ = await wixData.get(
        BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z,
        `Z_${operationDate}`, { suppressAuth: true }
    ).catch(() => null);

    if (existingZ) {
        log.error("PERIOD_CLOSED: Intento de insertar movimiento en periodo cerrado", {
            operationDate, traceId,
        });
        throw new Error("PERIOD_CLOSED: No se pueden insertar movimientos en un periodo con cierre Z");
    }
}

// ============================================================================
// CALCULO FISCAL COHERENTE
// ============================================================================

function _resolveFiscalBase({
    amount,
    taxRate,
    withholdingBase,
    irpfWithholdingAmount,
    surchargeAmount,
}) {
    // Si base viene explicita (caso retencion profesional), usarla.
    if (withholdingBase > 0) {
        const base = _roundMoney(withholdingBase);
        const taxAmount = _roundMoney(base * taxRate);

        const expectedTotal = _roundMoney(
            base + taxAmount + (surchargeAmount || 0) - (irpfWithholdingAmount || 0)
        );
        const diff = Math.abs(expectedTotal - amount);

        if (diff > MONEY_EPSILON_FISCAL) {
            return {
                ok: false,
                code: "CUADRE_FISCAL_INVALIDO",
                message: `Base ${base} + IVA ${taxAmount} + RE ${surchargeAmount || 0} - Ret ${irpfWithholdingAmount || 0} = ${expectedTotal}, amount ${amount}`,
                base,
                taxAmount,
            };
        }

        return { ok: true, base, taxAmount };
    }

    // Sin base explicita: derivar de amount.
    const base = _roundMoney(amount / (1 + taxRate));
    const taxAmount = _roundMoney(amount - base);
    return { ok: true, base, taxAmount };
}

// ============================================================================
// ENCOLAR ASIENTO DESCUADRADO
// ============================================================================

async function _queueAccountingResync(movement, err, traceId) {
    try {
        await wixData.insert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
            controlType: CONTROL_TYPE.COMPENSATION,
            dedupeKey: `REC_ACCT_SYNC_${movement.transactionId || "NA"}_${Date.now()}`,
            kind: "RESYNC_LEDGER_ACCOUNTING",
            transactionId: movement.transactionId || null,
            amount: Number(movement.totalAmount) || 0,
            paymentMethod: movement.paymentMethod || null,
            concept: "Reintento de proyeccion contable tras fallo",
            status: "PENDING_RECOVERY",
            phase: "WAIT_FOR_ACCOUNTING_RESYNC",
            origin: "ACCOUNTING_PROJECTION_FAILED",
            alertRequired: true,
            attempts: 0,
            lastError: err?.message || "UNKNOWN",
            traceId,
            _createdDate: new Date(),
            _updatedDate: new Date(),
        }, { suppressAuth: true });
    } catch (queueErr) {
        log.error("_queueAccountingResync failed", { traceId, error: queueErr?.message });
    }
}

// ============================================================================
// REGISTER MANUAL TRANSACTION
//
// [V20.1] Acepta payload con nombres antiguos o nuevos. Prioriza nuevos.
// ============================================================================

export const registerManualTransaction = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("manual-tx");
    try {
        _rateLimitOrThrow(
            "cajas.registerManualTransaction",
            _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
            traceId
        );

        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { issuerTaxId } = await _getFiscalKeys();

        const amount = _readPositiveAmount(payload?.amount);
        if (!amount) {
            return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
        }

        const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
        if (!Object.values(PAYMENT_METHOD).includes(paymentMethod)) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
        }

        const movementType = _safeTrim(payload?.movementType || payload?.movementType || "VENTA").toUpperCase();
        const operationDescription = _cleanText(payload?.operationDescription || payload?.concept || payload?.description || "Venta mostrador", 500);
        const resourceId = _safeTrim(payload?.resourceId || "CAJA_LOCAL");
        const transactionId = payload?.transactionId || null;

        const recipientTaxId = _safeTrim(payload?.recipientTaxId || payload?.nifTercero) || null;
        const recipientLegalName = _cleanText(payload?.recipientLegalName || payload?.razonSocialTercero || "", 200) || null;
        const isB2B = payload?.isB2B === true || payload?.esB2B === true;
        const requiresTaxId = isB2B || amount >= MONTO_OBLIGA_NIF_TERCERO;

        if (requiresTaxId && !recipientTaxId) {
            return {
                status: "ERROR", data: null,
                error: {
                    code: "RECIPIENT_TAX_ID_REQUIRED",
                    message: `Ventas B2B o > ${MONTO_OBLIGA_NIF_TERCERO} EUR requieren NIF del tercero`,
                },
            };
        }

        if (requiresTaxId && !recipientLegalName) {
            return {
                status: "ERROR", data: null,
                error: {
                    code: "RECIPIENT_LEGAL_NAME_REQUIRED",
                    message: `Ventas B2B o > ${MONTO_OBLIGA_NIF_TERCERO} EUR requieren razon social del tercero`,
                },
            };
        }

        const irpfWithholdingRate = Number(payload?.irpfWithholdingRate || payload?.tipoRetencionIRPF) || 0;
        const withholdingBase = Number(payload?.withholdingBase || payload?.baseImponibleRetencion) || 0;
        let irpfWithholdingAmount = Number(payload?.irpfWithholdingAmount || payload?.importeRetencionIRPF) || 0;

        if (irpfWithholdingRate > 0 && withholdingBase > 0 && irpfWithholdingAmount === 0) {
            irpfWithholdingAmount = _roundMoney(withholdingBase * irpfWithholdingRate);
        }

        const surchargeRate = Number(payload?.surchargeRate || payload?.tipoRecargoEquivalencia) || 0;
        let surchargeAmount = Number(payload?.surchargeAmount || payload?.importeRecargoEquivalencia) || 0;

        if (surchargeRate > 0 && surchargeAmount === 0) {
            const baseForSurcharge = withholdingBase > 0
                ? withholdingBase
                : _roundMoney(amount / (1 + (Number(payload?.taxRate) || IVA_RATES.GENERAL)));
            surchargeAmount = _roundMoney(baseForSurcharge * surchargeRate);
        }

        const rawFiscalRole = _safeTrim(payload?.fiscalRole || payload?.rolFiscal).toUpperCase();
        const fiscalRole = (rawFiscalRole === FISCAL_ROLE.EMISOR || rawFiscalRole === FISCAL_ROLE.RECEPTOR)
            ? rawFiscalRole
            : FISCAL_ROLE.EMISOR;

        const linkedAdvanceId = _safeTrim(payload?.linkedAdvanceId || payload?.idAnticipoVinculado) || null;
        const vatAccrualStatus = _safeTrim(payload?.vatAccrualStatus || payload?.estadoDevengoIVA)
            || (movementType === MOVEMENT_TYPE.ANTICIPO
                ? VAT_ACCRUAL_STATUS.ANTICIPADO
                : linkedAdvanceId
                    ? VAT_ACCRUAL_STATUS.APLICACION_ANTICIPO
                    : VAT_ACCRUAL_STATUS.DEVENGADO);

        const bankReconciliationReference = _safeTrim(payload?.bankReconciliationReference || payload?.referenciaBancariaConciliacion) || null;
        const invoiceType = _safeTrim(payload?.invoiceType || payload?.claveRegistroFactura) || null;
        const correctionReason = _safeTrim(payload?.correctionReason || payload?.motivoRectificacion) || null;
        const previousInvoiceId = _safeTrim(payload?.previousInvoiceId || payload?.idFacturaRectificada) || null;
        const issuerInvoiceNumber = _safeTrim(payload?.issuerInvoiceNumber || payload?.numeroSerieFacturaEmisor) || null;

        if (transactionId) {
            const existingRes = await wixData
                .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                .eq("transactionId", transactionId)
                .limit(1)
                .find({ suppressAuth: true, consistentRead: true });

            if (existingRes?.items?.length > 0) {
                log.info("Ledger idempotent duplicate detected", { transactionId, traceId });
                return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
            }
        }

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
        await _assertPeriodNotClosed(operationDate, traceId);

        const taxRate = Number(payload?.taxRate) || IVA_RATES.GENERAL;
        const fiscalCalc = _resolveFiscalBase({
            amount,
            taxRate,
            withholdingBase,
            irpfWithholdingAmount,
            surchargeAmount,
        });

        if (!fiscalCalc.ok) {
            log.warn("Fiscal cuadre failed", { traceId, code: fiscalCalc.code });
            return {
                status: "ERROR", data: null,
                error: { code: fiscalCalc.code, message: fiscalCalc.message },
            };
        }

        const taxableBaseOrNonSubjectAmount = fiscalCalc.base;
        const taxAmount = fiscalCalc.taxAmount;

        return await (async () => {
            const seq = await _getNextSequence(traceId);
            const lastMovement = await _getLastMovement();
            const previousRecordHash = lastMovement?.recordHash || GENESIS_HASH;

            const generatedAt = new Date();

            const baseMovement = {
                sequenceNumber: seq.sequenceNumber,
                invoiceNumber: seq.invoiceNumber,
                invoiceIssueDate: operationDate,
                operationDate,
                fiscalPeriod: operationDate.slice(0, 7),
                movementType,
                paymentMethod,
                totalAmount: amount,
                taxableBaseOrNonSubjectAmount,
                taxAmount,
                taxRate,
                accountingSign: movementType === MOVEMENT_TYPE.REEMBOLSO ? -1 : 1,
                accountingAmount: movementType === MOVEMENT_TYPE.REEMBOLSO ? -amount : amount,
                operationDescription,
                lineItems: payload?.lineItems || [],
                issuerTaxId,
                schemaVersion: LEDGER_SCHEMA_VERSION,
                recordSource: payload?.origen || payload?.recordSource || "INTERNAL",
                resourceId,
                linkedBookingIds: _linkedBookingValue(payload?.linkedBookingIds ?? payload?.reservaIdVinculada ?? payload?.reservationIdLinked),
                transactionId: transactionId || `TX_${seq.sequenceNumber}`,
                orderId: payload?.orderId || null,
                refundId: payload?.refundId || null,

                recipientTaxId,
                recipientLegalName,
                isB2B,

                withholdingBase,
                irpfWithholdingRate,
                irpfWithholdingAmount,
                fiscalRole,

                surchargeRate,
                surchargeAmount,

                linkedAdvanceId,
                vatAccrualStatus,

                bankReconciliationReference,

                invoiceType: invoiceType || AEAT_INVOICE_TYPE.F1,
                correctionReason,
                previousInvoiceId,
                issuerInvoiceNumber,
            };

            const aeatPayload = _buildAEATPayload(
                { ...baseMovement, previousRecordHash },
                generatedAt
            );

            const recordHash = await _computeCurrentHash(previousRecordHash, aeatPayload);

            let digitalSignature;
            try {
                digitalSignature = await _computeSignature(recordHash, traceId);
            } catch (signErr) {
                log.warn("Fiscal signer unavailable; queuing movement", {
                    transactionId: baseMovement.transactionId,
                    error: signErr?.message,
                    traceId,
                });
                await queueFiscalRecovery({
                    transactionId: baseMovement.transactionId,
                    bookingIds: baseMovement.linkedBookingIds,
                    amount,
                    paymentMethod,
                    concept: operationDescription,
                    resourceId,
                    movementType,
                    phase: "WAIT_FOR_SIGNER",
                    origin: "FISCAL_SIGNER_DOWN",
                    traceId,
                    lastError: signErr?.message || "FISCAL_SIGN_FAIL",
                });
                return {
                    status: "SUCCESS",
                    data: {
                        ...baseMovement,
                        previousRecordHash,
                        recordHash,
                        pendingSignature: true,
                        queued: true,
                    },
                    error: null,
                };
            }

            const verificationQR = _generateVerificationQR(
                baseMovement.invoiceNumber,
                issuerTaxId,
                operationDate,
                amount
            );

            const movement = {
                ...baseMovement,
                previousRecordHash,
                recordHash,
                digitalSignature,
                aeatPayload,
                verificationQR,
                hashAlgorithm: "SHA-256",
                signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                registeredAt: generatedAt,
                traceId,
                _createdDate: new Date(),
            };

            const saved = await wixData.insert(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, movement, { suppressAuth: true });
            await _updateCajaActual(movement, traceId);

            projectLedgerMovementToAccounting(movement)
                .then((accResult) => {
                    if (accResult?.status === "SUCCESS" || accResult?.status === "SKIPPED") return;
                    log.warn("Accounting projection non-success", {
                        traceId,
                        status: accResult?.status,
                        reason: accResult?.reason,
                    });
                })
                .catch(async (accErr) => {
                    log.error("Accounting projection failed; queuing resync", {
                        traceId,
                        error: accErr?.message || String(accErr),
                    });
                    await _queueAccountingResync(movement, accErr, traceId);
                });

            if (SDK_CONFIG?.M365?.ENABLED) {
                try {
                    await _enqueueM365Sync(saved, traceId);
                } catch (e) {
                    log.error("M365 sync enqueue failed (non-blocking)", { traceId, error: e?.message });
                    await logAuditEvent("M365_SYNC_ENQUEUE_FAILED", "ERROR", `Encolado M365 fallido para ${saved.invoiceNumber}`, { invoiceNumber: saved.invoiceNumber, error: e?.message, traceId }, traceId, saved.invoiceNumber, "backend/cajas.web.js");
                }
            }

            return { status: "SUCCESS", data: saved, error: null };
        })();
    } catch (err) {
        const norm = normalizeError(err);
        log.error("registerManualTransaction failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "LEDGER_FAIL", message: norm.message } };
    }
});

// ============================================================================
// UPDATE CAJA ACTUAL
// ============================================================================

async function _updateCajaActual(movement, traceId) {
    try {
        const cajaCol = BUSINESS_COLLECTIONS.CAJA_ACTUAL;
        let cashRegister = await wixData.get(cajaCol, CASH_REGISTER_ID, { suppressAuth: true }).catch(() => null);
        if (!cashRegister) {
            cashRegister = {
                _id: CASH_REGISTER_ID,
                operationDate: movement.operationDate,
                cashRegisterStatus: CASH_REGISTER_STATUS.OPEN,
                totalBalance: 0, cashBalance: 0, cardBalance: 0, bizumBalance: 0, onlineBalance: 0,
                totalOperations: 0,
                openedAt: new Date(), closedAt: null, lastActivityAt: new Date(),
                _createdDate: new Date(), _updatedDate: new Date(),
            };
        }
        const amount = Number(movement.accountingAmount) || 0;
        const method = _safeTrim(movement.paymentMethod).toUpperCase();
        if (method === PAYMENT_METHOD.EFECTIVO) cashRegister.cashBalance = _roundMoney((cashRegister.cashBalance || 0) + amount);
        else if (method === PAYMENT_METHOD.TARJETA) cashRegister.cardBalance = _roundMoney((cashRegister.cardBalance || 0) + amount);
        else if (method === PAYMENT_METHOD.BIZUM) cashRegister.bizumBalance = _roundMoney((cashRegister.bizumBalance || 0) + amount);
        else if (method === PAYMENT_METHOD.ONLINE) cashRegister.onlineBalance = _roundMoney((cashRegister.onlineBalance || 0) + amount);

        cashRegister.totalBalance = _roundMoney((cashRegister.cashBalance || 0) + (cashRegister.cardBalance || 0) + (cashRegister.bizumBalance || 0) + (cashRegister.onlineBalance || 0));
        cashRegister.totalOperations = Number(cashRegister.totalOperations || 0) + 1;
        cashRegister.lastActivityAt = new Date();
        cashRegister._updatedDate = new Date();
        await wixData.save(cajaCol, cashRegister, { suppressAuth: true });
    } catch (err) {
        log.error("_updateCajaActual failed; queuing resync", { traceId, error: err?.message });
        try {
            await wixData.insert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                controlType: CONTROL_TYPE.COMPENSATION,
                dedupeKey: `REC_CAJA_SYNC_${movement.transactionId || "NA"}_${Date.now()}`,
                kind: "RESYNC_CAJA_BALANCE",
                transactionId: movement.transactionId || null,
                amount: Number(movement.accountingAmount) || 0,
                paymentMethod: movement.paymentMethod || null,
                concept: "Sincronizacion de saldo tras fallo en _updateCajaActual",
                status: "PENDING_RECOVERY",
                phase: "WAIT_FOR_CAJA_RESYNC",
                origin: "UPDATE_CAJA_FAILED",
                alertRequired: true,
                attempts: 0,
                lastError: err?.message || "UNKNOWN",
                traceId,
                _createdDate: new Date(), _updatedDate: new Date(),
            }, { suppressAuth: true });
        } catch (queueErr) {
            log.error("_updateCajaActual: failed to queue resync", { traceId, error: queueErr?.message });
        }
    }
}

// ============================================================================
// ENQUEUE M365 SYNC
// ============================================================================

async function _enqueueM365Sync(movement, traceId) {
    const queueCol = HISTORICAL_COLLECTIONS.M365_GRAPH_SYNC_QUEUE;
    const payload = {
        eventType: "LEDGER_MOVEMENT",
        correlationId: traceId,
        transactionId: movement.transactionId,
        bookingReference: _linkedBookingValue(movement.linkedBookingIds ?? movement.reservaIdVinculada) || movement._id,
        amount: movement.totalAmount,
        currency: "EUR",
        occurredAt: movement.registeredAt,
    };
    payload.title = `LEDGER_MOVEMENT ${movement.transactionId || movement.invoiceNumber}`;
    const integrityHash = await hashSHA256(_stableSerialize(payload));
    payload.integrityHash = integrityHash;
    const queueId = `m365-graph-${integrityHash.slice(0, 56)}`;
    await wixData.insert(queueCol, {
        _id: queueId, payload, payloadHash: integrityHash,
        status: "PENDING", attempts: 0, nextAttemptAt: new Date(), traceId,
        _createdDate: new Date(), _updatedDate: new Date(),
    }, { suppressAuth: true });
}

// ============================================================================
// REGISTER BOOKING PAYMENT
// ============================================================================

export async function registerBookingPayment(bookingIds, amount, method, meta = {}) {
    const traceId = meta.traceId || makeTraceId("bkg-pay");

    const vatAccrualStatus = meta.linkedAdvanceId
        ? VAT_ACCRUAL_STATUS.APLICACION_ANTICIPO
        : meta.vatAccrualStatus || VAT_ACCRUAL_STATUS.DEVENGADO;

    return await registerManualTransaction({
        amount,
        paymentMethod: method,
        movementType: meta.movementType || meta.movementType || "VENTA_ONLINE",
        operationDescription: meta.operationDescription || meta.concept || `Cobro reserva ${bookingIds}`,
        resourceId: meta.resourceId || "ONLINE",
        linkedBookingIds: _linkedBookingValue(bookingIds),
        transactionId: meta.transactionId || null,
        orderId: meta.orderId || null,
        traceId,

        recipientTaxId: meta.recipientTaxId || meta.nifTercero || null,
        recipientLegalName: meta.recipientLegalName || meta.razonSocialTercero || null,
        isB2B: meta.isB2B === true || meta.esB2B === true,

        irpfWithholdingRate: meta.irpfWithholdingRate || meta.tipoRetencionIRPF || 0,
        withholdingBase: meta.withholdingBase || meta.baseImponibleRetencion || 0,
        irpfWithholdingAmount: meta.irpfWithholdingAmount || meta.importeRetencionIRPF || 0,
        fiscalRole: meta.fiscalRole || meta.rolFiscal || FISCAL_ROLE.EMISOR,

        surchargeRate: meta.surchargeRate || meta.tipoRecargoEquivalencia || 0,

        linkedAdvanceId: meta.linkedAdvanceId || meta.idAnticipoVinculado || null,
        vatAccrualStatus,

        bankReconciliationReference: meta.bankReconciliationReference || meta.referenciaBancariaConciliacion || null,

        invoiceType: meta.invoiceType || meta.claveRegistroFactura || null,
        correctionReason: meta.correctionReason || meta.motivoRectificacion || null,
        previousInvoiceId: meta.previousInvoiceId || meta.idFacturaRectificada || null,
    });
}

// ============================================================================
// QUEUE FISCAL RECOVERY
// ============================================================================

export async function queueFiscalRecovery(recoveryData) {
    const traceId = recoveryData.traceId || makeTraceId("fiscal-rec");
    try {
        await wixData.insert(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
            controlType: CONTROL_TYPE.COMPENSATION,
            dedupeKey: `REC_${recoveryData.transactionId || Date.now()}_${Date.now()}`,
            bookingIds: recoveryData.bookingIds || null,
            orderId: recoveryData.orderId || null,
            refundId: recoveryData.refundId || null,
            transactionId: recoveryData.transactionId || null,
            status: "PENDING_RECOVERY",
            amount: Number(recoveryData.amount) || 0,
            concept: recoveryData.concept || "Fiscal recovery",
            paymentMethod: recoveryData.paymentMethod || null,
            movementType: recoveryData.movementType || recoveryData.movementType || null,
            kind: "FISCAL_LEDGER",
            phase: recoveryData.phase || null,
            origin: recoveryData.origin || "FISCAL_RECOVERY",
            alertRequired: false,
            attempts: 0,
            lastError: recoveryData.lastError || null,
            traceId,
            _createdDate: new Date(), _updatedDate: new Date(),
        }, { suppressAuth: true });
    } catch (err) {
        log.error("queueFiscalRecovery failed", { traceId, error: err?.message });
    }
}

// ============================================================================
// GET CASHIER STATE
// ============================================================================

export const getCashierState = webMethod(Permissions.SiteMember, async (options = {}) => {
    const { traceId } = options;
    try {
        await requireCajero(traceId);
        const cashRegister = await wixData.get(BUSINESS_COLLECTIONS.CAJA_ACTUAL, CASH_REGISTER_ID, { suppressAuth: true }).catch(() => null);
        return {
            status: "SUCCESS",
            data: cashRegister || {
                _id: CASH_REGISTER_ID,
                cashRegisterStatus: CASH_REGISTER_STATUS.CLOSED,
                totalBalance: 0, cashBalance: 0, cardBalance: 0, bizumBalance: 0, onlineBalance: 0,
                totalOperations: 0,
            },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "CASHIER_STATE_FAIL") };
    }
});

// ============================================================================
// REGISTER Z CLOSING
// ============================================================================

export const registerZClosing = webMethod(Permissions.SiteMember, async (diaKey, options = {}) => {
    const { traceId } = options;
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const cleanDiaKey = _readDate(diaKey);
        if (!cleanDiaKey) {
            return { status: "ERROR", data: null, error: { code: "INVALID_DATE", message: "Fecha invalida" } };
        }

        const existingZ = await wixData.get(
            BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z,
            `Z_${cleanDiaKey}`, { suppressAuth: true }
        ).catch(() => null);

        if (existingZ) {
            log.warn("Z_CLOSING_ALREADY_EXISTS", { cleanDiaKey, traceId });
            return { status: "ERROR", data: null, error: { code: "Z_ALREADY_CLOSED", message: "Ya existe un cierre Z para esta fecha" } };
        }

        let allMovements = [];
        const query = wixData.query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("invoiceIssueDate", cleanDiaKey)
            .ascending("sequenceNumber")
            .limit(LEDGER_PAGE_SIZE);
        let res = await query.find({ suppressAuth: true });
        allMovements = allMovements.concat(res.items || []);
        let page = 2;
        while (res.hasNext() && page <= MAX_LEDGER_BATCH_PAGES) {
            res = await res.next();
            allMovements = allMovements.concat(res.items || []);
            page++;
        }

        if (allMovements.length === 0) {
            return { status: "ERROR", data: null, error: { code: "NO_MOVEMENTS", message: "No hay movimientos para cerrar" } };
        }

        const totalCash = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.EFECTIVO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalCard = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.TARJETA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalBizum = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.BIZUM).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalOnline = allMovements.filter(m => m.paymentMethod === PAYMENT_METHOD.ONLINE).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalRefunds = allMovements.filter(m => m.movementType === MOVEMENT_TYPE.REEMBOLSO).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalTips = allMovements.filter(m => m.movementType === MOVEMENT_TYPE.PROPINA).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const totalAdjustments = allMovements.filter(m => m.movementType === MOVEMENT_TYPE.AJUSTE).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const grossSalesTotal = allMovements.filter(m => m.movementType && !["REEMBOLSO", "PROPINA", "AJUSTE"].includes(m.movementType)).reduce((s, m) => s + Number(m.accountingAmount || 0), 0);
        const netTaxableAmount = allMovements.reduce((s, m) => s + Number(m.taxableBaseOrNonSubjectAmount || 0), 0);
        const netTaxAmount = allMovements.reduce((s, m) => s + Number(m.taxAmount || 0), 0);
        const consolidatedTotalAmount = _roundMoney(totalCash + totalCard + totalBizum + totalOnline);

        let approverUser = null;
        if (Math.abs(totalAdjustments) > MONTO_OBLIGA_APROBADOR_Z) {
            approverUser = _safeTrim(options?.approverUser || options?.usuarioAprobador) || null;
            if (!approverUser) {
                return {
                    status: "ERROR", data: null,
                    error: {
                        code: "APPROVER_REQUIRED",
                        message: `Cierre Z con ajustes > ${MONTO_OBLIGA_APROBADOR_Z} EUR requiere approverUser explicito`,
                    },
                };
            }
        }

        const movementTypeBreakdown = {};
        for (const m of allMovements) {
            const mt = m.movementType || "UNKNOWN";
            movementTypeBreakdown[mt] = _roundMoney((movementTypeBreakdown[mt] || 0) + Number(m.accountingAmount || 0));
        }

        const taxTypeBreakdown = {};
        for (const m of allMovements) {
            const rate = String(Number(m.taxRate) || 0);
            if (!taxTypeBreakdown[rate]) {
                taxTypeBreakdown[rate] = { taxableBaseOrNonSubjectAmount: 0, taxAmount: 0, total: 0, operations: 0 };
            }
            taxTypeBreakdown[rate].taxableBaseOrNonSubjectAmount = _roundMoney(taxTypeBreakdown[rate].taxableBaseOrNonSubjectAmount + Number(m.taxableBaseOrNonSubjectAmount || 0));
            taxTypeBreakdown[rate].taxAmount = _roundMoney(taxTypeBreakdown[rate].taxAmount + Number(m.taxAmount || 0));
            taxTypeBreakdown[rate].total = _roundMoney(taxTypeBreakdown[rate].total + Number(m.accountingAmount || 0));
            taxTypeBreakdown[rate].operations++;
        }

        let expectedPreviousHash = GENESIS_HASH;
        let integrityVerified = true;
        for (const mov of allMovements) {
            if (mov.previousRecordHash && mov.previousRecordHash !== expectedPreviousHash) {
                integrityVerified = false;
                log.error("Hash chain integrity violation detected", {
                    traceId, movementId: mov._id,
                    expected: expectedPreviousHash, actual: mov.previousRecordHash,
                });
                break;
            }
            expectedPreviousHash = mov.recordHash || expectedPreviousHash;
        }

        if (!integrityVerified) {
            return { status: "ERROR", data: null, error: { code: "INTEGRITY_VIOLATION", message: "Hash chain integrity violation detected. Cannot close." } };
        }

        const firstMovement = allMovements[0];
        const lastMovement = allMovements[allMovements.length - 1];
        const closingPayload = _stableSerialize({
            operationDate: cleanDiaKey,
            consolidatedTotalAmount,
            grossSalesTotal: _roundMoney(grossSalesTotal),
            netTaxableAmount: _roundMoney(netTaxableAmount),
            netTaxAmount: _roundMoney(netTaxAmount),
            totalOperations: allMovements.length,
            startSequence: Number(firstMovement?.sequenceNumber) || 0,
            endSequence: Number(lastMovement?.sequenceNumber) || 0,
        });
        const closingHash = await hashSHA256(closingPayload);

        let closingSignature = "";
        let closingSignatureStatus = "SIGNED";
        try {
            closingSignature = await _computeSignature(closingHash, traceId);
        } catch (signErr) {
            closingSignatureStatus = "PENDING_SIGNATURE";
            log.warn("Z closing signature unavailable; proceeding without signature", {
                cleanDiaKey, error: signErr?.message, traceId,
            });
            await queueFiscalRecovery({
                transactionId: `Z_${cleanDiaKey}`,
                amount: consolidatedTotalAmount,
                concept: `Cierre Z pendiente de firma ${cleanDiaKey}`,
                phase: "WAIT_FOR_SIGNER_Z_CLOSING",
                origin: "FISCAL_SIGNER_DOWN",
                traceId,
                lastError: signErr?.message || "FISCAL_SIGN_FAIL",
            });
        }

        const zRecord = {
            _id: `Z_${cleanDiaKey}`,
            operationDate: cleanDiaKey,
            closingStatus: "CERRADO",
            consolidatedTotalAmount,
            grossSalesTotal: _roundMoney(grossSalesTotal),
            netTaxableAmount: _roundMoney(netTaxableAmount),
            netTaxAmount: _roundMoney(netTaxAmount),
            totalCash: _roundMoney(totalCash),
            totalCard: _roundMoney(totalCard),
            totalBizum: _roundMoney(totalBizum),
            totalOnline: _roundMoney(totalOnline),
            totalRefunds: _roundMoney(totalRefunds),
            totalTips: _roundMoney(totalTips),
            totalAdjustments: _roundMoney(totalAdjustments),
            totalOperations: allMovements.length,
            startSequence: Number(firstMovement?.sequenceNumber) || 0,
            endSequence: Number(lastMovement?.sequenceNumber) || 0,
            startTicketNumber: firstMovement?.invoiceNumber || "",
            endTicketNumber: lastMovement?.invoiceNumber || "",
            startRecordHash: firstMovement?.previousRecordHash || GENESIS_HASH,
            endRecordHash: lastMovement?.recordHash || GENESIS_HASH,
            movementTypeBreakdown,
            taxTypeBreakdown,
            isIntegrityVerified: closingSignatureStatus === "SIGNED",
            auditedRecordsCount: allMovements.length,
            closingHash,
            closingSignature,
            closingSignatureStatus,
            closingSource: "CRON",
            closingSchemaVersion: LEDGER_SCHEMA_VERSION,
            timeZone: SDK_CONFIG?.TZ || "Europe/Madrid",
            closedAt: new Date(),
            verifiedAt: closingSignatureStatus === "SIGNED" ? new Date() : null,
            approverUser,
            traceId,
            _createdDate: new Date(),
        };

        const saved = await wixData.insert(BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z, zRecord, { suppressAuth: true });

        const cashRegister = await wixData.get(BUSINESS_COLLECTIONS.CAJA_ACTUAL, CASH_REGISTER_ID, { suppressAuth: true }).catch(() => null);
        if (cashRegister) {
            cashRegister.cashRegisterStatus = CASH_REGISTER_STATUS.CLOSED;
            cashRegister.closedAt = new Date();
            cashRegister._updatedDate = new Date();
            await wixData.save(BUSINESS_COLLECTIONS.CAJA_ACTUAL, cashRegister, { suppressAuth: true });
        }

        return { status: "SUCCESS", data: saved, error: null };
    } catch (err) {
        return { status: "ERROR", data: null, error: _toPublicError(err, "Z_CLOSING_FAIL") };
    }
});

// ============================================================================
// VERIFY FISCAL HASH CHAIN INTEGRITY
// ============================================================================

export async function verifyFiscalHashChainIntegrity(options = {}) {
    const traceId = options.traceId || makeTraceId("hash-audit");
    const batchSize = Number(options.limit) || LEDGER_PAGE_SIZE;
    const breaks = [];
    try {
        const movements = await wixData.query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
            .ascending("sequenceNumber")
            .limit(batchSize)
            .find({ suppressAuth: true });

        let expectedPreviousHash = GENESIS_HASH;
        for (const mov of movements.items || []) {
            if (mov.previousRecordHash && mov.previousRecordHash !== expectedPreviousHash) {
                breaks.push({
                    movementId: mov._id,
                    invoiceNumber: mov.invoiceNumber,
                    expected: expectedPreviousHash,
                    actual: mov.previousRecordHash,
                });
            }
            expectedPreviousHash = mov.recordHash;
        }

        if (breaks.length > 0) {
            await logAuditEvent("FISCAL_CHAIN_CORRUPTED", "CRITICAL", `Detectadas ${breaks.length} rupturas en la cadena de facturas`, { breaksCount: breaks.length, details: breaks.slice(0, 5) }, traceId, "system", "backend/cajas.web.js");
        }

        return {
            status: breaks.length === 0 ? "SUCCESS" : "INTEGRITY_COMPROMISED",
            data: { checked: movements.items.length, breaksCount: breaks.length, breaks },
            error: null,
        };
    } catch (err) {
        return { status: "ERROR", data: null, error: { code: "AUDIT_FAIL", message: err.message } };
    }
}

// ============================================================================
// FLUJO 7 - TARJETAS REGALO
// ============================================================================

export const registerGiftCardSale = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("gc-sale");
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { issuerTaxId } = await _getFiscalKeys();

        const giftCardId = _safeTrim(payload?.giftCardId);
        if (!giftCardId) {
            return { status: "ERROR", data: null, error: { code: "INVALID_GIFT_CARD", message: "giftCardId requerido" } };
        }

        const amount = _readPositiveAmount(payload?.amount);
        if (!amount) {
            return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
        }

        const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
        if (!Object.values(PAYMENT_METHOD).includes(paymentMethod)) {
            return { status: "ERROR", data: null, error: { code: "INVALID_PAYMENT_METHOD", message: "Forma de pago invalida" } };
        }

        const existingRes = await wixData
            .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("transactionId", `GC_SALE-${giftCardId}`)
            .limit(1)
            .find({ suppressAuth: true, consistentRead: true });

        if (existingRes?.items?.length > 0) {
            return { status: "SUCCESS", data: existingRes.items[0], error: null, idempotent: true };
        }

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
        await _assertPeriodNotClosed(operationDate, traceId);

        return await (async () => {
            const seq = await _getNextSequence(traceId);
            const lastMovement = await _getLastMovement();
            const previousRecordHash = lastMovement?.recordHash || GENESIS_HASH;
            const generatedAt = new Date();

            const baseMovement = {
                sequenceNumber: seq.sequenceNumber,
                invoiceNumber: seq.invoiceNumber,
                invoiceIssueDate: operationDate,
                operationDate,
                fiscalPeriod: operationDate.slice(0, 7),
                movementType: MOVEMENT_TYPE.VENTA_TARJETA_REGALO,
                paymentMethod,
                totalAmount: amount,
                taxableBaseOrNonSubjectAmount: amount,
                taxAmount: 0,
                taxRate: 0,
                accountingSign: 1,
                accountingAmount: amount,
                operationDescription: `Venta tarjeta regalo ${giftCardId}`,
                lineItems: [],
                issuerTaxId,
                schemaVersion: LEDGER_SCHEMA_VERSION,
                recordSource: "POS",
                resourceId: _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
                linkedBookingIds: null,
                transactionId: `GC_SALE-${giftCardId}`,
                orderId: null, refundId: null,
                giftCardId, giftCardOperation: "SALE",
                customerEmail: payload?.customerEmail || null,

                recipientTaxId: _safeTrim(payload?.recipientTaxId || payload?.nifTercero) || null,
                recipientLegalName: _cleanText(payload?.recipientLegalName || payload?.razonSocialTercero || "", 200) || null,
                isB2B: false,
                withholdingBase: 0,
                irpfWithholdingRate: 0,
                irpfWithholdingAmount: 0,
                fiscalRole: FISCAL_ROLE.EMISOR,
                surchargeRate: 0,
                surchargeAmount: 0,
                linkedAdvanceId: null,
                vatAccrualStatus: VAT_ACCRUAL_STATUS.ANTICIPADO,
                bankReconciliationReference: _safeTrim(payload?.bankReconciliationReference) || null,
                invoiceType: AEAT_INVOICE_TYPE.F2,
                correctionReason: null,
                previousInvoiceId: null,
                issuerInvoiceNumber: null,
            };

            const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, generatedAt);
            const recordHash = await _computeCurrentHash(previousRecordHash, aeatPayload);

            let digitalSignature;
            try {
                digitalSignature = await _computeSignature(recordHash, traceId);
            } catch (signErr) {
                await queueFiscalRecovery({
                    transactionId: baseMovement.transactionId, amount, paymentMethod,
                    concept: baseMovement.operationDescription, movementType: baseMovement.movementType,
                    phase: "WAIT_FOR_SIGNER", origin: "FISCAL_SIGNER_DOWN", traceId,
                    lastError: signErr?.message || "FISCAL_SIGN_FAIL",
                });
                return {
                    status: "SUCCESS",
                    data: { ...baseMovement, previousRecordHash, recordHash, pendingSignature: true, queued: true },
                    error: null,
                };
            }

            const verificationQR = _generateVerificationQR(baseMovement.invoiceNumber, issuerTaxId, operationDate, amount);

            const movement = {
                ...baseMovement,
                previousRecordHash, recordHash, digitalSignature, aeatPayload, verificationQR,
                hashAlgorithm: "SHA-256",
                signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                registeredAt: generatedAt,
                traceId,
                _createdDate: new Date(),
            };

            const saved = await wixData.insert(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, movement, { suppressAuth: true });
            await _updateCajaActual(movement, traceId);

            projectLedgerMovementToAccounting(movement)
                .catch(async (accErr) => {
                    log.error("Accounting projection failed", { traceId, error: accErr?.message });
                    await _queueAccountingResync(movement, accErr, traceId);
                });

            await logAuditEvent("GIFT_CARD_SOLD", "INFO", `Tarjeta regalo vendida: ${giftCardId}`, { giftCardId, amount, traceId }, traceId, giftCardId, "backend/cajas.web.js");

            return { status: "SUCCESS", data: saved, error: null };
        })();
    } catch (err) {
        const norm = normalizeError(err);
        log.error("registerGiftCardSale failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "GC_SALE_FAIL", message: norm.message } };
    }
});

export const registerGiftCardRedemption = webMethod(Permissions.SiteMember, async (payload) => {
    const traceId = payload?.traceId || makeTraceId("gc-redeem");
    try {
        await requireCajero(traceId);
        await validateFiscalConfig(traceId);
        const { issuerTaxId } = await _getFiscalKeys();

        const giftCardId = _safeTrim(payload?.giftCardId);
        if (!giftCardId) {
            return { status: "ERROR", data: null, error: { code: "INVALID_GIFT_CARD", message: "giftCardId requerido" } };
        }

        const amount = _readPositiveAmount(payload?.amount);
        if (!amount) {
            return { status: "ERROR", data: null, error: { code: "INVALID_AMOUNT", message: "Importe positivo requerido" } };
        }

        const serviceId = _safeTrim(payload?.serviceId);
        const bookingId = _safeTrim(payload?.bookingId);

        const clientRedemptionId = _safeTrim(payload?.redemptionId);
        const clientTransactionId = _safeTrim(payload?.transactionId);
        const redemptionId = clientRedemptionId || clientTransactionId ||
            `GC_REDEEM-${giftCardId}-${bookingId || "NA"}-${amount}-${Date.now()}`;

        const existingRedemption = await wixData
            .query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
            .eq("transactionId", redemptionId)
            .limit(1)
            .find({ suppressAuth: true, consistentRead: true });

        if (existingRedemption?.items?.length > 0) {
            log.info("Gift card redemption idempotent duplicate detected", { redemptionId, giftCardId, traceId });
            return { status: "SUCCESS", data: existingRedemption.items[0], error: null, idempotent: true };
        }

        let taxRate = IVA_RATES.GENERAL;
        if (serviceId) {
            const serviceRes = await wixData
                .query(BUSINESS_COLLECTIONS.SERVICIOS_CATALOGO)
                .eq("serviceId", serviceId)
                .limit(1)
                .find({ suppressAuth: true })
                .catch(() => ({ items: [] }));

            if (serviceRes?.items?.length > 0) {
                taxRate = Number(serviceRes.items[0].taxRate) || IVA_RATES.GENERAL;
            }
        }

        const taxableBaseOrNonSubjectAmount = _roundMoney(amount / (1 + taxRate));
        const taxAmount = _roundMoney(amount - taxableBaseOrNonSubjectAmount);

        const operationDate = new Date().toLocaleDateString("sv-SE", { timeZone: SDK_CONFIG?.TZ || "Europe/Madrid" });
        await _assertPeriodNotClosed(operationDate, traceId);

        return await (async () => {
            const seq = await _getNextSequence(traceId);
            const lastMovement = await _getLastMovement();
            const previousRecordHash = lastMovement?.recordHash || GENESIS_HASH;
            const generatedAt = new Date();

            const baseMovement = {
                sequenceNumber: seq.sequenceNumber,
                invoiceNumber: seq.invoiceNumber,
                invoiceIssueDate: operationDate,
                operationDate,
                fiscalPeriod: operationDate.slice(0, 7),
                movementType: MOVEMENT_TYPE.CANJE_TARJETA_REGALO,
                paymentMethod: PAYMENT_METHOD.TARJETA_REGALO,
                totalAmount: amount,
                taxableBaseOrNonSubjectAmount, taxAmount, taxRate,
                accountingSign: 1,
                accountingAmount: amount,
                operationDescription: `Canje tarjeta regalo ${giftCardId}${serviceId ? ` - servicio ${serviceId}` : ""}`,
                lineItems: [],
                issuerTaxId,
                schemaVersion: LEDGER_SCHEMA_VERSION,
                recordSource: "POS",
                resourceId: _safeTrim(payload?.resourceId) || "CAJA_LOCAL",
                linkedBookingIds: bookingId ? _linkedBookingValue([bookingId]) : null,
                transactionId: redemptionId,
                orderId: null, refundId: null,
                giftCardId, giftCardOperation: "REDEMPTION",
                serviceIdRedeemed: serviceId || null,

                recipientTaxId: _safeTrim(payload?.recipientTaxId || payload?.nifTercero) || null,
                recipientLegalName: _cleanText(payload?.recipientLegalName || payload?.razonSocialTercero || "", 200) || null,
                isB2B: false,
                withholdingBase: 0,
                irpfWithholdingRate: 0,
                irpfWithholdingAmount: 0,
                fiscalRole: FISCAL_ROLE.EMISOR,
                surchargeRate: 0,
                surchargeAmount: 0,
                linkedAdvanceId: null,
                vatAccrualStatus: VAT_ACCRUAL_STATUS.APLICACION_ANTICIPO,
                bankReconciliationReference: null,
                invoiceType: AEAT_INVOICE_TYPE.F2,
                correctionReason: null,
                previousInvoiceId: null,
                issuerInvoiceNumber: null,
            };

            const aeatPayload = _buildAEATPayload({ ...baseMovement, previousRecordHash }, generatedAt);
            const recordHash = await _computeCurrentHash(previousRecordHash, aeatPayload);

            let digitalSignature;
            try {
                digitalSignature = await _computeSignature(recordHash, traceId);
            } catch (signErr) {
                await queueFiscalRecovery({
                    transactionId: baseMovement.transactionId, amount,
                    paymentMethod: baseMovement.paymentMethod,
                    concept: baseMovement.operationDescription, movementType: baseMovement.movementType,
                    phase: "WAIT_FOR_SIGNER", origin: "FISCAL_SIGNER_DOWN", traceId,
                    lastError: signErr?.message || "FISCAL_SIGN_FAIL",
                });
                return {
                    status: "SUCCESS",
                    data: { ...baseMovement, previousRecordHash, recordHash, pendingSignature: true, queued: true },
                    error: null,
                };
            }

            const verificationQR = _generateVerificationQR(baseMovement.invoiceNumber, issuerTaxId, operationDate, amount);

            const movement = {
                ...baseMovement,
                previousRecordHash, recordHash, digitalSignature, aeatPayload, verificationQR,
                hashAlgorithm: "SHA-256",
                signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA-256",
                registeredAt: generatedAt,
                traceId,
                _createdDate: new Date(),
            };

            const saved = await wixData.insert(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA, movement, { suppressAuth: true });
            await _updateCajaActual(movement, traceId);

            projectLedgerMovementToAccounting(movement)
                .catch(async (accErr) => {
                    log.error("Accounting projection failed", { traceId, error: accErr?.message });
                    await _queueAccountingResync(movement, accErr, traceId);
                });

            await logAuditEvent("GIFT_CARD_REDEEMED", "INFO", `Tarjeta regalo canjeada: ${giftCardId}`, { giftCardId, amount, serviceId, traceId }, traceId, giftCardId, "backend/cajas.web.js");

            return { status: "SUCCESS", data: saved, error: null };
        })();
    } catch (err) {
        const norm = normalizeError(err);
        log.error("registerGiftCardRedemption failed", { code: norm.code, error: norm.message, traceId });
        return { status: "ERROR", data: null, error: { code: norm.code || "GC_REDEEM_FAIL", message: norm.message } };
    }
});

// ============================================================================
// CONFIRMATION PAGE READ (SSOT-07: page code never queries CMS directly)
// ============================================================================

// Public DTO whitelist for the Verifactu receipt block. NEVER add: margin,
// internalNotes, tipoImpositivo, codigoImpuesto, payloadFiscal, nifEmisor,
// cuentaContable* (BIBLIA 15). recordHash IS allowed here because it is part
// of the AEAT public verification QR contract (Veri*/Facturae).
const _MOVEMENT_DTO_FIELDS = Object.freeze([
    "invoiceNumber",
    "issuerTaxId",
    "invoiceIssueDate",
    "totalAmount",
    "recordHash",
    "recordTimestamp",
    "operationDescription"
]);

function _toMovementDto(movement) {
    if (!movement || typeof movement !== "object") return null;
    const dto = {};
    for (const key of _MOVEMENT_DTO_FIELDS) {
        if (movement[key] !== undefined && movement[key] !== null) {
            dto[key] = movement[key];
        }
    }
    return dto;
}

/**
 * getMovimientoByBooking({ bookingId }) -> { ok, data }
 * Read-only lookup of the append-only ledger movement linked to a booking.
 */
export const getMovimientoByBooking = webMethod(
    Permissions.Anyone,
    async ({ bookingId } = {}) => {
        const traceId = makeTraceId("movimiento-by-booking");
        const cleanId = _safeTrim(bookingId);
        if (!cleanId) {
            return { ok: false, data: null, error: "BOOKING_ID_REQUIRED" };
        }
        try {
            // linkedBookingIds stores the canonical serialized value produced
            // by _linkedBookingValue(); exact match keeps this index-friendly.
            const expected = _linkedBookingValue([cleanId]);
            let res = await withTimeout(
                wixData.query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                    .eq("linkedBookingIds", expected)
                    .limit(1)
                    .find({ suppressAuth: true, consistentRead: true }),
                FISCAL_SIGNER_TIMEOUT_MS,
                "getMovimientoByBooking"
            );
            let item = res?.items?.[0] || null;
            if (!item) {
                // Legacy transition fallback (EOL 31/12/2026): rows written
                // before V20.1 stored the bare bookingId.
                res = await withTimeout(
                    wixData.query(BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA)
                        .eq("linkedBookingIds", cleanId)
                        .limit(1)
                        .find({ suppressAuth: true }),
                    FISCAL_SIGNER_TIMEOUT_MS,
                    "getMovimientoByBookingLegacy"
                );
                item = res?.items?.[0] || null;
                if (item) {
                    log.warn("legacy linkedBookingIds format read", {
                        traceId,
                        movementId: item._id
                    });
                }
            }
            if (!item) return { ok: false, data: null, error: "NOT_FOUND" };
            return { ok: true, data: _toMovementDto(item), error: null };
        } catch (err) {
            log.warn("getMovimientoByBooking failed", {
                traceId,
                error: err?.message
            });
            return { ok: false, data: null, error: "READ_FAILED" };
        }
    }
);
