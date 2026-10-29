import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_METADATA_SCHEMA,
  validateTargetForOperation,
  validateDropFreshness,
} from "./target-checks.mjs";
import { validateTypedDrop } from "./target-validation.mjs";

const mesh = {
  objectId: "mesh-1",
  unityObjectId: "gid-mesh",
  targetMetadataSchema: TARGET_METADATA_SCHEMA,
  hasRenderer: true,
  rendererType: "MeshRenderer",
  materialSlotCount: 2,
  surfaceKind: "wall",
  surfaceKindSource: "component",
};

const cam = {
  objectId: "cam-1",
  unityObjectId: "gid-cam",
  name: "Main Camera",
  renderCategory: "camera",
  targetMetadataSchema: TARGET_METADATA_SCHEMA,
};

const audio = {
  objectId: "audio-1",
  unityObjectId: "gid-audio",
  targetMetadataSchema: TARGET_METADATA_SCHEMA,
  hasAudioSource: true,
};

const stale = {
  objectId: "old",
  unityObjectId: "gid-old",
  hasRenderer: true,
  materialSlotCount: 1,
};

describe("validateTargetForOperation", () => {
  it("accepts valid material slot", () => {
    const r = validateTargetForOperation("assign_material", mesh, 1);
    assert.equal(r.ok, true);
  });

  it("rejects invalid material slot", () => {
    const r = validateTargetForOperation("assign_material", mesh, 5);
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid_slot");
  });

  it("rejects incompatible audio target", () => {
    const r = validateTargetForOperation("assign_audio", mesh, 0);
    assert.equal(r.ok, false);
    assert.equal(r.code, "incompatible_target");
  });

  it("accepts audio target with AudioSource", () => {
    assert.equal(validateTargetForOperation("assign_audio", audio).ok, true);
  });

  it("rejects protected camera", () => {
    const r = validateTargetForOperation("assign_material", cam, 0);
    assert.equal(r.ok, false);
    assert.equal(r.code, "protected");
  });

  it("rejects missing target", () => {
    assert.equal(validateTargetForOperation("assign_material", null).code, "missing_target");
  });

  it("rejects stale metadata", () => {
    const r = validateTargetForOperation("assign_material", stale, 0);
    assert.equal(r.ok, false);
    assert.equal(r.code, "stale_metadata");
  });

  it("rejects invalid floor/wall target", () => {
    const r = validateTargetForOperation("replace_floor_wall", { ...mesh, surfaceKind: null });
    assert.equal(r.code, "invalid_floor_wall_target");
  });

  it("accepts authoritative wall replace", () => {
    assert.equal(validateTargetForOperation("replace_floor_wall", mesh).ok, true);
  });

  it("rejects geometry suggestion without component marker", () => {
    const r = validateTargetForOperation("replace_floor_wall", {
      ...mesh,
      surfaceKind: null,
      surfaceKindSource: "none",
      surfaceKindSuggested: "floor",
    });
    assert.equal(r.code, "invalid_floor_wall_target");
  });
});

describe("validateDropFreshness", () => {
  const draft = {
    id: "d1",
    version: 10,
    scenePath: "Assets/Scenes/HertzStudioTest.unity",
    baseUnityRevision: 5000,
    exportGeneration: 3,
    objects: [mesh],
  };

  it("rejects stale draft version with 409", () => {
    const r = validateDropFreshness({
      draft,
      expectedDraftVersion: 9,
      expectedScenePath: draft.scenePath,
      expectedUnityRevision: 5000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.code, "stale_draft_version");
  });

  it("rejects wrong scene", () => {
    const r = validateDropFreshness({
      draft,
      expectedDraftVersion: 10,
      expectedScenePath: "Assets/Scenes/SampleScene.unity",
      expectedUnityRevision: 5000,
    });
    assert.equal(r.code, "stale_scene");
    assert.equal(r.status, 409);
  });

  it("rejects stale unity revision", () => {
    const r = validateDropFreshness({
      draft,
      expectedDraftVersion: 10,
      expectedScenePath: draft.scenePath,
      expectedUnityRevision: 4999,
    });
    assert.equal(r.code, "stale_unity_revision");
  });

  it("rejects stale export generation", () => {
    const r = validateDropFreshness({
      draft,
      expectedDraftVersion: 10,
      expectedScenePath: draft.scenePath,
      expectedUnityRevision: 5000,
      expectedExportGeneration: 1,
    });
    assert.equal(r.code, "stale_export_generation");
  });
});

describe("validateTypedDrop freshness binding", () => {
  it("requires draftId/draft and freshness fields", () => {
    const r = validateTypedDrop({
      assetId: "00000000-0000-4000-8000-000000000001",
      claimedType: "model_3d",
      operation: "instantiate_model",
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "missing_draft");
  });
});
