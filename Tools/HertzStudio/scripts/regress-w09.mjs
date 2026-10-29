#!/usr/bin/env node
import path from "node:path";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  runNodeTest,
  writeJson,
} from "./lib/regress-milestone.mjs";

const tests = runNodeTest(["api/src/animation.test.mjs"]);
const proof = {
  schemaVersion: 1,
  milestone: "W09",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-api-tests",
  scenePath: "Assets/Scenes/HertzCharacterTest.unity",
  sceneRevision: "n/a-api",
  fresh: true,
  sampleSceneHash: getSampleSceneHash(),
  assertions: [{ name: "api_tests", result: tests.result, counts: tests.counts }],
  externalPending: ["Real Mixamo Adobe download on Kingsley machine", "Unity Humanoid avatar Play Mode after domain reload"],
  note: "Vertical path: Asset Library FBX required; Unity probe/assign authoritative; posted humanoidValid ignored.",
};
writeJson(path.join(DATA_DIR, "w09-api-proof.json"), proof);
assertReviewManifest("W09");
console.log(JSON.stringify({ milestone: "W09", tests }, null, 2));
if (tests.exitCode !== 0) process.exit(tests.exitCode);
