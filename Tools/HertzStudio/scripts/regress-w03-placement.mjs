import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-placement-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const catalog = await import("../api/src/assets/catalog.mjs");
const assetId = "22222222-2222-4222-8222-222222222222";
const scenePath = "Assets/Scenes/HertzStudioTest.unity";
fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [assetId]: {
        id: assetId,
        displayName: "Placement Contract Model",
        assetType: "model_3d",
        state: "unity_imported",
        unity: { readiness: "ready", importedPath: `Assets/HertzStudio/Imported/${assetId}/model.glb` },
      },
    },
    jobs: [],
    uploads: {},
  }),
  "utf8",
);

const placement = {
  assetId,
  scenePath,
  confirmSave: true,
  expectedUnityRevision: 12,
  position: { x: 1, y: 2, z: 3 },
  rotation: { x: 10, y: 20, z: 30 },
  scale: { x: 1, y: 2, z: 1 },
};

assert.equal(catalog.enqueuePlaceInScene(assetId, scenePath, "missing-confirm", null).status, 400);
assert.equal(
  catalog.enqueuePlaceInScene(assetId, scenePath, "unknown-revision", { ...placement, expectedUnityRevision: null }).status,
  400,
);
assert.equal(
  catalog.enqueuePlaceInScene(assetId, scenePath, "forged-confirm", { ...placement, assetId: crypto.randomUUID() }).status,
  400,
);
assert.equal(
  catalog.enqueuePlaceInScene(assetId, scenePath, "bad-scale", { ...placement, scale: { x: 0, y: 1, z: 1 } }).status,
  400,
);

const queued = catalog.enqueuePlaceInScene(assetId, scenePath, "immutable-place", placement);
assert.equal(queued.status, 202);
assert.deepEqual(queued.job.placement, placement);
assert.equal(catalog.enqueuePlaceInScene(assetId, scenePath, "immutable-place", placement).status, 200);
assert.equal(
  catalog.enqueuePlaceInScene(assetId, scenePath, "immutable-place", {
    ...placement,
    rotation: { x: 11, y: 20, z: 30 },
  }).status,
  409,
);

assert.equal(catalog.enqueueUnityImport(assetId, "import-bypass", { scenePath }).status, 400);
const importAndPlace = catalog.enqueueUnityImport(assetId, "import-confirmed", { scenePath, placement });
assert.equal(importAndPlace.status, 202);
assert.deepEqual(importAndPlace.job.placement, placement);

const connectorSource = fs.readFileSync(path.join(__dirname, "../connector/src/connector.mjs"), "utf8");
assert.doesNotMatch(connectorSource, /confirmSave:\s*true/);
assert.match(connectorSource, /confirmSave:\s*placement\.confirmSave/);

console.log(JSON.stringify({ ok: true, checks: 10, dataDir }, null, 2));
