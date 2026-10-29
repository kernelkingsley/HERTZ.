import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VALIDATION_STATUS,
  validateDraftObject,
  validateDraftScene,
} from "./walkability.mjs";

describe("walkability validation", () => {
  it("marks missing collider invalid and blocking", () => {
    const row = validateDraftObject({
      objectId: "floor-1",
      name: "Floor",
      surfaceKind: "floor",
      surfaceKindSource: "component",
      collider: { present: false },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
    });
    assert.equal(row.status, VALIDATION_STATUS.INVALID);
    assert.equal(row.blocksApply, true);
  });

  it("marks trigger-only collider invalid", () => {
    const row = validateDraftObject({
      objectId: "wall-1",
      name: "Wall_Left",
      surfaceKind: "wall",
      surfaceKindSource: "component",
      collider: { present: true, enabled: true, isTrigger: true, hasNonTrigger: false },
      scale: { x: 1, y: 1, z: 1 },
    });
    assert.equal(row.status, VALIDATION_STATUS.INVALID);
  });

  it("marks steep floor invalid", () => {
    const row = validateDraftObject({
      objectId: "floor-2",
      name: "Floor",
      surfaceKind: "floor",
      surfaceKindSource: "component",
      collider: { present: true, enabled: true, isTrigger: false },
      rotation: { x: 50, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    assert.equal(row.status, VALIDATION_STATUS.INVALID);
  });

  it("excludes protected XR objects", () => {
    const row = validateDraftObject({ objectId: "xr", name: "XR Origin", renderCategory: "xr_protected" });
    assert.equal(row.excluded, true);
    assert.equal(row.status, VALIDATION_STATUS.VALID);
  });

  it("unknown collider is not Valid and does not block Apply", () => {
    const row = validateDraftObject({
      objectId: "floor-3",
      name: "Floor",
      surfaceKind: "floor",
      surfaceKindSource: "component",
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
    });
    assert.equal(row.status, VALIDATION_STATUS.UNKNOWN);
    assert.equal(row.blocksApply, false);
  });

  it("name-only floor without marker is not an environment surface", () => {
    const row = validateDraftObject({
      objectId: "named",
      name: "Floor_01",
      surfaceKindSuggested: "floor",
      surfaceKindSource: "none",
      targetMetadataSchema: 1,
    });
    assert.equal(row.status, VALIDATION_STATUS.UNKNOWN);
    assert.equal(row.blocksApply, false);
  });

  it("explicit component floor is classified", () => {
    const row = validateDraftObject({
      objectId: "marked",
      name: "Prop",
      surfaceKind: "floor",
      surfaceKindSource: "component",
      collider: { present: true, enabled: true, isTrigger: false },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });
    assert.equal(row.status, VALIDATION_STATUS.VALID);
    assert.equal(row.surfaceKind, "floor");
  });

  it("scene summary aggregates statuses", () => {
    const scene = validateDraftScene({
      objects: [
        {
          objectId: "a",
          name: "Floor",
          surfaceKind: "floor",
          surfaceKindSource: "component",
          collider: { present: true, enabled: true, isTrigger: false },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        {
          objectId: "b",
          name: "Wall",
          surfaceKind: "wall",
          surfaceKindSource: "component",
          collider: { present: false },
          scale: { x: 1, y: 1, z: 1 },
        },
      ],
    });
    assert.equal(scene.status, VALIDATION_STATUS.INVALID);
    assert.equal(scene.blocksApply, true);
    assert.ok(scene.counts.invalid >= 1);
  });
});
