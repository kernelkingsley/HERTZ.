/**
 * Used by regress:w07 when aggregate exit code is 2 (pending).
 * Confirms the written proof is honestly pending (ok:false) — not a false complete.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proofPath = path.join(__dirname, "..", "data", "w07-aggregate-proof.json");

if (!fs.existsSync(proofPath)) {
  console.error(JSON.stringify({ ok: false, error: "missing_w07_aggregate_proof" }));
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(proofPath, "utf8"));
if (doc.ok === true || doc.status === "passed" || doc.completion === true) {
  console.error(
    JSON.stringify({
      ok: false,
      error: "aggregate_claimed_complete_while_regress_expected_pending",
      status: doc.status,
    }),
  );
  process.exit(1);
}
if (doc.status !== "pending") {
  console.error(JSON.stringify({ ok: false, error: "expected_pending_status", status: doc.status }));
  process.exit(1);
}

const pendingLayers = Object.entries(doc.layers || {})
  .filter(([, layer]) => layer?.status === "pending" || layer?.ok === false)
  .map(([name]) => name);
const manualOnly = pendingLayers.length === 1 && pendingLayers[0] === "manual_verification";

console.log(  JSON.stringify({
    ok: true,
    regress: manualOnly ? "pending_manual_verification" : "pending_verification",
    message: manualOnly
      ? "W07 automated and Unity runtime verification passed; manual audible Play Mode/headset verification remains."
      : `W07 remains pending: ${pendingLayers.join(", ") || "verification"}.`,
    status: doc.status,
    passed: doc.passed,
    total: doc.total,
    pendingLayers,
    runtime: doc.layers?.runtime_playback || null,
  }),
);
process.exit(0);
