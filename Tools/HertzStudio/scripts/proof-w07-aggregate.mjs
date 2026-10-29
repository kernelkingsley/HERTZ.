/**
 * Fail-closed W07 aggregate with truthful status:
 * ok:true / status:passed only when every required layer passes.
 * pending → ok:false, exit 2; failed → ok:false, exit 1.
 */
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import {
  AUTHORITATIVE_RUNTIME_SOURCES,
  evaluateW07AggregateStatus,
  isAuthoritativeRuntimeFailure,
  isAuthoritativeRuntimePass,
  validateW07ConnectorDelivery,
  w07AggregateExitCode,
} from "./lib/w07-aggregate-status.mjs";
import {
  W07_CHECK_SET_VERSION,
  W07_FINGERPRINT_FILES,
  W07_SCENE,
  computeW07Fingerprint,
  readProjectUnityVersion,
  readSceneGuid,
  validateProofFreshness,
} from "./lib/proof-fingerprint.mjs";
import { decideRuntimeProof, selectRuntimeAfterAttempt } from "./lib/proof-runtime-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const proofOut = path.join(dataDir, "w07-aggregate-proof.json");
const runtimeProof = path.join(dataDir, "w07-sound-runtime-proof.json");
const connectorDeliveryProof = path.join(dataDir, "w07-connector-delivery-proof.json");

const checks = [];
function check(name, pass, actual, expected, layer = "api_data") {
  checks.push({ name, pass: Boolean(pass), actual, expected, layer });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w07-agg-"));
process.env.HERTZ_STUDIO_DATA = tmp;
const audioId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
fs.writeFileSync(
  path.join(tmp, "assets-catalog.json"),
  JSON.stringify({
    version: 1,
    assets: {
      [audioId]: {
        id: audioId,
        name: "kenney_impact",
        assetType: "audio",
        provider: "kenney",
        license: "CC0",
        fileFormat: "wav",
        state: "unity_imported",
        unity: { readiness: "ready", clipPath: "Assets/HertzStudio/Imported/a/clip.wav" },
      },
    },
    jobs: [],
    uploads: {},
  }),
);

const sound = await import("../api/src/sound.mjs");
sound.upsertSlot({
  category: "weapon",
  slotKey: "shot",
  targetId: "left_pistol",
  audioAssetId: audioId,
});
sound.upsertEmitter({
  name: "Proof Emitter",
  volume: 0.6,
  loop: true,
  spatialBlend: 1,
  maxDistance: 20,
  audioAssetId: audioId,
});
const foot = sound.upsertFootstepMapping({
  surfaceId: "floor_wood",
  surfaceLabel: "Wood floor",
  audioAssetId: audioId,
});
check("footstep_explicit", foot.surfaceId === "floor_wood", foot.surfaceId, "floor_wood", "api_data");
check(
  "reject_auto_material",
  (() => {
    try {
      sound.upsertFootstepMapping({ surfaceId: "x", audioAssetId: audioId, materialGuid: "g" });
      return false;
    } catch (e) {
      return e.code === "footstep_auto_forbidden";
    }
  })(),
  true,
  "footstep_auto_forbidden",
  "api_data",
);

const board = sound.getSoundBoard();
check("board_has_slot", board.slots.some((s) => s.audioAssetId === audioId), board.slots.length, ">=1", "api_data");
check("board_has_emitter", board.emitters.length >= 1, board.emitters.length, ">=1", "api_data");
check(
  "comfort_rule",
  board.rules.materialAppearanceDoesNotChangeFootsteps === true,
  board.rules.materialAppearanceDoesNotChangeFootsteps,
  true,
  "api_data",
);

const job = sound.enqueueSoundSync("w07-agg-sync");
check("sync_enqueued", job?.payload?.payloadHash != null, job?.type, "sync_sound_board", "api_data");
check(
  "sync_payload_hash_present",
  typeof job?.payload?.payloadHash === "string" && job.payload.payloadHash.length > 8,
  job?.payload?.payloadHash?.slice?.(0, 8),
  "hash",
  "api_data",
);

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readRuntimeProof() {
  return readJson(runtimeProof);
}

const sceneGuid = readSceneGuid(W07_SCENE);
const expectedW07Fp = computeW07Fingerprint(sceneGuid);
const projectVersion = readProjectUnityVersion(projectRoot);
function freshnessFor(artifact) {
  if (!projectVersion.ok) return { ok: false, reason: projectVersion.reason };
  return validateProofFreshness(artifact, {
    expectedFingerprint: expectedW07Fp,
    expectedUnityVersion: projectVersion.version,
    expectedScenePath: W07_SCENE,
    expectedSceneGuid: sceneGuid,
    expectedCheckSetVersion: W07_CHECK_SET_VERSION,
    expectedSchemaVersion: 3,
    sourceFiles: W07_FINGERPRINT_FILES,
  });
}

function tryRunRuntimeProof() {
  const unity = process.env.UNITY_EDITOR || process.env.UNITY_PATH ||
    "C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.85f1\\Editor\\Unity.exe";
  if (!fs.existsSync(unity)) return { ran: false, reason: "unity_editor_missing" };
  const log = path.join(dataDir, "w07-unity-SoundRuntime.log");
  const result = spawnSync(unity, [
    "-batchmode", "-nographics", "-quit", "-projectPath", projectRoot,
    "-executeMethod", "HertzStudio.Editor.HertzStudioSoundCommands.RunSoundProof",
    "-logFile", log,
  ], { stdio: "inherit", timeout: 300000 });
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  if (/another Unity instance is running/i.test(logText)) {
    return { ran: false, reason: "unity_editor_project_locked", status: result.status };
  }
  return { ran: true, status: result.status ?? 1 };
}

let rt = readRuntimeProof();
const beforeAttempt = rt;
const initialFreshness = freshnessFor(rt);
const forceUnity = process.env.HERTZ_W07_FORCE_UNITY === "1";
const initialDecision = decideRuntimeProof({
  artifact: rt, freshness: initialFreshness, force: forceUnity,
  isAuthoritativePass: isAuthoritativeRuntimePass, authoritativeFailure: isAuthoritativeRuntimeFailure,
});
let rerunAttempt = null;
if (initialDecision.shouldRun) {
  const attempt = tryRunRuntimeProof();
  const selected = selectRuntimeAfterAttempt({ before: beforeAttempt, after: readRuntimeProof(), attempt });
  rt = selected.artifact;
  rerunAttempt = { ...attempt, failed: selected.attemptFailed, reason: selected.reason };
}
const w07Freshness = freshnessFor(rt);
let finalDecision = decideRuntimeProof({
  artifact: rt, freshness: w07Freshness, force: false,
  isAuthoritativePass: isAuthoritativeRuntimePass, authoritativeFailure: isAuthoritativeRuntimeFailure,
});
if (rerunAttempt?.failed && finalDecision.status !== "failed") {
  finalDecision = { ...finalDecision, status: "pending", reuse: false, reason: rerunAttempt.reason };
}
const runtimeFreshForStatus = w07Freshness.ok && !rerunAttempt?.failed;
const runtimePassed = isAuthoritativeRuntimePass(rt) && runtimeFreshForStatus;
const unityApplyOk = Boolean(rt?.unityApplication?.ok === true) && runtimeFreshForStatus;
const connectorDelivery = validateW07ConnectorDelivery(readJson(connectorDeliveryProof), rt);
const connectorOk = connectorDelivery.ok === true;
check("runtime_proof_exists", Boolean(rt), runtimeProof, "present", "runtime_playback");
check(
  "runtime_not_fallback_fixture",
  rt?.source !== "node_fallback_fixture",
  rt?.source,
  "not node_fallback_fixture",
  "runtime_playback",
);
check(
  "runtime_source_freshness",
  w07Freshness.ok || rt?.status === "pending",
  w07Freshness.ok ? "ok" : w07Freshness.reason,
  "fingerprint+schema match (or pending)",
  "runtime_playback",
);
check(
  "runtime_playback_ok",
  runtimePassed,
  { source: rt?.source, passed: rt?.passed, total: rt?.total, freshness: w07Freshness.reason || "ok" },
  "authoritative unity runtime + fresh fingerprint",
  "runtime_playback",
);
check(
  "unity_application_ok",
  unityApplyOk,
  rt?.unityApplication || null,
  "unityApplication.ok from SyncSoundBoard proof",
  "unity_application",
);
check(
  "connector_delivery_ok",
  connectorOk,
  connectorDelivery,
  "fresh matching Unity + API acknowledgement from live Studio connector",
  "connector_delivery",
);
check(
  "manual_verification_ok",
  false,
  "manualVerification_gate_false_until_playmode",
  "passed_only_after_playmode",
  "manual_verification",
);

fs.rmSync(tmp, { recursive: true, force: true });

const apiChecks = checks.filter((c) => c.layer === "api_data");
const apiOk = apiChecks.every((c) => c.pass) && apiChecks.length > 0;
const apiFailed = apiChecks.filter((c) => !c.pass).map((c) => c.name);

const evaluation = evaluateW07AggregateStatus({
  apiOk,
  connectorOk,
  unityApplyOk,
  manualOk: false,
  runtimeProof: rt,
  runtimeFresh: runtimeFreshForStatus,
  runtimeUnavailableReason: finalDecision.reason,
  failedChecks: apiFailed,
});

const layerChecksPassed = checks.filter((c) => c.pass).length;
const out = {
  schemaVersion: 4,
  proof: "w07-aggregate",
  status: evaluation.status,
  ok: evaluation.ok === true && evaluation.status === "passed",
  completion: evaluation.completion === true,
  passed: layerChecksPassed,
  total: checks.length,
  reason: evaluation.reason,
  sourceFingerprint: expectedW07Fp,
  checkSetVersion: W07_CHECK_SET_VERSION,
  scenePath: W07_SCENE,
  sceneGuid,
  stampedAt: new Date().toISOString(),
  currentUnityVersion: projectVersion.version,
  unityVersionValidation: projectVersion,
  rerunAttempt,
  layers: {
    api_data: { ok: apiOk },
    connector_delivery: {
      ok: connectorOk,
      status: connectorOk ? "passed" : "pending",
      detail: connectorDelivery,
    },
    unity_application: {
      ok: unityApplyOk,
      status: unityApplyOk ? "passed" : "pending",
      detail: rt?.unityApplication || null,
    },
    runtime_playback: evaluation.runtime,
    manual_verification: { ok: false, status: "pending" },
  },
  authoritativeRuntimeSources: [...AUTHORITATIVE_RUNTIME_SOURCES],
  menuWhenUnityFree: "HERTZ/Studio/Proofs/W07 Sound Runtime",
  checks,
};
fs.writeFileSync(proofOut, `${JSON.stringify(out, null, 2)}\n`);

const exitCode = w07AggregateExitCode(evaluation);
console.log(
  JSON.stringify({
    status: out.status,
    ok: out.ok,
    completion: out.completion,
    passed: out.passed,
    total: out.total,
    reason: out.reason,
    runtime: out.layers.runtime_playback,
    exitCode,
    note:
      exitCode === 2
        ? `PENDING - not a completed W07 proof (${evaluation.pendingLayers?.join(", ") || "verification"} required)`
        : exitCode === 0
          ? "PASSED — all required layers verified"
          : "FAILED",
  }),
);
process.exit(exitCode);
