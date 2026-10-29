import { describe, expect, it } from "vitest";
import {
  assertFreshApplySave,
  buildHierarchyPlan,
  buildSaveObjectsFromDraft,
  containsMojibake,
  controlHelpText,
  fallbackKindForObject,
  isFrameAllKey,
  isFrameSelectedKey,
  mapAxisConstraintKey,
  mapTransformToolKey,
  mapUnityMouseButtons,
  resolveSelectionObjectId,
  selectVisualRoots,
  shouldLoadModelForObject,
  shouldLoadNativeMeshForObject,
  computeFrameCameraPlacement,
  threeLocalToUnityPosition,
  unityLocalToThreePosition,
  unityPointerNavIntent,
  viewPresetFromNumpad,
} from "./levelEditorSceneViewport.js";

const ASSET = "8e7aeace-df2b-40ba-842d-9a94e99e1e8f";

describe("levelEditorSceneViewport", () => {
  const hierarchy = [
    {
      objectId: "root-cat",
      rootObjectId: "root-cat",
      assetId: ASSET,
      renderRole: "model_root",
      renderCategory: "catalog_model_root",
      prefabInstanceRoot: true,
      name: "Armored cat",
      position: { x: 1, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    {
      objectId: "child-mesh",
      parentObjectId: "root-cat",
      rootObjectId: "root-cat",
      assetId: ASSET,
      renderRole: "mesh",
      renderCategory: "native_mesh",
      name: "cat_low_Cat_0",
      position: { x: 0, y: 0, z: 0 },
    },
    {
      objectId: "root-cat-2",
      rootObjectId: "root-cat-2",
      assetId: ASSET,
      renderRole: "model_root",
      renderCategory: "catalog_model_root",
      prefabInstanceRoot: true,
      name: "Armored cat Copy",
      position: { x: 3, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    {
      objectId: "xr",
      name: "XR Rig",
      renderRole: "camera",
      renderCategory: "xr_protected",
      position: { x: 0, y: 0, z: 0 },
    },
    {
      objectId: "wall",
      parentObjectId: null,
      rootObjectId: "wall",
      renderRole: "mesh",
      renderCategory: "native_mesh",
      name: "Wall",
      localPosition: { x: 2, y: 0, z: 0 },
      position: { x: 2, y: 0, z: 0 },
    },
  ];

  it("loads one model root even when export includes child mesh rows", () => {
    const roots = selectVisualRoots(hierarchy);
    expect(roots.map((r) => r.objectId)).toEqual(["root-cat", "root-cat-2"]);
    expect(shouldLoadModelForObject(hierarchy[0], hierarchy)).toBe(true);
    expect(shouldLoadModelForObject(hierarchy[1], hierarchy)).toBe(false);
  });

  it("native mesh uses snapshot descriptor, not catalog cube root counting", () => {
    expect(shouldLoadNativeMeshForObject(hierarchy[4], {
      supported: true,
      sourceType: "native_snapshot",
      modelUrl: "/api/render-snapshots/abc/meshes/m.glb",
    })).toBe(true);
    expect(selectVisualRoots(hierarchy).some((r) => r.objectId === "wall")).toBe(false);
  });

  it("two instances share the same assetId for cache reuse (distinct objectIds)", () => {
    const roots = selectVisualRoots(hierarchy);
    expect(roots[0].assetId).toBe(roots[1].assetId);
    expect(roots[0].objectId).not.toBe(roots[1].objectId);
  });

  it("GLTF descendant selection resolves to the editable model root", () => {
    expect(resolveSelectionObjectId("child-mesh", hierarchy)).toBe("root-cat");
    expect(resolveSelectionObjectId("root-cat", hierarchy)).toBe("root-cat");
    expect(resolveSelectionObjectId("wall", hierarchy)).toBe("wall");
  });

  it("unsupported objects receive fallback kinds", () => {
    expect(fallbackKindForObject({ objectId: "a", renderRole: "empty" }, null)).toBe("empty");
    expect(
      fallbackKindForObject(
        { objectId: "b", renderRole: "model_root", renderCategory: "catalog_model_root" },
        { supported: false, status: "unsupported", fallbackReason: "FBX only" },
      ),
    ).toBe("unsupported");
    expect(fallbackKindForObject(hierarchy[3], null)).toBe("protected");
  });

  it("maps Unity mouse and W/E/R shortcuts", () => {
    const THREE = { MOUSE: { ROTATE: 0, DOLLY: 1, PAN: 2 } };
    expect(mapUnityMouseButtons(THREE)).toEqual({ LEFT: -1, MIDDLE: 2, RIGHT: 0 });
    expect(mapTransformToolKey("w")).toBe("translate");
    expect(mapTransformToolKey("e")).toBe("rotate");
    expect(mapTransformToolKey("r")).toBe("scale");
    expect(mapTransformToolKey("g")).toBe("translate");
    expect(mapTransformToolKey("s")).toBe("scale");
  });

  it("modifier-aware pointer intents for RMB/Alt+LMB orbit and MMB pan", () => {
    expect(unityPointerNavIntent({ button: 0 })).toEqual({ action: "select", reason: "lmb" });
    expect(unityPointerNavIntent({ button: 0, altKey: true })).toEqual({ action: "orbit", reason: "alt_lmb" });
    expect(unityPointerNavIntent({ button: 1 })).toEqual({ action: "pan", reason: "mmb" });
    expect(unityPointerNavIntent({ button: 2 })).toEqual({ action: "orbit", reason: "rmb" });
    expect(unityPointerNavIntent({ button: 0, altKey: true }, { gizmoDragging: true })).toEqual({
      action: "none",
      reason: "gizmo",
    });
  });

  it("builds hierarchy with local parent links and detects cycles", () => {
    const plan = buildHierarchyPlan([
      { objectId: "a", parentObjectId: null, siblingIndex: 0 },
      { objectId: "b", parentObjectId: "a", siblingIndex: 0 },
      { objectId: "c", parentObjectId: "b", siblingIndex: 0 },
      { objectId: "loop", parentObjectId: "loop2", siblingIndex: 0 },
      { objectId: "loop2", parentObjectId: "loop", siblingIndex: 0 },
    ]);
    expect(plan.roots.map((r) => r.objectId)).toContain("a");
    expect(plan.children.get("a").map((c) => c.objectId)).toEqual(["b"]);
    expect(plan.cyclic.has("loop") || plan.cyclic.has("loop2")).toBe(true);
  });

  it("converts Unity local X for Three.js round-trip", () => {
    expect(unityLocalToThreePosition({ x: 2, y: 1, z: 3 })).toEqual({ x: -2, y: 1, z: 3 });
    expect(threeLocalToUnityPosition({ x: -2, y: 1, z: 3 })).toEqual({ x: 2, y: 1, z: 3 });
  });

  it("frames selection a few meters back from object bounds", () => {
    const placement = computeFrameCameraPlacement(
      { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } },
      null,
    );
    expect(placement.distance).toBeGreaterThanOrEqual(2.5);
    const dx = placement.position.x - placement.target.x;
    const dy = placement.position.y - placement.target.y;
    const dz = placement.position.z - placement.target.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(dist).toBeGreaterThan(2);
    expect(placement.minDistance).toBeGreaterThan(0);
  });

  it("keeps orbit minDistance outside large room bounds", () => {
    const placement = computeFrameCameraPlacement(
      { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 3, z: 5 } },
      null,
    );
    expect(placement.minDistance).toBeGreaterThan(4);
    expect(placement.distance).toBeGreaterThan(placement.minDistance);
  });

  it("axis constraints and view presets", () => {
    expect(mapAxisConstraintKey("x", false)).toEqual({ axis: "x", plane: false });
    expect(mapAxisConstraintKey("y", true)).toEqual({ axis: "y", plane: true });
    expect(viewPresetFromNumpad("Numpad1", false)).toBe("front");
    expect(viewPresetFromNumpad("Numpad1", true)).toBe("back");
    expect(viewPresetFromNumpad("Numpad3", false)).toBe("right");
    expect(viewPresetFromNumpad("Numpad7", false)).toBe("top");
    expect(isFrameSelectedKey("NumpadDecimal", ".")).toBe(true);
    expect(isFrameSelectedKey("KeyF", "f")).toBe(true);
    expect(isFrameAllKey("Home")).toBe(true);
  });

  it("serializes transform saves by objectId and blocks stale Apply versions", () => {
    const draft = { id: "d1", version: 3, objects: hierarchy };
    const built = buildSaveObjectsFromDraft(
      draft,
      "root-cat",
      { position: { x: 2, y: 0, z: 0 } },
      { snap: false },
    );
    expect(built.ok).toBe(true);
    expect(built.expectedVersion).toBe(3);
    expect(built.objects[0].position.x).toBe(2);
    expect(assertFreshApplySave(draft, built).ok).toBe(true);
    expect(assertFreshApplySave({ ...draft, version: 4 }, built).ok).toBe(false);
    expect(assertFreshApplySave({ ...draft, version: 4 }, built).reason).toBe("stale_version");
  });

  it("keeps protected objects non-editable in save builder", () => {
    const draft = { id: "d1", version: 1, objects: hierarchy };
    const built = buildSaveObjectsFromDraft(draft, "xr", { position: { x: 9, y: 9, z: 9 } }, { snap: false });
    expect(built.objects.find((o) => o.objectId === "xr").position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("help text has no mojibake", () => {
    expect(containsMojibake(controlHelpText())).toBe(false);
    expect(containsMojibake("Unity's active scene")).toBe(false);
    expect(containsMojibake("Unityâ€™s")).toBe(true);
  });
});
