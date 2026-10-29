/**
 * Cross-milestone integration (no UI mocks): asset library → Characters preview URL contract
 * and asset library → Sound assignment → sync payload.
 *
 * Manual still required: browser GLTFLoader paint, Unity Play Mode gunshot.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w05-w07-int-"));
process.env.HERTZ_STUDIO_DATA = dataDir;

const modelSelfContained = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const modelWithDeps = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const audioKenney = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const blobsRoot = path.join(dataDir, "private", "assets");
fs.mkdirSync(blobsRoot, { recursive: true });

const glbName = `${modelSelfContained}.glb`;
fs.writeFileSync(path.join(blobsRoot, glbName), Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]));
const gltfMainName = `${modelWithDeps}.gltf`;
fs.writeFileSync(
  path.join(blobsRoot, gltfMainName),
  JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "scene.bin" }] }),
);
const depBlobName = `${modelWithDeps}__scene.bin`;
fs.writeFileSync(path.join(blobsRoot, depBlobName), Buffer.from([1, 2, 3, 4]));
const wavName = `${audioKenney}.wav`;
fs.writeFileSync(path.join(blobsRoot, wavName), Buffer.from("RIFF....WAVEfmt "));

fs.writeFileSync(
  path.join(dataDir, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [modelSelfContained]: {
        id: modelSelfContained,
        displayName: "Self Contained Kenney Prop",
        assetType: "model_3d",
        provider: "kenney",
        fileFormat: "glb",
        state: "unity_imported",
        entrypointFileName: "model.glb",
        blobPath: `private/assets/${glbName}`,
        unity: { readiness: "ready", dependencies: [] },
      },
      [modelWithDeps]: {
        id: modelWithDeps,
        displayName: "Split GLTF",
        assetType: "model_3d",
        provider: "kenney",
        fileFormat: "gltf",
        state: "unity_imported",
        entrypointFileName: "scene.gltf",
        blobPath: `private/assets/${gltfMainName}`,
        unity: {
          readiness: "ready",
          dependencies: [{ relativePath: "scene.bin", blobName: depBlobName, byteSize: 4 }],
        },
      },
      [audioKenney]: {
        id: audioKenney,
        displayName: "Kenney Impact",
        name: "impactGeneric",
        assetType: "audio",
        provider: "kenney",
        license: "CC0",
        fileFormat: "wav",
        state: "unity_imported",
        blobPath: `private/assets/${wavName}`,
        unity: { readiness: "ready", clipPath: "Assets/HertzStudio/Imported/c/impact.wav" },
      },
    },
    jobs: [],
    uploads: {},
  }),
);

const { createAssetRouter } = await import("./assets/routes.mjs");
const sound = await import("./sound.mjs");
const characters = await import("./characters.mjs");

function mountApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const requireOwner = (_req, _res, next) => next();
  const requireConnector = (_req, _res, next) => next();
  app.use("/api", createAssetRouter({ requireOwner, requireConnector }));
  return app;
}

function request(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, { method });
        const text = await res.text();
        let body = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* binary/text */
        }
        resolve({ status: res.status, body });
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

describe("W05/W07 asset-library integration", () => {
  after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("P0: /model serves self-contained GLB; missing dep returns selfContained hint", async () => {
    const app = mountApp();
    const model = await request(app, "GET", `/api/assets/${modelSelfContained}/model`);
    assert.equal(model.status, 200, "entrypoint /model must succeed for empty-deps GLB");

    const missing = await request(app, "GET", `/api/assets/${modelSelfContained}/model-dep/file`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.selfContained, true);
    assert.match(String(missing.body.hint || ""), /self-contained|\/model/i);

    const withDep = await request(
      app,
      "GET",
      `/api/assets/${modelWithDeps}/model-dep/${encodeURIComponent("scene.bin")}`,
    );
    assert.equal(withDep.status, 200);
  });

  it("W05: character model can bind ready library mesh id", () => {
    const saved = characters.upsertCharacterModel({
      displayName: "Int Enemy Visual",
      kind: "enemy_visual",
      modelAssetId: modelSelfContained,
      scale: 1,
      replaceTrackedXrRig: false,
    });
    assert.equal(saved.modelAssetId, modelSelfContained);
    assert.ok(saved.id);
  });

  it("W07: Kenney audio from library assigns to weapon shot and sync payload", () => {
    const slot = sound.upsertSlot({
      category: "weapon",
      slotKey: "shot",
      targetId: "left_pistol",
      audioAssetId: audioKenney,
    });
    assert.equal(slot.audioAssetId, audioKenney);
    assert.equal(slot.audio.provider, "kenney");

    const foot = sound.upsertFootstepMapping({
      surfaceId: "floor_wood",
      surfaceLabel: "Wood floor",
      audioAssetId: audioKenney,
    });
    assert.equal(foot.surfaceId, "floor_wood");

    const job = sound.enqueueSoundSync("w07-int-sync");
    assert.equal(job.type, "sync_sound_board");
    assert.ok(job.payload.slots.some((s) => s.clip?.assetId === audioKenney));
    assert.ok(job.payload.footstepMappings.some((m) => m.surfaceId === "floor_wood"));
    assert.equal(job.payload.rules.materialAppearanceDoesNotChangeFootsteps, true);

    const usages = sound.collectAudioUsages(audioKenney);
    assert.ok(usages.total >= 2);

    const out = path.join(dataDir, "w07-assignment-proof.json");
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          schemaVersion: 1,
          proof: "w07-assignment",
          ok: true,
          passed: 3,
          total: 3,
          stampedAt: new Date().toISOString(),
          checks: [
            { name: "kenney_audio_assigned_shot", pass: true, audioAssetId: audioKenney },
            { name: "footstep_floor_wood_mapped", pass: true },
            { name: "sync_payload_includes_clip", pass: true, payloadHash: job.payload.payloadHash },
          ],
          note: "Unity ScriptableObject apply via connector /sound/sync when Editor+bridge online; Play Mode is manual.",
        },
        null,
        2,
      ) + "\n",
    );
    assert.ok(fs.existsSync(out));
  });
});
