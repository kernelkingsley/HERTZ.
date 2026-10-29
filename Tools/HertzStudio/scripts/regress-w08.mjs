#!/usr/bin/env node
import path from "node:path";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  runNodeTest,
  writeJson,
} from "./lib/regress-milestone.mjs";

const tests = runNodeTest([
  "api/src/sceneIdentity.test.mjs",
  "api/src/materials.test.mjs",
  "api/src/polyhaven.test.mjs",
]);
const hash = getSampleSceneHash();
const proof = {
  schemaVersion: 1,
  milestone: "W08",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-api-tests",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  sceneRevision: "n/a-api",
  fresh: true,
  sampleSceneHash: hash,
  assertions: [
    { name: "api_tests", result: tests.result, counts: tests.counts },
    { name: "sample_scene_unchanged_hash_recorded", result: hash ? "passed" : "pending", hash },
  ],
  externalPending: ["Live Unity material/Terrain/HDRI apply after domain reload", "live Poly Haven network download in CI"],
  note: "Vertical path: authoritative Poly Haven URL selection, Asset Library ingest, Unity material inspect/apply commands. Fail-closed offline.",
};
writeJson(path.join(DATA_DIR, "w08-api-proof.json"), proof);
assertReviewManifest("W08");
console.log(JSON.stringify({ milestone: "W08", tests, proofPath: "data/w08-api-proof.json" }, null, 2));
if (tests.exitCode !== 0) process.exit(tests.exitCode);
