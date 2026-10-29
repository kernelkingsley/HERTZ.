#!/usr/bin/env node
import path from "node:path";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  runNodeTest,
  writeJson,
} from "./lib/regress-milestone.mjs";

const tests = runNodeTest(["api/src/encounters.test.mjs"]);
const proof = {
  schemaVersion: 1,
  milestone: "W12",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-api-tests",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  sceneRevision: "n/a-api",
  fresh: true,
  sampleSceneHash: getSampleSceneHash(),
  assertions: [{ name: "api_tests", result: tests.result, counts: tests.counts }],
  externalPending: ["Unity Play Mode spawn observation after domain reload"],
  note: "Vertical path: expectedUnityRevision required; Unity validate/apply/runtime ack; no random reset tokens.",
};
writeJson(path.join(DATA_DIR, "w12-api-proof.json"), proof);
assertReviewManifest("W12");
console.log(JSON.stringify({ milestone: "W12", tests }, null, 2));
if (tests.exitCode !== 0) process.exit(tests.exitCode);
