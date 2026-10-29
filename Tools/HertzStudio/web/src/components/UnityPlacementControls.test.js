import { describe, expect, it } from "vitest";
import { DEFAULT_PLACEMENT_TRANSFORM, buildPlacementBody } from "./UnityPlacementControls.jsx";

const assetId = "22222222-2222-4222-8222-222222222222";
const scenePath = "Assets/Scenes/HertzStudioTest.unity";

describe("buildPlacementBody", () => {
  it("binds asset, scene revision, confirmation, and default transforms", () => {
    expect(
      buildPlacementBody({
        assetId,
        scenePath,
        scenes: [{ path: scenePath, unityRevision: 42 }],
        transform: DEFAULT_PLACEMENT_TRANSFORM,
      }),
    ).toEqual({
      scenePath,
      placement: {
        assetId,
        scenePath,
        expectedUnityRevision: 42,
        confirmSave: true,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    });
  });

  it("refuses unknown revisions and invalid scale", () => {
    expect(() =>
      buildPlacementBody({ assetId, scenePath, scenes: [{ path: scenePath }], transform: DEFAULT_PLACEMENT_TRANSFORM }),
    ).toThrow(/revision is unknown/i);
    expect(() =>
      buildPlacementBody({
        assetId,
        scenePath,
        scenes: [{ path: scenePath, unityRevision: 1 }],
        transform: { ...DEFAULT_PLACEMENT_TRANSFORM, scale: { x: "0", y: "1", z: "1" } },
      }),
    ).toThrow(/between 0.001 and 1000/i);
  });
});
