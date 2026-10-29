/**
 * Accept exit 2 from proof-w06-aggregate when status is pending (not failed).
 * Authoritative failed aggregates must still fail the regress.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proof = path.join(__dirname, "..", "data", "w06-aggregate-proof.json");
if (!fs.existsSync(proof)) {
  console.error("accept-w06-pending: missing aggregate proof");
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(proof, "utf8"));
if (doc.status === "failed" || (doc.ok === false && doc.pending !== true)) {
  console.error("accept-w06-pending: aggregate failed — not accepting", doc.status, doc.reason || doc.note);
  process.exit(1);
}
if (doc.pending === true || doc.status === "pending") {
  console.log(JSON.stringify({ accepted: "pending", passed: doc.passed, total: doc.total, note: doc.note }));
  process.exit(0);
}
console.error("accept-w06-pending: unexpected status", doc.status);
process.exit(1);
