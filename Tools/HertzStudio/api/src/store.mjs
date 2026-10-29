import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, createHash, timingSafeEqual } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  advanceTransformBaselineAfterApply,
  buildApplyOperations,
  captureUnityTransformBaseline,
} from "./draft-commands.mjs";
import { validateDraftScene } from "./walkability.mjs";
import { normalizeHeadsetConnection, sanitizeHeadsetReport } from "./headset.mjs";
import { canonicalizeSceneAssetPath, scenePathsEqual } from "./sceneIdentity.mjs";
import {
  cachedExportMatchesForceRequest,
  captureExportBaseline,
  createForceExportRequest,
  exportSatisfiesForceRequest,
  REQUIRED_EXPORT_SCHEMA,
} from "./fresh-export.mjs";

export {
  cachedExportMatchesForceRequest,
  captureExportBaseline,
  createForceExportRequest,
  exportSatisfiesForceRequest,
  REQUIRED_EXPORT_SCHEMA,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.HERTZ_STUDIO_DATA
  ? path.resolve(process.env.HERTZ_STUDIO_DATA)
  : path.resolve(__dirname, "../../data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const STORE_GOOD_PATH = path.join(DATA_DIR, "store.json.good");
export const CONNECTOR_STALE_MS = Number(process.env.HERTZ_CONNECTOR_STALE_MS || 15000);

/** @type {null | { recoveredAt: string, reason: string, corruptBackup?: string, restoredFrom?: string | null, emptyReset?: boolean }} */
let lastStoreRecovery = null;

export function getStoreRecovery() {
  return lastStoreRecovery;
}

export function clearStoreRecoveryFlag() {
  lastStoreRecovery = null;
  if (fs.existsSync(STORE_PATH)) {
    try {
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      if (store.storeRecovery) {
        delete store.storeRecovery;
        atomicWrite(STORE_PATH, store);
        atomicWrite(STORE_GOOD_PATH, store);
      }
    } catch {
      // Ignore; next load will re-evaluate.
    }
  }
}

/**
 * Require objectId + finite numeric position axes before persisting or queueing.
 * @returns {string | null} error message, or null when valid
 */
export function validateDraftObjects(objects) {
  if (!Array.isArray(objects)) return "objects array required";
  for (let i = 0; i < objects.length; i += 1) {
    const obj = objects[i];
    if (!obj || typeof obj !== "object") {
      return `objects[${i}] must be an object`;
    }
    if (typeof obj.objectId !== "string" || obj.objectId.length === 0) {
      return `objects[${i}].objectId must be a non-empty string`;
    }
    const pos = obj.position;
    if (!pos || typeof pos !== "object" || Array.isArray(pos)) {
      return `objects[${i}].position must be an object`;
    }
    for (const axis of ["x", "y", "z"]) {
      const value = pos[axis];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `objects[${i}].position.${axis} must be a finite number`;
      }
    }
  }
  return null;
}

function defaultStore() {
  return {
    version: 1,
    owner: {
      username: "kingsley",
      passwordHash: null,
      passwordSalt: null,
    },
    sessions: {},
    project: {
      id: "hertz-main",
      name: "HERTZ",
      description: "Town spirits, frequency flip, dual pistols after the flip.",
      productionUrl: "https://studio.hertz.software",
      lastSceneSyncAt: null,
      unityRevision: 0,
      unityConnected: false,
      connectorLastSeenAt: null,
      scenePath: null,
      studioTargetScene: null,
      unityScenes: [],
      unityScenesUpdatedAt: null,
      lastSceneExport: null,
    },
    drafts: {},
    queue: [],
    results: [],
    pairing: {
      code: null,
      codeExpiresAt: null,
      connectorTokenHash: null,
      bridgeTokenHash: null,
      connectorId: null,
      pairedAt: null,
    },
    connections: {
      sketchfab: { status: "not_configured" },
      unity: { status: "disconnected" },
      headset: sanitizeHeadsetReport({}, new Date(0).toISOString()),
      deploy: {
        status: "pending",
        domain: "hertz.software",
        hostname: "studio.hertz.software",
        registrar: "Name.com",
        hostProvider: null,
      },
    },
    audit: [],
  };
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "secrets"), { recursive: true });
}

/**
 * Crash-safe write. On Windows, rename-over-existing often fails with EPERM and left
 * orphaned `*.tmp` files; replace via copy+unlink when rename cannot replace, and always
 * remove the temp in `finally`.
 */
export function atomicWrite(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    try {
      fs.renameSync(tmp, filePath);
    } catch (err) {
      if (err.code === "EPERM" || err.code === "EEXIST" || err.code === "EACCES") {
        fs.copyFileSync(tmp, filePath);
        try {
          const outFd = fs.openSync(filePath, "r+");
          try {
            fs.fsyncSync(outFd);
          } finally {
            fs.closeSync(outFd);
          }
        } catch {
          /* best-effort fsync */
        }
      } else {
        throw err;
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Remove abandoned `store.json.good.*.tmp` / `store.json.*.tmp` left by failed promotions. */
export function cleanupAbandonedStoreTemps(dataDir = DATA_DIR) {
  let removed = 0;
  if (!fs.existsSync(dataDir)) return removed;
  for (const name of fs.readdirSync(dataDir)) {
    if (!/\.tmp$/i.test(name)) continue;
    if (!/^store\.json(\.good)?\./i.test(name) && !/^assets-catalog\.json(\.good)?\./i.test(name)) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(dataDir, name));
      removed += 1;
    } catch {
      /* ignore locked */
    }
  }
  return removed;
}

function tryParseStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return { store: JSON.parse(raw), raw };
  } catch {
    return { store: null, raw };
  }
}

function markRecovered(store, recovery) {
  lastStoreRecovery = recovery;
  store.storeRecovery = recovery;
  store.audit = Array.isArray(store.audit) ? store.audit : [];
  store.audit.push({
    at: recovery.recoveredAt,
    action: "store_recovery",
    ...recovery,
  });
  return store;
}

export function loadStore() {
  ensureDirs();
  const primary = tryParseStoreFile(STORE_PATH);
  if (primary?.store) {
    if (primary.store.storeRecovery) {
      lastStoreRecovery = primary.store.storeRecovery;
    }
    return primary.store;
  }

  if (primary?.raw != null) {
    const backup = `${STORE_PATH}.corrupt.${Date.now()}.bak`;
    fs.writeFileSync(backup, primary.raw);
    const good = tryParseStoreFile(STORE_GOOD_PATH);
    if (good?.store) {
      const recovered = markRecovered(good.store, {
        recoveredAt: new Date().toISOString(),
        reason: "primary_store_corrupt",
        corruptBackup: path.basename(backup),
        restoredFrom: "store.json.good",
        emptyReset: false,
      });
      atomicWrite(STORE_PATH, recovered);
      console.error(
        `HERTZ store.json corrupt; restored last-known-good from store.json.good (backup ${path.basename(backup)}).`,
      );
      return recovered;
    }

    const fresh = markRecovered(defaultStore(), {
      recoveredAt: new Date().toISOString(),
      reason: "primary_corrupt_no_good_generation",
      corruptBackup: path.basename(backup),
      restoredFrom: null,
      emptyReset: true,
    });
    atomicWrite(STORE_PATH, fresh);
    atomicWrite(STORE_GOOD_PATH, fresh);
    console.error(
      `HERTZ store.json corrupt and no store.json.good; empty reset after backup ${path.basename(backup)}.`,
    );
    return fresh;
  }

  const goodOnly = tryParseStoreFile(STORE_GOOD_PATH);
  if (goodOnly?.store) {
    const recovered = markRecovered(goodOnly.store, {
      recoveredAt: new Date().toISOString(),
      reason: "primary_missing_restored_good",
      restoredFrom: "store.json.good",
      emptyReset: false,
    });
    atomicWrite(STORE_PATH, recovered);
    return recovered;
  }

  const fresh = defaultStore();
  atomicWrite(STORE_PATH, fresh);
  atomicWrite(STORE_GOOD_PATH, fresh);
  return fresh;
}

export function saveStore(store) {
  ensureDirs();
  cleanupAbandonedStoreTemps();
  atomicWrite(STORE_PATH, store);
  // Promote a verified primary write to last-known-good for crash recovery.
  // Windows EPERM must not turn a committed primary into an ambiguous failure.
  try {
    atomicWrite(STORE_GOOD_PATH, store);
    if (store.storeRecovery?.goodPromotionFailedAt) {
      delete store.storeRecovery.goodPromotionFailedAt;
      delete store.storeRecovery.goodPromotionError;
      delete store.storeRecovery.goodPromotionDegraded;
    }
  } catch (err) {
    console.error(`HERTZ store.json.good promotion failed: ${err.code || ""} ${err.message}`);
    store.storeRecovery = {
      ...(store.storeRecovery || {}),
      goodPromotionFailedAt: new Date().toISOString(),
      goodPromotionError: err.message,
      goodPromotionDegraded: true,
    };
    lastStoreRecovery = store.storeRecovery;
  }
}

export function mutateStore(fn) {
  const store = loadStore();
  fn(store);
  saveStore(store);
  return store;
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const next = scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, "hex");
  return next.length === prev.length && timingSafeEqual(next, prev);
}

export function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function ensureOwnerBootstrap() {
  const hosted = process.env.NODE_ENV === "production" || process.env.HERTZ_HOSTED === "1";
  const password = process.env.HERTZ_OWNER_PASSWORD;
  mutateStore((store) => {
    if (store.owner.passwordHash) {
      store.owner.setupRequired = false;
      return;
    }
    if (!password) {
      if (hosted) {
        throw new Error(
          "HERTZ_OWNER_PASSWORD is required in production/hosted mode before the API can start.",
        );
      }
      store.owner.setupRequired = true;
      store.audit.push({
        at: new Date().toISOString(),
        action: "owner_setup_required",
        note: "Set HERTZ_OWNER_PASSWORD and restart, or complete one-time local setup. No default password.",
      });
      return;
    }
    const { hash, salt } = hashPassword(password);
    store.owner.passwordHash = hash;
    store.owner.passwordSalt = salt;
    store.owner.setupRequired = false;
    store.audit.push({
      at: new Date().toISOString(),
      action: "owner_bootstrap",
      note: "Password from HERTZ_OWNER_PASSWORD only (no hardcoded default).",
    });
  });
}

/** One-time local owner password when setupRequired (never a built-in default). */
export function completeOwnerSetup(password) {
  const hosted = process.env.NODE_ENV === "production" || process.env.HERTZ_HOSTED === "1";
  if (hosted) {
    const err = new Error("Owner setup endpoint disabled in hosted mode. Use HERTZ_OWNER_PASSWORD.");
    err.code = "hosted";
    throw err;
  }
  const trimmed = String(password || "");
  if (trimmed.length < 10) {
    const err = new Error("Password must be at least 10 characters.");
    err.code = "weak";
    throw err;
  }
  let done = false;
  mutateStore((store) => {
    if (store.owner.passwordHash && !store.owner.setupRequired) {
      done = true;
      return;
    }
    const { hash, salt } = hashPassword(trimmed);
    store.owner.passwordHash = hash;
    store.owner.passwordSalt = salt;
    store.owner.setupRequired = false;
    store.audit.push({
      at: new Date().toISOString(),
      action: "owner_setup_completed",
      note: "Local one-time owner password set.",
    });
    done = true;
  });
  return { ok: done };
}

export function ownerAuthStatus() {
  const store = loadStore();
  return {
    setupRequired: Boolean(store.owner.setupRequired) || !store.owner.passwordHash,
    username: store.owner.username,
  };
}

export function authenticateOwner(username, password) {
  const store = loadStore();
  if (store.owner.username !== username || !store.owner.passwordHash) return null;
  if (!verifyPassword(password, store.owner.passwordSalt, store.owner.passwordHash)) return null;
  const token = randomBytes(32).toString("hex");
  mutateStore((s) => {
    s.sessions[token] = {
      username,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    };
  });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const store = loadStore();
  const session = store.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    mutateStore((s) => {
      delete s.sessions[token];
    });
    return null;
  }
  return session;
}

export function destroySession(token) {
  if (!token) return;
  mutateStore((s) => {
    delete s.sessions[token];
  });
}

export function createDraft(payload) {
  const objects = payload.objects || [];
  const invalid = validateDraftObjects(objects);
  if (invalid) return { error: invalid, status: 400 };

  const id = uuidv4();
  const store = loadStore();
  const draft = {
    id,
    title: payload.title || "Untitled draft",
    scenePath: payload.scenePath || store.project.scenePath || null,
    version: 1,
    baseUnityRevision: payload.unityRevision ?? store.project.unityRevision ?? 0,
    status: "draft_saved",
    statusLabel: "Draft saved",
    objects,
    unityTransformBaseline: captureUnityTransformBaseline(objects),
    updatedAt: new Date().toISOString(),
  };
  mutateStore((s) => {
    s.drafts[id] = draft;
    if (payload.scenePath) s.project.scenePath = payload.scenePath;
    if (typeof payload.unityRevision === "number") s.project.unityRevision = payload.unityRevision;
  });
  return draft;
}

export function getDraft(id) {
  return loadStore().drafts[id] || null;
}

export function updateDraft(id, { expectedVersion, objects, title }) {
  const store = loadStore();
  const draft = store.drafts[id];
  if (!draft) return { error: "Draft not found", status: 404 };
  if (expectedVersion != null && draft.version !== expectedVersion) {
    return {
      error: `Version conflict: expected ${expectedVersion}, have ${draft.version}`,
      status: 409,
      draft,
    };
  }
  if (objects !== undefined) {
    const invalid = validateDraftObjects(objects);
    if (invalid) return { error: invalid, status: 400, draft };
  }
  draft.version += 1;
  if (Array.isArray(objects)) draft.objects = objects;
  if (title) draft.title = title;
  draft.status = "draft_saved";
  draft.statusLabel = "Draft saved";
  draft.updatedAt = new Date().toISOString();
  mutateStore((s) => {
    s.drafts[id] = draft;
  });
  return { draft };
}

export function enqueueApply(draftId, requestId, expectedDraftVersion = undefined) {
  const store = loadStore();
  const draft = store.drafts[draftId];
  if (!draft) return { error: "Draft not found", status: 404 };

  const existing = store.queue.find((q) => q.requestId === requestId);
  if (existing) {
    return { deduplicated: true, command: existing, status: 200 };
  }

  // Bind apply to the version the client just saved; refuse silently applying another tab's save.
  if (expectedDraftVersion !== undefined && expectedDraftVersion !== null) {
    const expected = Number(expectedDraftVersion);
    if (!Number.isFinite(expected) || expected !== draft.version) {
      return {
        error: `Draft version mismatch: expected ${expectedDraftVersion}, current ${draft.version}`,
        status: 409,
        draft,
      };
    }
  }

  const built = buildApplyOperations(draft);
  // Atomic: any validation error queues nothing (no partial apply, no warning-only enqueue).
  if (built.errors.length > 0) {
    return {
      error: built.errors.map((e) => e.error).join("; "),
      status: 400,
      validationErrors: built.errors,
      draft,
    };
  }

  // Walkability / collider hard blocks (W03 #14).
  const validation = validateDraftScene(draft);
  if (validation.blocksApply) {
    return {
      error: `Walkability/collider validation blocked Apply (${validation.status}).`,
      status: 400,
      validation,
      draft,
    };
  }

  const command = {
    id: uuidv4(),
    requestId,
    type: "apply_scene_commands",
    schemaVersion: built.schemaVersion,
    draftId,
    draftVersion: draft.version,
    baseUnityRevision: draft.baseUnityRevision,
    scenePath: draft.scenePath,
    operations: built.operations,
    // Legacy position-only edits retained for older bridge builds / transform fallback.
    edits: built.operations
      .filter((op) => op.op === "transform" || op.op === "instantiate_model")
      .map((op) => ({
        objectId: op.objectId || op.draftObjectId,
        position: op.position,
        rotation: op.rotation,
        scale: op.scale,
        assetId: op.assetId || null,
        op: op.op,
      })),
    status: "pending_unity",
    statusLabel: "Pending Unity",
    createdAt: new Date().toISOString(),
    attempts: 0,
  };

  mutateStore((s) => {
    s.queue.push(command);
    s.drafts[draftId].status = "pending_unity";
    s.drafts[draftId].statusLabel = "Pending Unity";
    s.audit.push({ at: new Date().toISOString(), action: "queue_enqueue", requestId });
  });
  return { deduplicated: false, command, status: 202 };
}

export function nextPendingCommand() {
  const store = loadStore();
  return store.queue.find((q) => q.status === "pending_unity" || q.status === "applying") || null;
}

export function markApplying(commandId) {
  mutateStore((s) => {
    const command = s.queue.find((q) => q.id === commandId);
    if (!command) return;
    command.status = "applying";
    command.statusLabel = "Applying";
    command.attempts += 1;
    command.startedAt = new Date().toISOString();
    if (s.drafts[command.draftId]) {
      s.drafts[command.draftId].status = "applying";
      s.drafts[command.draftId].statusLabel = "Applying";
    }
  });
}

const ASSIGNMENT_OPS = new Set([
  "assign_material",
  "assign_sprite",
  "assign_ui",
  "assign_audio",
  "assign_animation",
]);

/** After Unity ack, consume typed assignment rows so they are not re-queued. */
export function markAssignmentOpsApplied(draft, operations = []) {
  if (!draft || !Array.isArray(draft.objects)) return draft;
  const ids = new Set(
    (Array.isArray(operations) ? operations : [])
      .filter((op) => op?.draftObjectId && ASSIGNMENT_OPS.has(op.op))
      .map((op) => op.draftObjectId),
  );
  for (const obj of draft.objects) {
    if (!obj || !ids.has(obj.objectId)) continue;
    obj.assignmentApplied = true;
    obj.assignmentAppliedAt = new Date().toISOString();
  }
  return draft;
}

/** Atomically bind Unity GlobalObjectIds onto matching draft objects by draftObjectId. */
export function mergeUnityBindingsIntoDraft(draft, bindings, operations = []) {
  if (!draft || !Array.isArray(draft.objects) || !Array.isArray(bindings)) return draft;
  const operationByDraftId = new Map(
    (Array.isArray(operations) ? operations : [])
      .filter((op) => op?.draftObjectId)
      .map((op) => [op.draftObjectId, op]),
  );
  for (const binding of bindings) {
    const draftObjectId = binding?.draftObjectId;
    const unityObjectId = binding?.unityObjectId;
    if (!draftObjectId || !unityObjectId) continue;
    const obj = draft.objects.find((o) => o.objectId === draftObjectId);
    if (!obj) continue;
    const operation = operationByDraftId.get(draftObjectId);
    const bindableOps = new Set(["instantiate_model", "replace_floor_wall", "duplicate"]);
    const staleReason =
      obj.removed
        ? "Object was removed after apply was queued."
        : !operation || !bindableOps.has(operation.op)
          ? "Binding does not match a queued instantiate/replace/duplicate operation."
          : obj.assetId && operation.assetId && obj.assetId !== operation.assetId
            ? "Library asset changed after apply was queued."
            : null;
    if (staleReason) {
      obj.bindingStale = true;
      obj.bindingError = staleReason;
      draft.bindingResyncRequired = true;
      continue;
    }
    // Never rebind a draft object that already points at a different Unity id.
    if (obj.unityObjectId && obj.unityObjectId !== unityObjectId) {
      obj.bindingStale = true;
      obj.bindingError = `Unity id conflict: kept ${obj.unityObjectId}, rejected ${unityObjectId}`;
      draft.bindingResyncRequired = true;
      continue;
    }
    obj.unityObjectId = unityObjectId;
    obj.bindingStale = false;
    obj.bindingError = null;
    if (binding.name && !obj.name) obj.name = binding.name;
  }
  return draft;
}

export function acknowledgeCommand({ requestId, ok, unityRevision, error, conflict, sceneExport, bindings }) {
  const store = loadStore();
  const command = store.queue.find((q) => q.requestId === requestId);
  if (!command) return null;

  if (["applied", "failed", "conflict"].includes(command.status)) {
    return { deduplicated: true, command };
  }

  mutateStore((s) => {
    const cmd = s.queue.find((q) => q.requestId === requestId);
    if (!cmd) return;

    if (conflict) {
      cmd.status = "conflict";
      cmd.statusLabel = "Conflict";
      cmd.error = error || "Revision conflict";
    } else if (ok) {
      cmd.status = "applied";
      cmd.statusLabel = "Applied to Unity";
      cmd.appliedAt = new Date().toISOString();
      if (typeof unityRevision === "number") s.project.unityRevision = unityRevision;
      s.project.lastSceneSyncAt = new Date().toISOString();
      if (sceneExport) s.project.lastSceneExport = sceneExport;
      if (Array.isArray(bindings) && bindings.length) cmd.bindings = bindings;
    } else {
      cmd.status = "failed";
      cmd.statusLabel = "Failed";
      cmd.error = error || "Apply failed";
    }

    const draft = s.drafts[cmd.draftId];
    if (draft) {
      const ackMatchesDraftVersion = draft.version === cmd.draftVersion;
      if (ackMatchesDraftVersion) {
        if (conflict) {
          draft.status = "conflict";
          draft.statusLabel = "Conflict";
          draft.lastError = cmd.error || null;
        } else if (ok) {
          draft.status = "applied";
          draft.statusLabel = "Applied to Unity";
          draft.baseUnityRevision =
            typeof unityRevision === "number" ? unityRevision : s.project.unityRevision;
          // Merge Unity bindings into matching draft objects only — never rewrite the draft from sceneExport.
          if (Array.isArray(bindings) && bindings.length) {
            mergeUnityBindingsIntoDraft(draft, bindings, cmd.operations);
          }
          markAssignmentOpsApplied(draft, cmd.operations);
          advanceTransformBaselineAfterApply(draft, cmd.operations);
          draft.lastError = null;
        } else {
          draft.status = "failed";
          draft.statusLabel = "Failed";
          draft.lastError = cmd.error || null;
        }
      } else if (ok && typeof unityRevision === "number") {
        // Newer draft edits must be preserved; only reconcile the Unity base revision.
        draft.baseUnityRevision = unityRevision;
        if (Array.isArray(bindings) && bindings.length) {
          mergeUnityBindingsIntoDraft(draft, bindings, cmd.operations);
        }
        markAssignmentOpsApplied(draft, cmd.operations);
        advanceTransformBaselineAfterApply(draft, cmd.operations);
        if (draft.status === "applying" || draft.status === "pending_unity") {
          draft.status = "draft_saved";
          draft.statusLabel = "Draft saved";
        }
      } else if (conflict && (draft.status === "applying" || draft.status === "pending_unity")) {
        // Stale command conflict must not leave a newer draft stuck Applying.
        draft.status = "draft_saved";
        draft.statusLabel = "Draft saved";
      }
    }

    s.results.push({
      id: uuidv4(),
      requestId,
      commandId: cmd.id,
      draftVersion: cmd.draftVersion,
      status: cmd.status,
      unityRevision: s.project.unityRevision,
      error: cmd.error || null,
      at: new Date().toISOString(),
    });
  });

  return { deduplicated: false, command: getQueue().find((q) => q.requestId === requestId) };
}

export function getQueue() {
  return loadStore().queue;
}

export function createPairingCode() {
  const code = randomBytes(3).toString("hex").toUpperCase();
  mutateStore((s) => {
    s.pairing.code = code;
    s.pairing.codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  });
  return { code, expiresAt: loadStore().pairing.codeExpiresAt };
}

export function completePairing(code) {
  const store = loadStore();
  if (!store.pairing.code || store.pairing.code !== code) return null;
  if (new Date(store.pairing.codeExpiresAt).getTime() < Date.now()) return null;
  const connectorToken = randomBytes(32).toString("hex");
  const bridgeToken = randomBytes(32).toString("hex");
  const connectorId = uuidv4();
  mutateStore((s) => {
    s.pairing.connectorTokenHash = hashToken(connectorToken);
    s.pairing.bridgeTokenHash = hashToken(bridgeToken);
    s.pairing.connectorId = connectorId;
    s.pairing.pairedAt = new Date().toISOString();
    s.pairing.code = null;
    s.pairing.codeExpiresAt = null;
    s.connections.unity.status = "paired";
  });
  const secretsDir = path.join(DATA_DIR, "secrets");
  fs.mkdirSync(secretsDir, { recursive: true });
  atomicWrite(path.join(secretsDir, "bridge-token.json"), {
    bridgeToken,
    bridgePort: Number(process.env.HERTZ_UNITY_BRIDGE_PORT || 8791),
    writtenAt: new Date().toISOString(),
    note: "Local Editor bridge credential. Keep on Unity machine only.",
  });
  return {
    connectorToken,
    bridgeToken,
    bridgePort: Number(process.env.HERTZ_UNITY_BRIDGE_PORT || 8791),
    connectorId,
    apiBaseUrl: process.env.HERTZ_PUBLIC_API_URL || "http://127.0.0.1:8787",
  };
}

export function verifyConnectorToken(token) {
  const store = loadStore();
  if (!token || !store.pairing.connectorTokenHash) return false;
  return hashToken(token) === store.pairing.connectorTokenHash;
}

export function isConnectorFresh(store = loadStore(), now = Date.now()) {
  const last = store.project.connectorLastSeenAt;
  if (!last) return false;
  const seen = Date.parse(last);
  if (!Number.isFinite(seen)) return false;
  return now - seen <= CONNECTOR_STALE_MS;
}

export function projectConnectionStatus(store = loadStore()) {
  const fresh = isConnectorFresh(store);
  const paired = Boolean(store.pairing.connectorTokenHash);
  // Fresh connector heartbeat alone is not enough — Safe Mode / offline bridge still polls.
  // Require the last observed Unity reachability as well.
  const reachable = Boolean(store.project.unityConnected);
  const unityConnected = fresh && reachable;
  return {
    unityConnected,
    connectorStatus: unityConnected
      ? "connected"
      : fresh
        ? "paired_offline"
        : paired
          ? "disconnected"
          : "unpaired",
    connectorFresh: fresh,
    unityReachable: reachable,
    connectorLastSeenAt: store.project.connectorLastSeenAt,
    lastSceneSyncAt: store.project.lastSceneSyncAt,
    unityRevision: store.project.unityRevision,
    scenePath: store.project.scenePath,
    staleAfterMs: CONNECTOR_STALE_MS,
  };
}

export function touchConnector(connected, unityRevision, scenePath) {
  mutateStore((s) => {
    s.project.connectorLastSeenAt = new Date().toISOString();
    // Persist last observed Unity reachability only as a hint; public reads use freshness.
    s.project.unityConnected = !!connected;
    if (typeof unityRevision === "number") s.project.unityRevision = unityRevision;
    if (scenePath) s.project.scenePath = scenePath;
    s.connections.unity.status = connected ? "connected" : "paired_offline";
  });
}

export function reportHeadsetStatus(report) {
  const sanitized = sanitizeHeadsetReport(report);
  mutateStore((store) => {
    store.connections = store.connections || {};
    store.connections.headset = sanitized;
  });
  return normalizeHeadsetConnection(sanitized);
}

export function getHeadsetConnectionStatus(store = loadStore(), now = Date.now()) {
  return normalizeHeadsetConnection(store?.connections?.headset, { now });
}

const UNITY_SCENE_GUID_RE = /^[0-9a-f]{32}$/i;

function normalizeSceneGuid(value) {
  const guid = String(value || "").trim().toLowerCase();
  return UNITY_SCENE_GUID_RE.test(guid) ? guid : "";
}

function publicStudioTargetScene(project) {
  const stored = project?.studioTargetScene;
  const scenePath = canonicalizeSceneAssetPath(stored?.scenePath);
  const sceneGuid = normalizeSceneGuid(stored?.sceneGuid);
  if (!scenePath || !scenePath.toLowerCase().endsWith(".unity") || !sceneGuid) return null;
  const scene = (project?.unityScenes || []).find(
    (candidate) =>
      normalizeSceneGuid(candidate?.guid) === sceneGuid && scenePathsEqual(candidate?.path, scenePath),
  );
  return {
    scenePath,
    sceneGuid,
    sceneName: scene?.name || scenePath.split("/").pop()?.replace(/\.unity$/i, "") || scenePath,
    unityRevision: Number.isInteger(scene?.unityRevision) ? scene.unityRevision : null,
    available: Boolean(scene),
    updatedAt: stored?.updatedAt || null,
  };
}

export function getStudioTargetScene(store = loadStore()) {
  return publicStudioTargetScene(store?.project);
}

export function setStudioTargetScene({ scenePath, sceneGuid } = {}) {
  if (!scenePath && !sceneGuid) {
    const store = mutateStore((draft) => {
      draft.project = draft.project || {};
      draft.project.studioTargetScene = null;
    });
    return publicStudioTargetScene(store.project);
  }

  const normalizedPath = canonicalizeSceneAssetPath(scenePath);
  const normalizedGuid = normalizeSceneGuid(sceneGuid);
  if (!normalizedPath || !normalizedPath.toLowerCase().endsWith(".unity") || !normalizedGuid) {
    const err = new Error("A canonical Assets/.../*.unity scenePath and 32-character Unity sceneGuid are required.");
    err.code = "invalid_target_scene";
    throw err;
  }

  const current = loadStore();
  const inventoryScene = (current.project?.unityScenes || []).find(
    (candidate) =>
      normalizeSceneGuid(candidate?.guid) === normalizedGuid && scenePathsEqual(candidate?.path, normalizedPath),
  );
  if (!inventoryScene) {
    const err = new Error("Target scene path/GUID pair is not present in the current Unity scene inventory. Refresh scenes and choose again.");
    err.code = "target_scene_unavailable";
    throw err;
  }

  const store = mutateStore((draft) => {
    draft.project = draft.project || {};
    draft.project.studioTargetScene = {
      scenePath: inventoryScene.path,
      sceneGuid: normalizedGuid,
      updatedAt: new Date().toISOString(),
    };
  });
  return publicStudioTargetScene(store.project);
}

/** Cache Unity project scene list reported by the connector (from bridge GET /scenes). */
export function reportUnityScenes({ scenes, activeScenePath, activeSceneName } = {}) {
  const list = Array.isArray(scenes)
    ? scenes
        .filter((s) => s && typeof s.path === "string" && s.path.startsWith("Assets/") && s.path.endsWith(".unity"))
        .map((s) => ({
          path: s.path,
          name: typeof s.name === "string" && s.name ? s.name : s.path.split("/").pop()?.replace(/\.unity$/i, "") || s.path,
          guid: normalizeSceneGuid(s.guid) || null,
          unityRevision: Number.isInteger(s.unityRevision) && s.unityRevision >= 0 ? s.unityRevision : null,
        }))
    : [];
  mutateStore((s) => {
    s.project.unityScenes = list;
    s.project.unityScenesUpdatedAt = new Date().toISOString();
    const selectedGuid = normalizeSceneGuid(s.project.studioTargetScene?.sceneGuid);
    const movedTarget = selectedGuid ? list.find((scene) => normalizeSceneGuid(scene.guid) === selectedGuid) : null;
    if (movedTarget && !scenePathsEqual(movedTarget.path, s.project.studioTargetScene?.scenePath)) {
      s.project.studioTargetScene.scenePath = movedTarget.path;
    }
    if (typeof activeScenePath === "string" && activeScenePath) {
      s.project.scenePath = activeScenePath;
    }
    if (typeof activeSceneName === "string" && activeSceneName) {
      s.project.activeSceneName = activeSceneName;
    }
  });
  return { scenes: list, activeScenePath: activeScenePath || null, activeSceneName: activeSceneName || null };
}

export function requestForceSceneExport(reason = "owner_sync") {
  mutateStore((s) => {
    const baseline = captureExportBaseline(s.project.lastSceneExport, s.project);
    s.project.pendingForceSceneExport = createForceExportRequest(reason, baseline);
  });
  return loadStore().project.pendingForceSceneExport;
}

/**
 * Clear pending force export only when the acknowledgement matches the request.
 * Bare clears (legacy) are ignored while a requestId-bearing pending request exists.
 */
export function clearForceSceneExport({ forceExportRequestId = null, force = false } = {}) {
  mutateStore((s) => {
    const pending = s.project.pendingForceSceneExport;
    if (!pending) return;
    if (force) {
      s.project.pendingForceSceneExport = null;
      return;
    }
    if (pending.requestId) {
      if (forceExportRequestId && forceExportRequestId === pending.requestId) {
        s.project.pendingForceSceneExport = null;
      }
      return;
    }
    // Legacy pending without requestId
    s.project.pendingForceSceneExport = null;
  });
}

export function peekForceSceneExport(store = loadStore()) {
  return store.project.pendingForceSceneExport || null;
}

export function getSceneExportImportGeneration(store = loadStore()) {
  return Number(store.project.lastSceneExport?.importGeneration) || 0;
}

/** True when draft objects lack hierarchy/renderRole/assetId provenance. */
export function draftLacksProvenance(draft) {
  const objs = Array.isArray(draft?.objects) ? draft.objects : [];
  if (!objs.length) return true;
  return !objs.some(
    (o) => o && (o.renderRole || o.assetId || o.parentObjectId !== undefined || o.rootObjectId),
  );
}

export function importSceneSnapshot(snapshot, { createDraftIfMissing = true, forceExportRequestId = null } = {}) {
  let createdDraft = null;
  let forceSatisfied = false;
  let forceRejectedReason = null;
  mutateStore((s) => {
    if (typeof snapshot.unityRevision === "number") s.project.unityRevision = snapshot.unityRevision;
    if (snapshot.scenePath) s.project.scenePath = snapshot.scenePath;
    s.project.lastSceneSyncAt = new Date().toISOString();
    const prevGen = Number(s.project.lastSceneExport?.importGeneration) || 0;
    const nextGen = prevGen + 1;
    const importedAt = new Date().toISOString();
    const ackRequestId =
      forceExportRequestId ||
      snapshot.forceExportRequestId ||
      snapshot.exportRequestId ||
      null;
    const pending = s.project.pendingForceSceneExport;
    if (pending?.requestId) {
      const check = exportSatisfiesForceRequest(
        pending,
        { ...snapshot, forceExportRequestId: ackRequestId },
        { importGeneration: nextGen, importedAt, forceExportRequestId: ackRequestId },
      );
      if (check.ok) {
        s.project.pendingForceSceneExport = null;
        forceSatisfied = true;
      } else if (ackRequestId) {
        // Stale or mismatched ack — keep pending; still import for connector restart recovery
        // only when this is a newer schema export for the active scene (non-force path).
        forceRejectedReason = check.reason;
      }
    } else {
      // No pending request-id handshake — legacy clear on any successful import.
      s.project.pendingForceSceneExport = null;
    }

    s.project.lastSceneExport = {
      scenePath: snapshot.scenePath || null,
      sceneName: snapshot.sceneName || null,
      unityRevision: snapshot.unityRevision ?? s.project.unityRevision,
      exportSchemaVersion: Number(snapshot.exportSchemaVersion) || 0,
      contentFingerprint: snapshot.contentFingerprint || null,
      exportGeneration: Number(snapshot.exportGeneration) || nextGen,
      importGeneration: nextGen,
      forceExportRequestId: ackRequestId,
      renderSnapshot: snapshot.renderSnapshot || null,
      objects: Array.isArray(snapshot.objects) ? snapshot.objects : [],
      exportedAt: importedAt,
    };

    if (!createDraftIfMissing) return;

    const scenePath = snapshot.scenePath || s.project.scenePath;
    const existingForScene = Object.values(s.drafts).find(
      (d) => d.scenePath === scenePath && Array.isArray(d.objects) && d.objects.length > 0,
    );
    if (existingForScene) return;

    const anyEditable = Object.values(s.drafts).some(
      (d) => d.status === "draft_saved" || d.status === "pending_unity" || d.status === "applying",
    );
    if (anyEditable) return;

    const importObjects = Array.isArray(snapshot.objects) ? snapshot.objects : [];
    if (validateDraftObjects(importObjects)) {
      return;
    }
    const id = uuidv4();
    createdDraft = {
      id,
      title: snapshot.sceneName || "Scene draft",
      scenePath: scenePath || null,
      version: 1,
      baseUnityRevision: snapshot.unityRevision ?? s.project.unityRevision ?? 0,
      status: "draft_saved",
      statusLabel: "Draft saved",
      objects: importObjects,
      unityTransformBaseline: captureUnityTransformBaseline(importObjects),
      updatedAt: new Date().toISOString(),
    };
    s.drafts[id] = createdDraft;
    s.audit.push({
      at: createdDraft.updatedAt,
      action: "draft_from_scene_import",
      draftId: id,
      scenePath,
    });
  });
  return {
    project: loadStore().project,
    draft: createdDraft,
    forceSatisfied,
    forceRejectedReason,
  };
}

export function openDraftFromSceneExport({ rebase = false } = {}) {
  const store = loadStore();
  const exportPayload = store.project.lastSceneExport;
  if (!exportPayload || !Array.isArray(exportPayload.objects) || exportPayload.objects.length === 0) {
    return { error: "No scene export available. Pair the connector with Unity open on the test scene.", status: 404 };
  }

  const invalid = validateDraftObjects(exportPayload.objects);
  if (invalid) {
    return { error: invalid, status: 400 };
  }

  const scenePath = exportPayload.scenePath || store.project.scenePath;
  const exportRev = exportPayload.unityRevision ?? store.project.unityRevision ?? 0;
  const existing = Object.values(store.drafts)
    .filter((d) => d.scenePath === scenePath)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];

  const exportHasProvenance = (exportPayload.objects || []).some(
    (o) => o && (o.renderRole || o.assetId || o.parentObjectId !== undefined || o.rootObjectId),
  );
  const exportHasRenderCategories = (exportPayload.objects || []).some(
    (o) => o && typeof o.renderCategory === "string" && o.renderCategory.length > 0,
  );
  const draftLacksRenderCategories =
    Boolean(existing) &&
    !(existing.objects || []).some(
      (o) => o && typeof o.renderCategory === "string" && o.renderCategory.length > 0,
    );
  // Only treat export revision as newer when it is strictly ahead of the draft base.
  // After Apply, draft.baseUnityRevision can be newer than a stale lastSceneExport — do not
  // wipe the draft on Open scene draft (rebase:false) in that case.
  const exportAheadOfDraft =
    Number.isFinite(Number(exportRev)) &&
    Number.isFinite(Number(existing?.baseUnityRevision)) &&
    Number(exportRev) > Number(existing.baseUnityRevision);
  const needsRebase =
    Boolean(existing) &&
    (rebase ||
      existing.status === "conflict" ||
      existing.status === "failed" ||
      exportAheadOfDraft ||
      (exportHasProvenance && draftLacksProvenance(existing)) ||
      (exportHasRenderCategories && draftLacksRenderCategories));

  if (existing && !needsRebase) {
    return { draft: existing, created: false, rebased: false };
  }

  if (existing && needsRebase) {
    let updated = null;
    mutateStore((s) => {
      const draft = s.drafts[existing.id];
      if (!draft) return;
      draft.version += 1;
      draft.objects = exportPayload.objects;
      draft.unityTransformBaseline = captureUnityTransformBaseline(exportPayload.objects);
      draft.baseUnityRevision = exportRev;
      draft.scenePath = scenePath || draft.scenePath;
      draft.status = "draft_saved";
      draft.statusLabel = "Draft saved";
      draft.lastError = null;
      draft.updatedAt = new Date().toISOString();
      s.audit.push({
        at: draft.updatedAt,
        action: "draft_rebase_from_scene",
        draftId: draft.id,
        baseUnityRevision: exportRev,
      });
      updated = draft;
    });
    return { draft: updated, created: false, rebased: true };
  }

  const draft = createDraft({
    title: exportPayload.sceneName || "Scene draft",
    scenePath,
    objects: exportPayload.objects,
    unityRevision: exportRev,
  });
  if (draft.error) return { error: draft.error, status: draft.status || 400 };
  return { draft, created: true, rebased: false };
}

export function publicDraft(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    title: draft.title,
    scenePath: draft.scenePath,
    version: draft.version,
    baseUnityRevision: draft.baseUnityRevision,
    status: draft.status,
    statusLabel: draft.statusLabel,
    lastError: draft.lastError || null,
    objects: draft.objects,
    updatedAt: draft.updatedAt,
  };
}
