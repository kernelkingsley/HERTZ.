/**
 * Fail-closed W05 aggregate: characters API + current-identity Unity proofs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR,
  REPO_ROOT,
  currentW05Identity,
  validateW05ProofArtifact,
} from "./lib/proof-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const required = [
  "w05-character-behavior-proof.json",
  "w05-character-sync-proof.json",
];

const identity = currentW05Identity();
const checks = [];
let passed = 0;

for (const file of required) {
  const p = path.join(DATA_DIR, file);
  const v = validateW05ProofArtifact(p);
  const ok = v.ok === true;
  checks.push({
    name: file,
    pass: ok,
    actual: ok ? `${v.artifact?.passed}/${v.artifact?.total}` : (v.reasons || []).join(","),
    expected: "schema=3 + matching sourceFingerprint + fresh timestamp + scene identity",
  });
  if (ok) passed++;
}

const scenePath = path.join(REPO_ROOT, "Assets/Scenes/HertzCharacterTest.unity");
const sceneOk = fs.existsSync(scenePath);
checks.push({
  name: "hertz_character_test_scene",
  pass: sceneOk,
  actual: sceneOk ? "Assets/Scenes/HertzCharacterTest.unity" : "missing",
  expected: "Assets/Scenes/HertzCharacterTest.unity",
});
if (sceneOk) passed++;

checks.push({
  name: "identity_unityVersion_known",
  pass: Boolean(identity.unityVersion),
  actual: identity.unityVersion || null,
  expected: "ProjectSettings/ProjectVersion.txt",
});
if (identity.unityVersion) passed++;

checks.push({
  name: "identity_sourceFingerprint_computed",
  pass: Boolean(identity.sourceFingerprint) && identity.sourceFingerprint.length === 64,
  actual: identity.sourceFingerprint?.slice(0, 16) || null,
  expected: "64-char sha256",
});
if (identity.sourceFingerprint?.length === 64) passed++;

const pending =
  checks.some((c) => !c.pass && String(c.actual).includes("stale")) ||
  checks.some((c) => !c.pass && String(c.actual).includes("schemaVersion")) ||
  checks.some((c) => !c.pass && String(c.actual).includes("sourceFingerprint"));

const out = {
  schemaVersion: 3,
  proof: "w05-aggregate",
  ok: passed === checks.length && checks.length > 0,
  pending: !pending ? false : true,
  passed,
  total: checks.length,
  generatedAt: new Date().toISOString(),
  stampedAt: new Date().toISOString(),
  proofSource: "aggregate_validator",
  expectedIdentity: identity,
  checks,
  note: outNote(passed, checks.length, pending),
};

function outNote(p, t, pend) {
  if (p === t) return "All W05 identity-bound Unity proofs current.";
  if (pend) return "Matching Unity evidence unavailable or stale — aggregate fail-closed/pending.";
  return "W05 aggregate failed checks.";
}

fs.writeFileSync(path.join(DATA_DIR, "w05-aggregate-proof.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ ok: out.ok, pending: out.pending, passed: out.passed, total: out.total }));
process.exit(out.ok ? 0 : 1);
