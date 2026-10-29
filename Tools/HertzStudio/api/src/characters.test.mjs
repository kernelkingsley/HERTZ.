import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w05-chars-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const modelId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const animIdleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const animAttackId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [modelId]: {
        id: modelId,
        displayName: "W05 Test Character Mesh",
        assetType: "model_3d",
        state: "unity_imported",
        unity: {
          readiness: "ready",
          prefabPath: `Assets/HertzStudio/Imported/${modelId}/Char.prefab`,
          importedPath: `Assets/HertzStudio/Imported/${modelId}/scene.gltf`,
        },
      },
      [animIdleId]: {
        id: animIdleId,
        displayName: "Idle Clip",
        assetType: "animation",
        state: "unity_imported",
        unity: {
          readiness: "ready",
          clipPath: `Assets/HertzStudio/Imported/${animIdleId}/Idle.anim`,
        },
      },
      [animAttackId]: {
        id: animAttackId,
        displayName: "Attack Controller",
        assetType: "animation",
        state: "unity_imported",
        unity: {
          readiness: "ready",
          controllerPath: `Assets/HertzStudio/Imported/${animAttackId}/Attack.controller`,
        },
      },
    },
    jobs: [],
    uploads: {},
  }),
  "utf8",
);
fs.writeFileSync(path.join(dataDir, "store.json"), "{}\n");

const characters = await import("./characters.mjs");

describe("W05 characters API", () => {
  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects replaceTrackedXrRig and invalid behavior mode", () => {
    assert.throws(
      () => characters.upsertCharacterModel({ displayName: "X", replaceTrackedXrRig: true }),
      (e) => e.code === "invalid_character_safety",
    );
    assert.throws(
      () =>
        characters.upsertEnemyProfile({
          displayName: "Bad",
          behavior: { mode: "fly" },
        }),
      (e) => e.code === "invalid_behavior",
    );
  });

  it("separates model and profile; profile may only link enemy_visual", () => {
    const player = characters.upsertCharacterModel({
      displayName: "Boy",
      kind: "player_character",
      modelAssetId: modelId,
    });
    const enemyModel = characters.upsertCharacterModel({
      displayName: "Spirit Mesh",
      kind: "enemy_visual",
      modelAssetId: modelId,
    });
    assert.throws(
      () =>
        characters.upsertEnemyProfile({
          displayName: "BadLink",
          modelId: player.id,
          behavior: { mode: "hold_position" },
        }),
      (e) => e.code === "invalid_model_ref",
    );
    const profile = characters.upsertEnemyProfile({
      displayName: "Hold Spirit",
      modelId: enemyModel.id,
      behavior: {
        mode: "hold_position",
        waitReactionDelaySeconds: 0.5,
        moveSpeed: 2,
      },
    });
    assert.equal(profile.modelId, enemyModel.id);
    assert.equal(profile.behavior.mode, "hold_position");
  });

  it("model delete blocked by profile ref", () => {
    const enemyModel = characters.upsertCharacterModel({
      displayName: "Spirit Mesh 2",
      kind: "enemy_visual",
      modelAssetId: modelId,
    });
    characters.upsertEnemyProfile({
      displayName: "P",
      modelId: enemyModel.id,
      behavior: { mode: "rush" },
    });
    assert.throws(() => characters.deleteCharacterModel(enemyModel.id), (e) => {
      return e.code === "dependency_blocked" && e.dependencies.some((d) => d.kind === "enemy_profile_ref");
    });
  });

  it("sync + ack preserves GUID; unity delete then catalog remove", () => {
    const model = characters.upsertCharacterModel({
      displayName: "Spirit Mesh Sync",
      kind: "enemy_visual",
      modelAssetId: modelId,
    });
    const enq = characters.enqueueCharacterModelSync(model.id, "req-char-sync-1");
    assert.equal(enq.job.type, "sync_character_model");
    const ack = characters.acknowledgeCharacterSync({
      requestId: "req-char-sync-1",
      ok: true,
      assetGuid: "guid-char-1",
      assetPath: `Assets/HertzStudio/Characters/Models/${model.id}.asset`,
      observedPayloadHash: enq.job.payloadHash,
      observedVersion: enq.job.entityVersion,
    });
    assert.equal(ack.job.status, "applied");
    assert.equal(characters.getCharacterModel(model.id).unitySync.assetGuid, "guid-char-1");

    assert.throws(() => characters.deleteCharacterModel(model.id), (e) => e.code === "dependency_blocked");

    const del = characters.enqueueCharacterUnityDelete("model", model.id, "req-char-del-1");
    assert.equal(del.job.type, "delete_character_definition");
    characters.acknowledgeCharacterSync({ requestId: "req-char-del-1", ok: true });
    const removed = characters.deleteCharacterModel(model.id, { unityResolution: "unity_deleted" });
    assert.equal(removed.deleted, true);
    assert.equal(characters.getCharacterModel(model.id), null);
  });

  it("restart recovery requeues applying character jobs", () => {
    const profile = characters.upsertEnemyProfile({
      displayName: "Rush",
      behavior: { mode: "rush", approachDistanceMeters: 2 },
    });
    const enq = characters.enqueueEnemyProfileSync(profile.id, "req-prof-1");
    characters.markCharacterJobApplying(enq.job.id);
    const recovered = characters.recoverCharacterJobsOnBoot();
    assert.ok(recovered.recovered >= 1);
    const job = characters.nextCharacterJob();
    assert.equal(job.status, "pending_unity");
    assert.equal(job.type, "sync_enemy_profile");
  });

  it("payload hash stable for identical canonical fields", () => {
    const a = characters.upsertEnemyProfile({
      displayName: "Same",
      behavior: {
        mode: "idle",
        moveSpeed: 1.5,
        detectionRangeMeters: 10,
        attackRangeMeters: 5,
        waitReactionDelaySeconds: 0.2,
        shotBurstIntervalSeconds: 1,
        approachDistanceMeters: 2,
      },
    });
    const h1 = characters.enemyProfilePayloadHash(a);
    const again = characters.getEnemyProfile(a.id);
    assert.equal(characters.enemyProfilePayloadHash(again), h1);
  });

  it("assigns idle/attack animation slots and includes paths in sync payload", () => {
    assert.throws(
      () =>
        characters.upsertCharacterModel({
          displayName: "BadAnim",
          kind: "enemy_visual",
          modelAssetId: modelId,
          animations: { idle: "not-a-uuid" },
        }),
      (e) => e.code === "invalid_animation",
    );
    const model = characters.upsertCharacterModel({
      displayName: "Animated Spirit",
      kind: "enemy_visual",
      modelAssetId: modelId,
      animations: { idle: animIdleId, attack: animAttackId, locomotion: null },
    });
    assert.equal(model.animations.idle, animIdleId);
    assert.equal(model.animations.attack, animAttackId);
    assert.equal(model.animations.locomotion, null);
    const payload = characters.buildCharacterModelSyncPayload(model.id);
    assert.equal(payload.animationPaths.idle, `Assets/HertzStudio/Imported/${animIdleId}/Idle.anim`);
    assert.equal(
      payload.animationPaths.attack,
      `Assets/HertzStudio/Imported/${animAttackId}/Attack.controller`,
    );
    const ready = characters.listReadyAnimations();
    assert.ok(ready.some((a) => a.id === animIdleId));
  });

  it("lists all model_3d for picker; only Unity-imported are assignable", () => {
    const catalogPath = path.join(dataDir, "assets-catalog.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const previewId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const failedId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    catalog.assets[previewId] = {
      id: previewId,
      displayName: "Preview Only Human",
      assetType: "model_3d",
      state: "preview_ready",
      unity: { readiness: "pending" },
    };
    catalog.assets[failedId] = {
      id: failedId,
      displayName: "Failed Human",
      assetType: "model_3d",
      state: "failed",
      importError: "bridge timeout",
      unity: { readiness: "failed", lastError: "bridge timeout" },
    };
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const library = characters.listCharacterModelLibrary();
    assert.ok(library.some((m) => m.id === modelId && m.assignable === true && m.canAddToCatalog === true));
    const pending = library.find((m) => m.id === previewId);
    assert.ok(pending);
    assert.equal(pending.assignable, false);
    assert.equal(pending.canAddToCatalog, false);
    assert.equal(pending.browserPreviewReady, true);
    assert.equal(pending.canEnqueueImport, true);
    assert.match(pending.blockReason || "", /Import to Unity|preview/i);
    const failed = library.find((m) => m.id === failedId);
    assert.equal(failed.canRetryImport, true);
    assert.equal(failed.canEnqueueImport, true);
    assert.match(failed.lastError || "", /timeout/i);
    const readyOnly = characters.listReadyCharacterModels();
    assert.ok(readyOnly.every((m) => m.assignable));
    assert.ok(!readyOnly.some((m) => m.id === previewId));
  });

  it("saves catalog entry linked to library modelAssetId without deleting the asset", () => {
    const created = characters.upsertCharacterModel({
      displayName: "From Library",
      kind: "enemy_visual",
      modelAssetId: modelId,
      scale: 1,
    });
    assert.equal(created.modelAssetId, modelId);
    const again = characters.getCharacterModel(created.id);
    assert.equal(again.modelAssetId, modelId);
    const player = characters.upsertCharacterModel({
      displayName: "Player From Same Mesh",
      kind: "player_character",
      modelAssetId: modelId,
      scale: 1,
    });
    assert.notEqual(player.id, created.id);
    assert.equal(player.modelAssetId, modelId);
    characters.deleteCharacterModel(created.id);
    assert.equal(characters.getCharacterModel(created.id), null);
    const catalog = JSON.parse(fs.readFileSync(path.join(dataDir, "assets-catalog.json"), "utf8"));
    assert.ok(catalog.assets[modelId], "Asset Library mesh must survive catalog remove");
  });

  it("animation compatibility probe stays pending without Unity evidence", () => {
    const probe = characters.resolveAnimationCompatibilityProbe({
      modelAssetId: modelId,
      animationAssetId: animIdleId,
      slot: "idle",
    });
    assert.equal(probe.unityCompatibility.status, "pending");
    assert.equal(probe.unityCompatibility.source, null);
    const verified = characters.resolveAnimationCompatibilityProbe({
      modelAssetId: modelId,
      animationAssetId: animIdleId,
      slot: "idle",
      unityResult: {
        compatible: true,
        source: "unity_bridge",
        reason: "Animator present",
      },
    });
    assert.equal(verified.unityCompatibility.status, "unity_verified");
    assert.equal(verified.unityCompatibility.source, "unity_bridge");
  });

  it("managed deploy binds the shared scene and preserves definition mappings", () => {
    const model = characters.upsertCharacterModel({ displayName: "Managed Spirit", kind: "enemy_visual", modelAssetId: modelId });
    const modelSync = characters.enqueueCharacterModelSync(model.id, "req-managed-model-sync");
    characters.acknowledgeCharacterSync({ requestId: "req-managed-model-sync", ok: true, assetGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", assetPath: `Assets/HertzStudio/Characters/Models/${model.id}.asset`, observedPayloadHash: modelSync.job.payloadHash, observedVersion: modelSync.job.entityVersion });
    const profile = characters.upsertEnemyProfile({ displayName: "Managed Hold", modelId: model.id, behavior: { mode: "hold_position" } });
    const profileSync = characters.enqueueEnemyProfileSync(profile.id, "req-managed-profile-sync");
    characters.acknowledgeCharacterSync({ requestId: "req-managed-profile-sync", ok: true, assetGuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", assetPath: `Assets/HertzStudio/Characters/Profiles/${profile.id}.asset`, observedPayloadHash: profileSync.job.payloadHash, observedVersion: profileSync.job.entityVersion });

    const options = { profileId: profile.id, scenePath: "Assets/Scenes/SampleScene.unity", sceneGuid: "33333333333333333333333333333333", expectedUnityRevision: 46, confirmSave: true, expectedVersion: model.version, quantity: 2, position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const conflictJob = characters.enqueueCharacterDeploy(model.id, "req-managed-deploy-conflict", options);
    assert.equal(conflictJob.job.type, "deploy_character_runtime");
    assert.equal(conflictJob.job.payload.sceneGuid, options.sceneGuid);
    const conflictAck = characters.acknowledgeCharacterSync({ requestId: "req-managed-deploy-conflict", ok: true, scenePath: "Assets/Scenes/Other.unity", sceneGuid: options.sceneGuid, managedObjectIds: ["a", "b"], unityRevision: 47 });
    assert.equal(conflictAck.job.status, "conflict");

    const deployJob = characters.enqueueCharacterDeploy(model.id, "req-managed-deploy-ok", options);
    const applied = characters.acknowledgeCharacterSync({ requestId: "req-managed-deploy-ok", ok: true, scenePath: options.scenePath, sceneGuid: options.sceneGuid, managedObjectIds: ["GlobalObjectId_A", "GlobalObjectId_B"], unityRevision: 47 });
    assert.equal(applied.job.status, "applied");
    assert.equal(applied.entity.unityDeploy.scenePath, options.scenePath);
    assert.equal(applied.entity.unityDeploy.managedObjectIds.length, 2);
    assert.equal(characters.buildCharacterModelSyncPayload(model.id).expectedAssetGuid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.throws(() => characters.enqueueCharacterDeploy(model.id, "req-managed-bad-transform", { ...options, position: { x: Number.NaN, y: 0, z: 0 } }), (error) => error.code === "invalid_transform");
  });
});
