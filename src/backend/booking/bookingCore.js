/*
=============================================================================
MODULE: backend/booking/bookingCore.js
VERSION: v5009-FISCAL-V20.1
BASE: v5008.6-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Capa de acceso y primitivas atomicas para reservas.
STANDARDS: ASCII only. No Node builtins.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo solo usa nombres cortos
            (bookingId, pairToken, status, paymentStatus, traceId) que no
            cambian en V20.1. CitasF2 mantiene su esquema corto; los campos
            V20.1 nuevos (thirdPartyId, sourceEventId, fiscalData, etc.) los
            escriben los modulos de nivel superior (bookingSaga, events).

HISTORIAL (heredado):
  v5008.6 | 2026-09-20 | Alineacion final: FIX-32, FIX-33, FIX-43.
  v5008.5 | 2026-09-19 | COHERENCIA scheduleId: CORE-16, CORE-17.
  v5008.4 | 2026-09-19 | Date range, scheduleId obligatorio, cache validaciones.
  v5008.3 | 2026-09-19 | Restauracion de exports faltantes.
  v5008.2 | 2026-09-15 | Aligned + dead code removed.
=============================================================================
*/

import { bookings } from "wix-bookings.v2";
import { checkout } from "wix-ecom-backend";
import { elevate } from "wix-auth";
import wixData from "wix-data";
import { getStaffScheduleId } from "backend/staff";
import { logger } from "backend/logger";
import {
    OPERATIONAL_COLLECTIONS,
    BUSINESS_COLLECTIONS,
    CONCURRENCY,
    SDK_CONFIG,
    API,
    INACTIVE_BOOKING_STATUSES,
    BOOKING_TYPE,
    BOOKING_STATUS,
    PAYMENT_STATUS,
    CONTROL_TYPE,
    CONTROL_STATUS,
} from "backend/internalConfig";
import {
    _safeTrim,
    _looksLikeGuid,
    getUtcDateFromMadridLocal,
    getMadridLocalStringNoZ,
    makeTraceId,
    _toDateSafe,
    _hashKey,
    _normalizeLocalIsoStr,
} from "public/mmUtils";
import {
    computeGapMinutes,
} from "backend/booking/bookingUtils";

const log = logger;

// FIX-32: STAFF_RESOURCE_TYPE_ID via SSOT.
const STAFF_RESOURCE_TYPE_ID = API.STAFF_RESOURCE_TYPE_ID;

// =============================================================================
// BLOQUE 1 - CODIGOS DE ERROR (25 codigos)
// =============================================================================

export const ERROR_CODES = Object.freeze({
    INVALID_PAYLOAD: "INVALID_PAYLOAD",
    TOKEN_BUSY: "TOKEN_BUSY",
    FISCAL_SIGN_FAIL: "FISCAL_SIGN_FAIL",
    FISCAL_VIOLATION: "FISCAL_VIOLATION",
    BOOKING_CREATION_FAILED: "BOOKING_CREATION_FAILED",
    CHECKOUT_FAILED: "CHECKOUT_FAILED",
    INVALID_EMPLOYEE: "INVALID_EMPLOYEE",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    ACCESS_DENIED: "ACCESS_DENIED",
    INVALID_CLOCK_TYPE: "INVALID_CLOCK_TYPE",
    RATE_LIMITED: "RATE_LIMITED",
    SLOT_UNAVAILABLE: "SLOT_UNAVAILABLE",
    STAFF_UNAVAILABLE: "STAFF_UNAVAILABLE",
    SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
    LOCK_KEY_OR_OWNER_INVALID: "LOCK_KEY_OR_OWNER_INVALID",
    LOCK_HELD_BY_ANOTHER_OWNER: "LOCK_HELD_BY_ANOTHER_OWNER",
    LOCK_EXPIRED_PENDING_CLEANUP: "LOCK_EXPIRED_PENDING_CLEANUP",
    LOCK_RENEWAL_FAILED: "LOCK_RENEWAL_FAILED",
    TRANSACTION_TIMEOUT: "TRANSACTION_TIMEOUT",
    PAIR_TOKEN_PAYLOAD_MISMATCH: "PAIR_TOKEN_PAYLOAD_MISMATCH",
    TRANSACTION_PREVIOUSLY_FAILED: "TRANSACTION_PREVIOUSLY_FAILED",
    INVALID_SLOT_RECHECK: "INVALID_SLOT_RECHECK",
    DATABASE_ERROR: "DATABASE_ERROR",
    INVALID_DATES: "INVALID_DATES",
    UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// =============================================================================
// BLOQUE 2 - ELEVATED PROXIES (Bookings V2 + eCommerce)
// =============================================================================

export const createBookingElevated = elevate(bookings.createBooking);
export const cancelBookingElevated = elevate(bookings.cancelBooking);
export const confirmOrDeclineBookingElevated = elevate(bookings.confirmOrDeclineBooking);
export const rescheduleBookingElevated = elevate(bookings.rescheduleBooking);
export const createCheckoutElevated = elevate(checkout.createCheckout);
export const getCheckoutUrlElevated = elevate(checkout.getCheckoutUrl);

// Back-compat: some modules historically imported logger from this file.
export { logger };

// =============================================================================
// BLOQUE 3 - CLASE BOOKINGERROR
// =============================================================================

export class BookingError extends Error {
    constructor(code, message, details = {}) {
        super(String(message || "Unknown error"));
        this.name = "BookingError";
        this.code = String(code || ERROR_CODES.UNKNOWN_ERROR);
        this.details = details && typeof details === "object" ? details : { details };
        this.timestamp = new Date().toISOString();
    }
}

export function createBookingError(code, message, details) {
    return new BookingError(code, message, details);
}

// =============================================================================
// BLOQUE 4 - NORMALIZACION DE ERRORES
// =============================================================================

export function normalizeError(err) {
    if (err && typeof err === "object" && err.name === "BookingError") {
        return {
            code: String(err.code || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details || {},
        };
    }
    if (err instanceof Error) {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || "Unknown error"),
            stack: err.stack || null,
            details: err.details && typeof err.details === "object" ? err.details : {},
        };
    }
    if (typeof err === "string") {
        return { code: ERROR_CODES.UNKNOWN_ERROR, message: err, stack: null, details: {} };
    }
    if (err && typeof err === "object") {
        return {
            code: String(err.code || err.errorCode || err.name || ERROR_CODES.UNKNOWN_ERROR),
            message: String(err.message || err.error || "Unknown error"),
            stack: err.stack || null,
            details: {},
        };
    }
    return { code: ERROR_CODES.UNKNOWN_ERROR, message: "Unknown error", stack: null, details: {} };
}

export function _handleError(error, context, traceId, logFn) {
    const loggerInstance = logFn || log;
    const norm = normalizeError(error);
    loggerInstance.error("[" + context + "] " + norm.code + ": " + norm.message, {
        traceId,
        details: norm.details,
    });
    return {
        status: "ERROR",
        data: null,
        error: {
            code: norm.code || ERROR_CODES.UNKNOWN_ERROR,
            message: norm.message || "Unknown error",
        },
    };
}

// =============================================================================
// BLOQUE 5 - RESOLUCION DE SCHEDULEID (FALLBACK CONTROLADO)
// =============================================================================

async function _resolveScheduleIdByResourceId(resourceId) {
    const id = _safeTrim(resourceId);
    if (!id || !_looksLikeGuid(id)) return null;
    const scheduleId = await getStaffScheduleId(id);
    return scheduleId && _looksLikeGuid(scheduleId) ? scheduleId : null;
}

export async function _resolveScheduleIdForResource(resourceId, sourceSlot) {
    const resourceIdClean = _safeTrim(resourceId);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const s = (sourceSlot && typeof sourceSlot === "object") ? sourceSlot : {};
    let scheduleId = _safeTrim(
        s.scheduleId || s.slot?.scheduleId || s.schedule?.id || s.resource?.scheduleId || ""
    );
    if (scheduleId && _looksLikeGuid(scheduleId)) return scheduleId;

    scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    return scheduleId || null;
}

// =============================================================================
// BLOQUE 6 - NORMALIZACION DE SLOTS PARA WRITER V2
// =============================================================================

export async function _forceStaffInPristineSlot(slot, resourceId, serviceIdOverride, defaultDurationMinutes) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(serviceIdOverride || slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) {
        log.error("_forceStaffInPristineSlot: invalid serviceId", { serviceId });
        return null;
    }

    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || slot.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) {
        log.error("_forceStaffInPristineSlot: invalid resourceId", { resourceIdClean });
        return null;
    }

    let scheduleId = _safeTrim(
        slot.scheduleId || slot.slot?.scheduleId || slot.schedule?.id || slot.resource?.scheduleId || ""
    );
    if (!scheduleId) {
        scheduleId = await _resolveScheduleIdByResourceId(resourceIdClean);
    }
    if (!scheduleId || !_looksLikeGuid(scheduleId)) {
        log.error("_forceStaffInPristineSlot: missing scheduleId", { resourceId: resourceIdClean });
        return null;
    }

    let localStartDate = "";
    const rawStart = slot.localStartDate || slot.startDate;
    if (rawStart instanceof Date) localStartDate = getMadridLocalStringNoZ(rawStart);
    else if (typeof rawStart === "string" && rawStart.endsWith("Z")) {
        const utcDt = new Date(rawStart);
        localStartDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localStartDate = _safeTrim(rawStart);
    if (!localStartDate) return null;

    let localEndDate = "";
    const rawEnd = slot.localEndDate || slot.endDate;
    if (rawEnd instanceof Date) localEndDate = getMadridLocalStringNoZ(rawEnd);
    else if (typeof rawEnd === "string" && rawEnd.endsWith("Z")) {
        const utcDt = new Date(rawEnd);
        localEndDate = !isNaN(utcDt.getTime()) ? getMadridLocalStringNoZ(utcDt) : "";
    } else localEndDate = _safeTrim(rawEnd);

    if (!localEndDate) {
        const startUtc = getUtcDateFromMadridLocal(localStartDate);
        if (!startUtc) return null;
        const durationMin = Number(defaultDurationMinutes || CONCURRENCY?.DEFAULT_DURATION_MIN || 30);
        localEndDate = getMadridLocalStringNoZ(new Date(startUtc.getTime() + durationMin * 60 * 1000));
    }

    const startDate = getUtcDateFromMadridLocal(localStartDate);
    const endDate = getUtcDateFromMadridLocal(localEndDate);
    if (!startDate || !endDate) return null;

    if (endDate.getTime() <= startDate.getTime()) {
        log.error("_forceStaffInPristineSlot: invalid date range (endDate <= startDate)", {
            localStartDate,
            localEndDate,
            resourceId: resourceIdClean,
            serviceId,
        });
        return null;
    }

    const locationId = _safeTrim(SDK_CONFIG?.LOCATION_ID);
    let locationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER) || "OWNER_BUSINESS";
    if (locationType === "BUSINESS") locationType = "OWNER_BUSINESS";
    const timezone = _safeTrim(SDK_CONFIG?.TZ) || "Europe/Madrid";

    if (!locationId) {
        log.error("_forceStaffInPristineSlot: missing LOCATION_ID in SDK_CONFIG");
        return null;
    }

    return {
        serviceId,
        scheduleId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        timezone,
        resource: { id: resourceIdClean },
        location: { id: locationId, locationType },
    };
}

// =============================================================================
// BLOQUE 7 - CHECKOUT URL HELPER
// =============================================================================

export function _extractCheckoutId(checkoutSession) {
    return checkoutSession?.checkout?._id || checkoutSession?._id || null;
}

export async function getCheckoutUrlSafe(checkoutSessionOrId) {
    const direct = checkoutSessionOrId?.checkoutUrl || checkoutSessionOrId?.checkout?.checkoutUrl || null;
    if (direct) return direct;
    const checkoutId =
        typeof checkoutSessionOrId === "string" ? checkoutSessionOrId : _extractCheckoutId(checkoutSessionOrId);
    if (!checkoutId) return null;
    try {
        const result = await getCheckoutUrlElevated(checkoutId, {});
        return result?.checkoutUrl || null;
    } catch (error) {
        log.warn("getCheckoutUrlSafe failed", { checkoutId, error: error?.message });
        return null;
    }
}

// =============================================================================
// BLOQUE 8 - MUTEX LOCKS (ControlOperativo SLOT_LOCK, FASE3 ADR-05)
// =============================================================================

const MS_TTL_MUTEX = Number(CONCURRENCY?.MS_TTL_MUTEX);
if (!Number.isFinite(MS_TTL_MUTEX) || MS_TTL_MUTEX <= 0) {
    throw new Error("MS_TTL_MUTEX must be positive");
}
const CONTROL_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export function _safeLockId(key) {
    const k = String(key || "").trim();
    if (!k) return "";
    return "lk_" + _hashKey(k) + "_" + k.slice(0, 24);
}

// Alias público para compatibilidad con módulos que importan safeLockId sin guión bajo
export const safeLockId = _safeLockId;

// Alias público para compatibilidad con módulos que importan generateSlotKey sin guión bajo
export const generateSlotKey = _generateSlotKey;

async function _getLock(slotClave) {
    const k = String(slotClave || "");
    if (!k) return null;
    const item = await wixData
        .get(CONTROL_COL, _safeLockId(k), { suppressAuth: true, consistentRead: true })
        .catch(() => null);
    if (!item) return null;
    if (item.expiresAt) item.expiresAt = _toDateSafe(item.expiresAt);
    return item;
}

function _getLockOwnerId(lock) {
    if (!lock || typeof lock !== "object") return "";
    return _safeTrim(lock.lockOwnerId || lock.traceId || "");
}

function _isDuplicateItemError(error) {
    const message = String(error?.message || "");
    return message.includes("WDE0123") || message.includes("WD_ITEM_ALREADY_EXISTS") || message.includes("Duplicated");
}

function _buildLockDocument(slotClave, lockOwnerId, ttlMs, existing) {
    const now = new Date();
    return {
        ...(existing || {}),
        _id: _safeLockId(slotClave),
        controlType: CONTROL_TYPE.SLOT_LOCK,
        dedupeKey: String(slotClave),
        status: CONTROL_STATUS.ACTIVE,
        slotKey: String(slotClave),
        lockOwnerId: String(lockOwnerId || makeTraceId("lock")),
        traceId: String(lockOwnerId || makeTraceId("lock")),
        expiresAt: new Date(Date.now() + (Number(ttlMs) || MS_TTL_MUTEX)),
        _createdDate: existing?._createdDate ? _toDateSafe(existing._createdDate) || now : now,
        _updatedDate: now,
    };
}

export async function _lockSlotKeyOrFail(slotClave, lockOwnerId, ttlMs) {
    const k = String(slotClave || "");
    const owner = String(lockOwnerId || "").trim();
    if (!k || !owner) return { ok: false, message: "LOCK_KEY_OR_OWNER_INVALID" };

    try {
        await wixData.insert(CONTROL_COL, _buildLockDocument(k, owner, ttlMs), { suppressAuth: true });
        return { ok: true, acquired: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) {
            log.error("_lockSlotKeyOrFail failed", { slotClave: k, error: error?.message });
            return { ok: false, message: error?.message || "Lock acquisition failed" };
        }
        const existing = await _getLock(k);
        const currentOwner = _getLockOwnerId(existing);
        if (currentOwner === owner) {
            const renewed = await _renewLock(k, owner, ttlMs);
            return renewed.ok ? { ok: true, renewed: true } : { ok: false, message: "LOCK_RENEWAL_FAILED" };
        }
        const expiresAt = _toDateSafe(existing?.expiresAt);
        const expired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        if (expired && existing?._id) {
            await wixData.remove(CONTROL_COL, existing._id, { suppressAuth: true }).catch(() => null);
            try {
                await wixData.insert(CONTROL_COL, _buildLockDocument(k, owner, ttlMs), { suppressAuth: true });
                return { ok: true, acquired: true, reclaimed: true };
            } catch (_) {
                return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
            }
        }
        return { ok: false, message: "LOCK_HELD_BY_ANOTHER_OWNER" };
    }
}

export async function _unlockSlotKey(slotClave, lockOwnerId) {
    const owner = String(lockOwnerId || "").trim();
    const existing = await _getLock(slotClave);
    if (!existing) return { ok: true, missing: true };
    const currentOwner = _getLockOwnerId(existing);
    if (!owner || currentOwner !== owner) return { ok: false, skipped: true };
    await wixData.remove(CONTROL_COL, existing._id, { suppressAuth: true });
    return { ok: true };
}

export async function _renewLock(slotClave, lockOwnerId, ttlMs) {
    try {
        const owner = String(lockOwnerId || "").trim();
        const existing = await _getLock(slotClave);
        if (!existing) return { ok: false };
        const currentOwner = _getLockOwnerId(existing);
        if (!owner || currentOwner !== owner) return { ok: false };
        await wixData.update(CONTROL_COL, _buildLockDocument(slotClave, owner, ttlMs, existing), { suppressAuth: true });
        return { ok: true };
    } catch (error) {
        log.error("_renewLock failed", { slotClave, error: error?.message });
        return { ok: false };
    }
}

// =============================================================================
// BLOQUE 9 - SLOT KEYS
// =============================================================================

export function _generateSlotKey(serviceId, resourceId, startDate, endDate) {
    const startUtc = startDate instanceof Date ? startDate : getUtcDateFromMadridLocal(startDate);
    const endUtc = endDate instanceof Date ? endDate : getUtcDateFromMadridLocal(endDate);
    if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime()) {
        throw createBookingError(ERROR_CODES.INVALID_DATES, "Invalid slot dates for lock key");
    }
    const startEpochMin = Math.floor(startUtc.getTime() / 60000);
    const endEpochMin = Math.floor(endUtc.getTime() / 60000);
    const raw = String(serviceId || "").trim() + "|" + String(resourceId || "").trim() + "|" + startEpochMin + "|" + endEpochMin;
    const prefix = serviceId ? String(serviceId).slice(0, 8) : "srv";
    const staffPrefix = resourceId ? String(resourceId).slice(0, 8) : "nostaff";
    return "slot_" + prefix + "_" + staffPrefix + "_" + _hashKey(raw);
}

export function _buildLockKeys(phases, resourceId) {
    const keys = (phases || []).map(function (p) {
        const slot = p?.rawSlot || {};
        return _generateSlotKey(slot.serviceId, resourceId, p.localStart, p.localEnd);
    });
    return Array.from(new Set(keys)).sort();
}

// =============================================================================
// BLOQUE 10 - TRANSACCIONES IDEMPOTENTES (ControlOperativo BOOKING_TX, FASE3)
// =============================================================================

const TRANSACTIONS_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;
const TRANSACTION_POLL_BASE_MS = Number(CONCURRENCY?.TRANSACTION_POLL_BASE_MS) || 250;
const TRANSACTION_MAX_WAIT_MS = Number(CONCURRENCY?.TRANSACTION_MAX_WAIT_MS) || 3000;

async function _getTransactionById(pairToken) {
    const id = String(pairToken || "");
    if (!id) return null;
    return await wixData.get(TRANSACTIONS_COL, id, { suppressAuth: true, consistentRead: true }).catch(() => null);
}

export async function _initTransaction(pairToken, payloadHash, traceId) {
    const id = String(pairToken || "");
    if (!id) return { success: false, error: "INVALID_PAIR_TOKEN" };

    try {
        await wixData.insert(
            TRANSACTIONS_COL,
            {
                _id: id,
                controlType: CONTROL_TYPE.BOOKING_TX,
                dedupeKey: id,
                pairToken: id,
                status: "PENDING",
                payloadHash,
                traceId,
                _createdDate: new Date(),
                _updatedDate: new Date(),
            },
            { suppressAuth: true }
        );
        return { success: true, isNew: true };
    } catch (error) {
        if (!_isDuplicateItemError(error)) throw error;

        const startTime = Date.now();
        let pollAttempt = 0;
        while (Date.now() - startTime < TRANSACTION_MAX_WAIT_MS) {
            const existing = await _getTransactionById(id);
            if (existing) {
                if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                    return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
                }
                if (existing.status === "COMPLETED") return { success: true, isNew: false, existing };
                if (existing.status === "FAILED") {
                    return { success: false, error: "TRANSACTION_PREVIOUSLY_FAILED", existing };
                }
            }
            const remainingMs = TRANSACTION_MAX_WAIT_MS - (Date.now() - startTime);
            const delay = Math.min(
                Math.floor(TRANSACTION_POLL_BASE_MS * Math.pow(2, Math.min(pollAttempt, 3)) * (0.5 + Math.random())),
                remainingMs
            );
            if (delay <= 0) break;
            pollAttempt++;
            await new Promise(function (r) { setTimeout(r, delay); });
        }

        const existing = await _getTransactionById(id);
        if (existing) {
            if (String(existing.payloadHash || "") !== String(payloadHash || "")) {
                return { success: false, error: "PAIR_TOKEN_PAYLOAD_MISMATCH" };
            }
            return { success: false, error: "TRANSACTION_TIMEOUT", existing, timeout: true };
        }
        return { success: false, error: "TRANSACTION_TIMEOUT" };
    }
}

export async function _completeTransaction(pairToken, result, traceId) {
    const id = String(pairToken || "");
    if (!id) return;
    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;
    const doc = {
        ...(existing || {}),
        _id: id,
        controlType: CONTROL_TYPE.BOOKING_TX,
        dedupeKey: id,
        pairToken: id,
        status: "COMPLETED",
        result,
        ownerTraceId: String(traceId || existing?.ownerTraceId || ""),
        traceId: String(traceId || existing?.traceId || ""),
        _updatedDate: new Date(),
        _createdDate: existing?._createdDate || new Date(),
    };
    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true });
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true });
}

export async function _failTransaction(pairToken, errorMessage) {
    const id = String(pairToken || "");
    if (!id) return;
    const existing = await _getTransactionById(id);
    if (existing && existing.status === "COMPLETED") return;
    const doc = {
        ...(existing || {}),
        _id: id,
        controlType: CONTROL_TYPE.BOOKING_TX,
        dedupeKey: id,
        pairToken: id,
        status: "FAILED",
        error: String(errorMessage || "UNKNOWN_ERROR"),
        lastError: String(errorMessage || "UNKNOWN_ERROR"),
        traceId: String(existing?.traceId || makeTraceId("tx-fail")),
        _updatedDate: new Date(),
        _createdDate: existing?._createdDate || new Date(),
    };
    if (existing) await wixData.update(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
    else await wixData.insert(TRANSACTIONS_COL, doc, { suppressAuth: true }).catch(() => null);
}

// =============================================================================
// BLOQUE 11 - PERSISTENCIA EN CITAS_F2
// =============================================================================

const CITAS_COL = BUSINESS_COLLECTIONS.CITAS_F2;

// Resolve legacy/canonical bookingType into the canonical enum for NEW writes.
// Read adapters elsewhere keep tolerating legacy values until EOL 31/12/2026.
function normalizeBookingTypeForWrite(p) {
    const raw = p.tipo || p.bookingType || "";
    const up = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (up === "DUALF1" || up === "DUALF2") return BOOKING_TYPE[up];
    if (up === "SIMPLE" || up === "NORMAL" || up === "") return BOOKING_TYPE.SIMPLE;
    // Legacy ambiguous dual markers resolved by pair presence (MATRIZ H.5):
    if (up === "DUAL" || up === "LINKED" || up === "MULTIPHASE") {
        return p.pairToken ? BOOKING_TYPE.DUALF1 : BOOKING_TYPE.SIMPLE;
    }
    return BOOKING_TYPE.SIMPLE;
}

export async function _persistBooking(params, traceId) {
    const p = params || {};
    const bookingId = p.bookingId;
    const serviceId = p.serviceId;
    const resourceId = p.resourceId;
    const startDate = p.startDate;
    const endDate = p.endDate;
    if (!bookingId || !serviceId || !resourceId || !startDate || !endDate) {
        throw new Error("Missing required fields for persistBooking");
    }

    const scheduleIdClean = _safeTrim(p.scheduleId);
    if (!scheduleIdClean || !_looksLikeGuid(scheduleIdClean)) {
        throw createBookingError(
            ERROR_CODES.INVALID_PAYLOAD,
            "scheduleId is required and must be a valid GUID for CitasF2 persistence",
            { traceId, bookingId: String(bookingId), scheduleIdRaw: p.scheduleId }
        );
    }

    const startDateObj = startDate instanceof Date ? startDate : new Date(startDate);
    const endDateObj = endDate instanceof Date ? endDate : new Date(endDate);
    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime()) || endDateObj.getTime() <= startDateObj.getTime()) {
        throw new Error("Invalid startDate/endDate for persistBooking");
    }

    const startLocal = getMadridLocalStringNoZ(startDateObj);
    const dateYmd = startLocal ? startLocal.slice(0, 10) : "";
    const now = new Date();
    // FASE1-P0: canonical PAYMENT_STATUS/BOOKING_STATUS (MATRIZ alias F
    // eradicated: no literal "UNPAID" in new writes). Transitional READ of
    // legacy persisted values happens via normalizePaymentStatusForWrite.
    const rawPago = String(p.paymentStatus || p.meta?.paymentStatus || "").toUpperCase();
    const metaPago = normalizePaymentStatusForWrite(rawPago) || PAYMENT_STATUS.NOT_PAID;
    const statusCita = String(p.status || (metaPago === PAYMENT_STATUS.PENDING_PAYMENT ? BOOKING_STATUS.PENDING : BOOKING_STATUS.CONFIRMED));

    // Transitional read-only normalizer (EOL 31/12/2026): maps known legacy
    // payment values to canonical PAYMENT_STATUS; unknown values return "" so
    // the caller falls back to NOT_PAID with an explicit warn. Never invents
    // data; used ONLY on the write boundary to sanitize inbound legacy payloads.
    function normalizePaymentStatusForWrite(raw) {
        if (!raw) return "";
        switch (raw) {
            case "UNPAID":
            case "NOPAGADO":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.NOT_PAID });
                return PAYMENT_STATUS.NOT_PAID;
            case "NOT_PAID": return PAYMENT_STATUS.NOT_PAID;
            case "PAGADO":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.PAID });
                return PAYMENT_STATUS.PAID;
            case "PAID": return PAYMENT_STATUS.PAID;
            case "PENDIENTEPAGO":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.PENDING_PAYMENT });
                return PAYMENT_STATUS.PENDING_PAYMENT;
            case "PENDING_PAYMENT": return PAYMENT_STATUS.PENDING_PAYMENT;
            case "PENDIENTEASIENTO":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.PENDING_LEDGER });
                return PAYMENT_STATUS.PENDING_LEDGER;
            case "PENDING_LEDGER": return PAYMENT_STATUS.PENDING_LEDGER;
            case "REEMBOLSADO":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.REFUNDED });
                return PAYMENT_STATUS.REFUNDED;
            case "REFUNDED": return PAYMENT_STATUS.REFUNDED;
            case "REEMBOLSADOPARCIAL":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.PARTIALLY_REFUNDED });
                return PAYMENT_STATUS.PARTIALLY_REFUNDED;
            case "PARTIALLY_REFUNDED": return PAYMENT_STATUS.PARTIALLY_REFUNDED;
            case "EXENTO":
                log.warn("legacy paymentStatus normalized on write", { raw, canonical: PAYMENT_STATUS.EXEMPT });
                return PAYMENT_STATUS.EXEMPT;
            default:
                log.warn("unknown paymentStatus on write, defaulting NOT_PAID", { raw });
                return "";
        }
    }

    let normalizedMeta = p.meta || {};
    if (typeof normalizedMeta === "string") {
        try { normalizedMeta = JSON.parse(normalizedMeta); } catch (_) { normalizedMeta = {}; }
    }
    if (typeof normalizedMeta !== "object" || normalizedMeta === null || Array.isArray(normalizedMeta)) {
        normalizedMeta = {};
    }
    normalizedMeta = { ...normalizedMeta, status: statusCita, paymentStatus: metaPago };

    const doc = {
        bookingId: String(bookingId),
        pairToken: String(p.pairToken || normalizedMeta.pairToken || ""),
        revision: Number(p.revision) || 1,
        serviceId: String(serviceId),
        scheduleId: scheduleIdClean,
        resourceId: String(resourceId),
        startDate: startDateObj,
        endDate: endDateObj,
        dateYmd,
        bookingType: normalizeBookingTypeForWrite(p),
        status: statusCita,
        paymentStatus: metaPago,
        meta: normalizedMeta,
        contactDetails: p.contactDetails || {},
        traceId: String(traceId || ""),
        _createdDate: now,
        _updatedDate: now,
    };

    if ((doc.bookingType === BOOKING_TYPE.DUALF1 || doc.bookingType === BOOKING_TYPE.DUALF2) && !doc.pairToken) {
        throw new Error("Missing pairToken for linked booking");
    }

    const existing = await wixData
        .query(CITAS_COL)
        .eq("bookingId", String(bookingId))
        .limit(1)
        .find({ suppressAuth: true, suppressHooks: true })
        .catch(() => null);

    if (existing?.items?.length > 0) {
        const existingDoc = existing.items[0];
        const incomingRevision = Number(doc.revision) || 1;
        const currentRevision = Number(existingDoc.revision) || 1;
        if (incomingRevision < currentRevision) {
            throw new BookingError(ERROR_CODES.DATABASE_ERROR, "Booking revision conflict", {
                bookingId: String(bookingId),
                currentRevision,
                incomingRevision,
            });
        }
        const updated = { ...existingDoc, ...doc };
        delete updated._createdDate;
        delete updated._updatedDate;
        delete updated._owner;
        const item = await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { created: false, item };
    }

    const item = await wixData.insert(CITAS_COL, doc, { suppressAuth: true, suppressHooks: true });
    return { created: true, item };
}

// =============================================================================
// BLOQUE 12 - ACTUALIZACION SEGURA DE CITA
// =============================================================================

export async function _updateCitaSafe(bookingId, updater, traceId, operation) {
    const bid = _safeTrim(bookingId);
    if (!bid) return { updated: false, reason: "INVALID_BOOKING_ID" };

    try {
        const res = await wixData
            .query(CITAS_COL)
            .eq("bookingId", bid)
            .limit(1)
            .find({ suppressAuth: true, suppressHooks: true });

        const cita = res?.items?.[0];
        if (!cita) {
            log.warn("_updateCitaSafe: cita not found", { bookingId: bid, operation, traceId });
            return { updated: false, reason: "NOT_FOUND" };
        }

        const updated = updater(cita);
        if (!updated) return { updated: false, reason: "NO_CHANGE" };

        updated._updatedDate = new Date();
        updated.traceId = traceId || updated.traceId;

        await wixData.update(CITAS_COL, updated, { suppressAuth: true, suppressHooks: true });
        return { updated: true, bookingId: bid };
    } catch (err) {
        log.error("_updateCitaSafe failed", {
            bookingId: bid,
            operation,
            traceId,
            error: err?.message,
        });
        return { updated: false, reason: "ERROR", error: err?.message };
    }
}

// =============================================================================
// BLOQUE 13 - DUAL CACHE (ControlOperativo DUAL_CACHE, FASE3)
// =============================================================================

const DUAL_CACHE_COL = OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO;

export async function _getDualPairFromCache(pairToken, traceId, expected = {}) {
    if (!pairToken) return null;

    const res = await wixData
        .query(DUAL_CACHE_COL)
        .eq("_id", String(pairToken))
        .eq("controlType", CONTROL_TYPE.DUAL_CACHE)
        .limit(1)
        .find({ suppressAuth: true })
        .catch(() => null);

    const item = res?.items?.[0] || null;
    if (!item) return null;

    const exp = _toDateSafe(item.expiresAt);
    if (exp && exp.getTime() < Date.now()) return null;

    if (expected.serviceId && _safeTrim(item.serviceId) !== _safeTrim(expected.serviceId)) {
        log.warn("_getDualPairFromCache: serviceId mismatch", {
            pairToken, traceId, cached: item.serviceId, expected: expected.serviceId,
        });
        return null;
    }
    if (expected.resourceId && _safeTrim(item.resourceId) !== _safeTrim(expected.resourceId)) {
        log.warn("_getDualPairFromCache: resourceId mismatch", {
            pairToken, traceId, cached: item.resourceId, expected: expected.resourceId,
        });
        return null;
    }
    if (expected.phase2ServiceId) {
        const cachedPhase2 = _safeTrim(item.phase2ServiceId);
        if (cachedPhase2 !== _safeTrim(expected.phase2ServiceId)) {
            log.warn("_getDualPairFromCache: phase2ServiceId mismatch", {
                pairToken, traceId, cached: cachedPhase2, expected: expected.phase2ServiceId,
            });
            return null;
        }
    }
    if (Number.isFinite(expected.minSchemaVersion)) {
        const cachedVersion = Number(item.schemaVersion || 1);
        if (cachedVersion < Number(expected.minSchemaVersion)) {
            log.warn("_getDualPairFromCache: schemaVersion too old", {
                pairToken, traceId, cached: cachedVersion, expected: expected.minSchemaVersion,
            });
            return null;
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 14 - HELPERS DE ADDONS
// =============================================================================

export function _normalizeAddons(addons) {
    if (!Array.isArray(addons)) return [];
    return addons.map((a) => {
        const rawPrice = Number(a?.precio ?? a?.price ?? 0);
        const precio = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
        return {
            id: a?.id || a?._id || "",
            nombre: a?.nombre || a?.name || "Complemento",
            precio,
        };
    });
}

export function _sumAddons(addons) {
    return _normalizeAddons(addons).reduce((acc, a) => acc + a.precio, 0);
}

// =============================================================================
// BLOQUE 15 - EXTRACCION DE RESOURCEIDS DESDE SLOTS
// =============================================================================

export function _extractResourceIdsFromSlot(slot) {
    if (!slot || typeof slot !== "object") return [];

    let groups = [];
    if (Array.isArray(slot.availableResources)) groups = slot.availableResources;
    else if (slot.slot && typeof slot.slot === "object" && Array.isArray(slot.slot.availableResources)) {
        groups = slot.slot.availableResources;
    } else if (slot.resourceId) {
        return _looksLikeGuid(String(slot.resourceId)) ? [String(slot.resourceId)] : [];
    } else if (slot.resource?.id) {
        return _looksLikeGuid(String(slot.resource.id)) ? [String(slot.resource.id)] : [];
    }

    const staffGroup = groups.find((g) => String(g.resourceTypeId) === String(STAFF_RESOURCE_TYPE_ID));
    if (!staffGroup) return [];

    return Array.from(new Set(
        (staffGroup.resources || [])
        .map((resource) => _safeTrim(resource?.id || resource?._id))
        .filter((resourceId) => _looksLikeGuid(resourceId))
    ));
}

// =============================================================================
// BLOQUE 16 - VALIDACION DE GUID
// =============================================================================

export function isValidGuid(id) {
    return _looksLikeGuid(id);
}

// =============================================================================
// BLOQUE 17 - VERIFICACION DE CONTIGUIDAD/GAP ENTRE SLOTS
// =============================================================================

export function _areSlotsContiguous(slot1, slot2, maxGapMinutes) {
    if (!slot1 || !slot2) return false;
    const maxGap = maxGapMinutes == null ? 120 : maxGapMinutes;
    const end1 = slot1.localEndDate || slot1.endDate;
    const start2 = slot2.localStartDate || slot2.startDate;
    if (!end1 || !start2) return false;

    const end1Utc = end1 instanceof Date ? end1 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(end1));
    const start2Utc = start2 instanceof Date ? start2 : getUtcDateFromMadridLocal(_normalizeLocalIsoStr(start2));
    if (!end1Utc || !start2Utc) return false;

    const rawDiffMinutes = (start2Utc.getTime() - end1Utc.getTime()) / 60000;

    if (rawDiffMinutes < -1) return false;

    const gapMinutes = computeGapMinutes(end1Utc, start2Utc);

    return gapMinutes <= maxGap;
}

// =============================================================================
// BLOQUE 18 - PROYECCION DE SLOTS CERTIFICADOS Y WRITER
// =============================================================================

export function _projectCertifiedSlot(slot, resourceId) {
    if (!slot || typeof slot !== "object") return null;

    const serviceId = _safeTrim(slot.serviceId);
    if (!serviceId || !_looksLikeGuid(serviceId)) return null;

    const resourceIdClean = _safeTrim(resourceId || slot.resourceId || slot.resource?.id);
    if (!resourceIdClean || !_looksLikeGuid(resourceIdClean)) return null;

    const localStartDate = _normalizeLocalIsoStr(slot.localStartDate || slot.startDate);
    const localEndDate = _normalizeLocalIsoStr(slot.localEndDate || slot.endDate);

    if (!localStartDate || !localEndDate) return null;

    const startDateUtc = getUtcDateFromMadridLocal(localStartDate);
    const endDateUtc = getUtcDateFromMadridLocal(localEndDate);

    if (!startDateUtc || !endDateUtc || endDateUtc.getTime() <= startDateUtc.getTime()) return null;

    return {
        serviceId,
        resourceId: resourceIdClean,
        scheduleId: _safeTrim(slot.scheduleId || slot.slot?.scheduleId || ""),
        localStartDate,
        localEndDate,
        startDate: startDateUtc,
        endDate: endDateUtc,
        bookable: slot.bookable === true,
        availableResources: _extractResourceIdsFromSlot(slot),
        timezone: SDK_CONFIG?.TZ || "Europe/Madrid",
        locationId: _safeTrim(slot.location?.id || SDK_CONFIG?.LOCATION_ID || ""),
        locationName: _safeTrim(slot.location?.name || ""),
        formattedAddress: _safeTrim(slot.location?.formattedAddress || ""),
    };
}

export function _projectWriterSlotFromAvailability(slot, resourceId, serviceId) {
    const projected = _projectCertifiedSlot(slot, resourceId);
    if (!projected) return null;

    const finalServiceId = _safeTrim(serviceId) || projected.serviceId;
    if (!finalServiceId || !_looksLikeGuid(finalServiceId)) return null;

    let writerLocationType = _safeTrim(SDK_CONFIG?.LOCATION_TYPES?.BOOKINGS_WRITER);
    if (writerLocationType === "BUSINESS" || !writerLocationType) writerLocationType = "OWNER_BUSINESS";

    return {
        serviceId: finalServiceId,
        scheduleId: projected.scheduleId,
        startDate: projected.startDate,
        endDate: projected.endDate,
        timezone: projected.timezone,
        resource: {
            id: projected.resourceId,
        },
        location: {
            id: projected.locationId,
            locationType: writerLocationType,
        },
    };
}

// =============================================================================
// BLOQUE 19 - SLOTS DUALES OPTIMIZADOS CON CACHE PRE-WARM
// =============================================================================

export async function getCertifiedDualSlotsOptimized(serviceId, resourceId, dateYmd, addOnIds = []) {
    const traceId = makeTraceId("dual-opt");
    try {
        const reservasModule = await import("backend/reservas.web");

        const cached = await wixData
            .query(DUAL_CACHE_COL)
            .eq("controlType", CONTROL_TYPE.DUAL_CACHE)
            .eq("serviceId", serviceId)
            .eq("dateYmd", dateYmd)
            .eq("status", "ACTIVE")
            .gt("expiresAt", new Date())
            .limit(50)
            .find({ suppressAuth: true })
            .catch(() => ({ items: [] }));

        if (cached?.items?.length > 0 && resourceId) {
            const matchingPairs = cached.items.filter((p) => {
                const sameService = _safeTrim(p.serviceId) === _safeTrim(serviceId);
                const sameResource = _safeTrim(p.resourceId) === _safeTrim(resourceId);
                const isActive = _safeTrim(p.status).toUpperCase() === "ACTIVE";
                return sameService && sameResource && isActive;
            });
            if (matchingPairs.length > 0) {
                log.info("getCertifiedDualSlotsOptimized: cache hit", { serviceId, dateYmd, traceId });
                return {
                    status: "SUCCESS",
                    data: matchingPairs.map((p) => ({
                        fase1: { slotRef: p.slotF1, resourceId: p.resourceId },
                        fase2: { slotRef: p.slotF2, resourceId: p.resourceId },
                        pairToken: p.pairToken,
                        serviceId: p.serviceId,
                        linkedPhases: p.phase2ServiceId,
                        dateYmd: p.dateYmd,
                    })),
                    error: null,
                    cached: true,
                };
            }
        }

        return await reservasModule._getCertifiedDualSlotsInternal(serviceId, resourceId, dateYmd, addOnIds);
    } catch (err) {
        log.error("getCertifiedDualSlotsOptimized failed", { error: err?.message, traceId });
        return { status: "ERROR", data: null, error: { code: "DUAL_SLOTS_FAILED", message: err?.message } };
    }
}

// =============================================================================
// BLOQUE 20 - HELPERS ADICIONALES
// =============================================================================

export function _generatePairToken(traceId) {
    return "pt_" + _hashKey(traceId || makeTraceId("pair")).slice(0, 32);
}

export function _areSlotsCompatible(slot1, slot2, maxGapMinutes) {
    return _areSlotsContiguous(slot1, slot2, maxGapMinutes);
}

export function _auditBookingPrice(basePrice, addons) {
    const base = Number(basePrice) || 0;
    const addonsTotal = _sumAddons(addons);
    const totalPrice = base + addonsTotal;
    return {
        totalPrice,
        audit: {
            basePrice: base,
            addonsTotal,
            addonsCount: Array.isArray(addons) ? addons.length : 0,
        },
    };
}

// =============================================================================
// BLOQUE 21 - RANKING DE RECURSOS POR CARGA
// =============================================================================

export async function _rankResourcesByLoad(resourceIds, dateYmd, traceId) {
    const input = Array.isArray(resourceIds) ?
        Array.from(new Set(resourceIds.map((id) => _safeTrim(id)).filter(_looksLikeGuid))) : [];

    if (input.length < 2) return input;

    const day = _safeTrim(dateYmd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        log.warn("_rankResourcesByLoad: invalid dateYmd", { dateYmd: day, traceId });
        return input;
    }

    const loads = Object.fromEntries(input.map((id, index) => [id, {
        resourceId: id,
        load: 0,
        firstIndex: index,
    }]));

    try {
        const pageSize = 1000;
        let skip = 0;
        let hasMore = true;

        while (hasMore) {
            const result = await wixData
                .query(CITAS_COL)
                .eq("dateYmd", day)
                .in("resourceId", input)
                .limit(pageSize)
                .skip(skip)
                .find({ suppressAuth: true, consistentRead: true });

            const items = Array.isArray(result?.items) ? result.items : [];

            for (const item of items) {
                const resourceId = _safeTrim(item?.resourceId);
                if (!loads[resourceId]) continue;

                const status = String(item?.status || "").toUpperCase();
                const paymentStatus = String(item?.paymentStatus || "").toUpperCase();
                const cancelled = INACTIVE_BOOKING_STATUSES.indexOf(status) >= 0;
                const ignoredPayment = paymentStatus === "CANCELLED";

                if (!cancelled && !ignoredPayment) loads[resourceId].load += 1;
            }

            skip += items.length;
            hasMore = items.length === pageSize;
            if (!items.length) hasMore = false;
        }

        return Object.values(loads)
            .sort((a, b) => a.load - b.load || a.firstIndex - b.firstIndex)
            .map((entry) => entry.resourceId);
    } catch (error) {
        log.warn("_rankResourcesByLoad failed; preserving availability order", {
            traceId,
            dateYmd: day,
            error: error?.message,
        });
        return input;
    }
}
