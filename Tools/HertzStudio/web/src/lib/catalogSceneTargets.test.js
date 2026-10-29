import { describe, it, expect } from "vitest";
import {
  HERTZ_CHARACTER_TEST_SCENE,
  HERTZ_WEAPON_TEST_SCENE,
  isDedicatedTestScene,
  resolveCatalogSceneTarget,
} from "./catalogSceneTargets.js";

describe("catalogSceneTargets", () => {
  it("Test mode locks to dedicated character/weapon scenes", () => {
    expect(resolveCatalogSceneTarget({ mode: "test", kind: "character" }).scenePath).toBe(
      HERTZ_CHARACTER_TEST_SCENE,
    );
    expect(resolveCatalogSceneTarget({ mode: "test", kind: "weapon" }).scenePath).toBe(
      HERTZ_WEAPON_TEST_SCENE,
    );
  });

  it("Deploy mode defaults to no scene selection", () => {
    const t = resolveCatalogSceneTarget({ mode: "deploy", deployScenePath: "", kind: "character" });
    expect(t.scenePath).toBe("");
    expect(t.locked).toBe(false);
  });

  it("recognizes dedicated test scenes only", () => {
    expect(isDedicatedTestScene(HERTZ_CHARACTER_TEST_SCENE, "character")).toBe(true);
    expect(isDedicatedTestScene("Assets/Scenes/SampleScene.unity", "character")).toBe(false);
  });
});
