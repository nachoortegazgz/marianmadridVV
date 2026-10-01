/*
=============================================================================
MODULE: backend/security.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Motor de seguridad. Rate limiter con ventana deslizante,
verificacion de roles y bloqueo persistente cross-instancia.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: import COLLAB_ROLES -> COLLABORATOR_ROLES.
  - V20-02: usos de COLLAB_ROLES.ADMIN y COLLAB_ROLES.GESTION actualizados.
  - V20-03: NOTA DE AUDITORIA: el modulo lee MapaStaff.rol, .email y .active.
            Estos campos no estaban en el schema V20.1 original de MapaStaff.
            Se ampliara el schema (ver deltas al final).
=============================================================================
*/

import wixData from "wix-data";
import { currentMember } from "wix-members-backend";

import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONTROL_STATUS,

    SDK_CONFIG,
    COLLABORATOR_ROLES,
    STAFF_ACCESS,
} from "backend/internalConfig";

import { makeTraceId } from "public/mmUtils";
import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES
// =============================================================================

const RATE_LIMIT_CACHE = new Map();

const RATE_LIMIT_MAX_REQUESTS =
    Number(SDK_CONFIG?.RATE_LIMIT?.MAX_REQUESTS) || 20;

const RATE_LIMIT_WINDOW_MS =
    Number(SDK_CONFIG?.RATE_LIMIT?.WINDOW_MS) || 5000;

const RATE_LIMIT_CLEANUP_TTL_MS =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_CLEANUP_TTL_MS) || 60000;

const RATE_LIMIT_CACHE_MAX_ENTRIES =
    Number(SDK_CONFIG?.SECURITY?.RATE_LIMIT_CACHE_MAX_ENTRIES) || 5000;

const PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER = 3;
const PERSISTENT_BLOCK_DURATION_MS = 60 * 60 * 1000;

const GUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let lastCleanupTime = Date.now();

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

function _safeString(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value).trim();
}

function _isValidGuid(value) {
    return GUID_PATTERN.test(_safeString(value));
}

function _normalizeRateLimitPart(value, fallback = "unknown") {
    const normalized = _safeString(value);

    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 200);
}

function _buildRateLimitCacheKey(surface, key) {
    return `${_normalizeRateLimitPart(surface)}:${_normalizeRateLimitPart(key)}`;
}

function _buildPersistentBlockId(surface, key) {
    const raw = `${_normalizeRateLimitPart(surface)}_${_normalizeRateLimitPart(
    key
  )}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return `RL_${raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 190)}`;
}

function _cleanupRateLimitCache() {
    const now = Date.now();

    if (now - lastCleanupTime < RATE_LIMIT_CLEANUP_TTL_MS) {
        return;
    }

    lastCleanupTime = now;

    for (const [cacheKey, entry] of RATE_LIMIT_CACHE.entries()) {
        const windowStart = now - entry.windowMs;

        entry.timestamps = (entry.timestamps || []).filter(
            (timestamp) => timestamp > windowStart
        );

        const activeBlock =
            Number(entry.blockedUntil) > now && entry.blockedUntil !== null;

        if (entry.timestamps.length === 0 && !activeBlock) {
            RATE_LIMIT_CACHE.delete(cacheKey);
        }
    }

    if (RATE_LIMIT_CACHE.size <= RATE_LIMIT_CACHE_MAX_ENTRIES) {
        return;
    }

    const entriesToDelete =
        RATE_LIMIT_CACHE.size - RATE_LIMIT_CACHE_MAX_ENTRIES;

    let deleted = 0;

    for (const cacheKey of RATE_LIMIT_CACHE.keys()) {
        if (deleted >= entriesToDelete) {
            break;
        }

        RATE_LIMIT_CACHE.delete(cacheKey);
        deleted += 1;
    }
}

function _createAccessDeniedError(requiredRole) {
    const error = new Error(
        `ACCESS_DENIED: ${requiredRole} role required`
    );

    error.code = "ACCESS_DENIED";
    error.requiredRole = requiredRole;

    return error;
}

async function _queryActiveStaffByEmail(email, traceId) {
    const normalizedEmail = _safeString(email).toLowerCase();

    if (!normalizedEmail) {
        return null;
    }

    try {
        const result = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq("email", normalizedEmail)
            .eq("active", true)
            .limit(1)
            .find({ suppressAuth: true });

        return result?.items?.[0] || null;
    } catch (error) {
        log.error("Active staff lookup failed", {
            traceId,
            message: error?.message || String(error),
        });

        return null;
    }
}

// =============================================================================
// BLOQUE 3 - RATE LIMITER LOCAL
// =============================================================================

export function rateLimiter({ surface, key } = {},
    maxRequests = RATE_LIMIT_MAX_REQUESTS,
    windowMs = RATE_LIMIT_WINDOW_MS
) {
    _cleanupRateLimitCache();

    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    const max = Math.max(1, Number(maxRequests) || RATE_LIMIT_MAX_REQUESTS);
    const window = Math.max(1, Number(windowMs) || RATE_LIMIT_WINDOW_MS);

    const cacheKey = _buildRateLimitCacheKey(
        normalizedSurface,
        normalizedKey
    );

    const now = Date.now();

    let entry = RATE_LIMIT_CACHE.get(cacheKey);

    if (!entry) {
        entry = {
            timestamps: [],
            blockedUntil: null,
            persistentBlockTriggered: false,
            maxRequests: max,
            windowMs: window,
        };

        RATE_LIMIT_CACHE.set(cacheKey, entry);
    }

    entry.maxRequests = max;
    entry.windowMs = window;

    if (entry.blockedUntil && entry.blockedUntil > now) {
        return {
            allowed: false,
            retryAfter: Math.max(
                1,
                Math.ceil((entry.blockedUntil - now) / 1000)
            ),
            persistentBlock: true,
        };
    }

    if (entry.blockedUntil && entry.blockedUntil <= now) {
        entry.blockedUntil = null;
        entry.persistentBlockTriggered = false;
    }

    const windowStart = now - window;

    entry.timestamps = entry.timestamps.filter(
        (timestamp) => timestamp > windowStart
    );

    const persistentThreshold =
        max * PERSISTENT_BLOCK_THRESHOLD_MULTIPLIER;

    if (entry.timestamps.length >= persistentThreshold) {
        if (!entry.persistentBlockTriggered) {
            entry.persistentBlockTriggered = true;
            entry.blockedUntil = now + PERSISTENT_BLOCK_DURATION_MS;

            const traceId = makeTraceId("rl-block");

            registerPersistentBlock(
                normalizedSurface,
                normalizedKey,
                PERSISTENT_BLOCK_DURATION_MS,
                traceId
            ).catch((error) => {
                log.error("Persistent block registration failed", {
                    traceId,
                    message: error?.message || String(error),
                });
            });

            log.warn("Persistent rate limit block triggered", {
                surface: normalizedSurface,
                key: normalizedKey,
                requestsInWindow: entry.timestamps.length,
                threshold: persistentThreshold,
                durationMs: PERSISTENT_BLOCK_DURATION_MS,
                traceId,
            });
        }

        return {
            allowed: false,
            retryAfter: Math.max(
                1,
                Math.ceil((entry.blockedUntil - now) / 1000)
            ),
            persistentBlock: true,
        };
    }

    if (entry.timestamps.length >= max) {
        const oldestTimestamp = entry.timestamps[0] || now;
        const retryAfterMs = oldestTimestamp + window - now;

        return {
            allowed: false,
            retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
            persistentBlock: false,
        };
    }

    entry.timestamps.push(now);

    return {
        allowed: true,
        retryAfter: 0,
        persistentBlock: false,
    };
}

// =============================================================================
// BLOQUE 4 - BLOQUEO PERSISTENTE
// =============================================================================

export async function isKeyPersistentlyBlocked(surface, key) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);

    if (!normalizedSurface || !normalizedKey) {
        return false;
    }

    try {
        const result = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", `${normalizedSurface}|${normalizedKey}`)
            .gt("expiresAt", new Date())
            .limit(1)
            .find({ suppressAuth: true });

        return Array.isArray(result?.items) && result.items.length > 0;
    } catch (error) {
        log.error("Persistent block lookup failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
        });

        return false;
    }
}

export async function registerPersistentBlock(
    surface,
    key,
    durationMs,
    traceId = null
) {
    const normalizedSurface = _normalizeRateLimitPart(surface);
    const normalizedKey = _normalizeRateLimitPart(key);
    const safeDurationMs = Math.max(
        1000,
        Number(durationMs) || PERSISTENT_BLOCK_DURATION_MS
    );

    if (!normalizedSurface || !normalizedKey) {
        return {
            status: "ERROR",
            registered: false,
            reason: "INVALID_BLOCK_KEY",
        };
    }

    const expiresAt = new Date(Date.now() + safeDurationMs);
    const blockId = _buildPersistentBlockId(
        normalizedSurface,
        normalizedKey
    );

    try {
        const existing = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.RATE_LIMIT)
            .eq("dedupeKey", `${normalizedSurface}|${normalizedKey}`)
            .gt("expiresAt", new Date())
            .limit(1)
            .find({ suppressAuth: true });

        if (existing?.items?.length > 0) {
            return {
                status: "SUCCESS",
                registered: false,
                alreadyBlocked: true,
            };
        }

        await wixData.insert(
            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                controlType: CONTROL_TYPE.RATE_LIMIT,
                dedupeKey: `${normalizedSurface}|${normalizedKey}`,
                status: CONTROL_STATUS.BLOCKED,
                _id: blockId,
                traceId: traceId || `rate-${blockId}`,
                surface: normalizedSurface,
                requesterKey: normalizedKey,
                expiresAt,
            }, { suppressAuth: true }
        );

        log.warn("Persistent block registered", {
            surface: normalizedSurface,
            key: normalizedKey,
            durationMs: safeDurationMs,
            traceId,
        });

        return {
            status: "SUCCESS",
            registered: true,
            alreadyBlocked: false,
        };
    } catch (error) {
        log.error("Persistent block registration failed", {
            surface: normalizedSurface,
            message: error?.message || String(error),
            traceId,
        });

        return {
            status: "ERROR",
            registered: false,
            reason: "PERSISTENT_BLOCK_REGISTRATION_FAILED",
        };
    }
}

// =============================================================================
// BLOQUE 5 - IDENTIDAD DEL MIEMBRO
// =============================================================================

async function _getCurrentMemberInfo(traceId = null) {
    try {
        const member = await currentMember.getMember();

        if (!member) {
            return null;
        }

        const memberId = _safeString(member._id);
        const email = _safeString(
            member.loginEmail || member.contactDetails?.email
        ).toLowerCase();

        return {
            memberId,
            email,
        };
    } catch (error) {
        log.error("Current member lookup failed", {
            traceId,
            message: error?.message || String(error),
        });

        return null;
    }
}

// =============================================================================
// BLOQUE 6 - VERIFICACION DE ROLES
// =============================================================================

export async function isAdmin(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.email) {
        return false;
    }

    const staff = await _queryActiveStaffByEmail(
        memberInfo.email,
        traceId
    );

    return staff?.rol === COLLABORATOR_ROLES.ADMIN;
}

export async function isCajero(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.email) {
        return false;
    }

    const staff = await _queryActiveStaffByEmail(
        memberInfo.email,
        traceId
    );

    return (
        staff?.rol === COLLABORATOR_ROLES.ADMIN ||
        staff?.rol === COLLABORATOR_ROLES.GESTION
    );
}

export async function isStaffCollaborator(traceId = null) {
    const memberInfo = await _getCurrentMemberInfo(traceId);

    if (!memberInfo?.email) {
        return false;
    }

    const staff = await _queryActiveStaffByEmail(
        memberInfo.email,
        traceId
    );

    return STAFF_ACCESS.ALLOWED_ROLES.includes(staff?.rol);
}

// =============================================================================
// BLOQUE 7 - EXIGENCIA DE ROLES
// =============================================================================

export async function requireAdmin(traceId = null) {
    const authorized = await isAdmin(traceId);

    if (!authorized) {
        throw _createAccessDeniedError("ADMIN");
    }

    return true;
}

export async function requireCajero(traceId = null) {
    const authorized = await isCajero(traceId);

    if (!authorized) {
        throw _createAccessDeniedError("CAJERO");
    }

    return true;
}

export async function requireMarianManager(traceId = null) {
    const authorized = await isAdmin(traceId);

    if (!authorized) {
        throw _createAccessDeniedError("MARIAN_MANAGER");
    }

    return true;
}