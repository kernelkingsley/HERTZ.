/**
 * Priority 1 #7: duplicate command/job delivery + idempotent acknowledgement.
 * Isolated HERTZ_STUDIO_DATA — never touches the live store.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-dup-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const store = await import("../api/src/store.mjs");
const catalog = await import("../api/src/assets/catalog.mjs");
assert.equal(store.DATA_DIR, path.resolve(dataDir));

const checks = [];
function check(name, pass, detail = undefined) {
  checks.push({ name, pass: Boolean(pass), detail });
  assert.ok(pass, detail ? `${name}: ${detail}` : name);
}

const assetId = "55555555-5555-4555-8555-555555555555";
fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [assetId]: {
        id: assetId,
        displayName: "Dup Delivery Model",
        assetType: "model_3d",
        state: "unity_imported",
        unity: { readiness: "ready", importedPath: `Assets/HertzStudio/Imported/${assetId}/model.glb` },
      },
    },
    jobs: [],
    uploads: {},
  }),
  "utf8",
);

const draft = store.createDraft({
  title: "dup-delivery",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  unityRevision: 20,
  objects: [
    {
      objectId: "bound-1",
      source: "library_drop",
      assetId,
      assetType: "model_3d",
      name: "Model",
      unityObjectId: "GlobalObjectId_V1-dup-source",
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  ],
});

const first = store.enqueueApply(draft.id, "dup-apply-1", draft.version);
check("apply_first_202", first.status === 202 && first.deduplicated === false);
const second = store.enqueueApply(draft.id, "dup-apply-1", draft.version);
check("apply_duplicate_200", second.status === 200 && second.deduplicated === true);
check("apply_queue_single", store.getQueue().filter((q) => q.requestId === "dup-apply-1").length === 1);

store.markApplying(first.command.id);
const ack1 = store.acknowledgeCommand({
  requestId: "dup-apply-1",
  ok: true,
  unityRevision: 21,
});
check("ack_first", ack1?.deduplicated === false && ack1?.command?.status === "applied");
const ack2 = store.acknowledgeCommand({
  requestId: "dup-apply-1",
  ok: true,
  unityRevision: 99,
  bindings: [{ draftObjectId: "bound-1", unityObjectId: "GlobalObjectId_V1-should-not-replace" }],
});
check("ack_duplicate_idempotent", ack2?.deduplicated === true);
const after = store.getDraft(draft.id);
check(
  "duplicate_ack_does_not_mutate",
  after.baseUnityRevision === 21 &&
    after.objects[0].unityObjectId === "GlobalObjectId_V1-dup-source",
);

const placement = {
  assetId,
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  confirmSave: true,
  expectedUnityRevision: 21,
  position: { x: 1, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
};
const place1 = catalog.enqueuePlaceInScene(assetId, placement.scenePath, "dup-place-1", placement);
check("place_first_202", place1.status === 202);
const place2 = catalog.enqueuePlaceInScene(assetId, placement.scenePath, "dup-place-1", placement);
check("place_duplicate_200", place2.status === 200);
const placeConflict = catalog.enqueuePlaceInScene(assetId, placement.scenePath, "dup-place-1", {
  ...placement,
  position: { x: 9, y: 0, z: 0 },
});
check("place_payload_conflict_409", placeConflict.status === 409);

// Complete placement via acknowledgeAssetJob; second conflicting ack must be deduplicated.
catalog.markAssetJobApplying(place1.job.id);
const placeAck1 = catalog.acknowledgeAssetJob({
  requestId: "dup-place-1",
  ok: true,
  placedScenePath: placement.scenePath,
  globalObjectId: "GlobalObjectId_V1-place-applied",
  unityRevision: 21,
});
check(
  "asset_job_ack_first",
  placeAck1?.job?.status === "applied" &&
    placeAck1?.deduplicated !== true &&
    placeAck1?.asset?.unity?.lastPlacedGlobalObjectId === "GlobalObjectId_V1-place-applied" &&
    placeAck1?.asset?.unity?.lastPlacedUnityRevision === 21,
);
const assetAfterFirst = catalog.getAsset(assetId);
const placeAck2 = catalog.acknowledgeAssetJob({
  requestId: "dup-place-1",
  ok: true,
  placedScenePath: "Assets/Scenes/SampleScene.unity",
  globalObjectId: "GlobalObjectId_V1-should-not-win",
  unityRevision: 999,
  error: "conflicting metadata must be ignored",
});
check("asset_job_ack_duplicate_deduplicated", placeAck2?.deduplicated === true);
const assetAfterDup = catalog.getAsset(assetId);
const jobAfterDup = catalog.loadCatalog().jobs.find((j) => j.requestId === "dup-place-1");
check(
  "asset_job_dup_ack_cannot_mutate_job",
  jobAfterDup?.status === "applied" && jobAfterDup?.error == null,
);
check(
  "asset_job_dup_ack_cannot_mutate_asset",
  assetAfterDup?.unity?.lastPlacedGlobalObjectId === "GlobalObjectId_V1-place-applied" &&
    assetAfterDup?.unity?.lastPlacedUnityRevision === 21 &&
    assetAfterDup?.unity?.lastPlacedScene === placement.scenePath &&
    assetAfterDup?.placeStatus === assetAfterFirst?.placeStatus,
);

check("data_dir_is_temp", path.resolve(store.DATA_DIR) === path.resolve(dataDir));
check(
  "not_live_studio_data",
  !path.resolve(store.DATA_DIR).replace(/\\/g, "/").endsWith("/Tools/HertzStudio/data"),
);

assert.equal(checks.filter((c) => !c.pass).length, 0);
console.log(JSON.stringify({ ok: true, checks: checks.length, dataDir, results: checks }, null, 2));
