/**
 * W11 Snapshots — Unity/project-enumerated capture; no caller-supplied file contents.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadStore, saveStore } from "./store.mjs";
import { postUnityBridge } from "./unityBridgeClient.mjs";
import { assertDedicatedStudioScene, isSampleScenePath, canonicalizeSceneAssetPath } from "./sceneIdentity.mjs";

const DATA_ROOT = process.env.HERTZ_STUDIO_DATA || path.resolve("data");
const SNAP_ROOT = path.join(DATA_ROOT, "snapshots");

const EXCLUDED_NAME_RE =
  /(^|\/)(library|temp|obj|logs?|node_modules|secrets|\.git)(\/|$)/i;

function ensure(store) {
  if (!store.snapshots) store.snapshots = { index: [], restoreJobs: [] };
  if (!Array.isArray(store.snapshots.index)) store.snapshots.index = [];
  if (!Array.isArray(store.snapshots.restoreJobs)) store.snapshots.restoreJobs = [];
  return store;
}

function blobDir() {
  const d = path.join(SNAP_ROOT, "blobs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function assertAllowedProjectPath(p) {
  const c = String(p || "").replace(/\\/g, "/");
  if (!c || c.includes("\0") || c.includes("..")) {
    const err = new Error(`Refusing path: ${p}`);
    err.code = "excluded_path";
    throw err;
  }
  if (EXCLUDED_NAME_RE.test(c)) {
    const err = new Error(`Refusing excluded path: ${p}`);
    err.code = "excluded_path";
    throw err;
  }
  if (isSampleScenePath(c) || /samplescene\.unity/i.test(path.posix.basename(c))) {
    const err = new Error("SampleScene cannot be snapshotted or restored.");
    err.code = "excluded_path";
    throw err;
  }
  const canon = canonicalizeSceneAssetPath(c);
  if (c.toLowerCase().startsWith("assets/") || canon) {
    return c.startsWith("Assets/") || c.startsWith("assets/") ? c : canon || c;
  }
  // Allow Studio-owned data profiles under Tools/HertzStudio/data owned trees only via Unity enum.
  if (!c.toLowerCase().startsWith("assets/")) {
    const err = new Error(`Snapshot path must be under Assets/ (got ${p})`);
    err.code = "excluded_path";
    throw err;
  }
  return c;
}

export async function createNamedSnapshot(body = {}) {
  const store = ensure(loadStore());
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) {
    const err = new Error("Snapshot name required.");
    err.code = "invalid_request";
    throw err;
  }
  if (Array.isArray(body.entries) && body.entries.length) {
    const err = new Error(
      "Caller-supplied snapshot entries/content are rejected. Unity enumerates selected project entities.",
    );
    err.code = "caller_content_rejected";
    throw err;
  }

  const scenePath = body.scenePath ? assertDedicatedStudioScene(body.scenePath) : null;
  const bridge = await postUnityBridge(
    "/snapshots/capture",
    {
      name,
      scenePath,
      includeMaterials: body.includeMaterials !== false,
      includePrefabs: body.includePrefabs !== false,
      includeProfiles: body.includeProfiles !== false,
      selection: body.selection || null,
    },
    { timeoutMs: 120000 },
  );
  if (!bridge.ok) {
    const err = new Error(bridge.error || "Unity snapshot capture failed.");
    err.code = bridge.status === 0 ? "unity_offline" : "unity_capture_failed";
    throw err;
  }
  const data = bridge.data || {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    const err = new Error("Unity returned empty snapshot selection.");
    err.code = "empty_snapshot";
    throw err;
  }

  const manifestEntries = [];
  for (const e of entries) {
    const p = assertAllowedProjectPath(e.path);
    const hash = String(e.hash || "");
    const bytes = Number(e.bytes) || 0;
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      const err = new Error(`Entry missing sha256 hash: ${p}`);
      err.code = "invalid_entry_hash";
      throw err;
    }
    // Prefer Unity-provided blob staging path if present; else require contentBase64 from bridge only.
    if (e.blobPath && fs.existsSync(e.blobPath)) {
      const disk = fs.readFileSync(e.blobPath);
      const diskHash = createHash("sha256").update(disk).digest("hex");
      if (diskHash !== hash) {
        const err = new Error(`Blob hash mismatch for ${p}`);
        err.code = "blob_hash_mismatch";
        throw err;
      }
      const dest = path.join(blobDir(), hash);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, disk);
    } else if (typeof e.contentBase64 === "string") {
      const buf = Buffer.from(e.contentBase64, "base64");
      const diskHash = createHash("sha256").update(buf).digest("hex");
      if (diskHash !== hash) {
        const err = new Error(`Blob hash mismatch for ${p}`);
        err.code = "blob_hash_mismatch";
        throw err;
      }
      const dest = path.join(blobDir(), hash);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    } else {
      const err = new Error(`Missing blob bytes for ${p}`);
      err.code = "missing_blob";
      throw err;
    }
    manifestEntries.push({
      path: p,
      hash,
      bytes,
      kind: e.kind || "asset",
      metaGuid: e.metaGuid || null,
    });
  }

  const manifestHash = createHash("sha256")
    .update(JSON.stringify(manifestEntries), "utf8")
    .digest("hex");
  const id = randomUUID();
  const record = {
    id,
    name,
    createdAt: new Date().toISOString(),
    manifestHash,
    entryCount: manifestEntries.length,
    totalBytes: manifestEntries.reduce((s, e) => s + e.bytes, 0),
    backedUp: false,
    scenePath,
    sceneGuid: data.sceneGuid || null,
    unityRevision: data.unityRevision ?? null,
    source: "unity_bridge",
  };
  fs.mkdirSync(path.join(SNAP_ROOT, id), { recursive: true });
  const manifestBody = { schemaVersion: 1, ...record, entries: manifestEntries };
  fs.writeFileSync(path.join(SNAP_ROOT, id, "manifest.json"), JSON.stringify(manifestBody, null, 2), "utf8");
  store.snapshots.index.unshift(record);
  store.snapshots.index = store.snapshots.index.slice(0, 100);
  saveStore(store);
  return record;
}

export function listSnapshots({ q = "" } = {}) {
  const store = ensure(loadStore());
  let list = store.snapshots.index;
  if (q) {
    const n = q.toLowerCase();
    list = list.filter((s) => s.name.toLowerCase().includes(n) || s.id.includes(n));
  }
  let totalBytes = 0;
  for (const s of list) totalBytes += s.totalBytes || 0;
  return {
    snapshots: list,
    storageRoot: "Tools/HertzStudio/data/snapshots (outside Assets)",
    retention: { maxSnapshots: 100, totalBytes },
  };
}

function loadAndVerifyManifest(id) {
  const p = path.join(SNAP_ROOT, id, "manifest.json");
  if (!fs.existsSync(p)) {
    const err = new Error(`Snapshot ${id} not found or incomplete.`);
    err.code = "missing_snapshot";
    throw err;
  }
  const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
  if (manifest.schemaVersion !== 1) {
    const err = new Error("Unsupported snapshot schema.");
    err.code = "bad_schema";
    throw err;
  }
  const entries = manifest.entries || [];
  const recomputed = createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
  if (recomputed !== manifest.manifestHash) {
    const err = new Error("Manifest hash mismatch — snapshot corrupt.");
    err.code = "corrupt_manifest";
    throw err;
  }
  for (const e of entries) {
    assertAllowedProjectPath(e.path);
    const blob = path.join(blobDir(), e.hash);
    if (!fs.existsSync(blob)) {
      const err = new Error(`Corrupt snapshot: missing blob ${e.hash}`);
      err.code = "corrupt_snapshot";
      throw err;
    }
    const diskHash = createHash("sha256").update(fs.readFileSync(blob)).digest("hex");
    if (diskHash !== e.hash) {
      const err = new Error(`Corrupt blob hash for ${e.path}`);
      err.code = "corrupt_blob";
      throw err;
    }
    const size = fs.statSync(blob).size;
    if (e.bytes != null && Number(e.bytes) !== size) {
      const err = new Error(`Corrupt blob size for ${e.path}`);
      err.code = "corrupt_blob";
      throw err;
    }
  }
  return manifest;
}

export function diffSnapshots(aId, bId) {
  const a = loadAndVerifyManifest(aId);
  const b = loadAndVerifyManifest(bId);
  const mapA = new Map((a.entries || []).map((e) => [e.path, e]));
  const mapB = new Map((b.entries || []).map((e) => [e.path, e]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [p, e] of mapB) {
    if (!mapA.has(p)) added.push(p);
    else if (mapA.get(p).hash !== e.hash) changed.push(p);
  }
  for (const p of mapA.keys()) {
    if (!mapB.has(p)) removed.push(p);
  }
  return {
    a: { id: aId, manifestHash: a.manifestHash },
    b: { id: bId, manifestHash: b.manifestHash },
    added,
    removed,
    changed,
  };
}

export function planRestoreSnapshot(snapshotId, { confirm = false, requestId = null } = {}) {
  const manifest = loadAndVerifyManifest(snapshotId);
  const steps = (manifest.entries || []).map((e) => ({
    path: e.path,
    hash: e.hash,
    action: "staged_write",
  }));
  return {
    ok: true,
    snapshotId,
    requestId: requestId || null,
    manifestHash: manifest.manifestHash,
    entryCount: steps.length,
    steps,
    requiresConfirm: !confirm,
    note: confirm
      ? "Restore plan accepted for staged Unity apply (offline queue supported). SampleScene never targeted."
      : "Pass confirm:true after reviewing diff. Creates pre-restore safety snapshot first.",
  };
}

export async function enqueueRestoreSnapshot(snapshotId, body = {}) {
  if (body.confirm !== true) {
    const err = new Error("confirm:true required to enqueue restore.");
    err.code = "confirm_required";
    throw err;
  }
  const requestId = String(body.requestId || "").trim();
  if (!requestId) {
    const err = new Error("requestId required and bound to snapshot+payload.");
    err.code = "invalid_request";
    throw err;
  }
  const plan = planRestoreSnapshot(snapshotId, { confirm: true, requestId });
  const store = ensure(loadStore());
  const existing = store.snapshots.restoreJobs.find((j) => j.requestId === requestId);
  if (existing) {
    if (existing.snapshotId !== snapshotId || existing.manifestHash !== plan.manifestHash) {
      const err = new Error("requestId reused with different snapshot payload.");
      err.code = "request_conflict";
      throw err;
    }
    return { deduplicated: true, job: existing };
  }
  const job = {
    id: randomUUID(),
    requestId,
    snapshotId,
    manifestHash: plan.manifestHash,
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    preRestoreSafetySnapshotId: null,
  };
  // Ask Unity to create safety snapshot + stage restore (or queue if offline).
  const bridge = await postUnityBridge(
    "/snapshots/restore",
    {
      snapshotId,
      requestId,
      manifestHash: plan.manifestHash,
      manifestPath: path.join(SNAP_ROOT, snapshotId, "manifest.json").replace(/\\/g, "/"),
      blobRoot: blobDir().replace(/\\/g, "/"),
    },
    { timeoutMs: 120000 },
  );
  if (!bridge.ok && bridge.status !== 0) {
    const err = new Error(bridge.error || "Unity restore rejected.");
    err.code = bridge.data?.code || "unity_restore_failed";
    throw err;
  }
  if (bridge.status === 0) {
    job.status = "queued_offline";
    job.note = "Unity offline — restore will execute exactly once on reconnect.";
  } else {
    job.status = bridge.data?.status || "staging";
    job.preRestoreSafetySnapshotId = bridge.data?.safetySnapshotId || null;
    job.unityAck = bridge.data || null;
  }
  store.snapshots.restoreJobs.unshift(job);
  store.snapshots.restoreJobs = store.snapshots.restoreJobs.slice(0, 100);
  saveStore(store);
  return { deduplicated: false, job };
}
