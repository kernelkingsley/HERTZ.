/**
 * W07 Sound — durable slots, scene emitters, explicit footstep mappings, Unity sync jobs.
 * Material appearance alone must never change footstep logic (mappings are explicit only).
 */
import { createHash, randomUUID } from "node:crypto";
import { loadStore, saveStore } from "./store.mjs";
import { getAsset, listAssets } from "./assets/catalog.mjs";

export const SOUND_SCHEMA_VERSION = 1;

export const SLOT_CATEGORIES = Object.freeze([
  "weapon",
  "enemy",
  "character",
  "ambience",
  "footstep",
]);

/** Slot keys allowed per category. */
export const SLOT_KEYS = Object.freeze({
  weapon: ["shot", "reload"],
  enemy: ["idle", "attack", "hit", "defeat"],
  character: ["generic"],
  ambience: ["loop"],
  footstep: ["step"],
});

const SYNC_STATES = new Set([
  "not_synced",
  "queued",
  "applying",
  "applied",
  "failed",
  "conflict",
  "stale",
  "disconnected",
]);

const AUDIO_EXTS = new Set([".wav", ".ogg", ".mp3", ".aiff", ".aif"]);

function ensureSoundStore(store) {
  if (!store.sound) {
    store.sound = {
      schemaVersion: SOUND_SCHEMA_VERSION,
      slots: [],
      emitters: [],
      footstepMappings: [],
      jobs: [],
      mappings: {},
      lastSyncedAt: null,
      sync: { state: "not_synced", lastError: null, lastRequestId: null, payloadHash: null },
    };
  }
  const s = store.sound;
  if (!Array.isArray(s.slots)) s.slots = [];
  if (!Array.isArray(s.emitters)) s.emitters = [];
  if (!Array.isArray(s.footstepMappings)) s.footstepMappings = [];
  if (!Array.isArray(s.jobs)) s.jobs = [];
  if (!s.mappings || typeof s.mappings !== "object") s.mappings = {};
  if (!s.sync) s.sync = { state: "not_synced", lastError: null, lastRequestId: null, payloadHash: null };
  // Authoritative monotonic sequence: unique assignments; nextJobSequence > every assigned.
  const used = new Set();
  let maxSeq = 0;
  for (const j of s.jobs) {
    if (!j) continue;
    if (Number.isFinite(j.sequence) && j.sequence >= 1 && !used.has(j.sequence)) {
      used.add(j.sequence);
      if (j.sequence > maxSeq) maxSeq = j.sequence;
    } else if (Number.isFinite(j.sequence) && used.has(j.sequence)) {
      // Duplicate sequence from mixed legacy/current stores — force reassignment.
      j.sequence = undefined;
    } else {
      j.sequence = undefined;
    }
  }
  let next = maxSeq + 1;
  for (const j of s.jobs) {
    if (!j) continue;
    if (!Number.isFinite(j.sequence) || j.sequence < 1) {
      j.sequence = next++;
      used.add(j.sequence);
    }
  }
  s.nextJobSequence = next;
  return store;
}

export function validateAudioAssetId(audioAssetId, { requireReady = false } = {}) {
  if (audioAssetId === null || audioAssetId === undefined || audioAssetId === "") return null;
  const id = String(audioAssetId).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    const err = new Error("audioAssetId must be a UUID.");
    err.code = "invalid_audio";
    throw err;
  }
  const asset = getAsset(id);
  if (!asset) {
    const err = new Error("audioAssetId not found in asset library.");
    err.code = "invalid_audio";
    throw err;
  }
  if (asset.assetType !== "audio") {
    const err = new Error(`audioAssetId type must be audio (got ${asset.assetType}).`);
    err.code = "invalid_audio";
    throw err;
  }
  if (asset.state === "unsupported" || asset.unity?.readiness === "unsupported") {
    const err = new Error("audioAssetId is not Unity-importable / unsupported format.");
    err.code = "unsupported_audio";
    throw err;
  }
  if (requireReady) {
    const ready = asset.state === "unity_imported" || asset.unity?.readiness === "ready";
    if (!ready) {
      const err = new Error("audioAssetId is not imported/ready in Unity yet.");
      err.code = "invalid_audio";
      throw err;
    }
  }
  return id;
}

function publicAudioRef(audioAssetId) {
  if (!audioAssetId) return null;
  const asset = getAsset(audioAssetId);
  if (!asset) {
    return { id: audioAssetId, missing: true, unsupported: false };
  }
  const unsupported =
    asset.state === "unsupported" ||
    asset.unity?.readiness === "unsupported" ||
    (asset.fileFormat && !AUDIO_EXTS.has(`.${String(asset.fileFormat).replace(/^\./, "").toLowerCase()}`));
  return {
    id: asset.id,
    name: asset.name || asset.originalName || asset.id,
    provider: asset.provider || null,
    license: asset.license || null,
    packName: asset.packName || null,
    fileFormat: asset.fileFormat || null,
    previewUrl: asset.preview?.url || null,
    unsupported: Boolean(unsupported),
    unityClipPath: asset.unity?.clipPath || null,
    state: asset.state || null,
  };
}

function clamp01(n, fallback = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

function clampDistance(n, fallback, min = 0.01, max = 500) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export function listAudioLibrary({ q = "", provider = "" } = {}) {
  const rows = listAssets({ type: "audio", q, provider: provider || undefined, pageSize: 100 });
  return {
    assets: (rows.assets || []).map((a) => ({
      ...a,
      unsupported: a.state === "unsupported" || a.unity?.readiness === "unsupported",
    })),
    total: rows.total ?? (rows.assets || []).length,
    note: "Kenney Audio packs import via Find Assets / Asset Library. Material appearance does not change footstep mappings.",
  };
}

export function getSoundBoard() {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  return {
    schemaVersion: SOUND_SCHEMA_VERSION,
    slotCategories: SLOT_CATEGORIES,
    slotKeys: SLOT_KEYS,
    slots: sound.slots.map(publicSlot),
    emitters: sound.emitters.map(publicEmitter),
    footstepMappings: sound.footstepMappings.map(publicFootstep),
    sync: { ...sound.sync },
    lastSyncedAt: sound.lastSyncedAt,
    comfortDefaults: {
      maxAuditionVolume: 0.85,
      defaultSpatialBlend: 1,
      defaultMaxDistance: 25,
      note: "VR comfort: keep sudden peaks muted; spatial defaults on for world emitters; single Studio audition at a time.",
    },
    rules: {
      footstepRequiresExplicitMapping: true,
      materialAppearanceDoesNotChangeFootsteps: true,
      singleAuditionPlayback: true,
    },
  };
}

function publicSlot(slot) {
  return {
    id: slot.id,
    category: slot.category,
    slotKey: slot.slotKey,
    targetId: slot.targetId || null,
    label: slot.label || `${slot.category}:${slot.slotKey}`,
    audioAssetId: slot.audioAssetId || null,
    audio: publicAudioRef(slot.audioAssetId),
    updatedAt: slot.updatedAt || null,
  };
}

function publicEmitter(em) {
  return {
    id: em.id,
    name: em.name,
    scenePath: em.scenePath || "Assets/Scenes/HertzSoundTest.unity",
    position: em.position || { x: 0, y: 0, z: 0 },
    volume: em.volume,
    loop: Boolean(em.loop),
    spatialBlend: em.spatialBlend,
    minDistance: em.minDistance,
    maxDistance: em.maxDistance,
    audioAssetId: em.audioAssetId || null,
    audio: publicAudioRef(em.audioAssetId),
    updatedAt: em.updatedAt || null,
  };
}

function publicFootstep(m) {
  return {
    id: m.id,
    surfaceId: m.surfaceId,
    surfaceLabel: m.surfaceLabel || m.surfaceId,
    audioAssetId: m.audioAssetId || null,
    audio: publicAudioRef(m.audioAssetId),
    note: "Explicit mapping only — changing a material/appearance does not alter this association.",
    updatedAt: m.updatedAt || null,
  };
}

function assertSlotShape(category, slotKey) {
  if (!SLOT_CATEGORIES.includes(category)) {
    const err = new Error(`Invalid slot category: ${category}`);
    err.code = "invalid_slot";
    throw err;
  }
  const keys = SLOT_KEYS[category] || [];
  if (!keys.includes(slotKey)) {
    const err = new Error(`Invalid slotKey '${slotKey}' for category '${category}'. Allowed: ${keys.join(", ")}`);
    err.code = "invalid_slot";
    throw err;
  }
}

export function upsertSlot(body = {}) {
  const category = String(body.category || "").trim();
  const slotKey = String(body.slotKey || "").trim();
  assertSlotShape(category, slotKey);
  const targetId = body.targetId != null && body.targetId !== "" ? String(body.targetId).trim().slice(0, 80) : null;
  const audioAssetId =
    body.audioAssetId === null || body.audioAssetId === ""
      ? null
      : validateAudioAssetId(body.audioAssetId);

  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  let slot = sound.slots.find(
    (s) => s.category === category && s.slotKey === slotKey && (s.targetId || null) === targetId,
  );
  const now = new Date().toISOString();
  if (!slot) {
    slot = {
      id: randomUUID(),
      category,
      slotKey,
      targetId,
      label: body.label ? String(body.label).slice(0, 80) : `${category}:${slotKey}`,
      audioAssetId,
      updatedAt: now,
    };
    sound.slots.push(slot);
  } else {
    if (body.label != null) slot.label = String(body.label).slice(0, 80);
    slot.audioAssetId = audioAssetId;
    slot.updatedAt = now;
  }
  markSoundStale(sound);
  saveStore(store);
  return publicSlot(slot);
}

export function clearSlot(slotId) {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const idx = sound.slots.findIndex((s) => s.id === slotId);
  if (idx < 0) {
    const err = new Error("Slot not found");
    err.code = "not_found";
    throw err;
  }
  sound.slots[idx].audioAssetId = null;
  sound.slots[idx].updatedAt = new Date().toISOString();
  markSoundStale(sound);
  saveStore(store);
  return publicSlot(sound.slots[idx]);
}

export function upsertEmitter(body = {}) {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const now = new Date().toISOString();
  const audioAssetId =
    body.audioAssetId === null || body.audioAssetId === ""
      ? null
      : validateAudioAssetId(body.audioAssetId);
  const pos = body.position || {};
  let em = body.id ? sound.emitters.find((e) => e.id === body.id) : null;
  if (!em) {
    em = {
      id: randomUUID(),
      name: String(body.name || "Emitter").slice(0, 80),
      scenePath: String(body.scenePath || "Assets/Scenes/HertzSoundTest.unity").slice(0, 200),
      position: {
        x: Number.isFinite(Number(pos.x)) ? Number(pos.x) : 0,
        y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : 0,
        z: Number.isFinite(Number(pos.z)) ? Number(pos.z) : 0,
      },
      volume: clamp01(body.volume, 0.7),
      loop: body.loop !== false,
      spatialBlend: clamp01(body.spatialBlend, 1),
      minDistance: clampDistance(body.minDistance, 1),
      maxDistance: clampDistance(body.maxDistance, 25),
      audioAssetId,
      updatedAt: now,
    };
    sound.emitters.push(em);
  } else {
    if (body.name != null) em.name = String(body.name).slice(0, 80);
    if (body.scenePath != null) em.scenePath = String(body.scenePath).slice(0, 200);
    if (body.position) {
      em.position = {
        x: Number.isFinite(Number(pos.x)) ? Number(pos.x) : em.position.x,
        y: Number.isFinite(Number(pos.y)) ? Number(pos.y) : em.position.y,
        z: Number.isFinite(Number(pos.z)) ? Number(pos.z) : em.position.z,
      };
    }
    if (body.volume != null) em.volume = clamp01(body.volume, em.volume);
    if (body.loop != null) em.loop = Boolean(body.loop);
    if (body.spatialBlend != null) em.spatialBlend = clamp01(body.spatialBlend, em.spatialBlend);
    if (body.minDistance != null) em.minDistance = clampDistance(body.minDistance, em.minDistance);
    if (body.maxDistance != null) em.maxDistance = clampDistance(body.maxDistance, em.maxDistance);
    if (body.audioAssetId !== undefined) em.audioAssetId = audioAssetId;
    em.updatedAt = now;
  }
  markSoundStale(sound);
  saveStore(store);
  return publicEmitter(em);
}

export function deleteEmitter(emitterId, { force = false } = {}) {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const em = sound.emitters.find((e) => e.id === emitterId);
  if (!em) {
    const err = new Error("Emitter not found");
    err.code = "not_found";
    throw err;
  }
  if (em.audioAssetId && !force) {
    const deps = collectAudioUsages(em.audioAssetId);
    if (deps.total > 1) {
      const err = new Error("Emitter clip is used elsewhere. Unassign other usages or pass force.");
      err.code = "dependency_blocked";
      err.dependencies = deps;
      throw err;
    }
  }
  sound.emitters = sound.emitters.filter((e) => e.id !== emitterId);
  markSoundStale(sound);
  saveStore(store);
  return { ok: true, deleted: emitterId };
}

export function upsertFootstepMapping(body = {}) {
  const surfaceId = String(body.surfaceId || "").trim().slice(0, 80);
  if (!surfaceId) {
    const err = new Error("surfaceId required (explicit footstep surface key)");
    err.code = "invalid_footstep";
    throw err;
  }
  // Reject silent material→sound coupling: clients must send surfaceId intentionally.
  if (body.materialGuid || body.materialAppearance || body.autoFromMaterial) {
    const err = new Error(
      "Footstep mappings are explicit only. materialGuid/materialAppearance/autoFromMaterial are rejected.",
    );
    err.code = "footstep_auto_forbidden";
    throw err;
  }
  const audioAssetId =
    body.audioAssetId === null || body.audioAssetId === ""
      ? null
      : validateAudioAssetId(body.audioAssetId);

  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const now = new Date().toISOString();
  let row = sound.footstepMappings.find((m) => m.surfaceId === surfaceId);
  if (!row) {
    row = {
      id: randomUUID(),
      surfaceId,
      surfaceLabel: String(body.surfaceLabel || surfaceId).slice(0, 80),
      audioAssetId,
      updatedAt: now,
    };
    sound.footstepMappings.push(row);
  } else {
    if (body.surfaceLabel != null) row.surfaceLabel = String(body.surfaceLabel).slice(0, 80);
    row.audioAssetId = audioAssetId;
    row.updatedAt = now;
  }
  markSoundStale(sound);
  saveStore(store);
  return publicFootstep(row);
}

export function deleteFootstepMapping(mappingId) {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const before = sound.footstepMappings.length;
  sound.footstepMappings = sound.footstepMappings.filter((m) => m.id !== mappingId);
  if (sound.footstepMappings.length === before) {
    const err = new Error("Footstep mapping not found");
    err.code = "not_found";
    throw err;
  }
  markSoundStale(sound);
  saveStore(store);
  return { ok: true, deleted: mappingId };
}

export function collectAudioUsages(audioAssetId) {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const slots = sound.slots.filter((s) => s.audioAssetId === audioAssetId).map((s) => ({
    kind: "slot",
    id: s.id,
    label: s.label || `${s.category}:${s.slotKey}`,
  }));
  const emitters = sound.emitters.filter((e) => e.audioAssetId === audioAssetId).map((e) => ({
    kind: "emitter",
    id: e.id,
    label: e.name,
  }));
  const footsteps = sound.footstepMappings
    .filter((m) => m.audioAssetId === audioAssetId)
    .map((m) => ({ kind: "footstep", id: m.id, label: m.surfaceLabel || m.surfaceId }));
  return {
    audioAssetId,
    slots,
    emitters,
    footsteps,
    total: slots.length + emitters.length + footsteps.length,
  };
}

/** Block clearing/removing a clip while other usages remain (unless force). */
export function unassignAudio(audioAssetId, { force = false } = {}) {
  const deps = collectAudioUsages(audioAssetId);
  if (deps.total === 0) {
    return { ok: true, cleared: 0, dependencies: deps };
  }
  if (!force && deps.total > 0) {
    // Caller asked to remove usages — clearing all is allowed when intentional via force.
    // Without force, return blocked so UI can show usages.
    const err = new Error(`Audio is assigned in ${deps.total} place(s). Unassign slots/emitters/footsteps first or pass force.`);
    err.code = "dependency_blocked";
    err.dependencies = deps;
    throw err;
  }
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  let cleared = 0;
  for (const s of sound.slots) {
    if (s.audioAssetId === audioAssetId) {
      s.audioAssetId = null;
      s.updatedAt = new Date().toISOString();
      cleared += 1;
    }
  }
  for (const e of sound.emitters) {
    if (e.audioAssetId === audioAssetId) {
      e.audioAssetId = null;
      e.updatedAt = new Date().toISOString();
      cleared += 1;
    }
  }
  for (const m of sound.footstepMappings) {
    if (m.audioAssetId === audioAssetId) {
      m.audioAssetId = null;
      m.updatedAt = new Date().toISOString();
      cleared += 1;
    }
  }
  markSoundStale(sound);
  saveStore(store);
  return { ok: true, cleared, dependencies: collectAudioUsages(audioAssetId) };
}

function markSoundStale(sound) {
  if (sound.sync?.state === "applied") {
    sound.sync.state = "stale";
  }
}

export function canonicalSoundPayload(sound) {
  const payload = {
    emitters: (sound.emitters || [])
      .map((e) => ({
        audioAssetId: e.audioAssetId || null,
        id: e.id,
        loop: Boolean(e.loop),
        maxDistance: Number(e.maxDistance),
        minDistance: Number(e.minDistance),
        name: e.name,
        position: e.position,
        scenePath: e.scenePath,
        spatialBlend: Number(e.spatialBlend),
        volume: Number(e.volume),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    footstepMappings: (sound.footstepMappings || [])
      .map((m) => ({
        audioAssetId: m.audioAssetId || null,
        surfaceId: m.surfaceId,
        surfaceLabel: m.surfaceLabel || m.surfaceId,
      }))
      .sort((a, b) => a.surfaceId.localeCompare(b.surfaceId)),
    schemaVersion: SOUND_SCHEMA_VERSION,
    slots: (sound.slots || [])
      .map((s) => ({
        audioAssetId: s.audioAssetId || null,
        category: s.category,
        slotKey: s.slotKey,
        targetId: s.targetId || null,
      }))
      .sort((a, b) => `${a.category}:${a.slotKey}:${a.targetId || ""}`.localeCompare(`${b.category}:${b.slotKey}:${b.targetId || ""}`)),
  };
  return JSON.stringify(payload);
}

export function soundPayloadHash(sound) {
  return createHash("sha256").update(canonicalSoundPayload(sound), "utf8").digest("hex");
}

export function buildSoundSyncPayload() {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  // Validate assigned clips exist (ready preferred but allow not-yet-imported for Editor resolve).
  for (const s of sound.slots) {
    if (s.audioAssetId) validateAudioAssetId(s.audioAssetId);
  }
  for (const e of sound.emitters) {
    if (e.audioAssetId) validateAudioAssetId(e.audioAssetId);
  }
  for (const m of sound.footstepMappings) {
    if (m.audioAssetId) validateAudioAssetId(m.audioAssetId);
  }

  const resolveClip = (id) => {
    if (!id) return null;
    const a = getAsset(id);
    return a
      ? {
          assetId: a.id,
          name: a.name || a.originalName || a.id,
          provider: a.provider || null,
          license: a.license || null,
          clipPath: a.unity?.clipPath || null,
          fileFormat: a.fileFormat || null,
        }
      : { assetId: id, missing: true };
  };

  const hash = soundPayloadHash(sound);
  return {
    type: "sync_sound_board",
    schemaVersion: SOUND_SCHEMA_VERSION,
    payloadHash: hash,
    slots: sound.slots.map((s) => ({
      id: s.id,
      category: s.category,
      slotKey: s.slotKey,
      targetId: s.targetId || null,
      label: s.label,
      clip: resolveClip(s.audioAssetId),
    })),
    emitters: sound.emitters.map((e) => ({
      id: e.id,
      name: e.name,
      scenePath: e.scenePath,
      position: e.position,
      volume: e.volume,
      loop: e.loop,
      spatialBlend: e.spatialBlend,
      minDistance: e.minDistance,
      maxDistance: e.maxDistance,
      clip: resolveClip(e.audioAssetId),
    })),
    footstepMappings: sound.footstepMappings.map((m) => ({
      id: m.id,
      surfaceId: m.surfaceId,
      surfaceLabel: m.surfaceLabel,
      clip: resolveClip(m.audioAssetId),
    })),
    rules: {
      materialAppearanceDoesNotChangeFootsteps: true,
      footstepRequiresExplicitMapping: true,
    },
  };
}

export function enqueueSoundSync(requestId) {
  if (!requestId) {
    const err = new Error("requestId required");
    err.code = "invalid_request";
    throw err;
  }
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  const payload = buildSoundSyncPayload();
  const existing = sound.jobs.find((j) => j.requestId === requestId);
  if (existing) {
    // Identical canonical payload/hash under the same requestId is idempotent.
    if (existing.payloadHash === payload.payloadHash) {
      return existing;
    }
    const err = new Error(
      `requestId '${requestId}' already queued with a different payload hash.`,
    );
    err.code = "request_id_conflict";
    err.existingPayloadHash = existing.payloadHash;
    err.attemptedPayloadHash = payload.payloadHash;
    err.existingJob = existing;
    throw err;
  }
  const sequence = sound.nextJobSequence++;
  const job = {
    id: randomUUID(),
    requestId,
    type: "sync_sound_board",
    status: "pending_unity",
    createdAt: new Date().toISOString(),
    sequence,
    payload,
    payloadHash: payload.payloadHash,
  };
  sound.jobs.push(job);
  sound.sync = {
    state: "queued",
    lastError: null,
    lastRequestId: requestId,
    payloadHash: payload.payloadHash,
  };
  saveStore(store);
  return job;
}

export function nextSoundJob() {
  const store = ensureSoundStore(loadStore());
  return (
    store.sound.jobs.find((j) => j.status === "pending_unity" || j.status === "applying") || null
  );
}

export function getSoundJob(id) {
  const store = ensureSoundStore(loadStore());
  return store.sound.jobs.find((j) => j.id === id || j.requestId === id) || null;
}

export function markSoundJobApplying(jobId) {
  const store = ensureSoundStore(loadStore());
  const job = store.sound.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  job.status = "applying";
  store.sound.sync.state = "applying";
  saveStore(store);
  return job;
}

export function acknowledgeSoundSync({
  requestId,
  ok,
  error,
  conflict,
  assetGuid,
  assetPath,
  observedPayloadHash,
  unityRevision,
} = {}) {
  const store = ensureSoundStore(loadStore());
  const sound = store.sound;
  if (!requestId) {
    const err = new Error("requestId required for sound acknowledgement.");
    err.code = "missing_request_id";
    throw err;
  }
  const job = sound.jobs.find((j) => j.requestId === requestId);
  if (!job) {
    const err = new Error(`Unknown sound sync requestId '${requestId}'.`);
    err.code = "unknown_request";
    throw err;
  }

  // Any newer job (pending, applying, applied, failed, rejected, superseded) blocks older ack.
  // Authoritative ordering is monotonic sequence (not timestamp-only — same-ms safe).
  const jobSeq = Number.isFinite(job.sequence) ? job.sequence : -1;
  const newer = sound.jobs.find(
    (j) => j.id !== job.id && Number.isFinite(j.sequence) && j.sequence > jobSeq,
  );
  if (newer) {
    // Do not mutate an already-terminal older job beyond marking superseded when still open.
    if (job.status === "pending_unity" || job.status === "applying") {
      job.status = "superseded";
      job.error = `Superseded by requestId ${newer.requestId} (status=${newer.status})`;
    }
    // Preserve the newer job's authoritative global sync/mappings byte-for-byte.
    // Stale-attempt diagnostics live separately and must not replace terminal state.
    if (!sound.staleAckAttempts) sound.staleAckAttempts = [];
    sound.staleAckAttempts.push({
      at: new Date().toISOString(),
      staleRequestId: requestId,
      newerRequestId: newer.requestId,
      newerStatus: newer.status,
      newerSequence: newer.sequence ?? null,
    });
    if (sound.staleAckAttempts.length > 50) {
      sound.staleAckAttempts = sound.staleAckAttempts.slice(-50);
    }
    saveStore(store);
    return {
      ok: false,
      code: "stale_acknowledgement",
      status: 409,
      job,
      newerJob: { requestId: newer.requestId, status: newer.status, id: newer.id, sequence: newer.sequence },
      sync: sound.sync,
    };
  }

  if (job.status === "applied" && sound.sync?.lastRequestId === requestId) {
    // Idempotent retry of an already-applied ack with matching hash.
    if (
      observedPayloadHash &&
      observedPayloadHash === job.payloadHash &&
      sound.sync.payloadHash === job.payloadHash
    ) {
      return { ok: true, deduplicated: true, job, sync: sound.sync };
    }
  }

  if (ok && !conflict) {
    if (!observedPayloadHash || typeof observedPayloadHash !== "string") {
      job.status = "failed";
      job.error = "observedPayloadHash required for successful acknowledgement.";
      sound.sync = {
        state: "failed",
        lastError: job.error,
        lastRequestId: requestId,
        payloadHash: job.payloadHash,
        code: "missing_payload_hash",
      };
      saveStore(store);
      return { ok: false, code: "missing_payload_hash", status: 400, job, sync: sound.sync };
    }
    if (observedPayloadHash !== job.payloadHash) {
      job.status = "failed";
      job.error = "observedPayloadHash does not match queued job payloadHash.";
      sound.sync = {
        state: "failed",
        lastError: job.error,
        lastRequestId: requestId,
        payloadHash: job.payloadHash,
        observedPayloadHash,
        code: "payload_hash_mismatch",
      };
      saveStore(store);
      return { ok: false, code: "payload_hash_mismatch", status: 409, job, sync: sound.sync };
    }

    job.status = "applied";
    job.appliedAt = new Date().toISOString();
    sound.sync = {
      state: "applied",
      lastError: null,
      lastRequestId: requestId,
      payloadHash: job.payloadHash,
      observedPayloadHash,
      assetGuid: assetGuid || null,
      assetPath: assetPath || null,
      unityRevision: unityRevision ?? null,
    };
    sound.lastSyncedAt = job.appliedAt;
    sound.mappings.board = {
      assetGuid: assetGuid || null,
      assetPath: assetPath || null,
      payloadHash: job.payloadHash,
      unityRevision: unityRevision ?? null,
      updatedAt: job.appliedAt,
    };
  } else {
    job.status = conflict ? "conflict" : "failed";
    job.error = error || (conflict ? "conflict" : "failed");
    sound.sync = {
      state: conflict ? "conflict" : "failed",
      lastError: job.error,
      lastRequestId: requestId,
      payloadHash: job.payloadHash,
    };
  }
  saveStore(store);
  return { ok: Boolean(ok) && !conflict && job.status === "applied", job, sync: sound.sync };
}

export function recoverSoundJobsOnBoot() {
  const store = ensureSoundStore(loadStore());
  let recovered = 0;
  for (const job of store.sound.jobs) {
    if (job.status === "applying") {
      job.status = "pending_unity";
      recovered += 1;
    }
  }
  if (recovered) saveStore(store);
  return { recovered };
}
