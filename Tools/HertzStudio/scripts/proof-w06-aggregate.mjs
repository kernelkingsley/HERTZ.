/**
 * Fail-closed W06 aggregate: requires real HertzAnalyticsCapture runtime proof
 * with isolated queue root + source fingerprint freshness.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  W06_CHECK_SET_VERSION,
  W06_FINGERPRINT_FILES,
  W06_SCENE,
  computeW06Fingerprint,
  readProjectUnityVersion,
  readSceneGuid,
  validateProofFreshness,
} from "./lib/proof-fingerprint.mjs";
import { decideRuntimeProof, selectRuntimeAfterAttempt } from "./lib/proof-runtime-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const runtimeProofPath = path.join(dataDir, "w06-runtime-capture-proof.json");
const proofOut = path.join(dataDir, "w06-aggregate-proof.json");
const productionManifest = path.join(dataDir, "w06-pending-queue", "manifest.json");

function readJson(p) {
  let t = fs.readFileSync(p, "utf8");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return JSON.parse(t);
}

function fileHash(p) {
  if (!fs.existsSync(p)) return "missing";
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase();
}

const checks = [];
function check(name, pass, actual, expected) {
  checks.push({ name, pass: Boolean(pass), actual, expected });
}

function tryRunRuntimeProof() {
  const unity =
    process.env.UNITY_EDITOR ||
    process.env.UNITY_PATH ||
    "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.85f1\\Editor\\Unity.exe";
  if (!fs.existsSync(unity)) return { ran: false, reason: "unity_editor_missing" };
  const log = path.join(dataDir, "w06-unity-RunRuntimeCaptureProof.log");
  const r = spawnSync(
    unity,
    [
      "-batchmode",
      "-nographics",
      "-projectPath",
      projectRoot,
      "-executeMethod",
      "HertzStudio.Editor.HertzStudioAnalyticsProof.RunRuntimeCaptureProofBatch",
      "-logFile",
      log,
    ],
    { stdio: "inherit", timeout: 600000 },
  );
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  if (/another Unity instance is running/i.test(logText)) {
    return { ran: false, reason: "unity_editor_project_locked", status: r.status };
  }
  return { ran: true, status: r.status ?? 1 };
}

const sceneGuid = readSceneGuid(W06_SCENE);
const expectedFp = computeW06Fingerprint(sceneGuid);
const projectVersion = readProjectUnityVersion(projectRoot);

function readRuntimeProof() {
  if (!fs.existsSync(runtimeProofPath)) return null;
  try { return readJson(runtimeProofPath); } catch { return null; }
}

function isW06AuthoritativePass(artifact) {
  return Boolean(
    artifact?.ok === true &&
    artifact?.status !== "failed" &&
    artifact?.proofSource === "unity_executeMethod_runtime_capture" &&
    artifact?.completionEvidence === "HertzAnalyticsCapture.CompleteAndStage" &&
    Number(artifact?.passed) === Number(artifact?.total) && Number(artifact?.total) > 0 &&
    !(Array.isArray(artifact?.checks) && artifact.checks.some((c) => c?.pass === false)) &&
    !artifact?.exception
  );
}

function w06AuthoritativeFailure(artifact) {
  if (!artifact || artifact.proofSource !== "unity_executeMethod_runtime_capture") return null;
  if (artifact.status === "pending") return null;
  if (artifact.status === "failed" || artifact.ok === false || artifact.exception ||
      (Array.isArray(artifact.checks) && artifact.checks.some((c) => c?.pass === false))) {
    return artifact.reason || artifact.failed || "authoritative_runtime_failed";
  }
  return null;
}

function freshnessFor(artifact) {
  if (!projectVersion.ok) return { ok: false, reason: projectVersion.reason };
  return validateProofFreshness(artifact, {
    expectedFingerprint: expectedFp,
    expectedUnityVersion: projectVersion.version,
    expectedScenePath: W06_SCENE,
    expectedSceneGuid: sceneGuid,
    expectedCheckSetVersion: W06_CHECK_SET_VERSION,
    expectedSchemaVersion: 5,
    sourceFiles: W06_FINGERPRINT_FILES,
  });
}

let runtime = readRuntimeProof();
const beforeAttempt = runtime;
const initialFreshness = freshnessFor(runtime);
const forceUnity = process.env.HERTZ_W06_FORCE_UNITY === "1";
const initialDecision = decideRuntimeProof({
  artifact: runtime, freshness: initialFreshness, force: forceUnity,
  isAuthoritativePass: isW06AuthoritativePass, authoritativeFailure: w06AuthoritativeFailure,
});
let rerunAttempt = null;
if (initialDecision.shouldRun) {
  const attempt = tryRunRuntimeProof();
  const selected = selectRuntimeAfterAttempt({ before: beforeAttempt, after: readRuntimeProof(), attempt });
  runtime = selected.artifact;
  rerunAttempt = { ...attempt, failed: selected.attemptFailed, reason: selected.reason };
  check("runtime_proof_execute", !selected.attemptFailed, attempt.reason || attempt.status, "RunRuntimeCaptureProof");
}

const freshness2 = freshnessFor(runtime);
let finalDecision = decideRuntimeProof({
  artifact: runtime, freshness: freshness2, force: false,
  isAuthoritativePass: isW06AuthoritativePass, authoritativeFailure: w06AuthoritativeFailure,
});
if (rerunAttempt?.failed && finalDecision.status !== "failed") {
  finalDecision = { ...finalDecision, status: "pending", reuse: false, reason: rerunAttempt.reason };
}
const runtimeOk = finalDecision.status === "passed" && isW06AuthoritativePass(runtime) && freshness2.ok;

check(
  "runtime_proof_identity",
  runtimeOk,
  runtime
    ? `${runtime.proofSource || "none"} ok=${runtime.ok} freshness=${freshness2.ok ? "ok" : freshness2.reason}`
    : "missing",
  "unity_executeMethod_runtime_capture + CompleteAndStage + fingerprint",
);

check(
  "isolated_proof_queue_root",
  Boolean(runtime?.proofQueueRoot && String(runtime.proofQueueRoot).includes("proofs") && String(runtime.proofQueueRoot).includes("w06-runtime-queue")),
  runtime?.proofQueueRoot || "missing",
  "Tools/.../proofs/w06-runtime-queue/<run-id>",
);

check(
  "quest_transfer_still_pending",
  runtime?.questTransferPending === true,
  runtime?.questTransferPending,
  true,
);

const prodHash = fileHash(productionManifest);
if (runtime?.productionManifestHashBefore && runtime?.productionManifestHashAfter) {
  check(
    "production_manifest_unchanged_by_proof",
    String(runtime.productionManifestHashBefore).toUpperCase() ===
      String(runtime.productionManifestHashAfter).toUpperCase(),
    `${runtime.productionManifestHashBefore}→${runtime.productionManifestHashAfter}`,
    "before===after",
  );
}

const capturePath =
  runtime?.stagedCapturePath && fs.existsSync(runtime.stagedCapturePath)
    ? runtime.stagedCapturePath
    : null;

check("staged_capture_present", Boolean(capturePath), capturePath || "missing", "isolated staged capture");
check(
  "staged_not_production_pending_slot",
  !capturePath || !capturePath.replace(/\\/g, "/").endsWith("/w06-pending-capture.json"),
  capturePath || "missing",
  "not legacy production pointer",
);

const failedAuthoritative = finalDecision.status === "failed";
let pendingCompletion = finalDecision.status === "pending";
if (!runtimeOk || !capturePath) {
  if (failedAuthoritative) {
    check("authoritative_failed_preserved", true, finalDecision.reason, "failed evidence preserved");
  } else {
    check(
      "completion_pending_real_capture",
      false,
      finalDecision.reason || freshness2.reason || "fixture_or_missing_runtime",
      "HertzAnalyticsCapture.CompleteAndStage evidence",
    );
  }
} else {
  const capture = readJson(capturePath);
  check(
    "capture_source_unity_runtime",
    capture.source === "unity_runtime",
    capture.source || "none",
    "unity_runtime",
  );
  check(
    "reject_fixture_as_completion",
    capture.source !== "unity_editor_fixture_not_completion" &&
      capture.fixtureOnly !== true &&
      capture.source !== "node_fallback_fixture" &&
      capture.source !== "unity_editor_proof",
    capture.source,
    "not fixture",
  );

  const proofDataDir = path.join(dataDir, "w06-proof-store");
  fs.rmSync(proofDataDir, { recursive: true, force: true });
  fs.mkdirSync(proofDataDir, { recursive: true });
  process.env.HERTZ_STUDIO_DATA = proofDataDir;

  const analytics = await import("../api/src/analytics.mjs");
  const first = analytics.importCapture(capture, { dataDir: proofDataDir, source: "w06_runtime_proof" });
  check("import_ok", first.ok && first.imported > 0, first.imported, ">0");

  const summary = analytics.summarizeAnalytics({ buildId: capture.buildId }, { dataDir: proofDataDir });
  check("sessions_present", summary.sampleCounts.sessions >= 1, summary.sampleCounts.sessions, ">=1");
  check("shots_traceable", summary.combat.shots >= 1, summary.combat.shots, ">=1");
  check("accuracy_defined", summary.combat.accuracy != null, summary.combat.accuracy, "number");
  check("enemy_defeats", summary.combat.enemyDefeats >= 1, summary.combat.enemyDefeats, ">=1");

  const second = analytics.importCapture(capture, { dataDir: proofDataDir, source: "w06_runtime_retry" });
  check("dedupe_no_double", second.imported === 0 && second.duplicates > 0, second, "dupes only");

  const csv = analytics.exportAnalytics({ buildId: capture.buildId }, { dataDir: proofDataDir, format: "csv" });
  check("csv_export", csv.body.includes("sessionId"), csv.body.slice(0, 80), "csv");

  const schema = analytics.getAnalyticsSchema();
  check("schema_quest_note", /unverified/i.test(schema.questTransferNote), "note", "unverified");
}

const passed = checks.filter((c) => c.pass).length;
const out = {
  schemaVersion: 5,
  proof: "w06-aggregate",
  ok: !pendingCompletion && !failedAuthoritative && passed === checks.length && checks.length > 0,
  pending: pendingCompletion && !failedAuthoritative,
  status: failedAuthoritative ? "failed" : pendingCompletion ? "pending" : passed === checks.length ? "passed" : "failed",
  passed,
  total: checks.length,
  generatedAt: new Date().toISOString(),
  sourceFingerprint: expectedFp,
  checkSetVersion: W06_CHECK_SET_VERSION,
  scenePath: W06_SCENE,
  sceneGuid,
  productionManifestHash: prodHash,
  currentUnityVersion: projectVersion.version,
  unityVersionValidation: projectVersion,
  rerunAttempt,
  layers: {
    runtime_playback: { ok: runtimeOk, status: finalDecision.status, reason: finalDecision.reason, source: runtime?.proofSource || runtime?.source || null },
    unity_application: { ok: runtimeOk, status: finalDecision.status, reason: finalDecision.reason },
  },
  proofSource: runtimeOk ? "runtime_capture_import" : failedAuthoritative ? "runtime_failed" : "pending_runtime_capture",
  questPending: true,
  checks,
  note: pendingCompletion
    ? `W06 completion requires fresh HertzAnalyticsCapture.CompleteAndStage evidence under isolated proof queue: ${finalDecision.reason}.`
    : failedAuthoritative
      ? "Authoritative runtime proof failed — not replaced by pending stub."
      : "Runtime capture imported through analytics boundary; Quest transfer still pending.",
};
fs.writeFileSync(proofOut, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify({
    ok: out.ok,
    pending: out.pending,
    status: out.status,
    passed: out.passed,
    total: out.total,
    fingerprint: expectedFp.slice(0, 12),
  }),
);
process.exit(out.ok ? 0 : out.pending ? 2 : 1);
