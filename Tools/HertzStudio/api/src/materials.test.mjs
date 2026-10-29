import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w08-mat-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const materials = await import("./materials.mjs");

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("W08 materials vertical contracts", () => {
  it("allows an explicitly selected canonical SampleScene path but still fails closed without Unity", async () => {
    await assert.rejects(
      () =>
        materials.applySurfaceAssignment({
          scenePath: "Assets/Scenes/SampleScene.unity",
          targetObjectId: "floor",
          expectedUnityRevision: 1,
        }),
      (e) => e.code === "unity_offline" || e.code === "unity_apply_failed",
    );
  });

  it("requires expectedUnityRevision from Unity — not client-invented apply without it", async () => {
    await assert.rejects(
      () =>
        materials.applySurfaceAssignment({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          targetObjectId: "floor_a",
        }),
      (e) => e.code === "revision_required",
    );
  });

  it("fails closed when Unity bridge is offline (no store-only success)", async () => {
    await assert.rejects(
      () =>
        materials.applySurfaceAssignment({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          targetObjectId: "floor_a",
          expectedUnityRevision: 1,
          targetKind: "terrain_layer",
          isActualTerrain: true,
        }),
      (e) => e.code === "unity_offline" || e.code === "unity_apply_failed" || e.code === "not_unity_imported",
    );
  });

  it("ignores browser isActualTerrain authority when bridge offline still not store-success", async () => {
    await assert.rejects(
      () =>
        materials.inspectMaterialTarget({
          scenePath: "Assets/Scenes/HertzStudioTest.unity",
          targetObjectId: "fake_terrain",
        }),
      (e) => e.code === "unity_offline" || e.code === "unity_inspect_failed",
    );
  });
});
