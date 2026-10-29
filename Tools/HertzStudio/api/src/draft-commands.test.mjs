import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceTransformBaselineAfterApply,
  buildApplyOperations,
  captureUnityTransformBaseline,
  objectTransformChanged,
  shouldEmitTransformOp,
} from "./draft-commands.mjs";

function root(overrides = {}) {
  return {
    objectId: "root-1",
    unityObjectId: "gid-root",
    name: "Armored cat",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    localPosition: { x: 0, y: 0, z: 0 },
    localRotation: { x: 0, y: 0, z: 0 },
    localScale: { x: 1, y: 1, z: 1 },
    ...overrides,
  };
}

function child(overrides = {}) {
  return {
    objectId: "child-1",
    unityObjectId: "gid-child",
    parentObjectId: "root-1",
    name: "cat_mesh",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    localPosition: { x: 0, y: 0, z: 0 },
    localRotation: { x: 0, y: 0, z: 0 },
    localScale: { x: 1, y: 1, z: 1 },
    ...overrides,
  };
}

describe("buildApplyOperations changed-object transforms", () => {
  it("moving a root does not emit transforms for unchanged descendants", () => {
    const objects = [root(), child()];
    const baseline = captureUnityTransformBaseline(objects);
    const moved = [
      root({ position: { x: 2, y: 0, z: 0 }, localPosition: { x: 2, y: 0, z: 0 } }),
      child(), // stale world ok — local unchanged vs baseline
    ];
    const built = buildApplyOperations({ objects: moved, unityTransformBaseline: baseline });
    assert.equal(built.errors.length, 0);
    assert.equal(built.operations.length, 1);
    assert.equal(built.operations[0].draftObjectId, "root-1");
    assert.equal(built.operations[0].space, "world");
    assert.deepEqual(built.operations[0].position, { x: 2, y: 0, z: 0 });
  });

  it("directly moving a child emits its local transform", () => {
    const objects = [root(), child()];
    const baseline = captureUnityTransformBaseline(objects);
    const moved = [
      root(),
      child({
        localPosition: { x: 0.5, y: 0.25, z: -0.1 },
        position: { x: 0.5, y: 0.25, z: -0.1 },
      }),
    ];
    const built = buildApplyOperations({ objects: moved, unityTransformBaseline: baseline });
    assert.equal(built.operations.length, 1);
    assert.equal(built.operations[0].draftObjectId, "child-1");
    assert.equal(built.operations[0].space, "local");
    assert.deepEqual(built.operations[0].localPosition, { x: 0.5, y: 0.25, z: -0.1 });
  });

  it("unchanged objects produce no transform operation", () => {
    const objects = [root(), child()];
    const baseline = captureUnityTransformBaseline(objects);
    const built = buildApplyOperations({ objects, unityTransformBaseline: baseline });
    assert.equal(built.operations.length, 0);
  });

  it("emits both parent and child when both intentionally changed", () => {
    const objects = [root(), child()];
    const baseline = captureUnityTransformBaseline(objects);
    const moved = [
      root({ position: { x: 1, y: 0, z: 0 }, localPosition: { x: 1, y: 0, z: 0 } }),
      child({ localPosition: { x: 0, y: 1, z: 0 }, position: { x: 1, y: 1, z: 0 } }),
    ];
    const built = buildApplyOperations({ objects: moved, unityTransformBaseline: baseline });
    assert.equal(built.operations.length, 2);
    const spaces = built.operations.map((o) => `${o.draftObjectId}:${o.space}`).sort();
    assert.deepEqual(spaces, ["child-1:local", "root-1:world"]);
  });

  it("orphan with missing parent still emits when changed (by objectId)", () => {
    const orphan = child({ parentObjectId: "missing-parent", localPosition: { x: 3, y: 0, z: 0 } });
    const baseline = captureUnityTransformBaseline([child({ parentObjectId: "missing-parent" })]);
    assert.equal(objectTransformChanged(orphan, baseline), true);
    const built = buildApplyOperations({
      objects: [orphan],
      unityTransformBaseline: baseline,
    });
    assert.equal(built.operations.length, 1);
    // Parent missing from draft → treated as world root for Apply space.
    assert.equal(built.operations[0].space, "world");
  });

  it("protected camera/XR objects never produce transform operations", () => {
    const cam = root({
      objectId: "cam-1",
      unityObjectId: "gid-cam",
      name: "Main Camera",
      renderRole: "camera",
      position: { x: 9, y: 9, z: 9 },
      localPosition: { x: 9, y: 9, z: 9 },
    });
    const xr = root({
      objectId: "xr-1",
      unityObjectId: "gid-xr",
      name: "XR Origin Hands (XR Rig)",
      position: { x: 1, y: 2, z: 3 },
      localPosition: { x: 1, y: 2, z: 3 },
    });
    const baseline = captureUnityTransformBaseline([
      { ...cam, position: { x: 0, y: 0, z: 0 }, localPosition: { x: 0, y: 0, z: 0 } },
      { ...xr, position: { x: 0, y: 0, z: 0 }, localPosition: { x: 0, y: 0, z: 0 } },
    ]);
    const built = buildApplyOperations({ objects: [cam, xr], unityTransformBaseline: baseline });
    assert.equal(built.operations.length, 0);
    assert.equal(shouldEmitTransformOp(cam, null, baseline), false);
  });

  it("identifies objects by stable objectId not array index", () => {
    const a = root({ objectId: "a", unityObjectId: "gid-a" });
    const b = root({ objectId: "b", unityObjectId: "gid-b", name: "Other" });
    const baseline = captureUnityTransformBaseline([a, b]);
    // Swap array order; only b moved.
    const built = buildApplyOperations({
      objects: [
        { ...b, position: { x: 5, y: 0, z: 0 }, localPosition: { x: 5, y: 0, z: 0 } },
        a,
      ],
      unityTransformBaseline: baseline,
    });
    assert.equal(built.operations.length, 1);
    assert.equal(built.operations[0].draftObjectId, "b");
  });

  it("advances baseline after apply so a second apply is a no-op", () => {
    const objects = [root({ position: { x: 2, y: 0, z: 0 }, localPosition: { x: 2, y: 0, z: 0 } })];
    const draft = {
      objects,
      unityTransformBaseline: captureUnityTransformBaseline([root()]),
    };
    const first = buildApplyOperations(draft);
    assert.equal(first.operations.length, 1);
    advanceTransformBaselineAfterApply(draft, first.operations);
    const second = buildApplyOperations(draft);
    assert.equal(second.operations.length, 0);
  });
});
