/**
 * Focused W03 regression: mixed valid/invalid draft ops must queue nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-atomic-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const store = await import("../api/src/store.mjs");
const catalog = await import("../api/src/assets/catalog.mjs");

store.ensureOwnerBootstrap();
const assetId = "11111111-1111-4111-8111-111111111111";
const catPath = path.join(dataDir, "assets-catalog.json");
fs.mkdirSync(path.dirname(catPath), { recursive: true });
fs.writeFileSync(
  catPath,
  JSON.stringify({
    version: 1,
    assets: {
      [assetId]: {
        id: assetId,
        displayName: "Valid Model",
        assetType: "model_3d",
        state: "unity_imported",
        unity: {
          readiness: "ready",
          importedPath: `Assets/HertzStudio/Imported/${assetId}/a.glb`,
          prefabPath: null,
        },
      },
    },
    jobs: [],
    uploads: {},
    updatedAt: new Date().toISOString(),
  }),
  "utf8",
);

const created = store.createDraft({
  title: "atomic-test",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  unityRevision: 1,
  objects: [
    {
      objectId: "lib-ok",
      source: "library_drop",
      assetId,
      assetType: "model_3d",
      name: "Ok",
      position: { x: 0, y: 0, z: 0 },
    },
    {
      objectId: "lib-bad",
      source: "library_drop",
      assetId,
      assetType: "audio",
      name: "Bad audio free-drop",
      position: { x: 0, y: 0, z: 0 },
      // missing targetObjectId → apply validation error
    },
  ],
});
assert.ok(created?.id, `createDraft failed: ${JSON.stringify(created)}`);

const result = store.enqueueApply(created.id, "req-atomic-mixed");
assert.equal(result.status, 400);
assert.ok(Array.isArray(result.validationErrors) && result.validationErrors.length >= 1);
const after = store.loadStore();
assert.equal(after.queue.filter((q) => q.requestId === "req-atomic-mixed").length, 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      validationErrors: result.validationErrors.length,
      queued: after.queue.length,
    },
    null,
    2,
  ),
);
