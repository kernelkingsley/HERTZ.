/**
 * W05 Unity proof runner — fail-closed on stale/mismatched identity.
 * Never passes merely because an old JSON file exists.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DATA_DIR,
  REPO_ROOT,
  currentW05Identity,
  validateW05ProofArtifact,
} from "./lib/proof-identity.mjs";

const required = [
  "w05-character-behavior-proof.json",
  "w05-character-sync-proof.json",
];

function validateAll() {
  const results = [];
  for (const file of required) {
    const p = path.join(DATA_DIR, file);
    const v = validateW05ProofArtifact(p);
    results.push({ file, ...v });
  }
  return results;
}

const identity = currentW05Identity();
console.log(JSON.stringify({ phase: "identity", ...identity }, null, 2));

let results = validateAll();
if (results.every((r) => r.ok)) {
  console.log(JSON.stringify({ ok: true, mode: "fresh_matching_artifacts", files: required }));
  process.exit(0);
}

console.warn(
  JSON.stringify({
    phase: "artifacts_rejected",
    results: results.map((r) => ({ file: r.file, ok: r.ok, pending: r.pending, reasons: r.reasons })),
  }),
);

const unity =
  process.env.UNITY_EDITOR ||
  process.env.UNITY_PATH ||
  "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.85f1\\Editor\\Unity.exe";

if (!fs.existsSync(unity)) {
  const pendingPath = path.join(DATA_DIR, "w05-unity-proof-pending.json");
  fs.writeFileSync(
    pendingPath,
    JSON.stringify(
      {
        schemaVersion: 3,
        proof: "w05-unity-runner",
        ok: false,
        pending: true,
        generatedAt: new Date().toISOString(),
        reason: "matching_unity_evidence_unavailable",
        rejectedArtifacts: results.map((r) => ({ file: r.file, reasons: r.reasons })),
        expectedIdentity: identity,
        note: "Run HERTZ/Studio/Proofs/W05 Character Behavior and W05 Character Sync, or set UNITY_EDITOR.",
      },
      null,
      2,
    ) + "\n",
  );
  console.error(
    "W05 Unity proofs are missing/stale/mismatched and UNITY_EDITOR was not found. Reporting pending (fail-closed).",
  );
  process.exit(1);
}

const methods = [
  "HertzStudio.Editor.HertzStudioCharacterProof.RunBehaviorProof",
  "HertzStudio.Editor.HertzStudioCharacterProof.RunSyncProof",
];

for (const method of methods) {
  const log = path.join(DATA_DIR, `w05-unity-${method.split(".").pop()}.log`);
  const r = spawnSync(
    unity,
    [
      "-batchmode",
      "-nographics",
      "-quit",
      "-projectPath",
      REPO_ROOT,
      "-executeMethod",
      method,
      "-logFile",
      log,
    ],
    { stdio: "inherit", timeout: 600000 },
  );
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  if ((r.status ?? 1) !== 0) {
    const locked = /another Unity instance is running/i.test(logText);
    fs.writeFileSync(
      path.join(DATA_DIR, "w05-unity-proof-pending.json"),
      JSON.stringify(
        {
          schemaVersion: 3,
          proof: "w05-unity-runner",
          ok: false,
          pending: true,
          generatedAt: new Date().toISOString(),
          reason: locked ? "unity_editor_project_locked" : `executeMethod_status_${r.status}`,
          method,
          note: locked
            ? "Close batchmode conflict: run HERTZ/Studio/Proofs/W05 menus in the open Editor after domain reload."
            : "Unity executeMethod failed; see log.",
          log,
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`executeMethod failed: ${method} status=${r.status}${locked ? " (Editor has project open)" : ""}`);
    process.exit(1);
  }
}

results = validateAll();
if (!results.every((r) => r.ok)) {
  console.error(
    JSON.stringify({
      ok: false,
      mode: "executeMethod_still_invalid",
      results: results.map((r) => ({ file: r.file, reasons: r.reasons })),
    }),
  );
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, mode: "executeMethod", files: required }));
process.exit(0);
