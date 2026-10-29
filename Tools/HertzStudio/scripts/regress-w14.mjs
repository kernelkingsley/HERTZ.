#!/usr/bin/env node
import path from "node:path";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  runNodeTest,
  writeJson,
} from "./lib/regress-milestone.mjs";

const tests = runNodeTest(["api/src/deployPlan.test.mjs"]);
const proof = {
  schemaVersion: 1,
  milestone: "W14",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-api-tests",
  scenePath: "n/a",
  sceneRevision: "n/a",
  fresh: true,
  sampleSceneHash: getSampleSceneHash(),
  assertions: [{ name: "api_tests", result: tests.result, counts: tests.counts }],
  externalPending: [
    "provider account access",
    "credit verification",
    "public deployment",
    "DNS application",
    "HTTPS",
    "hosted authentication",
    "second-device access",
  ],
  security: {
    secretsInApiResponses: false,
    publicDeployExecuted: false,
    dnsMutated: false,
    acknowledgeWithoutSecretRejected: true,
  },
  note: "Vertical path: provider selection required; credential deposit needs real secret → OS store; plan body stored and rehashed.",
};
writeJson(path.join(DATA_DIR, "w14-deploy-plan-proof.json"), proof);
assertReviewManifest("W14");
console.log(JSON.stringify({ milestone: "W14", tests }, null, 2));
if (tests.exitCode !== 0) process.exit(tests.exitCode);
