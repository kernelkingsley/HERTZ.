/**
 * Fresh scene-export handshake helpers (W03 Priority 2 #8 fidelity).
 * Sync must not complete on a cached schema-2 export that predates the request.
 */

import { randomUUID } from "node:crypto";

export const REQUIRED_EXPORT_SCHEMA = 3;

/**
 * Capture baseline snapshot fields before requesting a fresh export.
 * @param {object | null | undefined} lastSceneExport
 * @param {object | null | undefined} project
 */
export function captureExportBaseline(lastSceneExport, project = {}) {
  const exp = lastSceneExport && typeof lastSceneExport === "object" ? lastSceneExport : {};
  return {
    exportedAt: exp.exportedAt || null,
    contentFingerprint: exp.contentFingerprint || null,
    unityRevision: Number.isFinite(Number(exp.unityRevision))
      ? Number(exp.unityRevision)
      : Number.isFinite(Number(project.unityRevision))
        ? Number(project.unityRevision)
        : null,
    exportGeneration: Number.isFinite(Number(exp.exportGeneration)) ? Number(exp.exportGeneration) : 0,
    importGeneration: Number.isFinite(Number(exp.importGeneration)) ? Number(exp.importGeneration) : 0,
    scenePath: exp.scenePath || project.scenePath || null,
  };
}

/**
 * Build a pending force-export request with a unique request ID.
 * @param {string} reason
 * @param {ReturnType<typeof captureExportBaseline>} baseline
 * @param {{ now?: () => string, requestId?: string }} [opts]
 */
export function createForceExportRequest(reason, baseline, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now() : new Date().toISOString();
  return {
    requestId: opts.requestId || randomUUID(),
    reason: String(reason || "owner_sync"),
    requestedAt: now,
    baseline: {
      exportedAt: baseline?.exportedAt ?? null,
      contentFingerprint: baseline?.contentFingerprint ?? null,
      unityRevision: baseline?.unityRevision ?? null,
      exportGeneration: Number(baseline?.exportGeneration) || 0,
      importGeneration: Number(baseline?.importGeneration) || 0,
      scenePath: baseline?.scenePath ?? null,
    },
  };
}

/**
 * Whether an imported snapshot satisfies a pending force-export request.
 * @param {object | null} pending
 * @param {object | null} snapshot
 * @param {{ importedAt?: string, importGeneration?: number }} [meta]
 */
export function exportSatisfiesForceRequest(pending, snapshot, meta = {}) {
  if (!pending?.requestId) return { ok: false, reason: "no_pending" };
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "no_snapshot" };

  const ackId =
    snapshot.forceExportRequestId ||
    snapshot.exportRequestId ||
    meta.forceExportRequestId ||
    null;
  if (!ackId || ackId !== pending.requestId) {
    return { ok: false, reason: "request_id_mismatch" };
  }

  const requiredScene = pending.baseline?.scenePath || null;
  const snapScene = snapshot.scenePath || null;
  if (requiredScene && snapScene && requiredScene !== snapScene) {
    return { ok: false, reason: "scene_mismatch" };
  }

  const schema = Number(snapshot.exportSchemaVersion) || 0;
  if (schema < REQUIRED_EXPORT_SCHEMA) {
    return { ok: false, reason: "schema_too_old" };
  }

  const baselineGen = Number(pending.baseline?.importGeneration) || 0;
  const nextGen = Number(meta.importGeneration);
  if (!Number.isFinite(nextGen) || nextGen <= baselineGen) {
    return { ok: false, reason: "generation_not_newer" };
  }

  const requestedAt = pending.requestedAt ? Date.parse(pending.requestedAt) : NaN;
  const importedAt = meta.importedAt ? Date.parse(meta.importedAt) : Date.now();
  if (Number.isFinite(requestedAt) && Number.isFinite(importedAt) && importedAt < requestedAt) {
    return { ok: false, reason: "imported_before_request" };
  }

  return { ok: true, reason: null };
}

/**
 * Whether the cached lastSceneExport is a completed match for the pending request.
 * Used by Sync waiters — must not accept any schema-2 cache.
 */
export function cachedExportMatchesForceRequest(pending, lastSceneExport) {
  if (!pending?.requestId || !lastSceneExport) return false;
  const ackId = lastSceneExport.forceExportRequestId || lastSceneExport.exportRequestId || null;
  if (ackId !== pending.requestId) return false;
  const schema = Number(lastSceneExport.exportSchemaVersion) || 0;
  if (schema < REQUIRED_EXPORT_SCHEMA) return false;
  const baselineGen = Number(pending.baseline?.importGeneration) || 0;
  const gen = Number(lastSceneExport.importGeneration) || 0;
  if (gen <= baselineGen) return false;
  const requiredScene = pending.baseline?.scenePath || null;
  if (requiredScene && lastSceneExport.scenePath && requiredScene !== lastSceneExport.scenePath) {
    return false;
  }
  const requestedAt = pending.requestedAt ? Date.parse(pending.requestedAt) : NaN;
  const importedAt = lastSceneExport.exportedAt ? Date.parse(lastSceneExport.exportedAt) : NaN;
  if (Number.isFinite(requestedAt) && Number.isFinite(importedAt) && importedAt < requestedAt) {
    return false;
  }
  return true;
}
