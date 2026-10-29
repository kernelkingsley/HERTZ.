import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w04-weapons-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const modelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const modelIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001";
const WEAPON_TEST_SCENE_GUID = "11111111111111111111111111111111";
const CHARACTER_TEST_SCENE_GUID = "22222222222222222222222222222222";
const SAMPLE_SCENE_GUID = "33333333333333333333333333333333";
const SYNC_READY_ACK = { modelImported: true, definitionSynced: true, anchorsValid: true };
const DEPLOY_READY_ACK = {
  modelImported: true,
  definitionSynced: true,
  anchorsValid: true,
  runtimeDeployApplied: true,
  runtimePlayable: true,
  scenePath: "Assets/Scenes/HertzWeaponTest.unity",
  sceneGuid: WEAPON_TEST_SCENE_GUID,
};
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [modelId]: {
        id: modelId,
        displayName: "W04 Test Pistol Mesh",
        assetType: "model_3d",
        state: "unity_imported",
        unity: {
          readiness: "ready",
          prefabPath: `Assets/HertzStudio/Imported/${modelId}/Pistol.prefab`,
          importedPath: `Assets/HertzStudio/Imported/${modelId}/scene.gltf`,
          prefabGuid: "guid-model-a-aaaa",
        },
      },
      [modelIdB]: {
        id: modelIdB,
        displayName: "W04 Alternate Pistol Same Name",
        assetType: "model_3d",
        state: "unity_imported",
        unity: {
          readiness: "ready",
          prefabPath: `Assets/HertzStudio/Imported/${modelIdB}/Pistol.prefab`,
          importedPath: `Assets/HertzStudio/Imported/${modelIdB}/scene.gltf`,
          prefabGuid: "guid-model-b-bbbb",
        },
      },
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        displayName: "Not ready",
        assetType: "model_3d",
        state: "preview_ready",
        unity: { readiness: "pending" },
        preview: { url: "/preview" },
      },
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc": {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        displayName: "Audio clip",
        assetType: "audio",
        state: "ready",
      },
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd": {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        displayName: "W04 Test Pistol Mesh",
        assetType: "model_3d",
        state: "failed",
        unity: { readiness: "failed", lastError: "Import crashed" },
      },
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee": {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        displayName: "Pending Mesh",
        assetType: "model_3d",
        state: "pending_unity",
        unity: { readiness: "pending" },
      },
      "ffffffff-ffff-4fff-8fff-ffffffffffff": {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        displayName: "Unsupported Mesh",
        assetType: "model_3d",
        state: "unsupported",
        unity: { readiness: "unsupported" },
      },
    },
    jobs: [],
    uploads: {},
  }),
  "utf8",
);

const weapons = await import("./weapons.mjs");
const { getAsset } = await import("./assets/catalog.mjs");

describe("W04 weapons API", () => {
  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects non-finite and out-of-range tuning", () => {
    assert.throws(() => weapons.validateTuning({ damage: NaN }), (e) => e.code === "invalid_tuning");
    assert.throws(() => weapons.validateTuning({ damage: -1 }), (e) => e.code === "invalid_tuning");
    assert.throws(() => weapons.validateTuning({ fireIntervalSeconds: 0.01 }), (e) => e.code === "invalid_tuning");
  });

  it("rejects invalid UUID / wrong type / unreadiness for sync model", () => {
    assert.throws(() => weapons.validateModelAssetId("not-a-uuid"), (e) => e.code === "invalid_model");
    assert.throws(
      () => weapons.validateModelAssetId("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      (e) => e.code === "invalid_model",
    );
    assert.throws(
      () =>
        weapons.validateModelAssetId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { requireReady: true }),
      (e) => e.code === "invalid_model",
    );
    assert.equal(weapons.validateModelAssetId(modelId, { requireReady: true }), modelId);
  });

  it("refuses unknown update ids", () => {
    assert.throws(
      () => weapons.upsertWeapon({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", displayName: "x" }),
      (e) => e.code === "unknown_id",
    );
  });

  it("preserves enabled on partial update unless explicitly sent", () => {
    const created = weapons.upsertWeapon({
      displayName: "Left",
      role: "left_pistol",
      enabled: false,
      modelAssetId: modelId,
      tuning: { damage: 12 },
    });
    assert.equal(created.enabled, false);
    const updated = weapons.upsertWeapon({ id: created.id, displayName: "Left 2" });
    assert.equal(updated.enabled, false);
    assert.equal(updated.displayName, "Left 2");
    const enabled = weapons.upsertWeapon({ id: created.id, enabled: true });
    assert.equal(enabled.enabled, true);
  });

  it("canonical payload hash conflicts on duplicate requestId with different payload", () => {
    const w = weapons.upsertWeapon({
      displayName: "HashLeft",
      role: "left_pistol",
      modelAssetId: modelId,
    });
    const first = weapons.enqueueWeaponSync(w.id, "req-hash-1");
    assert.equal(first.status, 202);
    weapons.upsertWeapon({ id: w.id, displayName: "HashLeftChanged" });
    assert.throws(
      () => weapons.enqueueWeaponSync(w.id, "req-hash-1"),
      (e) => e.code === "payload_conflict",
    );
  });

  it("duplicate delivery and acknowledgement are idempotent", () => {
    const w = weapons.upsertWeapon({
      displayName: "DupLeft",
      role: "left_pistol",
      modelAssetId: modelId,
    });
    const a = weapons.enqueueWeaponSync(w.id, "req-dup-1");
    const b = weapons.enqueueWeaponSync(w.id, "req-dup-1");
    assert.equal(a.deduplicated, false);
    assert.equal(b.deduplicated, true);
    weapons.markWeaponJobApplying(a.job.id);
    const ack1 = weapons.acknowledgeWeaponSync({requestId: "req-dup-1",
      ok: true,
      assetGuid: "guid-1",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: a.job.payloadHash,
      observedVersion: w.version, ...SYNC_READY_ACK});
    assert.equal(ack1.deduplicated, false);
    assert.equal(ack1.job.status, "applied");
    const ack2 = weapons.acknowledgeWeaponSync({requestId: "req-dup-1",
      ok: true,
      assetGuid: "guid-SHOULD-NOT-REPLACE",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`, ...SYNC_READY_ACK});
    assert.equal(ack2.deduplicated, true);
    const after = weapons.getWeapon(w.id);
    assert.equal(after.unitySync.assetGuid, "guid-1");
  });

  it("restart recovery requeues applying jobs", () => {
    const w = weapons.upsertWeapon({
      displayName: "Recover",
      role: "right_pistol",
      modelAssetId: modelId,
    });
    const enq = weapons.enqueueWeaponSync(w.id, "req-recover-1");
    weapons.markWeaponJobApplying(enq.job.id);
    const recovered = weapons.recoverWeaponJobsOnBoot();
    assert.ok(recovered.recovered >= 1);
    const job = weapons.getWeaponJob(enq.job.id);
    assert.equal(job.status, "pending_unity");
  });

  it("stable GUID/path preserved across updates via mapping", () => {
    const w = weapons.upsertWeapon({
      displayName: "Stable",
      role: "left_pistol",
      modelAssetId: modelId,
    });
    const enq = weapons.enqueueWeaponSync(w.id, "req-stable-1");
    weapons.acknowledgeWeaponSync({requestId: "req-stable-1",
      ok: true,
      assetGuid: "stable-guid",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash, ...SYNC_READY_ACK});
    const payload = weapons.buildUnitySyncPayload(w.id);
    assert.equal(payload.expectedAssetGuid, "stable-guid");
    assert.equal(payload.assetPath, `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`);
  });

  it("stale-version conflict", () => {
    const w = weapons.upsertWeapon({ displayName: "Stale", role: "left_pistol", modelAssetId: modelId });
    assert.throws(
      () => weapons.upsertWeapon({ id: w.id, expectedVersion: 999, displayName: "x" }),
      (e) => e.code === "stale_version",
    );
  });

  it("ack without Unity GUID fails (connector cannot invent success)", () => {
    const w = weapons.upsertWeapon({
      displayName: "NoInvent",
      role: "left_pistol",
      modelAssetId: modelId,
    });
    weapons.enqueueWeaponSync(w.id, "req-no-invent");
    const ack = weapons.acknowledgeWeaponSync({requestId: "req-no-invent",
      ok: true,
      assetGuid: null,
      assetPath: null, ...SYNC_READY_ACK});
    assert.equal(ack.job.status, "failed");
  });

  it("failed sync then retry succeeds", () => {
    const w = weapons.upsertWeapon({
      displayName: "Retry",
      role: "right_pistol",
      modelAssetId: modelId,
    });
    weapons.enqueueWeaponSync(w.id, "req-fail-1");
    weapons.acknowledgeWeaponSync({
      requestId: "req-fail-1",
      ok: false,
      error: "Unity offline",
    });
    assert.equal(weapons.getWeapon(w.id).unitySync.state, "failed");
    const retry = weapons.enqueueWeaponSync(w.id, "req-fail-2");
    weapons.acknowledgeWeaponSync({requestId: "req-fail-2",
      ok: true,
      assetGuid: "g2",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: retry.job.payloadHash, ...SYNC_READY_ACK});
    assert.equal(weapons.getWeapon(w.id).unitySync.state, "applied");
  });

  it("left/right role validation on loadout", () => {
    const left = weapons.upsertWeapon({ displayName: "L", role: "left_pistol", modelAssetId: modelId });
    const right = weapons.upsertWeapon({ displayName: "R", role: "right_pistol", modelAssetId: modelId });
    assert.throws(
      () => weapons.setWeaponLoadout({ leftWeaponId: right.id }),
      (e) => e.code === "invalid_role",
    );
    const loadout = weapons.setWeaponLoadout({ leftWeaponId: left.id, rightWeaponId: right.id });
    assert.equal(loadout.leftWeaponId, left.id);
    assert.equal(loadout.rightWeaponId, right.id);
  });

  it("dependency-blocked removal and idempotent delete", () => {
    const left = weapons.upsertWeapon({ displayName: "DepL", role: "left_pistol", modelAssetId: modelId });
    weapons.setWeaponLoadout({ leftWeaponId: left.id });
    assert.throws(() => weapons.deleteWeapon(left.id), (e) => e.code === "dependency_blocked");
    const removed = weapons.deleteWeapon(left.id, { unassignLoadout: true });
    assert.equal(removed.deleted, true);
    const again = weapons.deleteWeapon(left.id);
    assert.equal(again.idempotent, true);
    assert.equal(again.deleted, false);
  });

  it("unity_mapping blocks removal until retain or Unity-acked delete", () => {
    const w = weapons.upsertWeapon({ displayName: "Mapped", role: "left_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-map-1");
    weapons.acknowledgeWeaponSync({requestId: "req-map-1",
      ok: true,
      assetGuid: "guid-map-1",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    assert.equal(weapons.getWeapon(w.id).unitySync.state, "applied");
    assert.throws(() => weapons.deleteWeapon(w.id), (e) => {
      assert.equal(e.code, "dependency_blocked");
      assert.ok(e.dependencies.some((d) => d.kind === "unity_mapping"));
      return true;
    });
    // force flag must not exist as a silent bypass
    assert.throws(() => weapons.deleteWeapon(w.id, { force: true }), (e) => e.code === "dependency_blocked");

    const retained = weapons.deleteWeapon(w.id, { unityResolution: "retain_unity" });
    assert.equal(retained.deleted, true);
    assert.equal(retained.unityResolution, "retain_unity");
  });

  it("unity delete job clears mapping then catalog remove with unity_deleted", () => {
    const w = weapons.upsertWeapon({ displayName: "DelUnity", role: "right_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-del-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-del-sync",
      ok: true,
      assetGuid: "guid-del-1",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    const del = weapons.enqueueWeaponUnityDelete(w.id, "req-del-unity");
    assert.equal(del.job.type, "delete_weapon_definition");
    weapons.acknowledgeWeaponSync({ requestId: "req-del-unity", ok: true });
    const deps = weapons.collectWeaponDependencies(w.id);
    assert.ok(!deps.dependencies.some((d) => d.kind === "unity_mapping"));
    const removed = weapons.deleteWeapon(w.id, { unityResolution: "unity_deleted" });
    assert.equal(removed.deleted, true);
  });

  it("wrong hash / wrong version / missing guid fail ack", () => {
    const w = weapons.upsertWeapon({ displayName: "AckNeg", role: "left_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-ack-neg");
    const badHash = weapons.acknowledgeWeaponSync({requestId: "req-ack-neg",
      ok: true,
      assetGuid: "g",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: "not-the-hash",
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    assert.equal(badHash.job.status, "conflict");

    const w2 = weapons.upsertWeapon({ displayName: "AckNeg2", role: "right_pistol", modelAssetId: modelId });
    const enq2 = weapons.enqueueWeaponSync(w2.id, "req-ack-neg2");
    const badGuid = weapons.acknowledgeWeaponSync({requestId: "req-ack-neg2",
      ok: true,
      assetGuid: "",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w2.id}.asset`,
      observedPayloadHash: enq2.job.payloadHash, ...SYNC_READY_ACK});
    assert.equal(badGuid.job.status, "failed");

    const w3 = weapons.upsertWeapon({ displayName: "AckNeg3", role: "left_pistol", modelAssetId: modelId });
    const enq3 = weapons.enqueueWeaponSync(w3.id, "req-ack-neg3");
    const badVer = weapons.acknowledgeWeaponSync({requestId: "req-ack-neg3",
      ok: true,
      assetGuid: "g3",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w3.id}.asset`,
      observedPayloadHash: enq3.job.payloadHash,
      observedVersion: 999, ...SYNC_READY_ACK});
    assert.equal(badVer.job.status, "conflict");
  });

  it("model picker lists only ready model_3d", () => {
    const models = weapons.listReadyWeaponModels({});
    assert.ok(models.some((m) => m.id === modelId));
    assert.ok(!models.some((m) => m.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    assert.ok(!models.some((m) => m.id === "cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
  });

  it("payload hash is stable for identical canonical fields", () => {
    const w = weapons.upsertWeapon({
      displayName: "Canon",
      role: "left_pistol",
      modelAssetId: modelId,
      tuning: {
        damage: 10,
        fireIntervalSeconds: 0.2,
        rangeMeters: 40,
        recoil: 0.15,
        leftHandAnchor: "LeftHand",
        rightHandAnchor: "RightHand",
        gripAnchor: "Grip",
        muzzleAnchor: "Muzzle",
      },
    });
    const h1 = weapons.weaponPayloadHash(w);
    const h2 = weapons.weaponPayloadHash({ ...w, updatedAt: "different" });
    assert.equal(h1, h2);
  });

  it("guided remove: cancel queued offline sync then remove; cancelled job not delivered", () => {
    const w = weapons.upsertWeapon({
      displayName: "QueuedOffline",
      role: "left_pistol",
      modelAssetId: modelId,
    });
    const enq = weapons.enqueueWeaponSync(w.id, "req-q-offline");
    assert.equal(enq.job.status, "pending_unity");
    const deps = weapons.collectWeaponDependencies(w.id);
    assert.equal(deps.actions.cancelQueuedSyncAndRemove, true);
    assert.equal(deps.actions.deleteUnityAndRemove, false);

    const removed = weapons.guidedRemoveWeapon(w.id, {
      action: "cancel_queued_and_remove",
      requestId: "rm-cancel-1",
    });
    assert.equal(removed.deleted, true);
    assert.equal(removed.modelPreserved, true);
    assert.ok(getAsset(modelId));

    const job = weapons.getWeaponJob(enq.job.id);
    assert.equal(job.status, "cancelled");
    const next = weapons.nextWeaponJob();
    assert.ok(!next || next.id !== enq.job.id);

    const again = weapons.guidedRemoveWeapon(w.id, {
      action: "cancel_queued_and_remove",
      requestId: "rm-cancel-1",
    });
    assert.equal(again.deduplicated, true);
    assert.equal(again.deleted, true);
  });

  it("guided remove: left/right loadout unassign preserves other side", () => {
    const left = weapons.upsertWeapon({ displayName: "L2", role: "left_pistol", modelAssetId: modelId });
    const right = weapons.upsertWeapon({ displayName: "R2", role: "right_pistol", modelAssetId: modelId });
    weapons.setWeaponLoadout({ leftWeaponId: left.id, rightWeaponId: right.id });

    const remLeft = weapons.guidedRemoveWeapon(left.id, {
      action: "unassign_and_remove",
      requestId: "rm-left-1",
      sides: ["left"],
    });
    assert.equal(remLeft.deleted, true);
    const loadout = weapons.listWeapons().loadout;
    assert.equal(loadout.leftWeaponId, null);
    assert.equal(loadout.rightWeaponId, right.id);
    assert.ok(weapons.getWeapon(right.id));

    const remRight = weapons.guidedRemoveWeapon(right.id, {
      action: "unassign_and_remove",
      requestId: "rm-right-1",
      sides: ["right"],
    });
    assert.equal(remRight.deleted, true);
    assert.equal(weapons.listWeapons().loadout.rightWeaponId, null);
  });

  it("guided remove: applying refuses unsafe cancel", () => {
    const w = weapons.upsertWeapon({ displayName: "Applying", role: "left_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-applying");
    weapons.markWeaponJobApplying(enq.job.id);
    const deps = weapons.collectWeaponDependencies(w.id);
    assert.equal(deps.actions.cancelQueuedSyncAndRemove, false);
    assert.equal(deps.actions.refreshStatus, true);
    assert.throws(
      () =>
        weapons.guidedRemoveWeapon(w.id, {
          action: "cancel_queued_and_remove",
          requestId: "rm-unsafe-1",
        }),
      (e) => e.code === "unsafe_cancel",
    );
    assert.ok(weapons.getWeapon(w.id));
  });

  it("guided remove: delete Unity then auto-finish catalog after ack; model preserved", () => {
    const w = weapons.upsertWeapon({ displayName: "AutoDel", role: "right_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-autodel-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-autodel-sync",
      ok: true,
      assetGuid: "guid-autodel",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    const queued = weapons.guidedRemoveWeapon(w.id, {
      action: "delete_unity_and_remove",
      requestId: "rm-autodel-1",
    });
    assert.equal(queued.status, "queued");
    assert.ok(weapons.getWeapon(w.id));

    const ack = weapons.acknowledgeWeaponSync({ requestId: "rm-autodel-1", ok: true });
    assert.equal(ack.catalogRemoved, true);
    assert.equal(weapons.getWeapon(w.id), null);
    assert.ok(getAsset(modelId));

    const sound = getAsset("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    assert.ok(sound);
  });

  it("guided remove: failed Unity delete remains recoverable; retain path works", () => {
    const w = weapons.upsertWeapon({ displayName: "FailDel", role: "left_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-faildel-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-faildel-sync",
      ok: true,
      assetGuid: "guid-fail",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    weapons.guidedRemoveWeapon(w.id, { action: "delete_unity_and_remove", requestId: "rm-fail-1" });
    weapons.acknowledgeWeaponSync({ requestId: "rm-fail-1", ok: false, error: "Unity refused delete" });
    assert.ok(weapons.getWeapon(w.id));
    const deps = weapons.collectWeaponDependencies(w.id);
    assert.equal(deps.actions.retainUnityAndRemove, true);

    const retained = weapons.guidedRemoveWeapon(w.id, {
      action: "retain_unity_and_remove",
      requestId: "rm-retain-1",
    });
    assert.equal(retained.deleted, true);
    assert.equal(retained.unityResolution, "retain_unity");
  });

  it("guided remove: overlapping requests blocked; actions match dependency state", () => {
    const w = weapons.upsertWeapon({ displayName: "Overlap", role: "left_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-overlap-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-overlap-sync",
      ok: true,
      assetGuid: "guid-ov",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    weapons.guidedRemoveWeapon(w.id, { action: "delete_unity_and_remove", requestId: "rm-ov-1" });
    assert.throws(
      () =>
        weapons.guidedRemoveWeapon(w.id, {
          action: "retain_unity_and_remove",
          requestId: "rm-ov-2",
        }),
      (e) => e.code === "removal_in_progress",
    );
    const deps = weapons.collectWeaponDependencies(w.id);
    assert.equal(deps.actions.cancelQueuedSyncAndRemove, false);
    assert.equal(deps.actions.refreshStatus, true);
  });

  it("guided remove: identical requestId replay is deduplicated", () => {
    const w = weapons.upsertWeapon({ displayName: "IdemA", role: "left_pistol", modelAssetId: modelId });
    const first = weapons.guidedRemoveWeapon(w.id, {
      action: "remove_now",
      requestId: "rm-idem-same",
    });
    assert.equal(first.deleted, true);
    const again = weapons.guidedRemoveWeapon(w.id, {
      action: "remove_now",
      requestId: "rm-idem-same",
    });
    assert.equal(again.deduplicated, true);
    assert.equal(again.deleted, true);
    assert.equal(again.weaponId, w.id);
    assert.equal(again.action, "remove_now");
    assert.ok(again.payloadHash);
  });

  it("guided remove: requestId reused for another weapon is 409 idempotency_conflict", () => {
    const a = weapons.upsertWeapon({ displayName: "IdemB1", role: "left_pistol", modelAssetId: modelId });
    const b = weapons.upsertWeapon({ displayName: "IdemB2", role: "right_pistol", modelAssetId: modelId });
    weapons.guidedRemoveWeapon(a.id, { action: "remove_now", requestId: "rm-cross-weapon" });
    assert.throws(
      () => weapons.guidedRemoveWeapon(b.id, { action: "remove_now", requestId: "rm-cross-weapon" }),
      (e) => e.code === "idempotency_conflict",
    );
    assert.ok(weapons.getWeapon(b.id));
    assert.ok(getAsset(modelId));
  });

  it("guided remove: requestId reused with different action or sides conflicts", () => {
    const left = weapons.upsertWeapon({ displayName: "IdemC-L", role: "left_pistol", modelAssetId: modelId });
    const right = weapons.upsertWeapon({ displayName: "IdemC-R", role: "right_pistol", modelAssetId: modelId });
    weapons.setWeaponLoadout({ leftWeaponId: left.id, rightWeaponId: right.id });
    weapons.guidedRemoveWeapon(left.id, {
      action: "unassign_and_remove",
      requestId: "rm-sides",
      sides: ["left"],
    });
    assert.throws(
      () =>
        weapons.guidedRemoveWeapon(left.id, {
          action: "unassign_and_remove",
          requestId: "rm-sides",
          sides: ["right"],
        }),
      (e) => e.code === "idempotency_conflict",
    );
    assert.throws(
      () =>
        weapons.guidedRemoveWeapon(right.id, {
          action: "remove_now",
          requestId: "rm-sides",
        }),
      (e) => e.code === "idempotency_conflict",
    );
    assert.ok(weapons.getWeapon(right.id));
  });

  it("guided remove: omitted sides infer left, delete, identical replay succeeds", () => {
    const left = weapons.upsertWeapon({ displayName: "InferL", role: "left_pistol", modelAssetId: modelId });
    const right = weapons.upsertWeapon({ displayName: "InferL-keep", role: "right_pistol", modelAssetId: modelId });
    weapons.setWeaponLoadout({ leftWeaponId: left.id, rightWeaponId: right.id });
    const first = weapons.guidedRemoveWeapon(left.id, {
      action: "unassign_and_remove",
      requestId: "rm-omit-left",
      // sides intentionally omitted
    });
    assert.equal(first.deleted, true);
    assert.deepEqual(first.effectiveSides || first.sides, ["left"]);
    assert.equal(first.sidesMode, "omitted");
    assert.ok(getAsset(modelId));
    const replay = weapons.guidedRemoveWeapon(left.id, {
      action: "unassign_and_remove",
      requestId: "rm-omit-left",
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.deleted, true);
    assert.equal(replay.sidesMode, "omitted");
    assert.ok(weapons.getWeapon(right.id));
    assert.ok(getAsset(modelId));
  });

  it("guided remove: omitted sides infer both, delete, identical replay succeeds", async () => {
    const w = weapons.upsertWeapon({ displayName: "InferBoth", role: "left_pistol", modelAssetId: modelId });
    // Force both loadout sides to the same id to exercise dual-side inference (role check skipped).
    const { loadStore, saveStore } = await import("./store.mjs");
    const store = loadStore();
    store.weaponLoadout = {
      ...(store.weaponLoadout || {}),
      leftWeaponId: w.id,
      rightWeaponId: w.id,
    };
    saveStore(store);
    const first = weapons.guidedRemoveWeapon(w.id, {
      action: "unassign_and_remove",
      requestId: "rm-omit-both",
    });
    assert.equal(first.deleted, true);
    assert.deepEqual((first.effectiveSides || first.sides).sort(), ["left", "right"]);
    const replay = weapons.guidedRemoveWeapon(w.id, {
      action: "unassign_and_remove",
      requestId: "rm-omit-both",
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.deleted, true);
    assert.ok(getAsset(modelId));
  });

  it("guided remove: explicit left sides replay succeeds; different sides conflict; model preserved", () => {
    const left = weapons.upsertWeapon({ displayName: "ExplL", role: "left_pistol", modelAssetId: modelId });
    const right = weapons.upsertWeapon({ displayName: "ExplR", role: "right_pistol", modelAssetId: modelId });
    weapons.setWeaponLoadout({ leftWeaponId: left.id, rightWeaponId: right.id });
    const first = weapons.guidedRemoveWeapon(left.id, {
      action: "unassign_and_remove",
      requestId: "rm-explicit-left",
      sides: ["left"],
    });
    assert.equal(first.deleted, true);
    assert.equal(first.sidesMode, "explicit");
    assert.deepEqual(first.requestedSides, ["left"]);
    const replay = weapons.guidedRemoveWeapon(left.id, {
      action: "unassign_and_remove",
      requestId: "rm-explicit-left",
      sides: ["left"],
    });
    assert.equal(replay.deduplicated, true);
    assert.throws(
      () =>
        weapons.guidedRemoveWeapon(left.id, {
          action: "unassign_and_remove",
          requestId: "rm-explicit-left",
          sides: ["right"],
        }),
      (e) => e.code === "idempotency_conflict",
    );
    // Omitted vs explicit is also a conflict for the same requestId.
    assert.throws(
      () =>
        weapons.guidedRemoveWeapon(left.id, {
          action: "unassign_and_remove",
          requestId: "rm-explicit-left",
        }),
      (e) => e.code === "idempotency_conflict",
    );
    assert.ok(getAsset(modelId));
    assert.ok(weapons.getWeapon(right.id));
  });

  it("guided remove: rejects empty/whitespace requestId", () => {
    const w = weapons.upsertWeapon({ displayName: "BadRid", role: "left_pistol", modelAssetId: modelId });
    assert.throws(
      () => weapons.guidedRemoveWeapon(w.id, { action: "remove_now", requestId: "   " }),
      (e) => e.code === "invalid_request",
    );
    assert.throws(
      () => weapons.guidedRemoveWeapon(w.id, { action: "remove_now", requestId: "" }),
      (e) => e.code === "invalid_request",
    );
  });

  it("Unity delete conflict overwrites queued remember and releases lock; model preserved", () => {
    const w = weapons.upsertWeapon({ displayName: "ConflictDel", role: "left_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-cdel-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-cdel-sync",
      ok: true,
      assetGuid: "guid-cdel",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    const queued = weapons.guidedRemoveWeapon(w.id, {
      action: "delete_unity_and_remove",
      requestId: "rm-conflict-1",
    });
    assert.equal(queued.status, "queued");
    weapons.acknowledgeWeaponSync({
      requestId: "rm-conflict-1",
      ok: false,
      conflict: true,
      error: "Unity conflict on delete",
    });
    assert.ok(weapons.getWeapon(w.id));
    assert.ok(getAsset(modelId));
    const replay = weapons.guidedRemoveWeapon(w.id, {
      action: "delete_unity_and_remove",
      requestId: "rm-conflict-1",
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.status, "conflict");
    assert.notEqual(replay.status, "queued");
    assert.ok(replay.nextAction);
    // Lock released — new requestId can retry.
    const retry = weapons.guidedRemoveWeapon(w.id, {
      action: "delete_unity_and_remove",
      requestId: "rm-conflict-retry",
    });
    assert.equal(retry.status, "queued");
  });

  it("failed Unity delete releases lock and remembers failed (not queued)", () => {
    const w = weapons.upsertWeapon({ displayName: "FailLock", role: "right_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-flock-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-flock-sync",
      ok: true,
      assetGuid: "guid-flock",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    weapons.guidedRemoveWeapon(w.id, { action: "delete_unity_and_remove", requestId: "rm-flock-1" });
    weapons.acknowledgeWeaponSync({ requestId: "rm-flock-1", ok: false, error: "boom" });
    const replay = weapons.guidedRemoveWeapon(w.id, {
      action: "delete_unity_and_remove",
      requestId: "rm-flock-1",
    });
    assert.equal(replay.status, "failed");
    assert.equal(replay.deleted, false);
    assert.ok(weapons.getWeapon(w.id));
    const retained = weapons.guidedRemoveWeapon(w.id, {
      action: "retain_unity_and_remove",
      requestId: "rm-flock-retain",
    });
    assert.equal(retained.deleted, true);
    assert.ok(getAsset(modelId));
  });

  it("listWeaponModelLibrary covers states, duplicate names, stable ids", () => {
    const library = weapons.listWeaponModelLibrary({});
    const byId = Object.fromEntries(library.map((m) => [m.id, m]));
    assert.ok(byId[modelId]?.assignable);
    assert.equal(byId["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]?.assignable, false);
    assert.ok(byId["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]?.browserPreviewReady);
    assert.ok(byId["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]?.canEnqueueImport);
    assert.equal(byId["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]?.state, "failed");
    assert.ok(byId["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]?.canRetryImport);
    assert.ok(byId["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]?.importInFlight);
    assert.equal(byId["ffffffff-ffff-4fff-8fff-ffffffffffff"]?.state, "unsupported");
    assert.equal(byId["ffffffff-ffff-4fff-8fff-ffffffffffff"]?.canEnqueueImport, false);
    const dupName = library.filter((m) => m.displayName === "W04 Test Pistol Mesh");
    assert.ok(dupName.length >= 2);
    assert.notEqual(dupName[0].id, dupName[1].id);
    const searched = weapons.listWeaponModelLibrary({ q: "Pending" });
    assert.ok(searched.some((m) => m.id === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"));
    const readyOnly = weapons.listReadyWeaponModels({});
    assert.ok(readyOnly.every((m) => m.assignable));
    assert.ok(readyOnly.some((m) => m.id === modelId));
  });

  it("stale weapon version rejected on edit and sync; deploy requires sync", () => {
    const w = weapons.upsertWeapon({ displayName: "Rev1", role: "left_pistol", modelAssetId: modelId });
    assert.equal(w.version, 1);
    const w2 = weapons.upsertWeapon({ id: w.id, displayName: "Rev2", expectedVersion: 1 });
    assert.equal(w2.version, 2);
    assert.throws(
      () => weapons.upsertWeapon({ id: w.id, displayName: "stale", expectedVersion: 1 }),
      (e) => e.code === "stale_version",
    );
    assert.throws(
      () => weapons.enqueueWeaponSync(w.id, "req-stale-sync", { expectedVersion: 1 }),
      (e) => e.code === "stale_version",
    );
    assert.throws(
      () =>
        weapons.enqueueWeaponDeploy(w.id, "req-deploy-nosync", {
          scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
          expectedUnityRevision: 1,
          expectedVersion: 2,
        }),
      (e) => e.code === "not_synced",
    );
    const enq = weapons.enqueueWeaponSync(w.id, "req-deploy-prep", { expectedVersion: 2 });
    weapons.acknowledgeWeaponSync({requestId: "req-deploy-prep",
      ok: true,
      assetGuid: "guid-deploy",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    const deploy = weapons.enqueueWeaponDeploy(w.id, "req-deploy-1", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 3,
      expectedVersion: 2,
    });
    assert.equal(deploy.job.type, "deploy_weapon_runtime");
    assert.equal(deploy.job.payload.role, "left_pistol");
    assert.equal(deploy.job.weaponVersion, 2);
    assert.ok(deploy.job.payload.managedObjectId.includes(w.id));
    const again = weapons.enqueueWeaponDeploy(w.id, "req-deploy-1", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 3,
      expectedVersion: 2,
    });
    assert.equal(again.deduplicated, true);
    assert.throws(
      () =>
        weapons.enqueueWeaponDeploy(w.id, "req-deploy-1", {
          scenePath: "Assets/Scenes/HertzCharacterTest.unity",
          sceneGuid: CHARACTER_TEST_SCENE_GUID,
          expectedUnityRevision: 3,
          expectedVersion: 2,
        }),
      (e) => e.code === "payload_conflict",
    );
    const sampleDeploy = weapons.enqueueWeaponDeploy(w.id, "req-sample", {
      scenePath: "Assets/Scenes/SampleScene.unity",
      sceneGuid: SAMPLE_SCENE_GUID,
      expectedUnityRevision: 1,
      expectedVersion: 2,
    });
    assert.equal(sampleDeploy.job.payload.scenePath, "Assets/Scenes/SampleScene.unity");
    assert.equal(sampleDeploy.job.payload.sceneGuid, SAMPLE_SCENE_GUID);
  });

  it("deploy ack records managed object without deleting library model", () => {
    const w = weapons.upsertWeapon({ displayName: "DeployAck", role: "right_pistol", modelAssetId: modelId });
    const enq = weapons.enqueueWeaponSync(w.id, "req-dack-sync");
    weapons.acknowledgeWeaponSync({requestId: "req-dack-sync",
      ok: true,
      assetGuid: "guid-dack",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion, ...SYNC_READY_ACK});
    const deploy = weapons.enqueueWeaponDeploy(w.id, "req-dack-deploy", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 5,
      expectedVersion: w.version,
    });
    const ack = weapons.acknowledgeWeaponSync({requestId: "req-dack-deploy",
      ok: true,
      assetGuid: `HertzStudioManagedWeapon_${w.id}@42`,
      assetPath: "Assets/Scenes/HertzWeaponTest.unity", ...DEPLOY_READY_ACK});
    assert.equal(ack.job.status, "applied");
    const pub = weapons.getWeapon(w.id);
    assert.equal(pub.unityDeploy.scenePath, "Assets/Scenes/HertzWeaponTest.unity");
    assert.ok(pub.unityDeploy.managedObjectId);
    assert.ok(getAsset(modelId));
    assert.equal(deploy.job.payload.tuning.damage, pub.tuning.damage);

    const mismatch = weapons.enqueueWeaponDeploy(w.id, "req-dack-mismatch", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
      sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 6,
      expectedVersion: w.version,
    });
    const mismatchAck = weapons.acknowledgeWeaponSync({
      requestId: mismatch.job.requestId,
      ok: true,
      assetGuid: `HertzStudioManagedWeapon_${w.id}@43`,
      assetPath: "Assets/Scenes/HertzCharacterTest.unity",
      ...DEPLOY_READY_ACK,
      scenePath: "Assets/Scenes/HertzCharacterTest.unity",
      sceneGuid: CHARACTER_TEST_SCENE_GUID,
    });
    assert.equal(mismatchAck.job.status, "failed");
    assert.equal(mismatchAck.job.errorCode, "target_scene_ack_mismatch");
    assert.equal(weapons.getWeapon(w.id).unityDeploy.sceneGuid, WEAPON_TEST_SCENE_GUID);

    const missing = weapons.enqueueWeaponDeploy(w.id, "req-dack-missing-identity", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
      sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 7,
      expectedVersion: w.version,
    });
    const missingAck = weapons.acknowledgeWeaponSync({
      requestId: missing.job.requestId,
      ok: true,
      assetGuid: `HertzStudioManagedWeapon_${w.id}@44`,
      assetPath: "Assets/Scenes/HertzWeaponTest.unity",
      ...DEPLOY_READY_ACK,
      sceneGuid: undefined,
    });
    assert.equal(missingAck.job.status, "failed");
    assert.equal(missingAck.job.errorCode, "target_scene_ack_missing");
    assert.equal(weapons.getWeapon(w.id).unityDeploy.sceneGuid, WEAPON_TEST_SCENE_GUID);
  });

  it("exposes runtime readiness stages and prefers runtimeModelPrefabPath for sync", () => {
    const w = weapons.upsertWeapon({
      displayName: "AnchorReady",
      role: "left_pistol",
      modelAssetId: modelId,
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    assert.equal(w.runtimeReadiness.modelImported, true);
    assert.equal(w.runtimeReadiness.definitionSynced, false);
    assert.equal(w.runtimeReadiness.anchorsValid, false);
    assert.equal(w.runtimeReadiness.runtimePlayable, false);

    const wrapPath = `Assets/HertzStudio/Weapons/Wrappers/${w.id}/Pistol_Anchored.prefab`;
    const wrapped = weapons.upsertWeapon({
      id: w.id,
      expectedVersion: w.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: {
        path: wrapPath,
        provisional: false,
        confirmed: true,
        needsConfirmation: false,
        sourcePrefabGuid: "src-guid",
      },
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle" },
    });
    assert.equal(wrapped.runtimeModelPrefabPath, wrapPath);
    const payload = weapons.buildUnitySyncPayload(w.id);
    assert.equal(payload.modelPrefabPath, wrapped.runtimeModelPrefabPath);
    assert.ok(payload.importedModelPrefabPath.includes(modelId));

    const enq = weapons.enqueueWeaponSync(w.id, "req-anchor-sync");
    weapons.acknowledgeWeaponSync({
      requestId: "req-anchor-sync",
      ok: true,
      assetGuid: "guid-anchor",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.weaponVersion,
      ...SYNC_READY_ACK,
      missingAnchors: [],
      prefabPath: wrapped.runtimeModelPrefabPath,
    });
    const afterSync = weapons.getWeapon(w.id);
    assert.equal(afterSync.unitySync.anchorsValid, true);
    assert.equal(afterSync.unitySync.runtimeDeployApplied, false);
    assert.equal(afterSync.unitySync.runtimePlayable, false);
    assert.equal(afterSync.runtimeReadiness.definitionSynced, true);
    assert.equal(afterSync.runtimeReadiness.anchorsValid, true);
    assert.equal(afterSync.runtimeReadiness.runtimePlayable, false);

    // Incomplete sync ack (omitted anchorsValid) must fail closed and keep prior applied mapping.
    const incomplete = weapons.enqueueWeaponSync(w.id, "req-anchor-incomplete");
    const priorGuid = afterSync.unitySync.assetGuid;
    const incAck = weapons.acknowledgeWeaponSync({
      requestId: "req-anchor-incomplete",
      ok: true,
      assetGuid: "guid-should-not-apply",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: incomplete.job.payloadHash,
      observedVersion: incomplete.job.weaponVersion,
      modelImported: true,
      definitionSynced: true,
      // anchorsValid omitted
    });
    assert.equal(incAck.job.status, "failed");
    assert.match(incAck.job.error, /omitted anchorsValid|incompatible|stale/i);
    const afterInc = weapons.getWeapon(w.id);
    assert.equal(afterInc.unitySync.state, "applied");
    assert.equal(afterInc.unitySync.assetGuid, priorGuid);
    assert.equal(afterInc.unitySync.anchorsValid, true);

    // Explicit false anchorsValid rejects sync success.
    const falseEnq = weapons.enqueueWeaponSync(w.id, "req-anchor-false");
    const falseAck = weapons.acknowledgeWeaponSync({
      requestId: "req-anchor-false",
      ok: true,
      assetGuid: "guid-false",
      assetPath: `Assets/HertzStudio/Weapons/Definitions/${w.id}.asset`,
      observedPayloadHash: falseEnq.job.payloadHash,
      observedVersion: falseEnq.job.weaponVersion,
      modelImported: true,
      definitionSynced: true,
      anchorsValid: false,
    });
    assert.equal(falseAck.job.status, "failed");
    assert.equal(weapons.getWeapon(w.id).unitySync.assetGuid, priorGuid);

    // Deploy missing runtimeDeployApplied fails; prior sync remains.
    const deployMissing = weapons.enqueueWeaponDeploy(w.id, "req-deploy-missing", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 1,
    });
    const depMissAck = weapons.acknowledgeWeaponSync({
      requestId: "req-deploy-missing",
      ok: true,
      assetGuid: `HertzStudioManagedWeapon_${w.id}@1`,
      assetPath: "Assets/Scenes/HertzWeaponTest.unity",
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
      sceneGuid: WEAPON_TEST_SCENE_GUID,
      modelImported: true,
      definitionSynced: true,
      anchorsValid: true,
      // runtimeDeployApplied omitted
    });
    assert.equal(depMissAck.job.status, "failed");
    assert.match(depMissAck.job.error, /runtimeDeployApplied|incompatible|stale/i);
    assert.equal(weapons.getWeapon(w.id).unityDeploy, null);
    assert.equal(weapons.getWeapon(w.id).runtimeReadiness.runtimePlayable, false);

    // Deploy with mandatory fields but omitted runtimePlayable → deploy applied, playable stays false.
    const deployOk = weapons.enqueueWeaponDeploy(w.id, "req-deploy-no-playable", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 2,
    });
    const depAck = weapons.acknowledgeWeaponSync({
      requestId: "req-deploy-no-playable",
      ok: true,
      assetGuid: `HertzStudioManagedWeapon_${w.id}@2`,
      assetPath: "Assets/Scenes/HertzWeaponTest.unity",
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
      sceneGuid: WEAPON_TEST_SCENE_GUID,
      modelImported: true,
      definitionSynced: true,
      anchorsValid: true,
      runtimeDeployApplied: true,
      // runtimePlayable omitted
    });
    assert.equal(depAck.job.status, "applied");
    const afterDeploy = weapons.getWeapon(w.id);
    assert.equal(afterDeploy.unitySync.runtimeDeployApplied, true);
    assert.equal(afterDeploy.unitySync.runtimePlayable, false);
    assert.equal(afterDeploy.runtimeReadiness.runtimePlayable, false);

    // Explicit playable true unlocks readiness.
    const deployPlay = weapons.enqueueWeaponDeploy(w.id, "req-deploy-playable", {
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
      expectedUnityRevision: 3,
    });
    weapons.acknowledgeWeaponSync({
      requestId: "req-deploy-playable",
      ok: true,
      assetGuid: `HertzStudioManagedWeapon_${w.id}@3`,
      assetPath: "Assets/Scenes/HertzWeaponTest.unity",
      ...DEPLOY_READY_ACK,
    });
    assert.equal(weapons.getWeapon(w.id).runtimeReadiness.runtimePlayable, true);
    assert.ok(deployMissing.job);
    assert.ok(deployOk.job);
    assert.ok(deployPlay.job);
  });

  it("rejects sync of unconfirmed provisional wrapper; confirm unlocks; source mapping untouched", () => {
    const base = weapons.upsertWeapon({
      displayName: "ProvisionalWrap",
      role: "left_pistol",
      modelAssetId: modelId,
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    const wrapPath = `Assets/HertzStudio/Weapons/Wrappers/${base.id}/Pistol_Anchored.prefab`;
    const w = weapons.upsertWeapon({
      id: base.id,
      expectedVersion: base.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: {
        path: wrapPath,
        provisional: true,
        confirmed: false,
        needsConfirmation: true,
        sourcePrefabGuid: "source-guid-keep",
        gripFromSource: false,
        muzzleFromSource: false,
      },
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    assert.equal(w.wrapperAnchorMeta.provisional, true);
    assert.equal(w.wrapperAnchorMeta.confirmed, false);
    assert.equal(w.wrapperAnchorMeta.needsConfirmation, true);
    assert.throws(
      () => weapons.enqueueWeaponSync(w.id, "req-prov-sync"),
      (err) => err.code === "anchors_unconfirmed",
    );
    assert.throws(
      () =>
        weapons.enqueueWeaponDeploy(w.id, "req-prov-deploy", {
          scenePath: "Assets/Scenes/HertzWeaponTest.unity",
          sceneGuid: WEAPON_TEST_SCENE_GUID,
        }),
      (err) => err.code === "anchors_unconfirmed",
    );

    const confirmed = weapons.upsertWeapon({
      id: w.id,
      expectedVersion: w.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: {
        path: wrapPath,
        provisional: false,
        confirmed: true,
        needsConfirmation: false,
        recoveryReason: null,
        confirmedAt: "2026-10-26T02:30:00.000Z",
        sourcePrefabGuid: "source-guid-keep",
        gripFromSource: false,
        muzzleFromSource: false,
      },
      tuning: w.tuning,
    });
    assert.equal(confirmed.wrapperAnchorMeta.confirmed, true);
    assert.equal(confirmed.wrapperAnchorMeta.needsConfirmation, false);
    assert.equal(confirmed.wrapperAnchorMeta.sourcePrefabGuid, "source-guid-keep");
    assert.equal(confirmed.runtimeModelPrefabPath, wrapPath);
    const enq = weapons.enqueueWeaponSync(w.id, "req-prov-sync-ok");
    assert.equal(enq.job.status, "pending_unity");
    assert.equal(enq.job.payload.modelPrefabPath, wrapPath);
    assert.ok(enq.job.payload.importedModelPrefabPath.includes(modelId));
  });

  it("legacy missing-sidecar wrapper is recoverable/unconfirmed and blocks Sync/Deploy", () => {
    const base = weapons.upsertWeapon({
      displayName: "LegacyWrap",
      role: "left_pistol",
      modelAssetId: modelId,
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    const wrapPath = `Assets/HertzStudio/Weapons/Wrappers/${base.id}/HERTZ_Pistol_Optimized_Rigged_Anchored.prefab`;
    const fromBridge = weapons.buildWrapperAnchorMetaFromBridge(base.id, {
      wrapperPrefabPath: wrapPath,
      anchorsProvisional: true,
      anchorsConfirmed: false,
      needsConfirmation: true,
      recoveryReason: "missing_metadata",
      sourcePrefabGuid: "imported-source-guid",
      idempotentReuse: true,
    });
    assert.equal(fromBridge.needsConfirmation, true);
    assert.equal(fromBridge.recoveryReason, "missing_metadata");
    assert.equal(fromBridge.confirmed, false);
    assert.equal(weapons.wrapperNeedsConfirmation(fromBridge), true);

    const w = weapons.upsertWeapon({
      id: base.id,
      expectedVersion: base.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: fromBridge,
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    assert.equal(w.wrapperAnchorMeta.needsConfirmation, true);
    assert.equal(w.wrapperAnchorMeta.recoveryReason, "missing_metadata");
    assert.equal(w.wrapperAnchorMeta.path, wrapPath);
    assert.throws(() => weapons.enqueueWeaponSync(w.id, "req-legacy-sync"), (e) => e.code === "anchors_unconfirmed");
    assert.throws(
      () => weapons.enqueueWeaponDeploy(w.id, "req-legacy-deploy", { scenePath: "Assets/Scenes/HertzWeaponTest.unity", sceneGuid: WEAPON_TEST_SCENE_GUID }),
      (e) => e.code === "anchors_unconfirmed",
    );

    const confirmed = weapons.upsertWeapon({
      id: w.id,
      expectedVersion: w.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: weapons.buildWrapperAnchorMetaFromBridge(
        w.id,
        {
          wrapperPrefabPath: wrapPath,
          sourcePrefabGuid: "imported-source-guid",
          anchorsConfirmed: true,
          anchorsProvisional: false,
          needsConfirmation: false,
        },
        { confirmedOverride: true },
      ),
      tuning: w.tuning,
    });
    assert.equal(confirmed.runtimeModelPrefabPath, wrapPath);
    assert.equal(confirmed.wrapperAnchorMeta.confirmed, true);
    assert.equal(confirmed.wrapperAnchorMeta.needsConfirmation, false);
    assert.equal(confirmed.wrapperAnchorMeta.sourcePrefabGuid, "imported-source-guid");
    const enq = weapons.enqueueWeaponSync(w.id, "req-legacy-sync-ok");
    assert.equal(enq.job.status, "pending_unity");
  });

  it("confirm path binding rejects mismatched, foreign, and traversal paths", () => {
    const base = weapons.upsertWeapon({
      displayName: "PathBind",
      role: "left_pistol",
      modelAssetId: modelId,
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    const wrapPath = `Assets/HertzStudio/Weapons/Wrappers/${base.id}/Pistol_Anchored.prefab`;
    const otherPath = `Assets/HertzStudio/Weapons/Wrappers/00000000-0000-4000-8000-000000000099/Other.prefab`;
    const w = weapons.upsertWeapon({
      id: base.id,
      expectedVersion: base.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: {
        path: wrapPath,
        provisional: true,
        confirmed: false,
        needsConfirmation: true,
        recoveryReason: "missing_metadata",
      },
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });

    assert.equal(weapons.resolveConfirmWrapperPath(w, null), wrapPath);
    assert.equal(weapons.resolveConfirmWrapperPath(w, wrapPath), wrapPath);
    assert.throws(() => weapons.resolveConfirmWrapperPath(w, otherPath), (e) => e.code === "wrapper_path_mismatch");
    assert.throws(
      () => weapons.resolveConfirmWrapperPath(w, "Assets/HertzStudio/Weapons/Wrappers/../Definitions/x.prefab"),
      (e) => e.code === "wrapper_path_mismatch" || e.code === "wrapper_path_invalid",
    );
    assert.equal(weapons.normalizeWeaponAssetPath("Assets/HertzStudio/Weapons/Wrappers/../x.prefab"), null);
    assert.equal(weapons.normalizeWeaponAssetPath("C:/Windows/x.prefab"), null);
    assert.equal(weapons.isManagedWrapperPathForWeapon(otherPath, w.id), false);
    assert.equal(weapons.isManagedWrapperPathForWeapon(wrapPath, w.id), true);

    assert.throws(
      () =>
        weapons.upsertWeapon({
          id: w.id,
          expectedVersion: w.version,
          runtimeModelPrefabPath: otherPath,
          tuning: w.tuning,
        }),
      (e) => e.code === "wrapper_path_invalid",
    );
  });

  it("direct valid anchors without managed wrapper still enqueue Sync", () => {
    const w = weapons.upsertWeapon({
      displayName: "DirectAnchors",
      role: "left_pistol",
      modelAssetId: modelId,
      runtimeModelPrefabPath: null,
      wrapperAnchorMeta: null,
      tuning: {
        gripAnchor: "GripAttach",
        muzzleAnchor: "MuzzlePoint",
        damage: 10,
        fireIntervalSeconds: 0.2,
        rangeMeters: 40,
        recoil: 0.15,
      },
    });
    assert.equal(w.wrapperAnchorMeta, null);
    const enq = weapons.enqueueWeaponSync(w.id, "req-direct-sync");
    assert.equal(enq.job.status, "pending_unity");
    assert.ok(enq.job.payload.modelPrefabPath.includes(modelId) || enq.job.payload.importedModelPrefabPath.includes(modelId));
  });

  it("authoritative source binding rejects caller substitution and model-change keeps wrapper stale", () => {
    const w = weapons.upsertWeapon({
      displayName: "SourceBind",
      role: "left_pistol",
      modelAssetId: modelId,
      tuning: { gripAnchor: "Grip", muzzleAnchor: "Muzzle", damage: 10, fireIntervalSeconds: 0.2, rangeMeters: 40, recoil: 0.15 },
    });
    const auth = weapons.resolveAuthoritativeWeaponSourcePrefab(w);
    assert.equal(auth.sourcePrefabPath, `Assets/HertzStudio/Imported/${modelId}/Pistol.prefab`);
    assert.equal(auth.sourcePrefabGuid, "guid-model-a-aaaa");
    assert.equal(
      weapons.resolveAuthoritativeWeaponSourcePrefab(w, {
        requestedPath: `Assets/HertzStudio/Imported/${modelId}/Pistol.prefab`,
      }).sourcePrefabPath,
      auth.sourcePrefabPath,
    );
    // Alternate spelling / separators of the same path.
    assert.equal(
      weapons.resolveAuthoritativeWeaponSourcePrefab(w, {
        requestedPath: `Assets\\HertzStudio\\Imported\\${modelId}\\Pistol.prefab`,
      }).sourcePrefabPath,
      auth.sourcePrefabPath,
    );
    assert.throws(
      () =>
        weapons.resolveAuthoritativeWeaponSourcePrefab(w, {
          requestedPath: `Assets/HertzStudio/Imported/${modelIdB}/Pistol.prefab`,
        }),
      (e) => e.code === "wrapper_source_mismatch",
    );
    assert.throws(
      () =>
        weapons.resolveAuthoritativeWeaponSourcePrefab(w, {
          requestedPath: "Assets/HertzStudio/Imported/../Weapons/Wrappers/x.prefab",
        }),
      (e) => e.code === "wrapper_source_mismatch",
    );
    assert.throws(
      () =>
        weapons.resolveAuthoritativeWeaponSourcePrefab(w, {
          requestedPath: "C:/Windows/System32/fake.prefab",
        }),
      (e) => e.code === "wrapper_source_mismatch",
    );

    const wrapPath = `Assets/HertzStudio/Weapons/Wrappers/${w.id}/Pistol_Anchored.prefab`;
    const withWrap = weapons.upsertWeapon({
      id: w.id,
      expectedVersion: w.version,
      runtimeModelPrefabPath: wrapPath,
      wrapperAnchorMeta: {
        path: wrapPath,
        provisional: false,
        confirmed: true,
        needsConfirmation: false,
        sourcePrefabPath: auth.sourcePrefabPath,
        sourcePrefabGuid: auth.sourcePrefabGuid,
        modelAssetId: modelId,
      },
      tuning: w.tuning,
    });
    assert.equal(withWrap.wrapperAnchorMeta.sourcePrefabGuid, "guid-model-a-aaaa");

    // Same filename, different GUID/path via model B — clears incompatible wrapper.
    const swapped = weapons.upsertWeapon({
      id: withWrap.id,
      expectedVersion: withWrap.version,
      modelAssetId: modelIdB,
      tuning: withWrap.tuning,
    });
    assert.equal(swapped.modelAssetId, modelIdB);
    assert.equal(swapped.runtimeModelPrefabPath, null);
    assert.equal(swapped.wrapperAnchorMeta, null);
    assert.equal(swapped.unitySync.anchorsValid, false);

    const authB = weapons.resolveAuthoritativeWeaponSourcePrefab(swapped);
    assert.equal(authB.sourcePrefabGuid, "guid-model-b-bbbb");
    assert.notEqual(authB.sourcePrefabPath, auth.sourcePrefabPath);
  });

  it("buildWrapperAnchorMetaFromBridge records source association for recovery", () => {
    const wid = "11111111-1111-4111-8111-111111111111";
    const path = `Assets/HertzStudio/Weapons/Wrappers/${wid}/Pistol_Anchored.prefab`;
    const meta = weapons.buildWrapperAnchorMetaFromBridge(wid, {
      wrapperPrefabPath: path,
      sourcePrefabPath: `Assets/HertzStudio/Imported/${modelId}/Pistol.prefab`,
      sourcePrefabGuid: "guid-model-a-aaaa",
      modelAssetId: modelId,
      needsConfirmation: true,
      recoveryReason: "missing_metadata",
      anchorsProvisional: true,
      anchorsConfirmed: false,
    });
    assert.equal(meta.sourcePrefabPath, `Assets/HertzStudio/Imported/${modelId}/Pistol.prefab`);
    assert.equal(meta.sourcePrefabGuid, "guid-model-a-aaaa");
    assert.equal(meta.modelAssetId, modelId);
    assert.equal(meta.needsConfirmation, true);
    assert.equal(meta.confirmed, false);
  });
});
