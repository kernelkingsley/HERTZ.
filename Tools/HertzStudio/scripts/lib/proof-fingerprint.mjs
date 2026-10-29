/**
 * Deterministic source fingerprints for W06/W07 Unity proof freshness.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lib → scripts → HertzStudio → Tools → HERTZ
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

export const W06_FINGERPRINT_FILES = Object.freeze([
  "ProjectSettings/ProjectVersion.txt",
  "Assets/Scripts/Analytics/HertzAnalyticsPendingQueue.cs",
  "Assets/Scripts/Analytics/HertzAnalyticsCapture.cs",
  "Assets/Scripts/Weapons/HertzDualPistolRuntime.cs",
  "Assets/Scripts/Weapons/HertzWeaponTestTarget.cs",
  "Assets/Editor/HertzStudio/HertzStudioAnalyticsProof.cs",
  "Tools/HertzStudio/scripts/proof-w06-aggregate.mjs",
]);

/** HertzFootstepPlayer lives in HertzFootstepSurfaceMap.cs (same compilation unit). */
export const W07_FINGERPRINT_FILES = Object.freeze([
  "ProjectSettings/ProjectVersion.txt",
  "Assets/Scripts/Weapons/HertzDualPistolRuntime.cs",
  "Assets/Scripts/Sound/HertzWeaponShotClipPresenter.cs",
  "Assets/Scripts/Sound/HertzFootstepSurfaceMap.cs",
  "Assets/Editor/HertzStudio/HertzStudioSoundCommands.cs",
  "Tools/HertzStudio/api/src/sound.mjs",
  "Tools/HertzStudio/connector/src/connector.mjs",

  "Tools/HertzStudio/scripts/proof-w07-aggregate.mjs",
  "Tools/HertzStudio/scripts/lib/w07-aggregate-status.mjs",
]);

export function readSceneGuid(scenePath = W06_SCENE) {
  const meta = path.join(PROJECT_ROOT, scenePath + ".meta");
  if (!fs.existsSync(meta)) return null;
  const m = fs.readFileSync(meta, "utf8").match(/^guid:\s*([a-f0-9]{32})/m);
  return m ? m[1] : null;
}

export const W06_CHECK_SET_VERSION = "w06-checks-v5-editor-lifecycle";
export const W07_CHECK_SET_VERSION = "w07-checks-v3-playmode";
export const W06_SCENE = "Assets/Scenes/HertzWeaponTest.unity";
export const W07_SCENE = "Assets/Scenes/HertzWeaponTest.unity";

export function readProjectUnityVersion(projectRoot = PROJECT_ROOT) {
  const versionPath = path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt");
  if (!fs.existsSync(versionPath)) {
    return { ok: false, version: null, reason: "project_version_missing", path: versionPath };
  }
  const text = fs.readFileSync(versionPath, "utf8").replace(/^\uFEFF/, "");
  const match = text.match(/^m_EditorVersion:\s*([^\s]+)\s*$/m);
  if (!match || !/^\d+\.\d+\.\d+[abfp]\d+$/.test(match[1])) {
    return { ok: false, version: null, reason: "project_version_malformed", path: versionPath };
  }
  return { ok: true, version: match[1], reason: null, path: versionPath };
}

export function hashFiles(relativePaths, { scenePath = null, sceneGuid = null } = {}) {
  const h = crypto.createHash("sha256");
  for (const rel of relativePaths) {
    const full = path.join(PROJECT_ROOT, rel);
    const norm = rel.replace(/\\/g, "/");
    h.update(norm + "\n");
    if (fs.existsSync(full)) h.update(fs.readFileSync(full));
    else h.update("MISSING");
  }
  if (scenePath) h.update(`scenePath:${scenePath}\n`);
  if (sceneGuid) h.update(`sceneGuid:${sceneGuid}\n`);
  return h.digest("hex");
}

export function computeW06Fingerprint(sceneGuid = null) {
  return hashFiles(W06_FINGERPRINT_FILES, { scenePath: W06_SCENE, sceneGuid });
}

export function computeW07Fingerprint(sceneGuid = null) {
  return hashFiles(W07_FINGERPRINT_FILES, { scenePath: W07_SCENE, sceneGuid });
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateProofFreshness(artifact, {
  expectedFingerprint,
  expectedUnityVersion = null,
  expectedScenePath = null,
  expectedSceneGuid = null,
  expectedCheckSetVersion = null,
  expectedSchemaVersion = null,
  sourceFiles = [],
} = {}) {
  if (!artifact || typeof artifact !== "object") {
    return { ok: false, reason: "missing_artifact" };
  }
  if (expectedSchemaVersion != null && Number(artifact.schemaVersion) !== Number(expectedSchemaVersion)) {
    return { ok: false, reason: `schemaVersion_${artifact.schemaVersion}_!=_${expectedSchemaVersion}` };
  }
  if (expectedCheckSetVersion && artifact.checkSetVersion !== expectedCheckSetVersion) {
    return { ok: false, reason: `checkSetVersion_mismatch` };
  }
  if (!artifact.sourceFingerprint || artifact.sourceFingerprint !== expectedFingerprint) {
    return { ok: false, reason: "sourceFingerprint_mismatch" };
  }
  if (expectedUnityVersion) {
    if (!artifact.unityVersion) return { ok: false, reason: "unityVersion_missing" };
    if (artifact.unityVersion !== expectedUnityVersion) return { ok: false, reason: "unityVersion_mismatch" };
  }
  if (expectedScenePath && artifact.scenePath !== expectedScenePath) {
    return { ok: false, reason: "scenePath_mismatch" };
  }
  if (expectedSceneGuid && artifact.sceneGuid !== expectedSceneGuid) {
    return { ok: false, reason: "sceneGuid_mismatch" };
  }

  const stamped = Date.parse(artifact.generatedAt || artifact.stampedAt || 0);
  if (!Number.isFinite(stamped)) {
    return { ok: false, reason: "missing_timestamp" };
  }

  for (const rel of sourceFiles) {
    const full = path.join(PROJECT_ROOT, rel);
    if (!fs.existsSync(full)) {
      return { ok: false, reason: `missing_source_${rel}` };
    }
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime > stamped) {
      return { ok: false, reason: `stale_vs_${rel}` };
    }
  }

  return { ok: true };
}
