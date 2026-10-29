import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  loadStore,
  cleanupAbandonedStoreTemps,
  ensureOwnerBootstrap,
  authenticateOwner,
  completeOwnerSetup,
  ownerAuthStatus,
  getSession,
  destroySession,
  createDraft,
  getDraft,
  updateDraft,
  enqueueApply,
  nextPendingCommand,
  markApplying,
  acknowledgeCommand,
  getQueue,
  createPairingCode,
  completePairing,
  verifyConnectorToken,
  touchConnector,
  reportHeadsetStatus,
  getHeadsetConnectionStatus,
  reportUnityScenes,
  getStudioTargetScene,
  setStudioTargetScene,
  importSceneSnapshot,
  openDraftFromSceneExport,
  projectConnectionStatus,
  publicDraft,
  validateDraftObjects,
  getStoreRecovery,
  requestForceSceneExport,
  clearForceSceneExport,
  peekForceSceneExport,
  draftLacksProvenance,
  cachedExportMatchesForceRequest,
  DATA_DIR,
} from "./store.mjs";
import { createAssetRouter } from "./assets/routes.mjs";
import { scenePathsEqual } from "./sceneIdentity.mjs";
import { validateLibraryDrop } from "./draft-commands.mjs";
import { validateTypedDrop } from "./target-validation.mjs";
import { validateDraftScene } from "./walkability.mjs";
import {
  listMilestones,
  markW03ReadyForCodexReview,
  readDurableMilestoneGates,
  writeDurableMilestoneGates,
  getMilestoneStatus,
  summarizeMilestoneProgress,
} from "../../shared/milestoneStatus.mjs";
import { getMilestoneDetail } from "../../shared/milestoneDetails.mjs";
import {
  getAnalyticsSchema,
  getQuestTransferGuide,
  importCapture,
  listCaptures,
  summarizeAnalytics,
  listSessions,
  exportAnalytics,
} from "./analytics.mjs";
import {
  getSoundBoard,
  listAudioLibrary,
  upsertSlot,
  clearSlot,
  upsertEmitter,
  deleteEmitter,
  upsertFootstepMapping,
  deleteFootstepMapping,
  collectAudioUsages,
  unassignAudio,
  enqueueSoundSync,
  nextSoundJob,
  getSoundJob,
  markSoundJobApplying,
  acknowledgeSoundSync,
  recoverSoundJobsOnBoot,
  buildSoundSyncPayload,
} from "./sound.mjs";
import {
  nextAssetJob,
  markAssetJobApplying,
  acknowledgeAssetJob,
  getAssetBlobPath,
  getDependencyBlobPath,
  getAsset,
  loadCatalog,
} from "./assets/catalog.mjs";
import { getSketchfabMeta } from "./assets/secrets.mjs";
import {
  listWeapons,
  upsertWeapon,
  deleteWeapon,
  getWeapon,
  setWeaponLoadout,
  collectWeaponDependencies,
  guidedRemoveWeapon,
  listReadyWeaponModels,
  listWeaponModelLibrary,
  enqueueWeaponSync,
  enqueueWeaponDeploy,
  enqueueWeaponUnityDelete,
  nextWeaponJob,
  getWeaponJob,
  markWeaponJobApplying,
  acknowledgeWeaponSync,
  recoverWeaponJobsOnBoot,
  buildUnitySyncPayload,
  resolveConfirmWrapperPath,
  resolveAuthoritativeWeaponSourcePrefab,
  buildWrapperAnchorMetaFromBridge,
  wrapperNeedsConfirmation,
  isManagedWrapperPathForWeapon,
} from "./weapons.mjs";
import {
  listPolyHavenAssets,
  getPolyHavenAssetInfo,
  startPolyHavenImport,
  listPolyHavenImports,
  getPolyHavenImport,
  recordPolyHavenDownloadIntent,
} from "./polyhaven.mjs";
import {
  listMaterialAssignments,
  listMaterialTargets,
  inspectMaterialTarget,
  applySurfaceAssignment,
  undoLastSurface,
  setHdriEnvironment,
} from "./materials.mjs";
import {
  listAnimationSlots,
  listStudioAnimationClips,
  recordMixamoImportMeta,
  probeAnimationAsset,
  assignAnimationSlot,
  listAnimationAssignments,
} from "./animation.mjs";
import {
  ingestPerformanceCapture,
  listPerformanceCaptures,
  runStaticProjectInspection,
  ingestEditorCapture,
} from "./performance.mjs";
import {
  createNamedSnapshot,
  listSnapshots,
  diffSnapshots,
  planRestoreSnapshot,
  enqueueRestoreSnapshot,
} from "./snapshots.mjs";
import { listEncounters, upsertEncounter, resetEncounterRuntime } from "./encounters.mjs";
import {
  getDeployOverview,
  acknowledgeCredentialDeposit,
  depositCredential,
  selectDeployProvider,
  createDeployPlan,
  validateDeployPlanTamper,
  buildStudioArtifactHash,
} from "./deployPlan.mjs";
import { postUnityBridge } from "./unityBridgeClient.mjs";
import {
  listCharacters,
  listReadyCharacterModels,
  listCharacterModelLibrary,
  listReadyAnimations,
  upsertCharacterModel,
  upsertEnemyProfile,
  getCharacterModel,
  getEnemyProfile,
  collectCharacterModelDependencies,
  collectEnemyProfileDependencies,
  deleteCharacterModel,
  deleteEnemyProfile,
  enqueueCharacterModelSync,
  enqueueEnemyProfileSync,
  enqueueCharacterDeploy,
  enqueueCharacterUnityDelete,
  nextCharacterJob,
  getCharacterJob,
  markCharacterJobApplying,
  acknowledgeCharacterSync,
  recoverCharacterJobsOnBoot,
  buildCharacterModelSyncPayload,
  buildEnemyProfileSyncPayload,
  resolveAnimationCompatibilityProbe,
} from "./characters.mjs";
import { buildDraftRenderDescriptors, isLegacySceneExport } from "./render-descriptors.mjs";
import fs from "node:fs";

/**
 * Wait until lastSceneExport acknowledges the given force-export request.
 * Does not treat a pre-existing schema-2 cache as success.
 */
async function waitForFreshSceneExport(pendingRequest, { timeoutMs = 18000, intervalMs = 400 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const store = loadStore();
    const pending = store.project.pendingForceSceneExport;
    const exp = store.project.lastSceneExport;
    // Pending cleared and cache matches the request we issued.
    if (
      cachedExportMatchesForceRequest(pendingRequest, exp) ||
      (!pending && cachedExportMatchesForceRequest(pendingRequest, exp))
    ) {
      return { ok: true, export: exp, timedOut: false };
    }
    // Still waiting for connector/Unity.
    if (pending && pending.requestId === pendingRequest.requestId) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    // Pending replaced or cleared without match — keep waiting until timeout or match.
    if (cachedExportMatchesForceRequest(pendingRequest, exp)) {
      return { ok: true, export: exp, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const exp = loadStore().project.lastSceneExport || null;
  if (cachedExportMatchesForceRequest(pendingRequest, exp)) {
    return { ok: true, export: exp, timedOut: false };
  }
  return { ok: false, export: exp, timedOut: true };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HERTZ_API_PORT || 8787);
const WEB_ORIGIN = process.env.HERTZ_WEB_ORIGIN || "http://127.0.0.1:5173";
const IS_PROD = process.env.NODE_ENV === "production";

try {
  ensureOwnerBootstrap();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = express();
app.use(
  cors({
    origin: [WEB_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

function requireOwner(req, res, next) {
  const token = req.cookies?.hertz_session || req.header("x-hertz-session");
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: "Authentication required." });
  req.owner = session;
  next();
}

function requireConnector(req, res, next) {
  const token = req.header("x-hertz-connector-token");
  if (!verifyConnectorToken(token)) {
    return res.status(401).json({ error: "Invalid connector token" });
  }
  req.connectorToken = token;
  next();
}

function withStudioTargetScene(body = {}, { requireRevision = true } = {}) {
  const target = getStudioTargetScene();
  if (!target?.available) {
    const err = new Error("Choose an available Studio target scene before using this feature.");
    err.code = "target_scene_required";
    throw err;
  }
  if (body.scenePath && !scenePathsEqual(body.scenePath, target.scenePath)) {
    const err = new Error("Request scene does not match the current Studio target scene. Refresh and try again.");
    err.code = "target_scene_conflict";
    throw err;
  }
  if (body.sceneGuid && String(body.sceneGuid).toLowerCase() !== String(target.sceneGuid).toLowerCase()) {
    const err = new Error("Request scene GUID does not match the current Studio target scene.");
    err.code = "target_scene_conflict";
    throw err;
  }
  if (requireRevision && !Number.isInteger(target.unityRevision)) {
    const err = new Error("The selected target scene has no current Unity revision. Refresh Unity scenes and retry.");
    err.code = "target_scene_stale";
    throw err;
  }

  return {
    ...body,
    scenePath: target.scenePath,
    sceneGuid: target.sceneGuid,
    ...(requireRevision
      ? { expectedUnityRevision: body.expectedUnityRevision != null ? Number(body.expectedUnityRevision) : target.unityRevision }
      : {}),
  };
}
app.get("/api/health", (_req, res) => {
  const recovery = getStoreRecovery();
  res.json({
    ok: true,
    service: "hertz-studio-api",
    productionUrl: "https://studio.hertz.software",
    hostingDeferred: true,
    storeRecovery: recovery,
  });
});

app.get("/api/auth/status", (_req, res) => {
  res.json(ownerAuthStatus());
});

app.post("/api/auth/setup", (req, res) => {
  try {
    const result = completeOwnerSetup(req.body?.password);
    res.json(result);
  } catch (err) {
    res.status(err.code === "hosted" ? 403 : 400).json({ error: err.message, code: err.code });
  }
});

app.post("/api/auth/login", (req, res) => {
  const status = ownerAuthStatus();
  if (status.setupRequired) {
    return res.status(403).json({
      error: "Owner setup required. Set a password via /api/auth/setup or HERTZ_OWNER_PASSWORD.",
      setupRequired: true,
    });
  }
  const { username, password } = req.body || {};
  const token = authenticateOwner(username, password);
  if (!token) return res.status(401).json({ error: "Invalid credentials" });
  res.cookie("hertz_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true, username });
});

app.post("/api/auth/logout", (req, res) => {
  destroySession(req.cookies?.hertz_session);
  res.clearCookie("hertz_session");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const session = getSession(req.cookies?.hertz_session || req.header("x-hertz-session"));
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  res.json({ username: session.username });
});

app.get("/api/project", requireOwner, (_req, res) => {
  const store = loadStore();
  const connection = projectConnectionStatus(store);
  const activeScenePath = store.project.scenePath || null;
  const draftSummaries = Object.values(store.drafts)
    .map((d) => ({
      id: d.id,
      title: d.title || null,
      scenePath: d.scenePath || null,
      version: d.version,
      status: d.status,
      statusLabel: d.statusLabel,
      baseUnityRevision: d.baseUnityRevision,
      updatedAt: d.updatedAt,
      objectCount: (d.objects || []).length,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  // Prefer newest draft for Unity's active scene — never the newest draft globally.
  const matchingForActive = draftSummaries.filter((d) => d.scenePath && d.scenePath === activeScenePath);
  const latestMatching = matchingForActive[0] || null;
  res.json({
    project: {
      ...store.project,
      unityConnected: connection.unityConnected,
      connectorStatus: connection.connectorStatus,
      unityScenes: store.project.unityScenes || [],
      scenePath: activeScenePath,
      activeSceneName: store.project.activeSceneName || null,
    },
    connection,
    storeRecovery: store.storeRecovery || getStoreRecovery(),
    hasSceneExport: Boolean(store.project.lastSceneExport?.objects?.length),
    activeScenePath,
    drafts: draftSummaries,
    draft: latestMatching
      ? {
          id: latestMatching.id,
          version: latestMatching.version,
          status: latestMatching.statusLabel,
          scenePath: latestMatching.scenePath,
          baseUnityRevision: latestMatching.baseUnityRevision,
          updatedAt: latestMatching.updatedAt,
          objectCount: latestMatching.objectCount,
        }
      : null,
    queueSummary: {
      pending: store.queue.filter((q) => q.status === "pending_unity" || q.status === "applying").length,
      applied: store.queue.filter((q) => q.status === "applied").length,
      conflict: store.queue.filter((q) => q.status === "conflict").length,
      failed: store.queue.filter((q) => q.status === "failed").length,
    },
  });
});

app.get("/api/drafts", requireOwner, (_req, res) => {
  const store = loadStore();
  const drafts = Object.values(store.drafts)
    .map((d) => publicDraft(d))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  res.json({ drafts, activeScenePath: store.project.scenePath || null });
});

app.post("/api/drafts/from-scene", requireOwner, async (req, res) => {
  const rebase = Boolean(req.body?.rebase);
  const storeBefore = loadStore();
  const cached = storeBefore.project.lastSceneExport;
  const activeDraft = storeBefore.project.scenePath
    ? Object.values(storeBefore.drafts)
        .filter((d) => d.scenePath === storeBefore.project.scenePath)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]
    : null;
  const needsFreshExport =
    rebase ||
    isLegacySceneExport(cached) ||
    (activeDraft && draftLacksProvenance(activeDraft) && isLegacySceneExport(cached));

  let forcedExport = false;
  let forceRequest = null;
  if (needsFreshExport) {
    forceRequest = requestForceSceneExport(rebase ? "owner_sync_rebase" : "owner_open_legacy");
    forcedExport = true;
    const waited = await waitForFreshSceneExport(forceRequest, { timeoutMs: 18000 });
    if (!waited.ok || isLegacySceneExport(waited.export)) {
      return res.status(503).json({
        error:
          "Timed out waiting for a fresh Unity scene export that acknowledges this Sync request. Keep the scene open and the connector running, then retry Sync from Unity.",
        code: "scene_export_stale",
        forceRequested: true,
        forceExportRequestId: forceRequest?.requestId || null,
        timedOut: Boolean(waited.timedOut),
      });
    }
  }

  const result = openDraftFromSceneExport({ rebase: rebase || forcedExport });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.created ? 201 : 200).json({
    created: result.created,
    rebased: Boolean(result.rebased),
    forcedExport,
    forceExportRequestId: forceRequest?.requestId || null,
    draft: publicDraft(result.draft),
  });
});

/** Validate a typed library drop without mutating the draft or Unity scene. */
app.post("/api/drafts/validate-drop", requireOwner, (req, res) => {
  const {
    assetId,
    claimedType,
    operation,
    draftId,
    targetObjectId = null,
    materialSlot = 0,
    expectedDraftVersion,
    expectedScenePath,
    expectedUnityRevision,
    expectedExportGeneration,
    expectedTargetMetadataSchema,
  } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ error: "draftId is required", code: "missing_draft" });
  }
  const draft = getDraft(draftId);
  if (!draft) return res.status(404).json({ error: "Draft not found", code: "missing_draft" });
  const result = validateTypedDrop({
    assetId,
    claimedType,
    operation,
    draftId,
    draft,
    targetObjectId,
    materialSlot,
    expectedDraftVersion,
    expectedScenePath,
    expectedUnityRevision,
    expectedExportGeneration,
    expectedTargetMetadataSchema,
  });
  if (!result.ok) {
    const status = result.status || (String(result.code || "").startsWith("stale_") ? 409 : 400);
    return res.status(status).json({
      error: result.error,
      code: result.code,
      resyncRequired: status === 409,
    });
  }
  res.json({
    ok: true,
    operation: result.operation,
    materialSlot: result.materialSlot ?? 0,
    draftVersion: draft.version,
    scenePath: draft.scenePath,
    baseUnityRevision: draft.baseUnityRevision,
    exportGeneration: draft.exportGeneration ?? null,
    asset: {
      id: result.asset.id,
      displayName: result.asset.displayName,
      assetType: result.asset.assetType,
      state: result.asset.state,
      unity: result.asset.unity,
    },
    target: result.target
      ? {
          objectId: result.target.objectId,
          unityObjectId: result.target.unityObjectId,
          surfaceKind: result.target.surfaceKind || null,
          surfaceKindSource: result.target.surfaceKindSource || null,
          materialSlotCount: result.target.materialSlotCount ?? null,
          targetMetadataSchema: result.target.targetMetadataSchema ?? null,
        }
      : null,
  });
});

app.get("/api/milestones", requireOwner, (_req, res) => {
  const milestones = listMilestones(DATA_DIR);
  res.json({
    gates: readDurableMilestoneGates(DATA_DIR),
    milestones,
    summary: summarizeMilestoneProgress(milestones),
  });
});

app.get("/api/milestones/:id/details", requireOwner, (req, res) => {
  try {
    const detail = getMilestoneDetail(req.params.id, DATA_DIR);
    res.json({
      ...detail,
      status: getMilestoneStatus(req.params.id, null, DATA_DIR),
      gates: readDurableMilestoneGates(DATA_DIR)[req.params.id] || {},
    });
  } catch (err) {
    const status = err.code === "invalid_milestone" ? 404 : 500;
    res.status(status).json({ error: err.message, code: err.code || "error" });
  }
});

app.patch("/api/milestones/:id", requireOwner, (req, res) => {
  try {
    writeDurableMilestoneGates({ [req.params.id]: req.body || {} }, DATA_DIR);
    res.json({
      id: req.params.id,
      status: getMilestoneStatus(req.params.id, null, DATA_DIR),
      gates: readDurableMilestoneGates(DATA_DIR)[req.params.id] || {},
    });
  } catch (err) {
    const status =
      err.code === "invalid_milestone" ? 400 : err.code === "forbidden_approval_gate" ? 403 : 500;
    res.status(status).json({ error: err.message, code: err.code, forbidden: err.forbidden || undefined });
  }
});

/** Internal/test helper — never sets Codex/Kingsley gates. */
app.post("/api/milestones/w03/mark-ready-for-codex", requireOwner, (_req, res) => {
  const payload = markW03ReadyForCodexReview(DATA_DIR);
  res.json({
    ok: true,
    status: getMilestoneStatus("W03", null, DATA_DIR),
    gates: payload.gates.W03,
  });
});

app.get("/api/drafts/:id/validation", requireOwner, (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  res.json(validateDraftScene(draft));
});

app.post("/api/drafts", requireOwner, (req, res) => {
  const { title, scenePath, objects, unityRevision } = req.body || {};
  const invalid = validateDraftObjects(objects);
  if (invalid) return res.status(400).json({ error: invalid });
  const draft = createDraft({ title, scenePath, objects, unityRevision });
  if (draft.error) return res.status(draft.status || 400).json({ error: draft.error });
  res.status(201).json(publicDraft(draft));
});

app.get("/api/drafts/:id", requireOwner, (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  res.json(publicDraft(draft));
});

/** Batched safe browser render descriptors for a draft (owner only). */
app.get("/api/drafts/:id/render-descriptors", requireOwner, (req, res) => {
  const draft = getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  const store = loadStore();
  const exportSnap = store.project.lastSceneExport || null;
  let renderSnapshot = exportSnap?.renderSnapshot || null;
  // Prefer draft-matching scene snapshot only.
  if (
    renderSnapshot &&
    draft.scenePath &&
    renderSnapshot.scenePath &&
    draft.scenePath !== renderSnapshot.scenePath
  ) {
    renderSnapshot = null;
  }
  let manifestMeshes = null;
  if (renderSnapshot?.snapshotId) {
    const manifestPath = path.resolve(
      DATA_DIR,
      "render-snapshots",
      renderSnapshot.snapshotId,
      "manifest.json",
    );
    const root = path.resolve(DATA_DIR, "render-snapshots");
    if (manifestPath.startsWith(root + path.sep) && fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifestMeshes = Array.isArray(manifest.meshes) ? manifest.meshes : null;
        renderSnapshot = {
          ...renderSnapshot,
          meshes: manifestMeshes,
          meshCount: manifest.meshCount ?? renderSnapshot.meshCount,
          manifestUrl: `/api/render-snapshots/${renderSnapshot.snapshotId}/manifest.json`,
        };
      } catch {
        /* keep summary-only snapshot */
      }
    }
  }
  const batch = buildDraftRenderDescriptors(draft.objects || [], { renderSnapshot });
  res.json({
    draftId: draft.id,
    scenePath: draft.scenePath || null,
    unityRevision: exportSnap?.unityRevision ?? store.project.unityRevision ?? null,
    exportSchemaVersion: exportSnap?.exportSchemaVersion ?? null,
    exportGeneration: exportSnap?.importGeneration ?? null,
    contentFingerprint: exportSnap?.contentFingerprint ?? null,
    ...batch,
  });
});

app.put("/api/drafts/:id", requireOwner, (req, res) => {
  const result = updateDraft(req.params.id, req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error, draft: publicDraft(result.draft) });
  res.json(publicDraft(result.draft));
});

app.post("/api/drafts/:id/apply", requireOwner, (req, res) => {
  const { requestId, expectedDraftVersion } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required" });
  if (expectedDraftVersion === undefined || expectedDraftVersion === null) {
    return res.status(400).json({ error: "expectedDraftVersion required" });
  }
  const result = enqueueApply(req.params.id, requestId, expectedDraftVersion);
  if (result.error) {
    return res.status(result.status).json({
      error: result.error,
      draft: result.draft ? publicDraft(result.draft) : undefined,
    });
  }
  res.status(result.status).json({
    deduplicated: result.deduplicated,
    command: result.command,
    requestId: result.command.requestId,
  });
});

app.get("/api/queue", requireOwner, (_req, res) => {
  res.json(getQueue());
});

app.get("/api/connections", requireOwner, (_req, res) => {
  const store = loadStore();
  const connection = projectConnectionStatus(store);
  const sketchfab = getSketchfabMeta();
  res.json({
    connections: {
      ...store.connections,
      unity: {
        ...store.connections.unity,
        status: connection.connectorStatus,
      },
      headset: getHeadsetConnectionStatus(store),
      sketchfab: {
        status: sketchfab.status,
        configured: sketchfab.configured,
        maskedId: sketchfab.maskedId,
        accountLabel: sketchfab.accountLabel,
        validatedAt: sketchfab.validatedAt,
      },
      kenney: { status: "no_credential_required", sourceUrl: "https://kenney.nl/assets" },
    },
    pairing: {
      hasCode: Boolean(store.pairing.code),
      codeExpiresAt: store.pairing.codeExpiresAt,
      paired: Boolean(store.pairing.connectorTokenHash),
      connectorId: store.pairing.connectorId,
      pairedAt: store.pairing.pairedAt,
    },
    project: {
      unityConnected: connection.unityConnected,
      connectorStatus: connection.connectorStatus,
      lastSceneSyncAt: connection.lastSceneSyncAt,
      unityRevision: connection.unityRevision,
      connectorLastSeenAt: connection.connectorLastSeenAt,
      scenePath: connection.scenePath,
      staleAfterMs: connection.staleAfterMs,
    },
  });
});

app.use("/api", createAssetRouter({ requireOwner, requireConnector }));

app.post("/api/connections/pair/start", requireOwner, (_req, res) => {
  const pairing = createPairingCode();
  res.json({
    ...pairing,
    instruction: "Run the Unity-machine connector pair script with this code. Token never returns to the browser after redeem.",
  });
});

app.post("/api/connections/pair/complete", (req, res) => {
  const { code } = req.body || {};
  const paired = completePairing(code);
  if (!paired) return res.status(400).json({ error: "Invalid or expired pairing code" });
  res.json(paired);
});

// Alias used by older connector draft
app.post("/api/connector/pair", (req, res) => {
  const { code } = req.body || {};
  const paired = completePairing(code);
  if (!paired) return res.status(400).json({ error: "Invalid or expired pairing code" });
  res.json({
    token: paired.connectorToken,
    connectorToken: paired.connectorToken,
    bridgeToken: paired.bridgeToken,
    connectorId: paired.connectorId,
    apiBaseUrl: paired.apiBaseUrl,
  });
});

app.get("/api/connector/poll", requireConnector, (req, res) => {
  const unityRevision = Number(req.query.unityRevision || 0);
  const unityReachable = req.query.unityReachable === "1";
  const scenePath = req.query.scenePath || undefined;
  touchConnector(unityReachable, Number.isFinite(unityRevision) ? unityRevision : undefined, scenePath);
  const force = peekForceSceneExport();
  const command = nextPendingCommand();
  const forcePayload = {
    forceSceneExport: Boolean(force),
    forceSceneExportReason: force?.reason || null,
    forceExportRequestId: force?.requestId || null,
    forceExportRequestedAt: force?.requestedAt || null,
    forceExportBaseline: force?.baseline || null,
  };
  if (!command) {
    return res.json({
      command: null,
      ...forcePayload,
    });
  }
  if (command.status === "pending_unity") markApplying(command.id);
  res.json({
    command: getQueue().find((q) => q.id === command.id),
    ...forcePayload,
  });
});

app.post("/api/connector/report-headset", requireConnector, (req, res) => {
  const headset = reportHeadsetStatus(req.body || {});
  res.json({ ok: true, headset });
});

app.post("/api/connector/ack-force-scene-export", requireConnector, (req, res) => {
  const forceExportRequestId = req.body?.forceExportRequestId || req.body?.requestId || null;
  clearForceSceneExport({ forceExportRequestId });
  const still = peekForceSceneExport();
  res.json({
    ok: true,
    cleared: !still || (forceExportRequestId && still.requestId !== forceExportRequestId),
    pendingForceExportRequestId: still?.requestId || null,
  });
});

app.post("/api/connector/ack", requireConnector, (req, res) => {
  const { requestId, ok, unityRevision, error, conflict, sceneExport, bindings } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required" });
  const result = acknowledgeCommand({
    requestId,
    ok,
    unityRevision,
    error,
    conflict,
    sceneExport,
    bindings,
  });
  if (!result) return res.status(404).json({ error: "Unknown requestId" });
  res.json(result);
});

app.post("/api/connector/import-scene", requireConnector, (req, res) => {
  const { snapshot, forceExportRequestId } = req.body || {};
  if (!snapshot) return res.status(400).json({ error: "snapshot required" });
  const result = importSceneSnapshot(snapshot, {
    createDraftIfMissing: true,
    forceExportRequestId: forceExportRequestId || snapshot.forceExportRequestId || null,
  });
  res.json({
    ok: true,
    project: result.project,
    draft: result.draft ? publicDraft(result.draft) : null,
    forceSatisfied: Boolean(result.forceSatisfied),
    forceRejectedReason: result.forceRejectedReason || null,
  });
});

function sendRenderSnapshotFile(res, snapshotId, relativeParts) {
  if (!/^[a-f0-9]{8,64}$/i.test(snapshotId)) {
    return res.status(400).json({ error: "Invalid snapshot id" });
  }
  for (const part of relativeParts) {
    if (!part || part.includes("..") || part.includes("/") || part.includes("\\") || part.includes("\0")) {
      return res.status(400).json({ error: "Invalid snapshot path segment" });
    }
  }
  const root = path.resolve(DATA_DIR, "render-snapshots");
  const full = path.resolve(root, snapshotId, ...relativeParts);
  if (!full.startsWith(root + path.sep)) {
    return res.status(400).json({ error: "Path traversal rejected" });
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return res.status(404).json({ error: "Snapshot file not found" });
  }
  const ext = path.extname(full).toLowerCase();
  const type =
    ext === ".glb"
      ? "model/gltf-binary"
      : ext === ".json"
        ? "application/json"
        : ext === ".hmsh"
          ? "application/octet-stream"
          : "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "private, max-age=120");
  fs.createReadStream(full).pipe(res);
}

/** Authenticated render-snapshot file (GLB/bin/json) from Studio-owned cache. No path traversal. */
app.get("/api/render-snapshots/:snapshotId/manifest.json", requireOwner, (req, res) => {
  sendRenderSnapshotFile(res, String(req.params.snapshotId || ""), ["manifest.json"]);
});

app.get("/api/render-snapshots/:snapshotId/meshes/:fileName", requireOwner, (req, res) => {
  const fileName = String(req.params.fileName || "");
  if (!/^[A-Za-z0-9._-]+\.(glb|bin|hmsh|json)$/.test(fileName)) {
    return res.status(400).json({ error: "Invalid mesh file name" });
  }
  sendRenderSnapshotFile(res, String(req.params.snapshotId || ""), ["meshes", fileName]);
});

app.get("/api/connector/poll-assets", requireConnector, (_req, res) => {
  const job = nextAssetJob();
  if (!job) return res.json({ command: null });
  if (job.status === "pending_unity") markAssetJobApplying(job.id);
  const catalog = loadCatalog();
  const fresh = catalog.jobs.find((j) => j.id === job.id);
  const asset = getAsset(job.assetId);
  res.json({
    command: fresh
      ? {
          ...fresh,
          type: fresh.type || "import_asset",
          scenePath: fresh.scenePath || null,
          asset,
        }
      : null,
  });
});

app.get("/api/connector/poll-weapons", requireConnector, (_req, res) => {
  const job = nextWeaponJob();
  if (!job) return res.json({ command: null });
  if (job.status === "pending_unity") markWeaponJobApplying(job.id);
  const fresh = getWeaponJob(job.id) || job;
  // Preserve job.type — delete_weapon_definition must not be rewritten as sync.
  const type = fresh.type || "sync_weapon_definition";
  let payload = fresh.payload || null;
  if (!payload && type === "sync_weapon_definition") {
    payload = buildUnitySyncPayload(fresh.weaponId);
  }
  res.json({
    command: {
      ...fresh,
      type,
      payload: payload || {},
    },
  });
});

app.get("/api/connector/poll-characters", requireConnector, (_req, res) => {
  const job = nextCharacterJob();
  if (!job) return res.json({ command: null });
  if (job.status === "pending_unity") markCharacterJobApplying(job.id);
  const fresh = getCharacterJob(job.id) || job;
  const type = fresh.type || "sync_character_model";
  let payload = fresh.payload || null;
  if (!payload && type === "sync_character_model") {
    payload = buildCharacterModelSyncPayload(fresh.entityId);
  } else if (!payload && type === "sync_enemy_profile") {
    payload = buildEnemyProfileSyncPayload(fresh.entityId);
  }
  res.json({
    command: {
      ...fresh,
      type,
      payload: payload || {},
    },
  });
});

app.get("/api/connector/poll-sound", requireConnector, (_req, res) => {
  const job = nextSoundJob();
  if (!job) return res.json({ command: null });
  if (job.status === "pending_unity") markSoundJobApplying(job.id);
  const fresh = getSoundJob(job.id) || job;
  const type = fresh.type || "sync_sound_board";
  let payload = fresh.payload || null;
  if (!payload && type === "sync_sound_board") {
    payload = buildSoundSyncPayload();
  }
  res.json({
    command: {
      ...fresh,
      type,
      payload: payload || {},
    },
  });
});

app.post("/api/connector/ack-sound", requireConnector, (req, res) => {
  const {
    requestId,
    ok,
    error,
    conflict,
    assetGuid,
    assetPath,
    observedPayloadHash,
    unityRevision,
  } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required", code: "missing_request_id" });
  try {
    const result = acknowledgeSoundSync({
      requestId,
      ok: Boolean(ok),
      error,
      conflict: Boolean(conflict),
      assetGuid,
      assetPath,
      observedPayloadHash,
      unityRevision,
    });
    if (!result) {
      return res.status(404).json({ error: "Unknown sound sync requestId", code: "unknown_request" });
    }
    if (result.ok === false) {
      const status =
        result.status ||
        (result.code === "stale_acknowledgement" || result.code === "payload_hash_mismatch"
          ? 409
          : result.code === "missing_payload_hash"
            ? 400
            : 400);
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) {
    const code = err.code || "error";
    const status =
      code === "unknown_request"
        ? 404
        : code === "missing_request_id" || code === "invalid_request"
          ? 400
          : code === "stale_acknowledgement" ||
              code === "payload_hash_mismatch" ||
              code === "request_id_conflict"
            ? 409
            : 500;
    res.status(status).json({ error: err.message, code, ok: false });
  }
});

app.post("/api/connector/ack-character", requireConnector, (req, res) => {
  const {
    requestId,
    ok,
    error,
    conflict,
    assetGuid,
    assetPath,
    observedPayloadHash,
    observedVersion,
    unityRevision,
    scenePath,
    sceneGuid,
    managedObjectIds,
  } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required" });
  const result = acknowledgeCharacterSync({
    requestId,
    ok: Boolean(ok),
    error,
    conflict: Boolean(conflict),
    assetGuid,
    assetPath,
    observedPayloadHash,
    observedVersion,
    unityRevision,
    scenePath,
    sceneGuid,
    managedObjectIds,
  });
  if (!result) return res.status(404).json({ error: "Unknown character sync requestId" });
  res.json(result);
});

app.post("/api/connector/ack-weapon", requireConnector, (req, res) => {
  const {
    requestId,
    ok,
    error,
    conflict,
    assetGuid,
    assetPath,
    scenePath,
    sceneGuid,
    observedPayloadHash,
    observedVersion,
    unityRevision,
    modelImported,
    definitionSynced,
    anchorsValid,
    runtimeDeployApplied,
    runtimePlayable,
    missingAnchors,
    prefabPath,
  } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required" });
  const result = acknowledgeWeaponSync({
    requestId,
    ok: Boolean(ok),
    error,
    conflict: Boolean(conflict),
    assetGuid,
    assetPath,
    scenePath,
    sceneGuid,
    observedPayloadHash,
    observedVersion,
    unityRevision,
    modelImported,
    definitionSynced,
    anchorsValid,
    runtimeDeployApplied,
    runtimePlayable,
    missingAnchors,
    prefabPath,
  });
  if (!result) return res.status(404).json({ error: "Unknown weapon sync requestId" });
  res.json(result);
});

app.post("/api/connector/ack-asset", requireConnector, (req, res) => {
  const {
    requestId,
    ok,
    error,
    importedPath,
    prefabPath,
    placedScenePath,
    placeError,
    globalObjectId,
    unityRevision,
    placeCode,
    blockingScenes,
    deduplicated,
  } = req.body || {};
  if (!requestId) return res.status(400).json({ error: "requestId required" });
  const result = acknowledgeAssetJob({
    requestId,
    ok,
    error,
    importedPath,
    prefabPath,
    placedScenePath,
    placeError,
    globalObjectId,
    unityRevision,
    placeCode,
    blockingScenes,
    deduplicated,
  });
  if (!result) return res.status(404).json({ error: "Unknown requestId" });
  res.json(result);
});

app.post("/api/connector/report-scenes", requireConnector, (req, res) => {
  const result = reportUnityScenes({
    scenes: req.body?.scenes,
    activeScenePath: req.body?.activeScenePath,
    activeSceneName: req.body?.activeSceneName,
  });
  res.json({ ok: true, ...result });
});

app.get("/api/studio/target-scene", requireOwner, (_req, res) => {
  res.json({ target: getStudioTargetScene() });
});

app.put("/api/studio/target-scene", requireOwner, (req, res) => {
  try {
    const target = setStudioTargetScene(req.body || {});
    res.json({ target });
  } catch (err) {
    const status = err.code === "target_scene_unavailable" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid_target_scene" });
  }
});

/** Owner-facing Unity scene list (cached from connector reports). */
app.get("/api/unity/scenes", requireOwner, (_req, res) => {
  const store = loadStore();
  const connection = projectConnectionStatus(store);
  res.json({
    scenes: store.project.unityScenes || [],
    activeScenePath: store.project.scenePath || null,
    activeSceneName: store.project.activeSceneName || null,
    updatedAt: store.project.unityScenesUpdatedAt || null,
    unityConnected: connection.unityConnected,
    connectorStatus: connection.connectorStatus,
    target: getStudioTargetScene(store),
  });
});

app.get("/api/connector/assets/:id/file", requireConnector, (req, res) => {
  const blob = getAssetBlobPath(req.params.id);
  if (!blob) return res.status(404).json({ error: "Asset blob not found" });
  res.sendFile(blob);
});

app.get("/api/connector/assets/:id/dependency/:name", requireConnector, (req, res) => {
  const blob = getDependencyBlobPath(req.params.id, req.params.name);
  if (!blob) return res.status(404).json({ error: "Dependency blob not found" });
  res.sendFile(blob);
});

app.get("/api/weapons", requireOwner, (_req, res) => {
  res.json(listWeapons());
});

app.get("/api/weapons/models/ready", requireOwner, (req, res) => {
  res.json({ models: listReadyWeaponModels({ q: req.query.q || "" }) });
});

app.get("/api/weapons/models/library", requireOwner, (req, res) => {
  res.json({ models: listWeaponModelLibrary({ q: req.query.q || "" }) });
});

app.patch("/api/weapons/loadout", requireOwner, (req, res) => {
  try {
    res.json({ loadout: setWeaponLoadout(req.body || {}) });
  } catch (err) {
    const status = err.code === "unknown_id" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/weapons/:id", requireOwner, (req, res) => {
  const weapon = getWeapon(req.params.id);
  if (!weapon) return res.status(404).json({ error: "Weapon not found" });
  res.json(weapon);
});

app.get("/api/weapons/:id/dependencies", requireOwner, (req, res) => {
  const result = collectWeaponDependencies(req.params.id);
  if (!result.exists) return res.status(404).json({ error: "Weapon not found" });
  res.json(result);
});

app.post("/api/weapons/:id/inspect-prefab-anchors", requireOwner, async (req, res) => {
  try {
    const weapon = getWeapon(req.params.id);
    if (!weapon) return res.status(404).json({ error: "Weapon not found", code: "unknown_id" });
    const asset = weapon.modelAssetId ? getAsset(weapon.modelAssetId) : null;
    const prefabPath =
      req.body?.prefabPath ||
      weapon.runtimeModelPrefabPath ||
      asset?.unity?.prefabPath ||
      asset?.unity?.importedPath ||
      null;
    if (!prefabPath) {
      return res.status(400).json({
        error: "No Unity prefab path available. Import the model first.",
        code: "no_prefab",
        modelImported: false,
        anchorsValid: false,
        runtimePlayable: false,
      });
    }
    const gripAnchor = req.body?.gripAnchor || weapon.tuning?.gripAnchor || "Grip";
    const muzzleAnchor = req.body?.muzzleAnchor || weapon.tuning?.muzzleAnchor || "Muzzle";
    const result = await postUnityBridge("/weapons/inspect-prefab", {
      prefabPath,
      gripAnchor,
      muzzleAnchor,
      weaponId: weapon.id,
    });
    if (!result.ok) {
      return res.status(result.status || 503).json({
        error: result.error || "Unity prefab inspect failed",
        code: "unity_bridge",
        bridgePort: result.bridgePort || null,
        modelImported: false,
        anchorsValid: false,
        runtimePlayable: false,
        prefabPath,
      });
    }
    res.json({
      ...result.data,
      weaponId: weapon.id,
      note:
        result.data?.note ||
        "Grip determines hand alignment; Muzzle determines flash/tracer origin and direction. Select an existing node or create a managed wrapper — never silent-guess placement.",
    });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons/:id/create-anchor-wrapper", requireOwner, async (req, res) => {
  try {
    const weapon = getWeapon(req.params.id);
    if (!weapon) return res.status(404).json({ error: "Weapon not found", code: "unknown_id" });
    let authoritative;
    try {
      authoritative = resolveAuthoritativeWeaponSourcePrefab(weapon, {
        requestedPath: req.body?.sourcePrefabPath || req.body?.prefabPath || null,
      });
    } catch (srcErr) {
      const status = srcErr.code === "wrapper_source_mismatch" ? 409 : 400;
      return res.status(status).json({ error: srcErr.message, code: srcErr.code || "invalid" });
    }
    const gripSourceNode = req.body?.gripSourceNode || "GripAttach";
    const muzzleSourceNode = req.body?.muzzleSourceNode || "MuzzlePoint";
    const replaceExisting = req.body?.replaceExisting === true;
    const result = await postUnityBridge("/weapons/create-anchor-wrapper", {
      prefabPath: authoritative.sourcePrefabPath,
      sourcePrefabPath: authoritative.sourcePrefabPath,
      sourcePrefabGuid: authoritative.sourcePrefabGuid,
      modelAssetId: authoritative.modelAssetId,
      weaponId: weapon.id,
      gripSourceNode,
      muzzleSourceNode,
      replaceExisting,
    });
    if (!result.ok) {
      return res.status(result.status || 503).json({
        error: result.error || "Wrapper creation failed",
        code: "unity_bridge",
        bridgePort: result.bridgePort || null,
      });
    }
    const data = result.data || {};
    if (data.wrapperPrefabPath && !isManagedWrapperPathForWeapon(data.wrapperPrefabPath, weapon.id)) {
      return res.status(400).json({
        error: `Unity returned a wrapper outside Assets/HertzStudio/Weapons/Wrappers/${weapon.id}/.`,
        code: "wrapper_path_invalid",
      });
    }
    if (
      data.sourcePrefabPath &&
      data.sourcePrefabPath !== authoritative.sourcePrefabPath
    ) {
      return res.status(409).json({
        error: "Unity wrapper source path does not match the weapon's authoritative imported prefab.",
        code: "wrapper_source_mismatch",
      });
    }
    if (
      authoritative.sourcePrefabGuid &&
      data.sourcePrefabGuid &&
      data.sourcePrefabGuid !== authoritative.sourcePrefabGuid
    ) {
      return res.status(409).json({
        error: "Unity wrapper source GUID does not match the weapon's authoritative imported prefab.",
        code: "wrapper_source_mismatch",
      });
    }
    const meta = buildWrapperAnchorMetaFromBridge(weapon.id, {
      ...data,
      sourcePrefabPath: authoritative.sourcePrefabPath,
      sourcePrefabGuid: data.sourcePrefabGuid || authoritative.sourcePrefabGuid,
      modelAssetId: authoritative.modelAssetId,
    });
    const needsConfirm = wrapperNeedsConfirmation(meta) || meta.needsConfirmation === true;
    // Idempotent reuse with already-matching Studio meta: no version bump.
    if (
      data.idempotentReuse === true &&
      weapon.runtimeModelPrefabPath === data.wrapperPrefabPath &&
      weapon.wrapperAnchorMeta?.path === data.wrapperPrefabPath &&
      weapon.wrapperAnchorMeta?.needsConfirmation === meta.needsConfirmation &&
      weapon.wrapperAnchorMeta?.confirmed === meta.confirmed &&
      weapon.wrapperAnchorMeta?.recoveryReason === meta.recoveryReason
    ) {
      return res.json({
        ...data,
        weapon,
        nextAction: needsConfirm
          ? meta.recoveryReason === "missing_metadata"
            ? "Confirmation required (legacy wrapper missing metadata). Confirm Grip/Muzzle without overwriting the prefab."
            : "Existing provisional wrapper preserved. Confirm after positioning before Sync/Deploy."
          : "Existing wrapper preserved (idempotent, confirmed).",
      });
    }
    // Persist wrapper path + recovery meta; create/replace invalidates prior sync/deploy readiness.
    const updated = upsertWeapon({
      id: weapon.id,
      expectedVersion: weapon.version,
      runtimeModelPrefabPath: data.wrapperPrefabPath,
      wrapperAnchorMeta: meta,
      tuning: {
        ...weapon.tuning,
        gripAnchor: "Grip",
        muzzleAnchor: "Muzzle",
      },
      displayName: weapon.displayName,
      role: weapon.role,
      enabled: weapon.enabled,
      frequencyFlipRequired: weapon.frequencyFlipRequired,
      modelAssetId: weapon.modelAssetId,
    });
    res.json({
      ...data,
      weapon: updated,
      nextAction: needsConfirm
        ? meta.recoveryReason === "missing_metadata"
          ? "Confirmation required (legacy missing .anchors.json). Confirm to write metadata; Sync/Deploy stay blocked."
          : "Provisional Grip/Muzzle — Confirm after positioning before Sync/Deploy."
        : data.createdNewVersion
          ? "New versioned wrapper created. Sync to Unity, then Test/Deploy."
          : "Wrapper ready. Sync to Unity, then Test/Deploy.",
    });
  } catch (err) {
    const status = err.code === "stale_version" ? 409 : err.code === "unknown_id" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons/:id/confirm-anchor-wrapper", requireOwner, async (req, res) => {
  try {
    const weapon = getWeapon(req.params.id);
    if (!weapon) return res.status(404).json({ error: "Weapon not found", code: "unknown_id" });
    // Authoritative path is the weapon's saved wrapper — never adopt a caller-supplied alternate.
    let savedPath;
    try {
      savedPath = resolveConfirmWrapperPath(weapon, req.body?.wrapperPrefabPath);
    } catch (pathErr) {
      const status =
        pathErr.code === "wrapper_path_mismatch" || pathErr.code === "wrapper_path_invalid"
          ? 409
          : 400;
      return res.status(status).json({ error: pathErr.message, code: pathErr.code || "invalid" });
    }
    let authoritative = null;
    try {
      authoritative = resolveAuthoritativeWeaponSourcePrefab(weapon);
    } catch (srcErr) {
      // Direct-anchor weapons without model may still confirm an already-associated wrapper meta.
      if (srcErr.code !== "no_model" && srcErr.code !== "no_prefab") {
        const status = srcErr.code === "wrapper_source_mismatch" ? 409 : 400;
        return res.status(status).json({ error: srcErr.message, code: srcErr.code || "invalid" });
      }
    }
    const result = await postUnityBridge("/weapons/confirm-anchor-wrapper", {
      wrapperPrefabPath: savedPath,
      weaponId: weapon.id,
      sourcePrefabPath:
        authoritative?.sourcePrefabPath || weapon.wrapperAnchorMeta?.sourcePrefabPath || null,
      sourcePrefabGuid:
        authoritative?.sourcePrefabGuid || weapon.wrapperAnchorMeta?.sourcePrefabGuid || null,
      modelAssetId: authoritative?.modelAssetId || weapon.modelAssetId || null,
    });
    if (!result.ok) {
      return res.status(result.status || 503).json({
        error: result.error || "Confirm failed",
        code: result.data?.code || "unity_bridge",
      });
    }
    const bridgePath = result.data?.wrapperPrefabPath || savedPath;
    if (bridgePath !== savedPath) {
      return res.status(409).json({
        error: "Unity confirmation returned a different wrapper path than the weapon's saved path.",
        code: "wrapper_path_mismatch",
      });
    }
    const updated = upsertWeapon({
      id: weapon.id,
      expectedVersion: weapon.version,
      // Keep the exact saved path — confirmation does not relink.
      runtimeModelPrefabPath: savedPath,
      wrapperAnchorMeta: buildWrapperAnchorMetaFromBridge(
        weapon.id,
        {
          ...(result.data || {}),
          wrapperPrefabPath: savedPath,
          sourcePrefabGuid:
            result.data?.sourcePrefabGuid ||
            authoritative?.sourcePrefabGuid ||
            weapon.wrapperAnchorMeta?.sourcePrefabGuid,
          sourcePrefabPath:
            result.data?.sourcePrefabPath ||
            authoritative?.sourcePrefabPath ||
            weapon.wrapperAnchorMeta?.sourcePrefabPath,
          modelAssetId: authoritative?.modelAssetId || weapon.modelAssetId,
          wrapperVersion: weapon.wrapperAnchorMeta?.wrapperVersion || result.data?.wrapperVersion || 1,
          gripFromSource: weapon.wrapperAnchorMeta?.gripFromSource,
          muzzleFromSource: weapon.wrapperAnchorMeta?.muzzleFromSource,
          anchorsConfirmed: true,
          anchorsProvisional: false,
          needsConfirmation: false,
          recoveryReason: null,
        },
        { confirmedOverride: true },
      ),
      tuning: weapon.tuning,
      displayName: weapon.displayName,
      role: weapon.role,
      enabled: weapon.enabled,
      frequencyFlipRequired: weapon.frequencyFlipRequired,
      modelAssetId: weapon.modelAssetId,
    });
    res.json({
      ...result.data,
      wrapperPrefabPath: savedPath,
      weapon: updated,
      note: result.data?.note || "Anchors confirmed. Sync to Unity next.",
    });
  } catch (err) {
    const status = err.code === "stale_version" ? 409 : err.code === "unknown_id" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons/:id/guided-remove", requireOwner, (req, res) => {
  try {
    const result = guidedRemoveWeapon(req.params.id, {
      action: req.body?.action || "preview",
      requestId: req.body?.requestId || null,
      sides: req.body?.sides || null,
    });
    const status =
      result.status === "queued" ? 202 : result.deleted || result.idempotent || result.ok ? 200 : 200;
    res.status(status).json(result);
  } catch (err) {
    if (err.code === "dependency_blocked" || err.code === "unsafe_cancel") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        dependencies: err.dependencies || [],
        actions: err.actions || {},
        nextAction: err.nextAction || null,
        resolutions: err.resolutions || [],
      });
    }
    if (err.code === "removal_in_progress") {
      return res.status(409).json({ error: err.message, code: err.code, lock: err.lock || null });
    }
    if (err.code === "idempotency_conflict") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        prior: err.prior || null,
      });
    }
    const status = err.code === "unknown_id" ? 404 : err.code === "invalid_request" ? 400 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons/:id/deploy-to-scene", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const target = getStudioTargetScene();
    if (!target?.available) {
      const err = new Error("Choose an available Studio target scene before Test/Deploy.");
      err.code = "target_scene_required";
      throw err;
    }
    if (
      (req.body?.scenePath && req.body.scenePath !== target.scenePath) ||
      (req.body?.sceneGuid && String(req.body.sceneGuid).toLowerCase() !== target.sceneGuid)
    ) {
      const err = new Error("Requested scene does not match the shared Studio target. Refresh and retry.");
      err.code = "target_scene_mismatch";
      throw err;
    }
    const expectedUnityRevision = req.body?.expectedUnityRevision ?? target.unityRevision;
    if (!Number.isInteger(expectedUnityRevision) || expectedUnityRevision !== target.unityRevision) {
      const err = new Error("Target scene revision is stale. Refresh scenes and retry.");
      err.code = "target_scene_stale";
      throw err;
    }
    const result = enqueueWeaponDeploy(req.params.id, requestId, {
      scenePath: target.scenePath,
      sceneGuid: target.sceneGuid,
      expectedUnityRevision,
      confirmSave: req.body?.confirmSave !== false,
      expectedVersion: req.body?.expectedVersion,
    });
    res.status(result.status || 202).json({
      ...result,
      requestId,
      note: "Queued managed HertzWeaponDefinition bind into the selected scene (not raw mesh place).",
    });
  } catch (err) {
    const status =
      err.code === "unknown_id"
        ? 404
        : err.code === "stale_version" ||
            err.code === "payload_conflict" ||
            err.code === "target_scene_required" ||
            err.code === "target_scene_mismatch" ||
            err.code === "target_scene_stale"
          ? 409
          : err.code === "not_synced"
            ? 409
            : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons", requireOwner, (req, res) => {
  try {
    const entry = upsertWeapon(req.body || {});
    const created = !req.body?.id;
    res.status(created ? 201 : 200).json(entry);
  } catch (err) {
    const status =
      err.code === "unknown_id" ? 404 : err.code === "stale_version" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons/:id/sync", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const result = enqueueWeaponSync(req.params.id, requestId, {
      expectedVersion: req.body?.expectedVersion,
    });
    res.status(result.status).json({
      requestId,
      deduplicated: result.deduplicated,
      job: result.job,
      weapon: getWeapon(req.params.id),
      payloadPreview: buildUnitySyncPayload(req.params.id),
    });
  } catch (err) {
    const status =
      err.code === "unknown_id"
        ? 404
        : err.code === "stale_version" || err.code === "payload_conflict"
          ? 409
          : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/weapons/:id/unity-delete", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const result = enqueueWeaponUnityDelete(req.params.id, requestId);
    res.status(result.status).json({
      requestId,
      deduplicated: result.deduplicated,
      job: result.job,
      note: "Queued Unity definition delete. Catalog removal still requires unityResolution=unity_deleted after ack.",
    });
  } catch (err) {
    const status = err.code === "unknown_id" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.delete("/api/weapons/:id", requireOwner, (req, res) => {
  try {
    const unityResolution =
      req.body?.unityResolution || req.query.unityResolution || null;
    res.json(
      deleteWeapon(req.params.id, {
        unassignLoadout: req.body?.unassignLoadout === true || req.query.unassignLoadout === "1",
        unassignSides: req.body?.unassignSides || null,
        cancelQueuedJobs: req.body?.cancelQueuedJobs === true || req.query.cancelQueuedJobs === "1",
        unityResolution,
      }),
    );
  } catch (err) {
    if (err.code === "dependency_blocked" || err.code === "unsafe_cancel") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        dependencies: err.dependencies || [],
        actions: err.actions || {},
        nextAction: err.nextAction || null,
        resolutions: err.resolutions || [],
      });
    }
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/analytics/schema", requireOwner, (_req, res) => {
  res.json(getAnalyticsSchema());
});

app.get("/api/analytics/quest-transfer", requireOwner, (_req, res) => {
  res.json(getQuestTransferGuide());
});

app.get("/api/analytics/captures", requireOwner, (_req, res) => {
  res.json(listCaptures({ dataDir: DATA_DIR }));
});

app.post("/api/analytics/captures/import", requireOwner, (req, res) => {
  try {
    const result = importCapture(req.body || {}, { dataDir: DATA_DIR, source: "browser_import" });
    res.status(result.imported > 0 ? 201 : 200).json(result);
  } catch (err) {
    const status =
      err.code === "payload_too_large" ? 413 : err.code === "invalid_capture" || err.code === "invalid_event" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/connector/analytics/upload", requireConnector, (req, res) => {
  try {
    const result = importCapture(req.body || {}, { dataDir: DATA_DIR, source: "connector" });
    res.status(result.imported > 0 ? 201 : 200).json(result);
  } catch (err) {
    const status =
      err.code === "payload_too_large" ? 413 : err.code === "invalid_capture" || err.code === "invalid_event" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/analytics/summary", requireOwner, (req, res) => {
  const filters = {
    buildId: req.query.buildId || undefined,
    levelId: req.query.levelId || undefined,
    sessionId: req.query.sessionId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  };
  res.json(summarizeAnalytics(filters, { dataDir: DATA_DIR }));
});

app.get("/api/analytics/sessions", requireOwner, (req, res) => {
  const filters = {
    buildId: req.query.buildId || undefined,
    levelId: req.query.levelId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  };
  res.json(
    listSessions(filters, {
      dataDir: DATA_DIR,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }),
  );
});

app.get("/api/analytics/export", requireOwner, (req, res) => {
  const filters = {
    buildId: req.query.buildId || undefined,
    levelId: req.query.levelId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
  };
  const format = String(req.query.format || "json").toLowerCase() === "csv" ? "csv" : "json";
  const out = exportAnalytics(filters, { dataDir: DATA_DIR, format });
  res.setHeader("Content-Type", out.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
  res.send(out.body);
});

app.get("/api/sound", requireOwner, (_req, res) => {
  res.json(getSoundBoard());
});

app.get("/api/sound/library", requireOwner, (req, res) => {
  res.json(
    listAudioLibrary({
      q: req.query.q || "",
      provider: req.query.provider || "",
    }),
  );
});

app.post("/api/sound/slots", requireOwner, (req, res) => {
  try {
    const slot = upsertSlot(req.body || {});
    res.status(201).json(slot);
  } catch (err) {
    const status =
      err.code === "invalid_slot" || err.code === "invalid_audio" || err.code === "unsupported_audio"
        ? 400
        : 500;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/sound/slots/:id/clear", requireOwner, (req, res) => {
  try {
    res.json(clearSlot(req.params.id));
  } catch (err) {
    res.status(err.code === "not_found" ? 404 : 500).json({ error: err.message, code: err.code });
  }
});

app.post("/api/sound/emitters", requireOwner, (req, res) => {
  try {
    const em = upsertEmitter(req.body || {});
    res.status(req.body?.id ? 200 : 201).json(em);
  } catch (err) {
    const status = err.code === "invalid_audio" || err.code === "unsupported_audio" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.delete("/api/sound/emitters/:id", requireOwner, (req, res) => {
  try {
    res.json(deleteEmitter(req.params.id, { force: req.query.force === "1" }));
  } catch (err) {
    const status =
      err.code === "not_found" ? 404 : err.code === "dependency_blocked" ? 409 : 500;
    res.status(status).json({ error: err.message, code: err.code, dependencies: err.dependencies });
  }
});

app.post("/api/sound/footsteps", requireOwner, (req, res) => {
  try {
    const row = upsertFootstepMapping(req.body || {});
    res.status(201).json(row);
  } catch (err) {
    const status =
      err.code === "footstep_auto_forbidden" ||
      err.code === "invalid_footstep" ||
      err.code === "invalid_audio" ||
      err.code === "unsupported_audio"
        ? 400
        : 500;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.delete("/api/sound/footsteps/:id", requireOwner, (req, res) => {
  try {
    res.json(deleteFootstepMapping(req.params.id));
  } catch (err) {
    res.status(err.code === "not_found" ? 404 : 500).json({ error: err.message, code: err.code });
  }
});

app.get("/api/sound/usages/:audioAssetId", requireOwner, (req, res) => {
  res.json(collectAudioUsages(req.params.audioAssetId));
});

app.post("/api/sound/unassign/:audioAssetId", requireOwner, (req, res) => {
  try {
    res.json(unassignAudio(req.params.audioAssetId, { force: Boolean(req.body?.force) }));
  } catch (err) {
    res
      .status(err.code === "dependency_blocked" ? 409 : 500)
      .json({ error: err.message, code: err.code, dependencies: err.dependencies });
  }
});

app.post("/api/sound/sync", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const job = enqueueSoundSync(requestId);
    res.status(202).json({ ok: true, requestId, job });
  } catch (err) {
    const code = err.code || "invalid";
    const status =
      code === "request_id_conflict"
        ? 409
        : code === "invalid_audio" || code === "unsupported_audio" || code === "invalid_request"
          ? 400
          : 500;
    res.status(status).json({
      error: err.message,
      code,
      existingPayloadHash: err.existingPayloadHash,
      attemptedPayloadHash: err.attemptedPayloadHash,
    });
  }
});

app.get("/api/characters", requireOwner, (_req, res) => {
  res.json(listCharacters());
});

app.get("/api/characters/models/ready", requireOwner, (req, res) => {
  const library = listCharacterModelLibrary({ q: req.query.q || "" });
  const assignable = library.filter((m) => m.assignable);
  res.json({
    models: library,
    assignableModels: assignable,
    note: "All model_3d assets are listed. Only unity_imported (or unity.readiness ready) may be assigned. Browser preview_ready is not Unity-ready.",
  });
});

app.get("/api/characters/animations/ready", requireOwner, (req, res) => {
  res.json({
    animations: listReadyAnimations({ q: req.query.q || "" }),
    slots: ["idle", "attack", "locomotion"],
    note: "Assign existing Unity-imported RuntimeAnimatorController or AnimationClip assets. Mixamo integration is W09.",
  });
});

app.post("/api/characters/animation-compatibility", requireOwner, async (req, res) => {
  try {
    const modelAssetId = req.body?.modelAssetId || null;
    const animationAssetId = req.body?.animationAssetId || null;
    const slot = req.body?.slot || "idle";
    let unityResult = null;
    // Optional live bridge probe — never invents success when bridge is down.
    if (req.body?.unityResult && typeof req.body.unityResult === "object") {
      unityResult = req.body.unityResult;
    } else {
      try {
        const probe = resolveAnimationCompatibilityProbe({ modelAssetId, animationAssetId, slot });
        const bridgePort = Number(process.env.HERTZ_UNITY_BRIDGE_PORT || 8791);
        const tokenPath = path.join(DATA_DIR, "secrets", "bridge-token.json");
        if (
          probe.bridgeHint?.modelUnityPath &&
          probe.bridgeHint?.animationUnityPath &&
          fs.existsSync(tokenPath)
        ) {
          const tokenDoc = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
          const token = tokenDoc.bridgeToken;
          if (token) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2500);
            try {
              const resp = await fetch(`http://127.0.0.1:${bridgePort}/characters/validate-animation`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-hertz-bridge-token": token,
                },
                body: JSON.stringify({
                  modelAssetId,
                  animationAssetId,
                  slot,
                  modelUnityPath: probe.bridgeHint.modelUnityPath,
                  animationUnityPath: probe.bridgeHint.animationUnityPath,
                }),
                signal: ctrl.signal,
              });
              if (resp.ok) {
                const body = await resp.json();
                if (body && (body.source === "unity_bridge" || body.source === "unity_editor")) {
                  unityResult = body;
                }
              }
            } finally {
              clearTimeout(timer);
            }
          }
        }
      } catch {
        // Bridge down / timeout → pending (handled below).
      }
    }
    res.json(resolveAnimationCompatibilityProbe({ modelAssetId, animationAssetId, slot, unityResult }));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/characters/models", requireOwner, (req, res) => {
  try {
    const entry = upsertCharacterModel(req.body || {});
    const created = !req.body?.id;
    res.status(created ? 201 : 200).json(entry);
  } catch (err) {
    const status =
      err.code === "unknown_id" ? 404 : err.code === "stale_version" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/characters/models/:id", requireOwner, (req, res) => {
  const model = getCharacterModel(req.params.id);
  if (!model) return res.status(404).json({ error: "Character model not found" });
  res.json(model);
});

app.get("/api/characters/models/:id/dependencies", requireOwner, (req, res) => {
  const result = collectCharacterModelDependencies(req.params.id);
  if (!result.exists) return res.status(404).json({ error: "Character model not found" });
  res.json(result);
});

app.post("/api/characters/models/:id/sync", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const result = enqueueCharacterModelSync(req.params.id, requestId, {
      expectedVersion: req.body?.expectedVersion,
    });
    res.status(result.status).json({
      requestId,
      deduplicated: result.deduplicated,
      job: result.job,
      model: getCharacterModel(req.params.id),
      payloadPreview: buildCharacterModelSyncPayload(req.params.id),
    });
  } catch (err) {
    const status =
      err.code === "unknown_id"
        ? 404
        : err.code === "stale_version" || err.code === "payload_conflict"
          ? 409
          : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/characters/models/:id/deploy-to-scene", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const target = getStudioTargetScene();
    if (!target?.available) {
      const err = new Error("Choose an available Studio target scene before deploying a character.");
      err.code = "target_scene_required";
      throw err;
    }
    if ((req.body?.scenePath && req.body.scenePath !== target.scenePath) || (req.body?.sceneGuid && String(req.body.sceneGuid).toLowerCase() !== target.sceneGuid)) {
      const err = new Error("Requested scene does not match the shared Studio target. Refresh and retry.");
      err.code = "target_scene_mismatch";
      throw err;
    }
    const expectedUnityRevision = req.body?.expectedUnityRevision ?? target.unityRevision;
    if (!Number.isInteger(expectedUnityRevision) || expectedUnityRevision !== target.unityRevision) {
      const err = new Error("Target scene revision is stale. Refresh scenes and retry.");
      err.code = "target_scene_stale";
      throw err;
    }
    const result = enqueueCharacterDeploy(req.params.id, requestId, {
      profileId: req.body?.profileId || null,
      scenePath: target.scenePath,
      sceneGuid: target.sceneGuid,
      expectedUnityRevision,
      confirmSave: req.body?.confirmSave === true,
      expectedVersion: req.body?.expectedVersion,
      quantity: req.body?.quantity ?? 1,
      position: req.body?.position,
      rotation: req.body?.rotation,
      scale: req.body?.scale,
    });
    res.status(result.status || 202).json({ ...result, requestId, note: "Queued managed character runtime deployment into the selected Studio target scene." });
  } catch (err) {
    const conflictCodes = new Set(["stale_version", "payload_conflict", "target_scene_required", "target_scene_mismatch", "target_scene_stale", "not_synced"]);
    const status = err.code === "unknown_id" ? 404 : conflictCodes.has(err.code) ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/characters/models/:id/unity-delete", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const result = enqueueCharacterUnityDelete("model", req.params.id, requestId);
    res.status(result.status).json({
      requestId,
      deduplicated: result.deduplicated,
      job: result.job,
      note: "Queued Unity definition delete. Catalog removal still requires unityResolution=unity_deleted after ack.",
    });
  } catch (err) {
    const status = err.code === "unknown_id" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.delete("/api/characters/models/:id", requireOwner, (req, res) => {
  try {
    const unityResolution =
      req.body?.unityResolution || req.query.unityResolution || null;
    res.json(deleteCharacterModel(req.params.id, { unityResolution }));
  } catch (err) {
    if (err.code === "dependency_blocked") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        dependencies: err.dependencies || [],
        resolutions: err.resolutions || [],
      });
    }
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/characters/profiles", requireOwner, (req, res) => {
  try {
    const entry = upsertEnemyProfile(req.body || {});
    const created = !req.body?.id;
    res.status(created ? 201 : 200).json(entry);
  } catch (err) {
    const status =
      err.code === "unknown_id" ? 404 : err.code === "stale_version" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/characters/profiles/:id", requireOwner, (req, res) => {
  const profile = getEnemyProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: "Enemy profile not found" });
  res.json(profile);
});

app.get("/api/characters/profiles/:id/dependencies", requireOwner, (req, res) => {
  const result = collectEnemyProfileDependencies(req.params.id);
  if (!result.exists) return res.status(404).json({ error: "Enemy profile not found" });
  res.json(result);
});

app.post("/api/characters/profiles/:id/sync", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const result = enqueueEnemyProfileSync(req.params.id, requestId, {
      expectedVersion: req.body?.expectedVersion,
    });
    res.status(result.status).json({
      requestId,
      deduplicated: result.deduplicated,
      job: result.job,
      profile: getEnemyProfile(req.params.id),
      payloadPreview: buildEnemyProfileSyncPayload(req.params.id),
    });
  } catch (err) {
    const status =
      err.code === "unknown_id"
        ? 404
        : err.code === "stale_version" || err.code === "payload_conflict"
          ? 409
          : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.post("/api/characters/profiles/:id/unity-delete", requireOwner, (req, res) => {
  try {
    const requestId = req.body?.requestId || randomUUID();
    const result = enqueueCharacterUnityDelete("profile", req.params.id, requestId);
    res.status(result.status).json({
      requestId,
      deduplicated: result.deduplicated,
      job: result.job,
      note: "Queued Unity definition delete. Catalog removal still requires unityResolution=unity_deleted after ack.",
    });
  } catch (err) {
    const status = err.code === "unknown_id" ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.delete("/api/characters/profiles/:id", requireOwner, (req, res) => {
  try {
    const unityResolution =
      req.body?.unityResolution || req.query.unityResolution || null;
    res.json(deleteEnemyProfile(req.params.id, { unityResolution }));
  } catch (err) {
    if (err.code === "dependency_blocked") {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        dependencies: err.dependencies || [],
        resolutions: err.resolutions || [],
      });
    }
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/deploy", requireOwner, (_req, res) => {
  res.json(getDeployOverview());
});
app.post("/api/deploy/provider", requireOwner, (req, res) => {
  try {
    res.json(selectDeployProvider(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/deploy/credentials", requireOwner, (req, res) => {
  try {
    const body = req.body || {};
    const result =
      body.secret || body.password || body.token || body.apiKey
        ? depositCredential(body)
        : acknowledgeCredentialDeposit(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/deploy/artifact-hash", requireOwner, (_req, res) => {
  try {
    res.json(buildStudioArtifactHash());
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/deploy/plan", requireOwner, (req, res) => {
  try {
    res.status(201).json(createDeployPlan(req.body || {}));
  } catch (err) {
    const status = err.code === "provider_selection_required" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/deploy/plan/validate", requireOwner, (req, res) => {
  try {
    res.json(validateDeployPlanTamper(req.body || {}));
  } catch (err) {
    const status = err.code === "plan_tamper" || err.code === "plan_field_changed" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/polyhaven/assets", requireOwner, async (req, res) => {
  try {
    res.json(await listPolyHavenAssets({ type: req.query.type || "textures", q: req.query.q || "" }));
  } catch (err) {
    res.status(err.code === "timeout" ? 504 : 502).json({ error: err.message, code: err.code || "provider" });
  }
});
app.get("/api/polyhaven/assets/:id", requireOwner, async (req, res) => {
  try {
    res.json(await getPolyHavenAssetInfo(req.params.id));
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code || "provider" });
  }
});
app.post("/api/polyhaven/download-intent", requireOwner, (_req, res) => {
  try {
    recordPolyHavenDownloadIntent({});
    res.status(410).json({ error: "retired", code: "intent_retired" });
  } catch (err) {
    res.status(410).json({ error: err.message, code: err.code || "intent_retired" });
  }
});
app.post("/api/polyhaven/import", requireOwner, async (req, res) => {
  try {
    const result = await startPolyHavenImport(req.body || {});
    res.status(202).json(result);
  } catch (err) {
    const status =
      err.code === "caller_url_rejected"
        ? 400
        : err.code === "unavailable_resolution" || err.code === "too_large" || err.code === "archive_traversal"
          ? 400
          : err.code === "timeout" || err.code === "rate_limit"
            ? 504
            : 502;
    res.status(status).json({ error: err.message, code: err.code || "provider" });
  }
});
app.get("/api/polyhaven/imports", requireOwner, (_req, res) => {
  res.json(listPolyHavenImports());
});
app.get("/api/polyhaven/imports/:id", requireOwner, (req, res) => {
  const row = getPolyHavenImport(req.params.id);
  if (!row) return res.status(404).json({ error: "Import job not found" });
  res.json(row);
});

app.get("/api/materials", requireOwner, (req, res) => {
  const target = getStudioTargetScene();
  res.json(listMaterialAssignments({ scenePath: target?.scenePath }));
});
app.get("/api/materials/targets", requireOwner, async (_req, res) => {
  try {
    res.json(await listMaterialTargets(withStudioTargetScene({}, { requireRevision: false })));
  } catch (err) {
    const status = err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/materials/inspect", requireOwner, async (req, res) => {
  try {
    res.json(await inspectMaterialTarget(withStudioTargetScene(req.body || {}, { requireRevision: false })));
  } catch (err) {
    const status = err.code === "unity_offline" ? 503 : err.code === "protected_scene" ? 400 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/materials/assign", requireOwner, async (req, res) => {
  try {
    res.status(201).json(await applySurfaceAssignment(withStudioTargetScene(req.body || {})));
  } catch (err) {
    const status =
      err.code === "stale_revision" ||
      err.code === "shared_material_protected" ||
      err.code === "dependency_version_mismatch"
        ? 409
        : err.code === "unity_offline"
          ? 503
          : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/materials/undo", requireOwner, async (req, res) => {
  try {
    res.json(await undoLastSurface(withStudioTargetScene(req.body || {})));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/materials/hdri", requireOwner, async (req, res) => {
  try {
    res.json(await setHdriEnvironment(withStudioTargetScene(req.body || {})));
  } catch (err) {
    const status = err.code === "stale_revision" ? 409 : err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/animation/slots", requireOwner, (_req, res) => {
  res.json(listAnimationSlots());
});
app.get("/api/animation/studio-clips", requireOwner, (_req, res) => {
  res.json(listStudioAnimationClips());
});
app.get("/api/animation/assignments", requireOwner, (req, res) => {
  res.json(listAnimationAssignments({ characterId: req.query.characterId }));
});
app.post("/api/animation/imports", requireOwner, (req, res) => {
  try {
    res.status(201).json(recordMixamoImportMeta(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/animation/probe", requireOwner, async (req, res) => {
  try {
    res.json(await probeAnimationAsset(req.body || {}));
  } catch (err) {
    const status = err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/animation/assign", requireOwner, async (req, res) => {
  try {
    res.status(201).json(await assignAnimationSlot(withStudioTargetScene(req.body || {})));
  } catch (err) {
    const status =
      err.code === "rig_mismatch" || err.code === "xr_protected" ? 409 : err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({
      error: err.message,
      code: err.code || "invalid",
      priorPreserved: err.priorPreserved || false,
      prior: err.prior || undefined,
    });
  }
});

app.get("/api/performance/captures", requireOwner, (req, res) => {
  res.json(
    listPerformanceCaptures({
      page: req.query.page,
      pageSize: req.query.pageSize,
      source: req.query.source || null,
    }),
  );
});
app.post("/api/performance/inspect-static", requireOwner, async (req, res) => {
  try {
    res.status(201).json(await runStaticProjectInspection(req.body || {}));
  } catch (err) {
    const status = err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/performance/editor-capture", requireOwner, async (req, res) => {
  try {
    res.status(201).json(await ingestEditorCapture(req.body || {}));
  } catch (err) {
    const status = err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/performance/captures", requireOwner, (req, res) => {
  try {
    res.status(201).json(ingestPerformanceCapture(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});

const AVATAR_PREVIEWS_DIR = path.join(DATA_DIR, "avatar-previews");
const AVATAR_PREVIEW_LABELS = {
  "fp-arms.png": "First person — arms",
  "fp-arms-out.png": "First person — both arms out (full reach)",
  "fp-look-shoes.png": "First person — look down (no insides)",
  "proof-camera-in-front.png": "Proof — HMD (yellow) in front of face",
  "third-arms-out.png": "Third person — both arms out",
  "third-person.png": "Third person — body",
  "third-look-shoes.png": "Third person — looking toward shoes",
  "front-arms.png": "Front — torso / arms",
};

app.get("/api/avatar-previews", requireOwner, (_req, res) => {
  try {
    if (!fs.existsSync(AVATAR_PREVIEWS_DIR)) {
      return res.json({ previews: [] });
    }
    const previews = fs
      .readdirSync(AVATAR_PREVIEWS_DIR)
      .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
      .sort()
      .map((name) => {
        const abs = path.join(AVATAR_PREVIEWS_DIR, name);
        const st = fs.statSync(abs);
        return {
          name,
          label: AVATAR_PREVIEW_LABELS[name] || name,
          kb: Math.max(1, Math.round(st.size / 1024)),
          url: `/api/avatar-previews/${encodeURIComponent(name)}`,
          mtimeMs: st.mtimeMs,
        };
      });
    res.json({ previews });
  } catch (err) {
    res.status(500).json({ error: err.message || "avatar_previews_failed" });
  }
});

app.get("/api/avatar-previews/:name", requireOwner, (req, res) => {
  const raw = String(req.params.name || "");
  const name = path.basename(raw);
  if (!name || name !== raw || !/\.(png|jpe?g|webp)$/i.test(name)) {
    return res.status(400).json({ error: "Invalid preview name." });
  }
  const abs = path.join(AVATAR_PREVIEWS_DIR, name);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: "Preview not found." });
  res.sendFile(abs);
});

app.get("/api/snapshots", requireOwner, (req, res) => {
  res.json(listSnapshots({ q: req.query.q || "" }));
});
app.post("/api/snapshots", requireOwner, async (req, res) => {
  try {
    res.status(201).json(await createNamedSnapshot(req.body || {}));
  } catch (err) {
    const status = err.code === "unity_offline" ? 503 : err.code === "caller_content_rejected" ? 400 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.get("/api/snapshots/diff", requireOwner, (req, res) => {
  try {
    res.json(diffSnapshots(req.query.a, req.query.b));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/snapshots/:id/restore-plan", requireOwner, (req, res) => {
  try {
    res.json(planRestoreSnapshot(req.params.id, { confirm: req.body?.confirm === true, requestId: req.body?.requestId }));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/snapshots/:id/restore", requireOwner, async (req, res) => {
  try {
    res.status(202).json(await enqueueRestoreSnapshot(req.params.id, req.body || {}));
  } catch (err) {
    const status = err.code === "request_conflict" ? 409 : err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

app.get("/api/encounters", requireOwner, (req, res) => {
  const target = getStudioTargetScene();
  res.json(listEncounters({ scenePath: target?.scenePath }));
});
app.post("/api/encounters", requireOwner, async (req, res) => {
  try {
    res.status(201).json(await upsertEncounter(withStudioTargetScene(req.body || {})));
  } catch (err) {
    const status =
      err.code === "stale_version" || err.code === "stale_revision" || err.code === "xr_protected"
        ? 409
        : err.code === "unity_offline"
          ? 503
          : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});
app.post("/api/encounters/:id/reset", requireOwner, async (req, res) => {
  try {
    res.json(await resetEncounterRuntime(req.params.id, req.body || {}));
  } catch (err) {
    const status = err.code === "unknown_id" ? 404 : err.code === "unity_offline" ? 503 : 400;
    res.status(status).json({ error: err.message, code: err.code || "invalid" });
  }
});

const webDist = path.resolve(__dirname, "../../web/dist");
app.use(express.static(webDist));
app.get(/^(?!\/api\/).*/, (req, res) => {
  const index = path.join(webDist, "index.html");
  res.sendFile(index, (err) => {
    if (err) res.status(404).json({ error: "Web build not found. Run npm run build -w web" });
  });
});

const cleanedTemps = cleanupAbandonedStoreTemps();
const weaponRecovery = recoverWeaponJobsOnBoot();
const characterRecovery = recoverCharacterJobsOnBoot();
const soundRecovery = recoverSoundJobsOnBoot();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`HERTZ Studio API on http://127.0.0.1:${PORT}`);
  console.log("Owner user: kingsley (password via HERTZ_OWNER_PASSWORD or one-time local setup — no hardcoded default)");
  console.log("Production target (pending host): https://studio.hertz.software");
  if (cleanedTemps > 0) console.log(`Cleaned ${cleanedTemps} abandoned store/catalog temp files.`);
  if (weaponRecovery.recovered > 0) {
    console.log(`Recovered ${weaponRecovery.recovered} weapon sync job(s) after restart.`);
  }
  if (characterRecovery.recovered > 0) {
    console.log(`Recovered ${characterRecovery.recovered} character sync job(s) after restart.`);
  }
  if (soundRecovery.recovered > 0) {
    console.log(`Recovered ${soundRecovery.recovered} sound sync job(s) after restart.`);
  }
});
