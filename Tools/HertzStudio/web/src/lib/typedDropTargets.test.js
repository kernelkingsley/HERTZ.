import { describe, expect, it } from "vitest";
import { listCompatibleTargets, objectSupportsOperation, operationForAssetType } from "./typedDropTargets.js";

describe("typedDropTargets", () => {
  it("maps asset types to operations", () => {
    expect(operationForAssetType("texture")).toBe("assign_material");
    expect(operationForAssetType("audio")).toBe("assign_audio");
    expect(operationForAssetType("animation")).toBe("assign_animation");
  });

  it("rejects protected targets", () => {
    expect(
      objectSupportsOperation(
        { name: "XR Rig", renderCategory: "xr_protected", targetMetadataSchema: 1, isProtected: true },
        "assign_material",
      ).ok,
    ).toBe(false);
  });

  it("lists compatible mesh targets for materials using authoritative metadata", () => {
    const listed = listCompatibleTargets(
      [
        {
          objectId: "m1",
          name: "Floor",
          targetMetadataSchema: 1,
          hasRenderer: true,
          materialSlotCount: 1,
          surfaceKind: "floor",
        },
        {
          objectId: "cam",
          name: "Main Camera",
          renderRole: "camera",
          renderCategory: "camera",
          targetMetadataSchema: 1,
          isProtected: true,
        },
        {
          objectId: "stale",
          name: "Old Mesh",
          renderRole: "mesh",
          hasRenderer: true,
        },
      ],
      "texture",
    );
    expect(listed.compatible.map((c) => c.objectId)).toContain("m1");
    expect(listed.incompatible.some((c) => c.objectId === "cam")).toBe(true);
    expect(listed.incompatible.some((c) => c.objectId === "stale")).toBe(true);
  });

  it("does not treat object names or suggestions as floor/wall authority", () => {
    const namedOnly = objectSupportsOperation(
      { objectId: "n1", name: "Floor_01", targetMetadataSchema: 1, hasRenderer: true },
      "replace_floor_wall",
    );
    expect(namedOnly.ok).toBe(false);
    const suggested = objectSupportsOperation(
      {
        objectId: "n1b",
        name: "Plane",
        targetMetadataSchema: 1,
        hasRenderer: true,
        surfaceKindSuggested: "floor",
        surfaceKindSource: "none",
      },
      "replace_floor_wall",
    );
    expect(suggested.ok).toBe(false);
    const authoritative = objectSupportsOperation(
      {
        objectId: "n2",
        name: "Prop",
        targetMetadataSchema: 1,
        hasRenderer: true,
        surfaceKind: "wall",
        surfaceKindSource: "component",
      },
      "replace_floor_wall",
    );
    expect(authoritative.ok).toBe(true);
  });
});
