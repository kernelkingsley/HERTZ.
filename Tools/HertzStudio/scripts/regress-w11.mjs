#!/usr/bin/env node
import path from "node:path";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  runNodeTest,
  writeJson,
} from "./lib/regress-milestone.mjs";

const tests = runNodeTest(["api/src/snapshots.test.mjs"]);
const proof = {
  schemaVersion: 1,
  milestone: "W11",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-api-tests",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  sceneRevision: "n/a-api",
  fresh: true,
  sampleSceneHash: getSampleSceneHash(),
  assertions: [{ name: "api_tests", result: tests.result, counts: tests.counts }],
  externalPending: ["Unity staged file restore end-to-end after domain reload"],
  note: "Vertical path: rejects caller content; Unity enumerates snapshot bytes; manifest/blob hash revalidation.",
};
writeJson(path.join(DATA_DIR, "w11-api-proof.json"), proof);
assertReviewManifest("W11");
console.log(JSON.stringify({ milestone: "W11", tests }, null, 2));
if (tests.exitCode !== 0) process.exit(tests.exitCode);
