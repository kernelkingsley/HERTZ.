#!/usr/bin/env node
/**
 * Aggregate W08–W14 local regressions.
 * Runs each milestone script (W13 re-validates nested suites + rejects presence-only proofs).
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertReviewManifest,
  DATA_DIR,
  rejectStaleProof,
  STUDIO_ROOT,
  writeJson,
} from "./lib/regress-milestone.mjs";

const ORDER = ["w08", "w09", "w10", "w11", "w12", "w14", "w13"];
const PROOFS = {
  w08: "w08-api-proof.json",
  w09: "w09-api-proof.json",
  w10: "w10-api-proof.json",
  w11: "w11-api-proof.json",
  w12: "w12-api-proof.json",
  w13: "w13-integration-proof.json",
  w14: "w14-deploy-plan-proof.json",
};

const results = [];
let failed = false;

for (const m of ORDER) {
  const script = path.join(STUDIO_ROOT, `scripts/regress-${m}.mjs`);
  const r = spawnSync(process.execPath, [script], { cwd: STUDIO_ROOT, encoding: "utf8" });
  const ok = (r.status ?? 1) === 0;
  if (!ok) failed = true;
  console.log(`\n===== ${m.toUpperCase()} =====`);
  console.log(r.stdout || "");
  if (r.stderr) console.error(r.stderr);
  results.push({
    milestone: m.toUpperCase(),
    exitCode: r.status ?? 1,
    result: ok ? "passed" : "failed",
  });

  try {
    assertReviewManifest(m.toUpperCase());
  } catch (e) {
    failed = true;
    results[results.length - 1].manifestError = String(e.message || e);
  }

  const proofPath = path.join(DATA_DIR, PROOFS[m]);
  const freshness = rejectStaleProof(proofPath);
  if (!freshness.fresh) {
    failed = true;
    results[results.length - 1].proofError = freshness.reason;
  }
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  results,
  failed,
  externalPendingCommon: ["Quest device", "public deploy", "DNS", "hosted auth", "Unity domain-reload live apply"],
  note: "Contract suites must pass; W13 rejects presence-only proofs. Live Unity vertical apply remains pending until Editor reloads new bridge commands.",
};
writeJson(path.join(DATA_DIR, "w08-w14-aggregate-proof.json"), summary);
console.log(JSON.stringify(summary, null, 2));
process.exit(failed ? 1 : 0);
