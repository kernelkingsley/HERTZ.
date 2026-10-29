import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-bindings-"));
process.env.HERTZ_STUDIO_DATA = dataDir;
const store = await import("../api/src/store.mjs");
assert.equal(store.DATA_DIR, path.resolve(dataDir));

function draftObject(assetId) {
  return {
    objectId: "draft-model",
    source: "library_drop",
    assetId,
    assetType: "model_3d",
    name: "Model",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

const assetA = "33333333-3333-4333-8333-333333333333";
const assetB = "44444444-4444-4444-8444-444444444444";
fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [assetA]: {
        id: assetA,
        displayName: "Binding Model",
        assetType: "model_3d",
        state: "unity_imported",
        unity: { readiness: "ready", importedPath: `Assets/HertzStudio/Imported/${assetA}/model.glb` },
      },
    },
    jobs: [],
    uploads: {},
  }),
  "utf8",
);
const operations = [{ op: "instantiate_model", draftObjectId: "draft-model", assetId: assetA }];
const binding = [{ draftObjectId: "draft-model", unityObjectId: "GlobalObjectId_V1-test", name: "Bound" }];

const direct = { objects: [draftObject(assetA)] };
store.mergeUnityBindingsIntoDraft(direct, binding, operations);
assert.equal(direct.objects[0].unityObjectId, "GlobalObjectId_V1-test");
assert.equal(direct.objects[0].bindingStale, false);

const removed = { objects: [{ ...draftObject(assetA), removed: true }] };
store.mergeUnityBindingsIntoDraft(removed, binding, operations);
assert.equal(removed.objects[0].unityObjectId, undefined);
assert.equal(removed.objects[0].bindingStale, true);
assert.equal(removed.bindingResyncRequired, true);

const replaced = { objects: [draftObject(assetB)] };
store.mergeUnityBindingsIntoDraft(replaced, binding, operations);
assert.equal(replaced.objects[0].unityObjectId, undefined);
assert.equal(replaced.objects[0].bindingStale, true);

const conflicting = { objects: [{ ...draftObject(assetA), unityObjectId: "GlobalObjectId_V1-existing" }] };
store.mergeUnityBindingsIntoDraft(conflicting, binding, operations);
assert.equal(conflicting.objects[0].unityObjectId, "GlobalObjectId_V1-existing");
assert.equal(conflicting.objects[0].bindingStale, true);

const missingOperation = { objects: [draftObject(assetA)] };
store.mergeUnityBindingsIntoDraft(missingOperation, binding, []);
assert.equal(missingOperation.objects[0].unityObjectId, undefined);
assert.equal(missingOperation.objects[0].bindingStale, true);

const persisted = store.createDraft({
  title: "binding-version",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  unityRevision: 50,
  objects: [draftObject(assetA)],
});
const queued = store.enqueueApply(persisted.id, "binding-ack", persisted.version);
assert.equal(queued.status, 202);
store.markApplying(queued.command.id);
const current = store.getDraft(persisted.id);
const updated = store.updateDraft(persisted.id, {
  expectedVersion: current.version,
  objects: [{ ...draftObject(assetA), removed: true }],
});
assert.ok(updated.draft.version > queued.command.draftVersion);
const acknowledged = store.acknowledgeCommand({
  requestId: "binding-ack",
  ok: true,
  unityRevision: 51,
  bindings: binding,
});
assert.equal(acknowledged.deduplicated, false);
const afterAck = store.getDraft(persisted.id);
assert.equal(afterAck.objects[0].unityObjectId, undefined);
assert.equal(afterAck.objects[0].bindingStale, true);
assert.equal(afterAck.bindingResyncRequired, true);
const duplicateAck = store.acknowledgeCommand({
  requestId: "binding-ack",
  ok: true,
  unityRevision: 51,
  bindings: binding,
});
assert.equal(duplicateAck.deduplicated, true);
assert.equal(store.getDraft(persisted.id).objects[0].unityObjectId, undefined);

console.log(JSON.stringify({ ok: true, checks: 8, dataDir }, null, 2));
