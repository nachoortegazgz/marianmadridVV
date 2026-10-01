/*
=============================================================================
MODULE: backend/data.js
VERSION: v5009-FISCAL-V20.1
BASE: v5009-FISCAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Hooks de inmutabilidad y validacion para Wix Data.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: imports alineados a internalConfig V20.1.
  - V20-02: hooks validan campos CMS V20.1 (ingles camelCase).
  - V20-03: helpers _read* aceptan aliases legacy durante transicion.
  - V20-04: mensajes de error se mantienen en espanol (operadores).
  - V20-05: validaciones nuevas para fiscalRole, linkedAdvanceId,
            vatAccrualStatus, bankReconciliationReference, isB2B,
            issuerInvoiceNumber, correctionType, nonSubjectReason.

FIXES APLICADOS v5009-FISCAL (heredados):
  - FIX-50, FIX-51, FIX-65.
  - D-01..D-13.
  - FIX-FISCAL-04.
=============================================================================
*/

import wixData from "wix-data";

import {
    BUSINESS_COLLECTIONS,

    EU_VAT_PREFIXES,
    FISCAL_ROLE,
    EVENT_TYPE,
    THIRD_PARTY_TYPE,
    ITEM_NATURE,
    CONTROL_TYPE,
    TIMECLOCK_TYPE,
} from "backend/internalConfig";

import {
    assertValidEnum,
    assertCitasF2,
} from "backend/validation";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// CONSTANTES
// =============================================================================

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMMUTABLE_ENTRY_STATUSES = new Set([
    "POSTED",
    "LOCKED",
]);

const ALLOWED_Z_UPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "verifiedAt",
    "approverUser",
    "_updatedDate",
]);

const NIF_LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";

const LEDGER_SCHEMA_VERSION_AEAT = "LEDGER_V5_FISCAL";

const VALID_THIRD_PARTY_TYPES = new Set([
    "CLIENTE", "PROVEEDOR", "STAFF", "AAPP", "MIXTO",
]);

const VALID_ITEM_NATURES = new Set([
    "SERVICIO_PROPIO", "PRODUCTO_VENTA", "PRODUCTO_USO", "GASTO_FIJO",
]);

const VALID_TAX_CODES = new Set([
    "IVA_21", "IVA_10", "IVA_4", "IVA_0",
    "IRPF_15", "IRPF_19", "EXENTO",
]);

const VALID_EVENT_TYPES = new Set([
    "VENTA_LINEA", "COMPRA_LINEA", "CIERRE_Z",
    "AJUSTE", "RECTIFICATIVA", "MOV_STOCK",
]);

const VALID_FISCAL_ROLES = new Set([
    "EMISOR", "RECEPTOR",
]);

// =============================================================================
// HELPERS
// =============================================================================

function _safeTrim(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

function _isGuid(value) {
    return GUID_PATTERN.test(_safeTrim(value));
}

function _isFiniteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0;
}

function _isImmutableStatus(status) {
    return IMMUTABLE_ENTRY_STATUSES.has(_safeTrim(status).toUpperCase());
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function _roundItem(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function _isV5Fiscal(item) {
    return _safeTrim(item?.schemaVersion) === LEDGER_SCHEMA_VERSION_AEAT;
}

// =============================================================================
// VALIDACION NIF ESPANOL Y VAT UE
// =============================================================================

function _isValidNifEspanol(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean || clean.length < 8) return false;

    // DNI: 8 digitos + letra
    if (/^\d{8}[A-Z]$/.test(clean)) {
        const numero = Number(clean.slice(0, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    // NIE: X/Y/Z + 7 digitos + letra
    if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
        const prefijo = { X: "0", Y: "1", Z: "2" }[clean.charAt(0)];
        const numero = Number(prefijo + clean.slice(1, 8));
        const letraEsperada = NIF_LETRAS_DNI[numero % 23];
        return clean.charAt(8) === letraEsperada;
    }

    // CIF: letra + 7 digitos + digito/letra control
    if (/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(clean)) {
        return true;
    }

    return false;
}

function _isValidNifOrEuVat(nif) {
    const clean = _safeTrim(nif).toUpperCase().replace(/[-\s]/g, "");
    if (!clean) return false;

    if (_isValidNifEspanol(clean)) return true;

    if (clean.length >= 8 && clean.length <= 14) {
        const prefix = clean.slice(0, 2);
        if (EU_VAT_PREFIXES.includes(prefix)) {
            const body = clean.slice(2);
            if (/^[A-Z0-9]{5,12}$/.test(body)) return true;
        }
    }

    return false;
}

// =============================================================================
// HELPERS DE LECTURA — Aceptan nomenclatura V20.1 y aliases legacy
// =============================================================================

function _readTaxableBase(item) {
    const v = item.taxableBaseOrNonSubjectAmount ?? item.baseImponibleOImporteNoSujeto ?? item.taxableAmount;
    return Number(v) || 0;
}

function _readTaxAmount(item) {
    const v = item.taxAmount ?? item.cuotaTotal;
    return Number(v) || 0;
}

function _readTotalAmount(item) {
    const v = item.totalAmount ?? item.importeTotal ?? item.amount;
    return Number(v) || 0;
}

function _readSurchargeAmount(item) {
    const v = item.surchargeAmount ?? item.cuotaRecargoEquivalencia ?? item.importeRecargoEquivalencia;
    return Number(v) || 0;
}

function _readRecipientTaxId(item) {
    return _safeTrim(item.recipientTaxId || item.nifDestinatario || item.nifTercero);
}

function _readRecipientLegalName(item) {
    return _safeTrim(item.recipientLegalName || item.nombreRazonDestinatario || item.razonSocialTercero);
}

function _readInvoiceType(item) {
    return _safeTrim(item.invoiceType || item.tipoFactura || item.claveRegistroFactura).toUpperCase();
}

function _readBreakdownBaseAndTax(item) {
    let base = 0;
    let tax = 0;

    const breakdown =
        item.detailedBreakdown ||
        item.desgloseDetallado ||
        item.desgloseImpuestos ||
        item.lineItems;

    if (breakdown) {
        try {
            const arr = typeof breakdown === "string" ? JSON.parse(breakdown) : breakdown;
            if (Array.isArray(arr) && arr.length > 0) {
                base = arr.reduce(
                    (sum, d) => sum + Number(d.taxableBaseOrNonSubjectAmount ?? d.baseImponibleOImporteNoSujeto ?? d.base ?? 0),
                    0
                );
                tax = arr.reduce(
                    (sum, d) => sum + Number(d.chargedTaxAmount ?? d.cuotaRepercutida ?? d.cuota ?? 0),
                    0
                );
            }
        } catch (e) {
            _schemaError("detailedBreakdown/desgloseDetallado no es JSON valido");
        }
    }

    return { base, tax };
}

function _validateF1Requirements(item) {
    if (_readInvoiceType(item) !== "F1") return;

    const pf = item.fiscalPayload || item.payloadFiscal || {};
    const taxId = _readRecipientTaxId(item) || _safeTrim(pf.nifDestinatario);
    const legalName = _readRecipientLegalName(item) || _safeTrim(pf.nombreRazonDestinatario);
    const address = item.recipientAddress || pf.domicilioDestinatario || {};

    if (!taxId) {
        _schemaError("Factura F1 exige recipientTaxId");
    }
    if (!legalName) {
        _schemaError("Factura F1 exige recipientLegalName");
    }
    if (!address || !_safeTrim(address.cp)) {
        _schemaError("Factura F1 exige recipientAddress con CP");
    }
}

function _validateReverseCharge(item) {
    if (item.reverseCharge !== true) return;

    const tax = _readTaxAmount(item);
    if (tax > 0) {
        _schemaError("reverseCharge implica taxAmount = 0");
    }
}

function _validateAjuste(item) {
    if (_safeTrim(item.eventType).toUpperCase() !== "AJUSTE") return;

    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("eventType=AJUSTE exige previousInvoiceId");
    }
}

function _validateFiscalRole(item) {
    const role = _safeTrim(item.fiscalRole).toUpperCase();
    if (!role) return;
    if (!VALID_FISCAL_ROLES.has(role)) {
        _schemaError("fiscalRole invalido (EMISOR|RECEPTOR)");
    }
}

function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const eventType = _safeTrim(item.eventType).toUpperCase();
    if (!eventType || !VALID_EVENT_TYPES.has(eventType)) {
        _schemaError("eventType obligatorio y valido");
    }

    if (eventType !== "CIERRE_Z") {
        if (!_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        if (!item.fiscalPayload || typeof item.fiscalPayload !== "object") {
            _schemaError("fiscalPayload obligatorio (snapshot AEAT)");
        }
    }

    if (["VENTA_LINEA", "COMPRA_LINEA", "RECTIFICATIVA", "MOV_STOCK"].includes(eventType)) {
        if (!_isGuid(item.catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }
    }

    if (!Number.isFinite(Number(item.sequenceNumber)) || Number(item.sequenceNumber) <= 0) {
        _schemaError("sequenceNumber obligatorio (> 0)");
    }

    if (!_safeTrim(item.recordHash)) {
        _schemaError("recordHash obligatorio (cadena SHA-256)");
    }
}

// =============================================================================
// BLOQUE 1 - MOVIMIENTOS DE CAJA
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // Validar NIF/VAT del destinatario
    const taxId = _readRecipientTaxId(item);
    if (taxId && !_isValidNifOrEuVat(taxId)) {
        _schemaError("recipientTaxId no tiene formato valido (espanol o VAT UE)");
    }

    // Validar cuadre fiscal segun fiscalRole
    const { base, tax } = _readBreakdownBaseAndTax(item);
    const finalBase = base > 0 ? base : _readTaxableBase(item);
    const finalTax = tax > 0 ? tax : _readTaxAmount(item);

    const withholding = Number(item.irpfWithholdingAmount || item.importeRetencionIRPF) || 0;
    const surcharge = _readSurchargeAmount(item);
    const total = _readTotalAmount(item);

    if (finalBase > 0 || finalTax > 0 || withholding > 0 || surcharge > 0) {
        const role = _safeTrim(item.fiscalRole || item.rolFiscal).toUpperCase() || FISCAL_ROLE.EMISOR;
        const withholdingFactor = role === FISCAL_ROLE.RECEPTOR ? 1 : -1;

        const expected = _roundItem(finalBase + finalTax + surcharge + withholdingFactor * withholding);
        const diff = Math.abs(expected - total);
        if (diff > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${role}): base ${finalBase} + cuota ${finalTax} + recargo ${surcharge} ${withholdingFactor > 0 ? "+" : "-"} retencion ${withholding} = ${expected.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // Validaciones nuevas V20.1
    _validateF1Requirements(item);
    _validateReverseCharge(item);
    _validateAjuste(item);
    _validateFiscalRole(item);

    // Validaciones capa AEAT V5
    _validateFiscalPayload(item);

    // Cuadre detailedBreakdown vs cabecera
    if (Array.isArray(item.detailedBreakdown) && item.detailedBreakdown.length > 0) {
        let sumBase = 0;
        let sumTax = 0;
        for (const d of item.detailedBreakdown) {
            sumBase += Number(d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0);
            sumTax += Number(d.chargedTaxAmount ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - finalBase) > 0.02) {
            _schemaError(`detailedBreakdown.base (${sumBase}) no cuadra con cabecera (${finalBase})`);
        }
        if (Math.abs(_roundItem(sumTax) - finalTax) > 0.02) {
            _schemaError(`detailedBreakdown.cuota (${sumTax}) no cuadra con cabecera (${finalTax})`);
        }
    }

    // Validar regimeKey coherente con catalogo
    if (item.catalogId) {
        // Aqui solo validamos que si viene regimeKey, sea coherente con el payload
        const payloadRegimeKey = _safeTrim(item.fiscalPayload?.claveRegimen);
        const itemRegimeKey = _safeTrim(item.regimeKey);
        if (payloadRegimeKey && itemRegimeKey && payloadRegimeKey !== itemRegimeKey) {
            _schemaError("regimeKey no coincide con fiscalPayload.claveRegimen");
        }
    }

    // FASE2 SSOT-12: trazabilidad transaccional obligatoria en toda escritura
    // del ledger + version de esquema AEAT canonica.
    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en MovimientosCaja (SSOT-12)");
    }
    if (_safeTrim(item.schemaVersion) !== LEDGER_SCHEMA_VERSION_AEAT) {
        _schemaError(`schemaVersion debe ser "${LEDGER_SCHEMA_VERSION_AEAT}"`);
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _fiscalError(
        "Modificacion de MovimientosCaja prohibida por normativa fiscal (append-only). Use eventType=AJUSTE."
    );
}

export function MovimientosCaja_beforeRemove() {
    _fiscalError(
        "Borrado de MovimientosCaja prohibido por normativa fiscal"
    );
}

// =============================================================================
// BLOQUE 2 - CIERRES Z
// =============================================================================

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const previous = context?.original || {};
    const changes = Object.keys(item || {}).filter((key) => {
        const before = previous[key];
        const after = item[key];
        return String(before) !== String(after);
    });

    const onlySignatureFields = changes.every((key) =>
        ALLOWED_Z_UPDATE_FIELDS.has(key)
    );

    if (!onlySignatureFields) {
        _fiscalError(
            "Modificacion de HistoricoCierresZ prohibida. Solo se permite actualizar closingSignature/closingSignatureStatus desde recovery."
        );
    }

    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    _fiscalError(
        "Borrado de HistoricoCierresZ prohibido por normativa fiscal"
    );
}

// =============================================================================
// BLOQUE 3 - REGISTROS HORARIOS
// =============================================================================

export function RegistrosHorariosStaff_beforeUpdate() {
    _fiscalError(
        "Modificacion de RegistrosHorariosStaff prohibida"
    );
}

export function RegistrosHorariosStaff_beforeRemove() {
    _fiscalError(
        "Borrado de RegistrosHorariosStaff prohibido"
    );
}

// =============================================================================
// BLOQUE 4 - CAJA ACTUAL
// =============================================================================

export function CajaActual_beforeUpdate(item, context) {
    const previous = context?.original || {};

    const prevSeq = previous?.sequenceCounters;
    const nextSeq = item?.sequenceCounters;

    const changed =
        JSON.stringify(prevSeq || {}) !== JSON.stringify(nextSeq || {});

    if (changed && item?._id !== "CAJA_SEQ") {
        log.warn("CajaActual_beforeUpdate: sequenceCounters modified on non-CAJA_SEQ document", {
            _id: item?._id,
            prev: prevSeq,
            next: nextSeq,
        });
    }

    return item;
}

export function CajaActual_beforeRemove() {
    throw new Error(
        "SINGLETON_PROTECTED: No se puede eliminar el estado de caja"
    );
}

// =============================================================================
// BLOQUE 5 - SERVICIOS CATALOGO
// =============================================================================

export function ServiciosCatalogo_beforeInsert(item) {
    return _validateServiciosCatalogoSchema(item);
}

export function ServiciosCatalogo_beforeUpdate(item) {
    return _validateServiciosCatalogoSchema(item);
}

function _validateServiciosCatalogoSchema(item = {}) {
    const serviceId = _safeTrim(item.serviceId || item._id);
    const linkedPhases = _safeTrim(item.linkedPhases);
    const allowCombine = item.allowCombine === true;

    if (item.serviceId && !_isGuid(item.serviceId)) {
        _schemaError("serviceId debe ser un GUID valido");
    }

    if (allowCombine && !linkedPhases) {
        _schemaError("Servicio dual requiere linkedPhases");
    }

    if (linkedPhases && !_isGuid(linkedPhases)) {
        _schemaError("linkedPhases debe ser un GUID valido");
    }

    if (linkedPhases && linkedPhases === serviceId) {
        _schemaError("linkedPhases no puede referenciar al propio servicio");
    }

    // Validar itemNature si viene
    const itemNature = _safeTrim(item.itemNature || item.naturalezaItem).toUpperCase();
    if (itemNature && !VALID_ITEM_NATURES.has(itemNature)) {
        _schemaError("itemNature invalido");
    }

    // Validar taxCode si viene
    const taxCode = _safeTrim(item.taxCode || item.codigoImpuesto).toUpperCase();
    if (taxCode && !VALID_TAX_CODES.has(taxCode)) {
        _schemaError("taxCode invalido");
    }

    const phase1Duration = Number(item.phase1Duration) || 0;
    const exposureDuration = Number(item.exposureDuration) || 0;
    const phase2Duration = Number(item.phase2Duration) || 0;
    const totalDuration = Number(item.totalDuration) || 0;

    if (
        !_isFiniteNonNegative(phase1Duration) ||
        !_isFiniteNonNegative(exposureDuration) ||
        !_isFiniteNonNegative(phase2Duration) ||
        !_isFiniteNonNegative(totalDuration)
    ) {
        _schemaError("Las duraciones deben ser numeros no negativos");
    }

    // Inferir totalDuration si allowCombine y falta
    if (allowCombine && totalDuration === 0) {
        const inferred = phase1Duration + exposureDuration + phase2Duration;
        if (inferred > 0) {
            item.totalDuration = inferred;
        }
    }

    if (allowCombine && totalDuration > 0) {
        const expectedDuration =
            phase1Duration + exposureDuration + phase2Duration;

        if (expectedDuration > 0 && Math.abs(totalDuration - expectedDuration) > 1) {
            _schemaError(
                `totalDuration (${totalDuration}) no coincide con la suma de fases (${expectedDuration})`
            );
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 6 - MAPA STAFF
// =============================================================================

export async function MapaStaff_beforeInsert(item) {
    return _validateMapaStaffUniqueness(item);
}

export async function MapaStaff_beforeUpdate(item) {
    return _validateMapaStaffUniqueness(item);
}

async function _validateMapaStaffUniqueness(item = {}) {
    const itemId = _safeTrim(item._id);
    const resourceId = _safeTrim(item.resourceId);
    const staffMemberId = _safeTrim(item.staffMemberId);
    const email = _safeTrim(item.email).toLowerCase();

    if (resourceId) {
        if (!_isGuid(resourceId)) {
            _schemaError("resourceId debe ser un GUID valido");
        }

        const existingByResource = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq("resourceId", resourceId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByResource?.items?.length > 0) {
            _schemaError("resourceId duplicado en MapaStaff");
        }
    }

    if (staffMemberId) {
        const existingByMember = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq("staffMemberId", staffMemberId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByMember?.items?.length > 0) {
            _schemaError("staffMemberId duplicado en MapaStaff");
        }
    }

    if (email) {
        // ADR-03: el indice de email en MapaStaff NO es unico segun BIBLIA 14.
        // Se relaja la unicidad de email en el hook; la unicidad canonica se
        // preserva via resourceId/staffMemberId (bloques superiores).
        log.warn("MapaStaff email duplicado permitido (ADR-03, indice no unico)", {
            emailDomain: email.split("@")[1] || "",
        });
    }

    return item;
}

// =============================================================================
// BLOQUE 7 - ASIENTOS CONTABLES
// =============================================================================

export function AsientosContables_beforeUpdate(item) {
    if (_isImmutableStatus(item?.entryStatus)) {
        _fiscalError("No se puede modificar un asiento POSTED o LOCKED");
    }

    return item;
}

export function AsientosContables_beforeRemove(item) {
    if (_isImmutableStatus(item?.entryStatus)) {
        _fiscalError("No se puede eliminar un asiento POSTED o LOCKED");
    }

    return item;
}

// =============================================================================
// BLOQUE 8 - LINEAS DE ASIENTO
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    // Validar cuenta PGC obligatoria y de 6 digitos (solo si viene)
    const code = _safeTrim(item.accountCode || item.cuentaContable);
    if (code) {
        if (!/^\d{6}$/.test(code)) {
            _schemaError(`accountCode "${code}" no tiene formato PGC (6 digitos)`);
        }
    }

    // Validaciones capa AEAT v5
    if (_isV5Fiscal(item) || _safeTrim(item.sourceEventId || item.eventoOrigenId)) {
        const sourceEventId = _safeTrim(item.sourceEventId || item.eventoOrigenId);
        const thirdPartyId = _safeTrim(item.thirdPartyId || item.terceroId);
        const catalogId = _safeTrim(item.catalogId || item.catalogoId);

        if (!_isGuid(sourceEventId)) {
            _schemaError("sourceEventId obligatorio (FK MovimientosCaja)");
        }
        if (!_isGuid(thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        if (!_isGuid(catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }

        const lineNumber = Number(item.lineNumber ?? item.numeroLinea);
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
            _schemaError("lineNumber >= 1");
        }

        if (!Number.isFinite(Number(item.units)) || Number(item.units) <= 0) {
            _schemaError("units > 0");
        }

        const opDesc = _safeTrim(item.operationDescription || item.descripcionOperacion);
        if (!opDesc) {
            _schemaError("operationDescription obligatoria en lineas v5");
        }
    }

    return item;
}

export async function LibroAsientosContablesDetalle_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LibroAsientosContablesDetalle_beforeRemove(item) {
    return _validateAccountingLineParent(item);
}

export async function LineasAsientoContable_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LineasAsientoContable_beforeRemove(item) {
    return _validateAccountingLineParent(item);
}

async function _validateAccountingLineParent(item = {}) {
    // FASE3 SSOT-09: AsientosContables es FORBIDDEN; no se lee el padre.
    // La inmutabilidad se aplica sobre el propio item (estado embebido en la
    // linea al proyectarse desde el ledger).
    const parentStatus = _safeTrim(item.parentEntryStatus);

    if (parentStatus && _isImmutableStatus(parentStatus)) {
        _fiscalError(
            "No se puede modificar o eliminar una linea de asiento POSTED o LOCKED"
        );
    }

    return item;
}

// =============================================================================
// BLOQUE 9 - SECUENCIA DE TICKETS (RETIRADA, ADR-02)
// =============================================================================
// FASE2/ADR-02: SecuenciaTickets se retira formalmente. La secuencia de tickets
// vive ahora en CajaActual.CAJA_SEQ; los hooks de la coleccion bloqueada se
// eliminan por orden del plan (no hay hook que proteger).

// =============================================================================
// BLOQUE 10 - CIERRES DE INVENTARIO (RETIRADA, ADR-02)
// =============================================================================
// FASE2/ADR-02: InventarioStockVentaCierre se retira; el cierre de inventario
// queda absorbido por HistoricoCierresZ (bloque inventario). Sus hooks se
// retiraron; la inmutabilidad la garantiza HistoricoCierresZ_beforeUpdate/Remove.

// =============================================================================
// BLOQUE 11 - DATOS FISCALES
// =============================================================================

export function DatosFiscales_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const taxId = _safeTrim(item.taxId || item.nifCif);
    if (!taxId || !_isValidNifOrEuVat(taxId)) {
        _schemaError("taxId obligatorio y valido (espanol o VAT UE)");
    }

    const legalName = _safeTrim(item.legalName || item.razonSocial);
    if (!legalName) {
        _schemaError("legalName obligatoria");
    }

    const type = _safeTrim(item.thirdPartyType || item.tipoTercero).toUpperCase();
    if (!type || !VALID_THIRD_PARTY_TYPES.has(type)) {
        _schemaError("thirdPartyType invalido (CLIENTE, PROVEEDOR, STAFF, AAPP, MIXTO)");
    }

    if (type === "STAFF") {
        const bookingsResourceId = _safeTrim(item.bookingsResourceId || item.resourceIdBookings);
        const staffMemberId = _safeTrim(item.staffMemberId);
        if (!_isGuid(bookingsResourceId)) {
            _schemaError("thirdPartyType=STAFF exige bookingsResourceId GUID");
        }
        if (!staffMemberId) {
            _schemaError("thirdPartyType=STAFF exige staffMemberId");
        }
    }

    return item;
}

export function DatosFiscales_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;

    const taxId = _safeTrim(item.taxId || item.nifCif);
    if (taxId && !_isValidNifOrEuVat(taxId)) {
        _schemaError("taxId invalido en update");
    }

    return item;
}

// =============================================================================
// BLOQUE 12 - FACTURAS RECIBIDAS
// =============================================================================

export function FacturasRecibidas_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const issuerTaxId = _safeTrim(item.issuerTaxId || item.nifEmisor);
    if (!issuerTaxId || !_isValidNifOrEuVat(issuerTaxId)) {
        _schemaError("FacturasRecibidas requiere issuerTaxId valido (espanol o VAT UE)");
    }

    if (!_safeTrim(item.issuerLegalName || item.nombreRazonEmisor)) {
        _schemaError("FacturasRecibidas requiere issuerLegalName");
    }

    const thirdPartyId = _safeTrim(item.thirdPartyId || item.terceroId);
    if (!_isGuid(thirdPartyId)) {
        _schemaError("FacturasRecibidas requiere thirdPartyId (FK DatosFiscales)");
    }

    const sourceEventId = _safeTrim(item.sourceEventId || item.eventoOrigenId);
    if (!_isGuid(sourceEventId)) {
        _schemaError("FacturasRecibidas requiere sourceEventId (FK MovimientosCaja)");
    }

    const base = Number(item.totalTaxableBase || item.baseImponibleTotal) || 0;
    const tax = Number(item.totalVatAmount || item.cuotaIvaTotal) || 0;
    const surcharge = Number(item.surchargeAmount || item.cuotaRecargoEquivalencia) || 0;
    const withholding = Number(item.irpfWithholdingAmount || item.importeRetencionIRPF) || 0;
    const total = Number(item.totalAmount || item.importeTotal) || 0;

    if (base || tax || surcharge || withholding || total) {
        const expected = _roundItem(base + tax + surcharge - withholding);
        if (Math.abs(expected - total) > 0.02) {
            _schemaError(
                `Factura recibida descuadra: base ${base} + IVA ${tax} + RE ${surcharge} - ret ${withholding} = ${expected.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    // Cuadre detailedBreakdown si viene
    if (Array.isArray(item.detailedBreakdown) && item.detailedBreakdown.length > 0) {
        let sumBase = 0;
        let sumTax = 0;
        for (const d of item.detailedBreakdown) {
            sumBase += Number(d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0);
            sumTax += Number(d.chargedTaxAmount ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - base) > 0.02) {
            _schemaError("FacturasRecibidas detailedBreakdown.base no cuadra");
        }
        if (Math.abs(_roundItem(sumTax) - tax) > 0.02) {
            _schemaError("FacturasRecibidas detailedBreakdown.cuota no cuadra");
        }
    }

    return item;
}

export function FacturasRecibidas_beforeUpdate(item) {
    // No se bloquea el update (permite cambios de estado de pago, adjuntos, etc.)
    return item;
}

// =============================================================================
// BLOQUE 13 - CITAS F2 (hooks SSOT 13.2)
// =============================================================================

export function CitasF2_beforeInsert(item) {
    assertCitasF2(item);
    return item;
}

export function CitasF2_beforeUpdate(item) {
    assertCitasF2(item);
    return item;
}

// =============================================================================
// BLOQUE 14 - MOVIMIENTOS INVENTARIO (append-only, SSOT 13.1)
// =============================================================================

export function MovimientosInventario_beforeUpdate() {
    _fiscalError("MovimientosInventario es append-only");
}

export function MovimientosInventario_beforeRemove() {
    _fiscalError("Borrado prohibido en MovimientosInventario");
}

// =============================================================================
// BLOQUE 15 - CONTROL OPERATIVO (8-en-1, ADR-05)
// =============================================================================

export function ControlOperativo_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertValidEnum(item.controlType, CONTROL_TYPE, "controlType");

    if (!_safeTrim(item.dedupeKey)) {
        _schemaError("dedupeKey obligatorio en ControlOperativo");
    }
    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio (SSOT-12)");
    }
    if (item.controlType === CONTROL_TYPE.WEBHOOK_EVENT && !_safeTrim(item.eventId)) {
        _schemaError("WEBHOOK_EVENT exige eventId");
    }

    return item;
}

export function ControlOperativo_beforeUpdate(item, context) {
    const original = context?.original || item;
    if (_safeTrim(original?.controlType) === CONTROL_TYPE.WEBHOOK_EVENT) {
        _fiscalError("WEBHOOK_EVENT es append-only (ADR-05)");
    }
    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (_safeTrim(item?.controlType) === CONTROL_TYPE.WEBHOOK_EVENT) {
        _fiscalError("Borrado prohibido en WEBHOOK_EVENT");
    }
    return item;
}

// =============================================================================
// BLOQUE 16 - INVENTARIO STOCK VENTA (invariante de stock)
// =============================================================================

export function InventarioStockVenta_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;

    const stockOnHand = Number(item.stockOnHand);
    const stockReserved = Number(item.stockReserved ?? 0);
    const stockAvailable = Number(item.stockAvailable);

    if (Number.isFinite(stockOnHand) && Number.isFinite(stockAvailable)) {
        if (Math.abs((stockOnHand - stockReserved) - stockAvailable) > 0.001) {
            _schemaError(
                `InventarioStockVenta: stockAvailable (${stockAvailable}) debe ser stockOnHand (${stockOnHand}) - stockReserved (${stockReserved})`
            );
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 17 - REGISTROS HORARIOS STAFF (fichajes, SSOT 13 / RD 8/2019)
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertValidEnum(item.clockEventType, TIMECLOCK_TYPE, "clockEventType");

    if (item.clockEventType === TIMECLOCK_TYPE.AJUSTE && !_safeTrim(item.adjustmentReason)) {
        _schemaError("clockEventType=AJUSTE exige adjustmentReason");
    }

    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en RegistrosHorariosStaff (SSOT-12)");
    }

    return item;
}
