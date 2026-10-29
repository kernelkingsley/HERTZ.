/**
 * Shared Unity proof identity + freshness validation.
 * Stale or mismatched proofs must not pass as current evidence.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_ROOT = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(STUDIO_ROOT, "../..");
export const DATA_DIR = path.join(STUDIO_ROOT, "data");

export const W05_PROOF_SCHEMA = 3;
export const DEFAULT_MAX_AGE_HOURS = 72;

/** Source files that define W05 character behavior/sync product surface. */
export const W05_SOURCE_FILES = [
  "Assets/Scripts/Characters/HertzEnemyAgent.cs",
  "Assets/Scripts/Characters/HertzSpiritTarget.cs",
  "Assets/Scripts/Weapons/HertzFrequencyGate.cs",
  "Assets/Editor/HertzStudio/HertzStudioCharacterProof.cs",
  "Assets/Editor/HertzStudio/HertzStudioCharacterCommands.cs",
];

export function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toLowerCase();
}

export function fingerprintSources(relPaths, { root = REPO_ROOT } = {}) {
  const h = createHash("sha256");
  const present = [];
  for (const rel of relPaths) {
    const abs = path.join(root, rel);
    h.update(rel.replace(/\\/g, "/"));
    h.update("\0");
    if (fs.existsSync(abs)) {
      h.update(fs.readFileSync(abs));
      present.push(rel.replace(/\\/g, "/"));
    } else {
      h.update("MISSING");
    }
    h.update("\0");
  }
  return {
    sourceFingerprint: h.digest("hex").toLowerCase(),
    sourceFiles: present,
  };
}

export function readProjectUnityVersion(root = REPO_ROOT) {
  const p = path.join(root, "ProjectSettings/ProjectVersion.txt");
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, "utf8").match(/m_EditorVersion:\s*(\S+)/);
  return m ? m[1] : null;
}

export function readJsonBomSafe(filePath) {
  let text = fs.readFileSync(filePath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

/**
 * Validate a W05 Unity proof artifact against current project identity.
 * @returns {{ ok: boolean, pending?: boolean, reasons: string[], artifact?: object }}
 */
export function validateW05ProofArtifact(filePath, {
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  expectedScenePath = "Assets/Scenes/HertzCharacterTest.unity",
  requireLiveUnity = false,
} = {}) {
  const reasons = [];
  if (!fs.existsSync(filePath)) {
    return { ok: false, pending: true, reasons: ["missing_artifact"] };
  }
  let artifact;
  try {
    artifact = readJsonBomSafe(filePath);
  } catch (e) {
    return { ok: false, reasons: [`parse_error:${e.message}`] };
  }

  if (artifact.ok !== true) reasons.push("ok_not_true");
  if (!Array.isArray(artifact.checks) || artifact.checks.length < 1) reasons.push("no_checks");
  if (artifact.passed !== artifact.total) reasons.push("checks_incomplete");

  const schema = Number(artifact.schemaVersion);
  if (schema !== W05_PROOF_SCHEMA) {
    reasons.push(`schemaVersion_expected_${W05_PROOF_SCHEMA}_got_${artifact.schemaVersion ?? "missing"}`);
  }

  const stamped = artifact.generatedAt || artifact.stampedAt || artifact.executedAt;
  if (!stamped) {
    reasons.push("missing_timestamp");
  } else {
    const ageMs = Date.now() - Date.parse(stamped);
    if (!Number.isFinite(ageMs) || ageMs < 0) reasons.push("invalid_timestamp");
    else if (ageMs > maxAgeHours * 3600 * 1000) reasons.push(`stale_age_hours_${(ageMs / 3600000).toFixed(1)}`);
  }

  const expectedUnity = readProjectUnityVersion();
  if (expectedUnity && artifact.unityVersion && artifact.unityVersion !== expectedUnity) {
    reasons.push(`unityVersion_mismatch:${artifact.unityVersion}!=${expectedUnity}`);
  }
  if (!artifact.unityVersion) reasons.push("missing_unityVersion");

  const { sourceFingerprint } = fingerprintSources(W05_SOURCE_FILES);
  if (!artifact.sourceFingerprint) reasons.push("missing_sourceFingerprint");
  else if (artifact.sourceFingerprint !== sourceFingerprint) {
    reasons.push("sourceFingerprint_mismatch");
  }

  if (!artifact.proofSource) reasons.push("missing_proofSource");
  const scene = String(artifact.scenePath || "").replace(/\\/g, "/");
  if (scene.toLowerCase() !== expectedScenePath.toLowerCase()) {
    reasons.push(`scenePath_mismatch:${scene}`);
  }
  if (!artifact.sceneGuid) reasons.push("missing_sceneGuid");
  if (artifact.sceneRevision == null && artifact.unityRevision == null) {
    reasons.push("missing_sceneRevision");
  }

  if (requireLiveUnity && artifact.proofSource === "reused_stale_artifact") {
    reasons.push("reused_stale_not_allowed");
  }

  const pending = reasons.some((r) =>
    r.startsWith("missing_") || r.startsWith("stale_") || r.includes("mismatch") || r.includes("schemaVersion"),
  );

  return {
    ok: reasons.length === 0,
    pending: pending && reasons.length > 0,
    reasons,
    artifact,
    expected: {
      schemaVersion: W05_PROOF_SCHEMA,
      unityVersion: expectedUnity,
      sourceFingerprint,
      scenePath: expectedScenePath,
      maxAgeHours,
    },
  };
}

export function currentW05Identity() {
  const fp = fingerprintSources(W05_SOURCE_FILES);
  return {
    schemaVersion: W05_PROOF_SCHEMA,
    unityVersion: readProjectUnityVersion(),
    projectIdentity: path.basename(REPO_ROOT),
    ...fp,
    scenePath: "Assets/Scenes/HertzCharacterTest.unity",
  };
}
