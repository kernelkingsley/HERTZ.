#!/usr/bin/env node
import path from "node:path";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  runNodeTest,
  writeJson,
} from "./lib/regress-milestone.mjs";

const tests = runNodeTest(["api/src/performance.test.mjs"]);
const proof = {
  schemaVersion: 1,
  milestone: "W10",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-api-tests",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  sceneRevision: "n/a-api",
  fresh: true,
  sampleSceneHash: getSampleSceneHash(),
  assertions: [{ name: "api_tests", result: tests.result, counts: tests.counts }],
  externalPending: ["Real Quest 3S device capture"],
  note: "Vertical path: quest_device requires importer provenance; static/editor via Unity bridge endpoints.",
};
writeJson(path.join(DATA_DIR, "w10-api-proof.json"), proof);
assertReviewManifest("W10");
console.log(JSON.stringify({ milestone: "W10", tests }, null, 2));
if (tests.exitCode !== 0) process.exit(tests.exitCode);
