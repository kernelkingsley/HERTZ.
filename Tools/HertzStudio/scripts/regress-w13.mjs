#!/usr/bin/env node
/**
 * W13 integration regress — requires real milestone contract suites, not file presence alone.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertReviewManifest,
  DATA_DIR,
  getSampleSceneHash,
  rejectStaleProof,
  STUDIO_ROOT,
  writeJson,
} from "./lib/regress-milestone.mjs";

const matrixPath = path.join(DATA_DIR, "w13-integration-matrix.json");
if (!fs.existsSync(matrixPath)) {
  console.error("Missing W13 integration matrix:", matrixPath);
  process.exit(1);
}

const milestones = ["w08", "w09", "w10", "w11", "w12", "w14"];
const results = [];
let failed = false;
for (const m of milestones) {
  const r = spawnSync(process.execPath, [path.join(STUDIO_ROOT, `scripts/regress-${m}.mjs`)], {
    cwd: STUDIO_ROOT,
    encoding: "utf8",
  });
  const ok = (r.status ?? 1) === 0;
  if (!ok) failed = true;
  results.push({
    milestone: m.toUpperCase(),
    exitCode: r.status ?? 1,
    result: ok ? "passed" : "failed",
  });
  console.log(r.stdout || "");
  if (r.stderr) console.error(r.stderr);

  const proofName = {
    w08: "w08-api-proof.json",
    w09: "w09-api-proof.json",
    w10: "w10-api-proof.json",
    w11: "w11-api-proof.json",
    w12: "w12-api-proof.json",
    w14: "w14-deploy-plan-proof.json",
  }[m];
  const freshness = rejectStaleProof(path.join(DATA_DIR, proofName));
  if (!freshness.fresh) {
    failed = true;
    results[results.length - 1].proofError = freshness.reason;
  }
  // Reject presence-only W13 claims: proof must mention fail-closed / unity / vertical keywords
  if (freshness.raw) {
    const text = JSON.stringify(freshness.raw);
    if (!/unity|vertical|fail|offline|provenance|authoritative/i.test(text)) {
      failed = true;
      results[results.length - 1].proofError = "proof_lacks_vertical_evidence";
    }
  }
}

assertReviewManifest("W13");
const proof = {
  schemaVersion: 1,
  milestone: "W13",
  generatedAt: new Date().toISOString(),
  sourceIdentity: "local-integration-contracts",
  scenePath: "Assets/Scenes/HertzStudioTest.unity",
  sceneRevision: "n/a",
  fresh: true,
  sampleSceneHash: getSampleSceneHash(),
  milestoneResults: results,
  matrixPath: "Tools/HertzStudio/data/w13-integration-matrix.json",
  claimsNotProven: ["remote hosting", "Quest device", "public HTTPS", "live Unity apply until domain reload"],
  note: "W13 fails if any milestone contract suite fails or proof is stale/presence-only.",
};
writeJson(path.join(DATA_DIR, "w13-integration-proof.json"), proof);
console.log(JSON.stringify({ milestone: "W13", results, failed }, null, 2));
process.exit(failed ? 1 : 0);
