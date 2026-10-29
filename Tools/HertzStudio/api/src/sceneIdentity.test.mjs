import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeSceneAssetPath,
  isSampleScenePath,
  assertDedicatedStudioScene,
  assertStudioTargetScene,
} from "./sceneIdentity.mjs";

describe("sceneIdentity", () => {
  it("canonicalizes and rejects traversal/absolute/lookalike SampleScene", () => {
    assert.equal(canonicalizeSceneAssetPath("Assets/Scenes/HertzStudioTest.unity"), "Assets/Scenes/HertzStudioTest.unity");
    assert.equal(canonicalizeSceneAssetPath("assets\\scenes\\../Scenes/HertzStudioTest.unity"), "");
    assert.equal(canonicalizeSceneAssetPath("C:/Assets/Scenes/HertzStudioTest.unity"), "");
    assert.equal(canonicalizeSceneAssetPath("/Assets/Scenes/HertzStudioTest.unity"), "");
    assert.equal(isSampleScenePath("Assets/Scenes/SampleScene.unity"), true);
    assert.equal(isSampleScenePath("Assets/Scenes/sampleSCENE.unity"), true);
    assert.equal(isSampleScenePath("Assets/Scenes/HertzStudioTest.unity"), false);
    assert.equal(isSampleScenePath("Assets/Scenes/NotSampleScene.unity"), false);
    assert.throws(() => assertDedicatedStudioScene("Assets/Scenes/SampleScene.unity"), (e) => e.code === "protected_scene");
    assert.throws(() => assertDedicatedStudioScene("Assets/Scenes/%53ampleScene.unity"), (e) => e.code === "protected_scene");
    assert.equal(assertStudioTargetScene("Assets/Scenes/SampleScene.unity"), "Assets/Scenes/SampleScene.unity");
    assert.throws(() => assertStudioTargetScene("../SampleScene.unity"), (e) => e.code === "invalid_scene_path");
  });
});
