import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-target-scene-"));
process.env.HERTZ_STUDIO_DATA = dataDir;
const store = await import("./store.mjs");

const WEAPON_GUID = "11111111111111111111111111111111";
const SAMPLE_GUID = "22222222222222222222222222222222";

function reportScenes() {
  return store.reportUnityScenes({
    activeScenePath: "Assets/Scenes/HertzWeaponTest.unity",
    activeSceneName: "HertzWeaponTest",
    scenes: [
      {
        path: "Assets/Scenes/HertzWeaponTest.unity",
        name: "HertzWeaponTest",
        guid: WEAPON_GUID,
        unityRevision: 7,
      },
      {
        path: "Assets/Scenes/SampleScene.unity",
        name: "SampleScene",
        guid: SAMPLE_GUID,
        unityRevision: 31,
      },
    ],
  });
}

describe("shared Studio target scene", () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
  });

  it("persists an explicit SampleScene path/GUID without using the active scene as a fallback", () => {
    reportScenes();
    assert.equal(store.getStudioTargetScene(), null);
    const selected = store.setStudioTargetScene({
      scenePath: "Assets/Scenes/SampleScene.unity",
      sceneGuid: SAMPLE_GUID,
    });
    assert.equal(selected.scenePath, "Assets/Scenes/SampleScene.unity");
    assert.equal(selected.sceneGuid, SAMPLE_GUID);
    assert.equal(selected.unityRevision, 31);
    assert.equal(selected.available, true);
    assert.deepEqual(store.getStudioTargetScene(), selected);
  });

  it("rejects a path/GUID mismatch and reports a selected scene as unavailable when inventory no longer contains it", () => {
    reportScenes();
    assert.throws(
      () =>
        store.setStudioTargetScene({
          scenePath: "Assets/Scenes/SampleScene.unity",
          sceneGuid: WEAPON_GUID,
        }),
      (error) => error.code === "target_scene_unavailable",
    );
    store.setStudioTargetScene({
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
      sceneGuid: WEAPON_GUID,
    });
    store.reportUnityScenes({ scenes: [], activeScenePath: null, activeSceneName: null });
    assert.equal(store.getStudioTargetScene().available, false);
  });

  it("tracks a scene rename by GUID and supports explicit clearing", () => {
    reportScenes();
    store.setStudioTargetScene({
      scenePath: "Assets/Scenes/HertzWeaponTest.unity",
      sceneGuid: WEAPON_GUID,
    });
    store.reportUnityScenes({
      scenes: [
        {
          path: "Assets/Game/WeaponsSandbox.unity",
          name: "WeaponsSandbox",
          guid: WEAPON_GUID,
          unityRevision: 8,
        },
      ],
    });
    assert.equal(store.getStudioTargetScene().scenePath, "Assets/Game/WeaponsSandbox.unity");
    assert.equal(store.setStudioTargetScene({}), null);
  });
});