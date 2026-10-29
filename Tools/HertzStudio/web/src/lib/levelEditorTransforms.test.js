import { describe, expect, it } from "vitest";
import {
  applyTransformCommitByObjectId,
  applyViewportTransformToObject,
  buildNumericTransformPayload,
  DEFAULT_POSITION_SNAP,
  formValuesFromObject,
  isProtectedDraftObject,
  normalizeEulerDegrees,
  shouldEmitThrottled,
  snapEulerDegrees,
  snapScalar,
  snapScaleVec,
  snapVec3,
  usesLocalNumericEdit,
} from "./levelEditorTransforms.js";
import { assertFreshApplySave, buildSaveObjectsFromDraft } from "./levelEditorSceneViewport.js";

describe("levelEditorTransforms", () => {
  it("snaps scalars and vectors to the grid step", () => {
    expect(snapScalar(1.2, 0.25)).toBe(1.25);
    expect(snapVec3({ x: 0.1, y: 0.4, z: -0.3 }, DEFAULT_POSITION_SNAP)).toEqual({
      x: 0,
      y: 0.5,
      z: -0.25,
    });
  });

  it("snaps euler degrees and normalizes to [-180,180]", () => {
    expect(normalizeEulerDegrees(370)).toBe(10);
    expect(snapEulerDegrees({ x: 7, y: 22, z: -8 }, 15)).toEqual({ x: 0, y: 15, z: -15 });
  });

  it("keeps snapped scale above zero", () => {
    expect(snapScaleVec({ x: 0.01, y: -1, z: 1.04 }, 0.1)).toEqual({ x: 0.01, y: 0.01, z: 1 });
  });

  it("blocks XR/camera objects from viewport transforms", () => {
    expect(isProtectedDraftObject({ name: "XR Rig" })).toBe(true);
    expect(isProtectedDraftObject({ objectId: "main-camera" })).toBe(true);
    expect(isProtectedDraftObject({ name: "Crate" })).toBe(false);
    const protectedObj = { name: "XR Rig", position: { x: 1, y: 2, z: 3 } };
    expect(
      applyViewportTransformToObject(protectedObj, { position: { x: 9, y: 9, z: 9 } }, { snap: true }),
    ).toBe(protectedObj);
  });

  it("applies snapped transform commits onto draft objects", () => {
    const next = applyViewportTransformToObject(
      {
        objectId: "crate",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      {
        position: { x: 1.2, y: 0.1, z: -0.3 },
        rotation: { x: 10, y: 40, z: 2 },
        scale: { x: 1.12, y: 0.96, z: 2.01 },
      },
      { snap: true, snaps: { position: 0.25, rotationDeg: 15, scale: 0.1 } },
    );
    expect(next.position).toEqual({ x: 1.25, y: 0, z: -0.25 });
    expect(next.rotation).toEqual({ x: 15, y: 45, z: 0 });
    expect(next.scale).toEqual({ x: 1.1, y: 1, z: 2 });
    // Unparented: local* mirrors world so viewport sync cannot snap back.
    expect(next.localPosition).toEqual(next.position);
    expect(next.localRotation).toEqual(next.rotation);
    expect(next.localScale).toEqual(next.scale);
  });

  it("persists local* from viewport commits so hierarchy sync does not snap back", () => {
    const next = applyViewportTransformToObject(
      {
        objectId: "cat",
        parentObjectId: null,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        localPosition: { x: 0, y: 0, z: 0 },
        localRotation: { x: 0, y: 0, z: 0 },
        localScale: { x: 1, y: 1, z: 1 },
      },
      {
        localPosition: { x: 1.5, y: 0, z: -2 },
        localRotation: { x: 0, y: 30, z: 0 },
        localScale: { x: 1, y: 1, z: 1 },
        position: { x: 1.5, y: 0, z: -2 },
        rotation: { x: 0, y: 30, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        space: "local",
      },
      { snap: false },
    );
    expect(next.localPosition).toEqual({ x: 1.5, y: 0, z: -2 });
    expect(next.position).toEqual({ x: 1.5, y: 0, z: -2 });
    expect(next.localRotation.y).toBe(30);
  });

  it("throttles incremental drag emissions", () => {
    expect(shouldEmitThrottled(1000, undefined, 100)).toBe(true);
    expect(shouldEmitThrottled(1050, 1000, 100)).toBe(false);
    expect(shouldEmitThrottled(1100, 1000, 100)).toBe(true);
  });

  it("serializes rapid consecutive transform commits by objectId", () => {
    const objects = [
      {
        objectId: "crate",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      {
        objectId: "barrel",
        position: { x: 2, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ];
    const first = applyTransformCommitByObjectId(
      objects,
      "crate",
      { position: { x: 1, y: 0, z: 0 } },
      { snap: false },
    );
    expect(first.ok).toBe(true);
    expect(first.index).toBe(0);
    expect(first.objects[0].position.x).toBe(1);

    const blocked = applyTransformCommitByObjectId(
      first.objects,
      "crate",
      { position: { x: 9, y: 9, z: 9 } },
      { commitInFlight: true },
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("commit_in_flight");
    expect(blocked.objects[0].position.x).toBe(1);

    // Index-safe: reorder then commit barrel by id, not index 0.
    const reordered = [first.objects[1], first.objects[0]];
    const second = applyTransformCommitByObjectId(
      reordered,
      "barrel",
      { position: { x: 3, y: 0, z: 0 } },
      { snap: false },
    );
    expect(second.ok).toBe(true);
    expect(second.index).toBe(0);
    expect(second.object.objectId).toBe("barrel");
    expect(second.objects[0].position.x).toBe(3);
    expect(second.objects[1].position.x).toBe(1);
  });

  it("treats a failed/conflicting commit as a no-op leave for caller rollback", () => {
    const persisted = [
      {
        objectId: "crate",
        position: { x: 0.5, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ];
    const optimistic = applyTransformCommitByObjectId(
      persisted,
      "crate",
      { position: { x: 4, y: 0, z: 0 } },
      { snap: false },
    );
    expect(optimistic.ok).toBe(true);
    // Simulated PUT failure: restore from last persisted snapshot.
    const rolledBack = persisted;
    expect(rolledBack[0].position.x).toBe(0.5);
    expect(optimistic.objects[0].position.x).toBe(4);
  });

  it("synchronizes a successful transform commit onto the returned objects array", () => {
    const objects = [
      {
        objectId: "crate",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ];
    const committed = applyTransformCommitByObjectId(
      objects,
      "crate",
      {
        position: { x: 1.2, y: 0.1, z: -0.3 },
        rotation: { x: 0, y: 40, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { snap: true, snaps: { position: 0.25, rotationDeg: 15, scale: 0.1 } },
    );
    expect(committed.ok).toBe(true);
    expect(committed.objects[0].position).toEqual({ x: 1.25, y: 0, z: -0.25 });
    expect(committed.objects[0].rotation.y).toBe(45);
    expect(committed.object).toBe(committed.objects[0]);
  });

  it("keeps protected XR/camera objects non-editable via objectId commits", () => {
    const objects = [
      {
        objectId: "xr-rig",
        name: "XR Rig",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ];
    const result = applyTransformCommitByObjectId(
      objects,
      "xr-rig",
      { position: { x: 9, y: 9, z: 9 } },
      { snap: false },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("protected");
    expect(result.objects[0].position).toEqual({ x: 0, y: 0, z: 0 });
  });

  const hierarchyDraft = () => ({
    id: "d-local",
    version: 7,
    objects: [
      {
        objectId: "root-a",
        parentObjectId: null,
        name: "Root Prop",
        position: { x: 1, y: 0, z: 2 },
        rotation: { x: 0, y: 10, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        localPosition: { x: 1, y: 0, z: 2 },
        localRotation: { x: 0, y: 10, z: 0 },
        localScale: { x: 1, y: 1, z: 1 },
      },
      {
        objectId: "child-b",
        parentObjectId: "root-a",
        name: "Child Mesh",
        position: { x: 3, y: 1, z: 2 },
        rotation: { x: 5, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        localPosition: { x: 0.5, y: 0.25, z: 0 },
        localRotation: { x: 0, y: 15, z: 0 },
        localScale: { x: 1, y: 1, z: 1 },
      },
      {
        objectId: "xr",
        name: "Main Camera",
        position: { x: 0, y: 1.6, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ],
  });

  it("numeric root edit updates world + mirrored local", () => {
    const draft = hierarchyDraft();
    const root = draft.objects[0];
    expect(usesLocalNumericEdit(root)).toBe(false);
    const form = formValuesFromObject(root);
    expect(form.space).toBe("world");
    expect(form.position).toEqual(root.position);
    const payload = buildNumericTransformPayload(root, {
      position: { x: 4, y: 0, z: 2 },
      rotation: root.rotation,
      scale: root.scale,
    });
    const built = buildSaveObjectsFromDraft(draft, "root-a", payload, { snap: false });
    expect(built.ok).toBe(true);
    const next = built.objects.find((o) => o.objectId === "root-a");
    expect(next.position.x).toBe(4);
    expect(next.localPosition.x).toBe(4);
    expect(built.objects.find((o) => o.objectId === "child-b").localPosition).toEqual({
      x: 0.5,
      y: 0.25,
      z: 0,
    });
  });

  it("numeric child local-position edit updates localPosition and Apply payload space", () => {
    const draft = hierarchyDraft();
    const child = draft.objects[1];
    expect(usesLocalNumericEdit(child)).toBe(true);
    const form = formValuesFromObject(child);
    expect(form.space).toBe("local");
    expect(form.position).toEqual(child.localPosition);
    const payload = buildNumericTransformPayload(child, {
      position: { x: 1.25, y: 0.5, z: -0.25 },
      rotation: form.rotation,
      scale: form.scale,
    });
    expect(payload.space).toBe("local");
    expect(payload.localPosition).toEqual({ x: 1.25, y: 0.5, z: -0.25 });
    expect(payload.position).toBeUndefined();
    const built = buildSaveObjectsFromDraft(draft, "child-b", payload, { snap: false });
    const next = built.objects.find((o) => o.objectId === "child-b");
    expect(next.localPosition).toEqual({ x: 1.25, y: 0.5, z: -0.25 });
    // Prior world retained until Sync — never copy stale local into world.
    expect(next.position).toEqual(child.position);
    expect(built.objects.find((o) => o.objectId === "root-a").position).toEqual(draft.objects[0].position);
  });

  it("numeric child rotation and scale update localRotation / localScale", () => {
    const draft = hierarchyDraft();
    const child = draft.objects[1];
    const payload = buildNumericTransformPayload(child, {
      position: child.localPosition,
      rotation: { x: 12, y: 45, z: -6 },
      scale: { x: 1.5, y: 0.75, z: 2 },
    });
    const built = buildSaveObjectsFromDraft(draft, "child-b", payload, { snap: false });
    const next = built.objects.find((o) => o.objectId === "child-b");
    expect(next.localRotation).toEqual({ x: 12, y: 45, z: -6 });
    expect(next.localScale).toEqual({ x: 1.5, y: 0.75, z: 2 });
  });

  it("gizmo child edit applies local + world from viewport commit", () => {
    const draft = hierarchyDraft();
    const result = applyTransformCommitByObjectId(
      draft.objects,
      "child-b",
      {
        space: "local",
        localPosition: { x: 2, y: 0, z: 0 },
        localRotation: { x: 0, y: 90, z: 0 },
        localScale: { x: 1, y: 1, z: 1 },
        position: { x: 5, y: 1, z: 2 },
        rotation: { x: 0, y: 100, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      { snap: false },
    );
    expect(result.ok).toBe(true);
    expect(result.object.localPosition.x).toBe(2);
    expect(result.object.position.x).toBe(5);
    expect(result.objects.find((o) => o.objectId === "root-a").localPosition).toEqual(
      draft.objects[0].localPosition,
    );
  });

  it("root movement leaves unchanged descendant locals intact", () => {
    const draft = hierarchyDraft();
    const childBefore = { ...draft.objects[1].localPosition };
    const built = buildSaveObjectsFromDraft(
      draft,
      "root-a",
      buildNumericTransformPayload(draft.objects[0], {
        position: { x: 9, y: 0, z: 2 },
        rotation: draft.objects[0].rotation,
        scale: draft.objects[0].scale,
      }),
      { snap: false },
    );
    expect(built.objects.find((o) => o.objectId === "child-b").localPosition).toEqual(childBefore);
    expect(built.objects.filter((o) => o.objectId !== "root-a").every((o, i) => {
      const src = draft.objects.find((d) => d.objectId === o.objectId);
      return JSON.stringify(o.localPosition || null) === JSON.stringify(src.localPosition || null);
    })).toBe(true);
  });

  it("parent and child both intentionally edited keep distinct objectId rows", () => {
    const draft = hierarchyDraft();
    const afterRoot = buildSaveObjectsFromDraft(
      draft,
      "root-a",
      buildNumericTransformPayload(draft.objects[0], {
        position: { x: 2, y: 0, z: 2 },
        rotation: draft.objects[0].rotation,
        scale: draft.objects[0].scale,
      }),
      { snap: false },
    );
    const mid = { ...draft, version: draft.version, objects: afterRoot.objects };
    const child = mid.objects.find((o) => o.objectId === "child-b");
    const afterChild = buildSaveObjectsFromDraft(
      mid,
      "child-b",
      buildNumericTransformPayload(child, {
        position: { x: 0.1, y: 0.2, z: 0.3 },
        rotation: child.localRotation,
        scale: child.localScale,
      }),
      { snap: false },
    );
    expect(afterChild.objects.find((o) => o.objectId === "root-a").position.x).toBe(2);
    expect(afterChild.objects.find((o) => o.objectId === "child-b").localPosition).toEqual({
      x: 0.1,
      y: 0.2,
      z: 0.3,
    });
  });

  it("protected-object rejection via numeric save builder", () => {
    const draft = hierarchyDraft();
    const built = buildSaveObjectsFromDraft(
      draft,
      "xr",
      { position: { x: 9, y: 9, z: 9 } },
      { snap: false },
    );
    expect(built.objects.find((o) => o.objectId === "xr").position).toEqual({ x: 0, y: 1.6, z: 0 });
  });

  it("failed/conflicting PUT rollback restores persisted child local", () => {
    const draft = hierarchyDraft();
    const persistedChild = draft.objects[1];
    const optimistic = buildSaveObjectsFromDraft(
      draft,
      "child-b",
      buildNumericTransformPayload(persistedChild, {
        position: { x: 9, y: 9, z: 9 },
        rotation: persistedChild.localRotation,
        scale: persistedChild.localScale,
      }),
      { snap: false },
    );
    expect(optimistic.objects.find((o) => o.objectId === "child-b").localPosition.x).toBe(9);
    // Simulate conflict: discard optimistic, keep persisted draft version check.
    expect(assertFreshApplySave({ ...draft, version: 8 }, optimistic).ok).toBe(false);
    expect(assertFreshApplySave({ ...draft, version: 8 }, optimistic).reason).toBe("stale_version");
    expect(persistedChild.localPosition.x).toBe(0.5);
  });

  it("rapid consecutive numeric edits serialize by objectId without clobbering peers", () => {
    let draft = hierarchyDraft();
    for (let i = 0; i < 5; i += 1) {
      const child = draft.objects.find((o) => o.objectId === "child-b");
      const built = buildSaveObjectsFromDraft(
        draft,
        "child-b",
        buildNumericTransformPayload(child, {
          position: { x: 0.1 * (i + 1), y: 0, z: 0 },
          rotation: child.localRotation,
          scale: child.localScale,
        }),
        { snap: false },
      );
      draft = { ...draft, version: draft.version + 1, objects: built.objects };
    }
    expect(draft.objects.find((o) => o.objectId === "child-b").localPosition.x).toBeCloseTo(0.5);
    expect(draft.objects.find((o) => o.objectId === "root-a").position.x).toBe(1);
  });
});
