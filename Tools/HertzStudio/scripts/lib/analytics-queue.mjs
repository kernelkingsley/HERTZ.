/**
 * Node twin of HertzAnalyticsPendingQueue — crash-safe durable analytics staging.
 * Fail-closed: never returns a fresh empty manifest when candidates exist but are corrupt.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_VERSION = 2;
export const UNRECOVERABLE = "manifest_unrecoverable";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function tryParseCandidate(filePath, source) {
  if (!fs.existsSync(filePath)) return { source, doc: null, mtime: 0 };
  try {
    const st = fs.statSync(filePath);
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!doc || doc.version < 1) return { source, doc: null, mtime: st.mtimeMs };
    if (!Array.isArray(doc.entries)) doc.entries = [];
    if (!Number.isFinite(doc.nextSequence) || doc.nextSequence < 1) doc.nextSequence = 1;
    return { source, doc, mtime: st.mtimeMs, nextSequence: doc.nextSequence, entryCount: doc.entries.length };
  } catch {
    return { source, doc: null, mtime: 0 };
  }
}

function pickBest(...cands) {
  let best = null;
  for (const c of cands) {
    if (!c?.doc) continue;
    if (!best) {
      best = c;
      continue;
    }
    if (c.nextSequence !== best.nextSequence) {
      if (c.nextSequence > best.nextSequence) best = c;
      continue;
    }
    if (c.entryCount !== best.entryCount) {
      if (c.entryCount > best.entryCount) best = c;
      continue;
    }
    if (c.mtime > best.mtime) best = c;
  }
  return best;
}

function normalizeSequences(doc) {
  const used = new Set();
  let max = 0;
  for (const e of doc.entries || []) {
    if (!e) continue;
    if (Number.isFinite(e.sequence) && e.sequence >= 1 && !used.has(e.sequence)) {
      used.add(e.sequence);
      if (e.sequence > max) max = e.sequence;
    } else {
      e.sequence = undefined;
    }
  }
  let next = max + 1;
  for (const e of doc.entries || []) {
    if (!e) continue;
    if (!Number.isFinite(e.sequence) || e.sequence < 1) {
      e.sequence = next++;
      used.add(e.sequence);
    }
  }
  doc.nextSequence = Math.max(doc.nextSequence || 1, next);
}

/**
 * @returns {{ ok:true, doc, recoveredFrom } | { ok:false, code, message, recoveredEmpty?: boolean }}
 */
export function loadManifestResult(root) {
  fs.mkdirSync(root, { recursive: true });
  const primaryPath = path.join(root, "manifest.json");
  const bakPath = primaryPath + ".bak";
  const tmpPath = primaryPath + ".tmp";

  const anyFile = fs.existsSync(primaryPath) || fs.existsSync(bakPath) || fs.existsSync(tmpPath);
  if (!anyFile) {
    return { ok: true, doc: { version: MANIFEST_VERSION, nextSequence: 1, entries: [] }, recoveredFrom: "empty" };
  }

  const primary = tryParseCandidate(primaryPath, "primary");
  const tmp = tryParseCandidate(tmpPath, "tmp");
  const bak = tryParseCandidate(bakPath, "bak");
  const best = pickBest(primary, tmp, bak);

  if (!best) {
    return {
      ok: false,
      code: UNRECOVERABLE,
      message: "all manifest candidates corrupt; refusing empty overwrite",
      doc: null,
    };
  }

  normalizeSequences(best.doc);

  // Promote recovered state to primary without clobbering a valid bak with invalid primary.
  if (best.source !== "primary") {
    try {
      if (!primary.doc && !fs.existsSync(primaryPath)) {
        saveManifestAtomic(root, best.doc);
      } else if (!primary.doc && fs.existsSync(primaryPath)) {
        // Corrupt primary: replace primary only; keep good bak.
        const json = JSON.stringify(best.doc, null, 2) + "\n";
        fs.writeFileSync(tmpPath, json);
        fs.unlinkSync(primaryPath);
        fs.renameSync(tmpPath, primaryPath);
      }
    } catch {
      /* non-fatal for read path */
    }
  }

  return { ok: true, doc: best.doc, recoveredFrom: best.source };
}

/** Back-compat: returns doc or throws / empty only when truly empty. Fail-closed on corrupt. */
export function loadManifest(root) {
  const r = loadManifestResult(root);
  if (!r.ok) {
    const err = new Error(r.message || r.code);
    err.code = r.code;
    throw err;
  }
  return r.doc;
}

export function saveManifestAtomic(root, doc) {
  fs.mkdirSync(root, { recursive: true });
  const primary = path.join(root, "manifest.json");
  const tmp = primary + ".tmp";
  const bak = primary + ".bak";
  normalizeSequences(doc);
  const json = JSON.stringify(doc, null, 2) + "\n";
  fs.writeFileSync(tmp, json, { encoding: "utf8", flag: "w" });
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(primary)) {
    const primaryOk = tryParseCandidate(primary, "primary").doc;
    if (primaryOk) {
      fs.copyFileSync(primary, bak);
    }
    // else: preserve last-known-good bak
    fs.renameSync(tmp, primary);
  } else {
    fs.renameSync(tmp, primary);
  }
}

export function stage(root, sourcePath, captureId) {
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, code: "missing_source" };
  }
  const id = String(captureId || crypto.randomUUID().replace(/-/g, ""));
  const capturesDir = path.join(root, "captures");
  fs.mkdirSync(capturesDir, { recursive: true });
  const bytes = fs.readFileSync(sourcePath);
  const hash = sha256Hex(bytes);
  const dest = path.join(capturesDir, `${id}.json`);
  const relative = `captures/${id}.json`;

  let doc;
  try {
    doc = loadManifest(root);
  } catch (e) {
    return { ok: false, code: e.code || UNRECOVERABLE, message: e.message };
  }

  const existing = (doc.entries || []).find((e) => e && e.captureId === id);
  if (existing) {
    if (
      String(existing.payloadSha256).toLowerCase() !== hash ||
      (Number.isFinite(existing.bytes) && existing.bytes !== bytes.length)
    ) {
      return { ok: false, code: "capture_id_content_conflict", captureId: id };
    }
    if (!fs.existsSync(dest)) {
      return { ok: false, code: "identical_retry_missing_payload", captureId: id };
    }
    const diskHash = sha256Hex(fs.readFileSync(dest));
    if (diskHash !== hash) {
      return { ok: false, code: "identical_retry_payload_tampered", captureId: id };
    }
    return { ok: true, captureId: id, filePath: dest, deduplicated: true, code: "deduplicated" };
  }
  if (fs.existsSync(dest)) {
    const diskHash = sha256Hex(fs.readFileSync(dest));
    if (diskHash !== hash) {
      return { ok: false, code: "capture_id_content_conflict", captureId: id };
    }
  } else {
    fs.writeFileSync(dest, bytes);
  }
  doc.entries = doc.entries || [];
  doc.entries.push({
    captureId: id,
    file: relative,
    status: "pending",
    createdAt: new Date().toISOString(),
    payloadSha256: hash,
    sequence: doc.nextSequence++,
    bytes: bytes.length,
  });
  try {
    saveManifestAtomic(root, doc);
  } catch (e) {
    return { ok: false, code: "manifest_write_failed", message: e.message };
  }
  return { ok: true, captureId: id, filePath: dest };
}

export function listPending(root) {
  let doc;
  try {
    doc = loadManifest(root);
  } catch {
    return [];
  }
  const pending = (doc.entries || []).filter((e) => e && e.status === "pending");
  pending.sort((a, b) => {
    const c = (a.sequence || 0) - (b.sequence || 0);
    return c !== 0 ? c : String(a.captureId).localeCompare(String(b.captureId));
  });
  const out = [];
  let dirty = false;
  for (const e of pending) {
    const full = path.isAbsolute(e.file) ? e.file : path.join(root, e.file);
    if (!fs.existsSync(full)) {
      e.status = "corrupt";
      e.lastError = "missing_payload";
      dirty = true;
      continue;
    }
    const disk = fs.readFileSync(full);
    if (Number.isFinite(e.bytes) && e.bytes !== disk.length) {
      e.status = "corrupt";
      e.lastError = "payload_length_mismatch";
      dirty = true;
      continue;
    }
    const diskHash = sha256Hex(disk);
    if (e.payloadSha256 && e.payloadSha256.toLowerCase() !== diskHash) {
      e.status = "corrupt";
      e.lastError = "payload_hash_mismatch";
      dirty = true;
      continue;
    }
    out.push({ captureId: e.captureId, filePath: full, status: e.status });
  }
  if (dirty) {
    try {
      saveManifestAtomic(root, doc);
    } catch {
      /* list still returns healthy */
    }
  }
  return out;
}

export function ack(root, captureId) {
  if (!captureId) return { ok: false, code: "missing_id" };
  let doc;
  try {
    doc = loadManifest(root);
  } catch (e) {
    return { ok: false, code: e.code || UNRECOVERABLE, message: e.message };
  }
  const entry = (doc.entries || []).find((e) => e && e.captureId === captureId);
  if (!entry) return { ok: false, code: "unknown_id" };
  if (entry.status === "delivered" || entry.status === "acked") {
    return { ok: true, deduplicated: true, code: "already_acked", status: entry.status };
  }
  if (entry.status === "corrupt") {
    return { ok: false, code: "corrupt_entry", message: entry.lastError };
  }
  const full = path.isAbsolute(entry.file) ? entry.file : path.join(root, entry.file);
  if (!fs.existsSync(full)) {
    entry.status = "corrupt";
    entry.lastError = "missing_payload";
    try {
      saveManifestAtomic(root, doc);
    } catch {
      /* */
    }
    return { ok: false, code: "corrupt_entry", message: "missing_payload" };
  }
  entry.status = "delivered";
  entry.lastError = null;
  try {
    saveManifestAtomic(root, doc);
  } catch (e) {
    return { ok: false, code: "manifest_write_failed", message: e.message };
  }
  return { ok: true, status: "delivered" };
}

export { sha256Hex };
