/*
=============================================================================
MODULE: backend/staff.js
VERSION: v5009-FISCAL-V20.1
BASE: v5007.4-FINAL + Directriz V20 (IDs nativa en ingles)
RESPONSIBILITY: Catalogo de personal activo con indices de busqueda y cache
                en memoria con TTL configurable.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. Los campos de MapaStaff usados
            por este modulo (displayName, resourceId, email, staffMemberId,
            scheduleId, locationId, rol, phone, active, notes) estan todos
            contemplados en el schema V20.1-EXPANDED.
=============================================================================
*/

import wixData from "wix-data";

import {
    BUSINESS_COLLECTIONS,

    SDK_CONFIG,
    STAFF_DEFAULT_NAME,
} from "backend/internalConfig";

import {
    _safeTrim,
    _looksLikeGuid,
} from "public/mmUtils";

import { logger } from "backend/logger";

const log = logger;

const STAFF_CACHE_TTL_MS =
    Number(SDK_CONFIG?.CACHE?.STAFF_TTL_MS) || 300000;

const STAFF_QUERY_PAGE_SIZE = 100;

let staffCache = null;

// =============================================================================
// BLOQUE 1 - HELPERS INTERNOS
// =============================================================================

function _emptyCatalog() {
    return {
        all: [],
        byResourceId: new Map(),
        byEmail: new Map(),
        byScheduleId: new Map(),
        byId: new Map(),
    };
}

function _normalizeText(value) {
    return _safeTrim(value);
}

function _normalizeEmail(value) {
    return _normalizeText(value).toLowerCase();
}

function _createStaffRecord(item) {
    return {
        _id: _normalizeText(item?._id),
        displayName: _normalizeText(item?.displayName),
        resourceId: _normalizeText(item?.resourceId),
        email: _normalizeEmail(item?.email),
        staffMemberId: _normalizeText(item?.staffMemberId),
        scheduleId: _normalizeText(item?.scheduleId),
        locationId: _normalizeText(item?.locationId),
        rol: _normalizeText(item?.rol),
        phone: _normalizeText(item?.phone),
        active: item?.active === true,
        notes: _normalizeText(item?.notes),
    };
}

function _addToIndex(index, key, record) {
    if (!key || index.has(key)) {
        return;
    }

    index.set(key, record);
}

function _buildCatalog(items) {
    const catalog = _emptyCatalog();

    for (const item of items) {
        const record = _createStaffRecord(item);

        if (!record._id && !record.resourceId && !record.email) {
            continue;
        }

        catalog.all.push(record);

        _addToIndex(
            catalog.byResourceId,
            record.resourceId,
            record
        );

        _addToIndex(
            catalog.byEmail,
            record.email,
            record
        );

        _addToIndex(
            catalog.byScheduleId,
            record.scheduleId,
            record
        );

        _addToIndex(
            catalog.byId,
            record._id,
            record
        );
    }

    return catalog;
}

async function _queryAllActiveStaff() {
    const items = [];

    let result = await wixData
        .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
        .eq("active", true)
        .limit(STAFF_QUERY_PAGE_SIZE)
        .find({ suppressAuth: true });

    items.push(...(result?.items || []));

    while (result?.hasNext?.()) {
        result = await result.next();
        items.push(...(result?.items || []));
    }

    return items;
}

// =============================================================================
// BLOQUE 2 - CACHE
// =============================================================================

export function clearStaffCache() {
    staffCache = null;
}

async function _loadStaffCatalog() {
    const now = Date.now();

    if (
        staffCache &&
        now - staffCache.timestamp < STAFF_CACHE_TTL_MS
    ) {
        return staffCache.data;
    }

    try {
        const items = await _queryAllActiveStaff();
        const catalog = _buildCatalog(items);

        staffCache = {
            data: catalog,
            timestamp: now,
        };

        return catalog;
    } catch (error) {
        log.error("_loadStaffCatalog failed", {
            message: error?.message || String(error),
        });

        if (staffCache?.data) {
            return staffCache.data;
        }

        return _emptyCatalog();
    }
}

// =============================================================================
// BLOQUE 3 - BUSQUEDA
// =============================================================================

export async function getAllStaff() {
    const catalog = await _loadStaffCatalog();
    return Array.isArray(catalog.all) ? catalog.all : [];
}

export async function findStaff(identifier) {
    const raw = _normalizeText(identifier);

    if (!raw) {
        return null;
    }

    const catalog = await _loadStaffCatalog();

    if (_looksLikeGuid(raw)) {
        const byResourceId = catalog.byResourceId.get(raw);

        if (byResourceId) {
            return byResourceId;
        }

        const byScheduleId = catalog.byScheduleId.get(raw);

        if (byScheduleId) {
            return byScheduleId;
        }

        const byId = catalog.byId.get(raw);

        if (byId) {
            return byId;
        }
    }

    const byEmail = catalog.byEmail.get(raw.toLowerCase());

    if (byEmail) {
        return byEmail;
    }

    const normalizedName = raw.toLowerCase();

    return (
        catalog.all.find(
            (record) =>
            record.displayName.toLowerCase() === normalizedName
        ) || null
    );
}

export async function findStaffByResourceId(resourceId) {
    const raw = _normalizeText(resourceId);

    if (!raw || !_looksLikeGuid(raw)) {
        return null;
    }

    const catalog = await _loadStaffCatalog();

    return catalog.byResourceId.get(raw) || null;
}

// =============================================================================
// BLOQUE 4 - DATOS DERIVADOS
// =============================================================================

export async function getStaffDisplayName(resourceId) {
    const staff = await findStaffByResourceId(resourceId);

    if (staff?.displayName) {
        return staff.displayName;
    }

    return STAFF_DEFAULT_NAME;
}

export async function getStaffScheduleId(resourceId) {
    const staff = await findStaffByResourceId(resourceId);

    return staff?.scheduleId || null;
}

export async function getStaffResourceIdByEmail(email) {
    const normalizedEmail = _normalizeEmail(email);

    if (!normalizedEmail) {
        return null;
    }

    const staff = await findStaff(normalizedEmail);

    return staff?.resourceId || null;
}

export async function isActiveStaff(resourceId) {
    const staff = await findStaffByResourceId(resourceId);

    return staff?.active === true;
}

export async function getAllActiveResourceIds() {
    const catalog = await _loadStaffCatalog();

    return Array.from(
        new Set(
            catalog.all
            .filter((staff) => staff.active === true)
            .map((staff) => staff.resourceId)
            .filter((resourceId) => _looksLikeGuid(resourceId))
        )
    );
}