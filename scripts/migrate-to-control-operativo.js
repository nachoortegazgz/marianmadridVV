/**
 * migrate-to-control-operativo.js
 * SSOT v7.0 FASE 3 (ADR-05): migracion de las 8 colecciones operativas
 * absorbidas a ControlOperativo con discriminador controlType + dedupeKey.
 *
 * USO (con acceso CMS, fuera de sandbox):
 *   node scripts/migrate-to-control-operativo.js --dry-run
 *   node scripts/migrate-to-control-operativo.js --apply
 *
 * Estrategia:
 *  - Read-all paginado por coleccion legacy -> transform -> insert en ControlOperativo.
 *  - Idempotencia garantizada por dedupeKey unico (verificacion previa por query).
 *  - NO elimina las colecciones origen hasta verificacion 1:1 (paso manual posterior).
 *  - WEBHOOK_EVENT se marca append-only: sin expiresAt (retencion indefinida).
 *
 * G10 ASCII strict. Sin console.log: usa logger canónico si existe, fallback stderr.
 */

import { createRequire } from "module";

const DRY_RUN = !process.argv.includes("--apply");

// Mapeo coleccion legacy -> { controlType, dedupeFn, statusMap, ttlMs }
const MIGRATIONS = [
  {
    source: "SlotLocks",
    controlType: "SLOT_LOCK",
    dedupeFn: (r) => `SLOT:${r.resourceId || r.slotResourceId}:${r.dateYmd || r.date}:${r.hour || r.slotHour}`,
    statusMap: { LOCKED: "ACTIVE", RELEASED: "CLOSED", EXPIRED: "EXPIRED" },
    ttlMs: 15 * 60 * 1000,
  },
  {
    source: "ProcessedWebhookEvents",
    controlType: "WEBHOOK_EVENT",
    dedupeFn: (r) => `WH:${r.eventType || r.topic}:${r.externalEventId || r.eventId}`,
    statusMap: { PROCESSED: "EXECUTED", FAILED: "FAILED" },
    ttlMs: null, // append-only, sin expiracion
  },
  {
    source: "RateLimitCounters",
    controlType: "RATE_LIMIT",
    dedupeFn: (r) => `RL:${r.surface}:${r.key || r.identityHash}`,
    statusMap: { ACTIVE: "ACTIVE", BLOCKED: "BLOCKED" },
    ttlMs: 60 * 60 * 1000,
  },
  {
    source: "BookingTransactions",
    controlType: "BOOKING_TX",
    dedupeFn: (r) => `TX:${r.transactionId || r.txId}`,
    statusMap: { PENDING: "PENDING", COMMITTED: "EXECUTED", ROLLEDBACK: "CANCELLED", FAILED: "FAILED" },
    ttlMs: 24 * 60 * 60 * 1000,
  },
  {
    source: "Compensaciones",
    controlType: "COMPENSATION",
    dedupeFn: (r) => `CMP:${r.transactionId || r.txId}:${r.stepIndex ?? 0}`,
    statusMap: { PENDING: "PENDING", DONE: "EXECUTED", FAILED: "FAILED" },
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  },
  {
    source: "AlertasSistema",
    controlType: "ALERT",
    dedupeFn: (r) => `ALR:${r.alertType || r.severity}:${r.dedupe || r.createdAt}`,
    statusMap: { OPEN: "ACTIVE", ACK: "CLOSED", RESOLVED: "CLOSED" },
    ttlMs: 30 * 24 * 60 * 60 * 1000,
  },
  {
    source: "DaysCache",
    controlType: "DAYS_CACHE",
    dedupeFn: (r) => `DAYC:${r.serviceId || r.slug}:${r.dateYmd}`,
    statusMap: { FRESH: "ACTIVE", STALE: "EXPIRED" },
    ttlMs: 24 * 60 * 60 * 1000,
  },
  {
    source: "DualCache",
    controlType: "DUAL_CACHE",
    dedupeFn: (r) => `DUALC:${r.bookingId || r.pairToken}`,
    statusMap: { ACTIVE: "ACTIVE", INVALIDATED: "EXPIRED" },
    ttlMs: 24 * 60 * 60 * 1000,
  },
];

function _toIso(dateOrMs) {
  if (dateOrMs == null) return undefined;
  const ms = typeof dateOrMs === "number" ? dateOrMs : Date.parse(dateOrMs);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function transformRecord(raw, plan) {
  const status = plan.statusMap[raw.status] || raw.status || "ACTIVE";
  const rec = {
    controlType: plan.controlType,
    dedupeKey: plan.dedupeFn(raw),
    status,
    traceId: raw.traceId || undefined,
    payload: (() => {
      const { _id, ownerId, createdTime, updatedTime, status: _s, traceId: _t, ...rest } = raw;
      return rest;
    })(),
  };
  if (plan.ttlMs != null) {
    const base = Date.parse(raw.updatedTime || raw.createdTime || "") || Date.now();
    rec.expiresAt = new Date(base + plan.ttlMs).toISOString();
  }
  return rec;
}

async function run() {
  // El acceso real a la CMS requiere entorno Wix (sandbox local no tiene red).
  // Este script se ejecuta con: wix dev / entorno backend con sdk-data disponible.
  let sdkData;
  try {
    const require = createRequire(import.meta.url);
    sdkData = require("@wix/data");
  } catch (_e) {
    process.stderr.write(
      "[migrate] ERROR: @wix/data no disponible en este entorno. Ejecutar dentro de runtime Wix (backend/ext). Modo documentado: ASUNCION ADR-05.\n"
    );
    process.exit(2);
  }

  const items = sdkData.items;
  let totalRead = 0;
  let totalWritten = 0;

  for (const plan of MIGRATIONS) {
    let offset = 0;
    const LIMIT = 100;
    for (;;) {
      const resp = await items.query(plan.source)
        .limit(LIMIT).offset(offset)
        .find();
      const chunk = resp.items || [];
      if (!chunk.length) break;
      totalRead += chunk.length;
      for (const raw of chunk) {
        const rec = transformRecord(raw, plan);
        const exists = await items.query("ControlOperativo")
          .eq("dedupeKey", rec.dedupeKey).limit(1).find();
        if ((exists.items || []).length > 0) continue; // idempotente
        if (!DRY_RUN) {
          await items.insert("ControlOperativo", rec);
          totalWritten++;
        }
      }
      offset += LIMIT;
    }
    process.stderr.write(`[migrate] ${plan.source} -> ControlOperativo/${plan.controlType}: leidos acumulados=${totalRead}\n`);
  }

  process.stderr.write(
    `[migrate] FINALIZADO (${DRY_RUN ? "DRY-RUN" : "APPLY"}): lecturas=${totalRead} escrituras=${totalWritten}. ` +
    "Verificar conteo 1:1 antes de retirar colecciones origen.\n"
  );
}

run().catch((err) => {
  process.stderr.write(`[migrate] FALLO: ${err && err.message}\n`);
  process.exit(1);
});

export { MIGRATIONS, transformRecord, _toIso };
