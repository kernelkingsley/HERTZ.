/**
 * Priority 1 #7: aggregate required Unity proof artifacts into regress:w03.
 * Fails closed on missing, stale, malformed, bad scene, wrong check names,
 * or passed:false / ok:false proofs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROOF_DIR = path.resolve(__dirname, "../data");
const PROOF_DIR = process.env.HERTZ_W03_PROOF_DIR
  ? path.resolve(process.env.HERTZ_W03_PROOF_DIR)
  : DEFAULT_PROOF_DIR;

/** Max age for Unity proofs included in the regression gate (14 days). */
export const PROOF_MAX_AGE_MS = Number(process.env.HERTZ_W03_PROOF_MAX_AGE_MS || 14 * 24 * 60 * 60 * 1000);

export const HERTZ_STUDIO_TEST_SCENE = "Assets/Scenes/HertzStudioTest.unity";

export const PLACE_REQUIRED_CHECKS = [
  "revisionRequired",
  "staleRevision",
  "dirtyRefuse",
  "idempotent",
  "transformPersisted",
  "globalObjectIdMatched",
  "payloadConflict",
  "sourceConfine",
  "multiSceneDirty",
  "savedCleanup",
];

export const PREFAB_REQUIRED_CHECKS = [
  "overridesPointAtCopyNotSource",
  "copyIsPrefabInstance",
  "copyCorrespondingAssetMatches",
  "nestedChildPresent",
  "nestedChildOverridePosition",
  "componentOverride",
  "nestedPrefabInstance",
  "serializedRefSourceWired",
  "serializedRefSourceComponentWired",
  "serializedRefPointsIntoCopy",
  "serializedRefNotSource",
  "serializedRefComponentPointsIntoCopy",
  "serializedRefComponentNotSource",
  "rootOverridePosition",
  "rootOverrideScale",
  "parentedUnderAnchor",
  "nonPrefabDuplicate",
  "childSelectionDuplicatesNearestRoot",
  "reopenedCopyPresent",
  "serializedRefAfterReopenPointsIntoCopy",
  "serializedRefAfterReopenNotSource",
  "serializedRefAfterReopenComponentPointsIntoCopy",
  "serializedRefAfterReopenComponentNotSource",
];

export const REQUIRED_PROOFS = [
  {
    file: "w03-place-safety-proof.json",
    successKey: "passed",
    requireScene: HERTZ_STUDIO_TEST_SCENE,
    requiredCheckNames: PLACE_REQUIRED_CHECKS,
  },
  {
    file: "w03-prefab-duplicate-proof.json",
    successKey: "passed",
    requireScene: HERTZ_STUDIO_TEST_SCENE,
    requiredCheckNames: PREFAB_REQUIRED_CHECKS,
  },
  {
    file: "w03-hash-proof.json",
    successKey: "ok",
    minChecks: 20,
  },
];

/**
 * @returns {{ ok: boolean, proofs: object[], failures: object[] }}
 */
export function evaluateUnityProofs(proofDir, { now = Date.now(), maxAgeMs = PROOF_MAX_AGE_MS } = {}) {
  const proofs = [];
  const failures = [];

  for (const req of REQUIRED_PROOFS) {
    const fullPath = path.join(proofDir, req.file);
    const entry = { file: req.file, path: fullPath };

    if (!fs.existsSync(fullPath)) {
      failures.push({ ...entry, reason: "missing" });
      continue;
    }

    let raw;
    try {
      raw = fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      failures.push({ ...entry, reason: "unreadable", detail: err.message });
      continue;
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      failures.push({ ...entry, reason: "malformed", detail: err.message });
      continue;
    }

    if (!json || typeof json !== "object" || Array.isArray(json)) {
      failures.push({ ...entry, reason: "malformed", detail: "root must be an object" });
      continue;
    }

    const success = json[req.successKey];
    if (success !== true) {
      failures.push({
        ...entry,
        reason: success === false ? "passed_false" : "malformed",
        detail: `${req.successKey}=${JSON.stringify(success)}`,
      });
      continue;
    }

    if (req.requireScene) {
      if (typeof json.scene !== "string" || json.scene.trim() === "") {
        failures.push({
          ...entry,
          reason: "bad_scene",
          detail: `scene missing or empty (required ${req.requireScene})`,
        });
        continue;
      }
      if (json.scene !== req.requireScene) {
        failures.push({
          ...entry,
          reason: "bad_scene",
          detail: `scene=${JSON.stringify(json.scene)} required=${req.requireScene}`,
        });
        continue;
      }
    }

    let checkCount = 0;
    if (req.requiredCheckNames) {
      if (!json.checks || typeof json.checks !== "object" || Array.isArray(json.checks)) {
        failures.push({ ...entry, reason: "malformed", detail: "checks object required" });
        continue;
      }
      const missing = [];
      const notTrue = [];
      for (const name of req.requiredCheckNames) {
        if (!Object.prototype.hasOwnProperty.call(json.checks, name)) {
          missing.push(name);
        } else if (json.checks[name] !== true) {
          notTrue.push(name);
        }
      }
      if (missing.length) {
        failures.push({
          ...entry,
          reason: "missing_required_checks",
          detail: missing.join(","),
        });
        continue;
      }
      if (notTrue.length) {
        failures.push({
          ...entry,
          reason: "passed_false",
          detail: `required checks not true: ${notTrue.join(",")}`,
        });
        continue;
      }
      checkCount = req.requiredCheckNames.length;
    } else if (typeof json.checks === "number") {
      checkCount = json.checks;
      if (checkCount < (req.minChecks || 0)) {
        failures.push({
          ...entry,
          reason: "malformed",
          detail: `checks ${checkCount} < required ${req.minChecks}`,
        });
        continue;
      }
    } else {
      failures.push({ ...entry, reason: "malformed", detail: "missing checks" });
      continue;
    }

    const stamped = parseStampMs(json, fullPath);
    if (stamped == null) {
      failures.push({ ...entry, reason: "malformed", detail: "missing ranAt/mtime" });
      continue;
    }
    if (now - stamped > maxAgeMs) {
      failures.push({
        ...entry,
        reason: "stale",
        detail: `ageMs=${now - stamped} maxAgeMs=${maxAgeMs}`,
      });
      continue;
    }

    proofs.push({
      file: req.file,
      successKey: req.successKey,
      checks: checkCount,
      scene: json.scene || null,
      stampedAt: new Date(stamped).toISOString(),
    });
  }

  return { ok: failures.length === 0, proofs, failures };
}

function parseStampMs(json, fullPath) {
  if (typeof json.ranAt === "string") {
    const t = Date.parse(json.ranAt);
    if (Number.isFinite(t)) return t;
  }
  try {
    return fs.statSync(fullPath).mtimeMs;
  } catch {
    return null;
  }
}

function writeProof(dir, file, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(body), "utf8");
}

function namedChecks(names, value = true) {
  return Object.fromEntries(names.map((n) => [n, value]));
}

function writePassingFixture(dir, { placeScene = HERTZ_STUDIO_TEST_SCENE, placeChecks = null, prefabChecks = null } = {}) {
  writeProof(dir, "w03-place-safety-proof.json", {
    passed: true,
    ranAt: new Date().toISOString(),
    scene: placeScene,
    checks: placeChecks || namedChecks(PLACE_REQUIRED_CHECKS),
  });
  writeProof(dir, "w03-prefab-duplicate-proof.json", {
    passed: true,
    ranAt: new Date().toISOString(),
    scene: HERTZ_STUDIO_TEST_SCENE,
    checks: prefabChecks || namedChecks(PREFAB_REQUIRED_CHECKS),
  });
  writeProof(dir, "w03-hash-proof.json", { ok: true, checks: 20, ranAt: new Date().toISOString() });
}

function selfTestFailClosed() {
  const results = [];

  // Missing proof file
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-neg-"));
    const r = evaluateUnityProofs(tmp, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_proof_missing",
      pass: r.ok === false && r.failures.some((f) => f.reason === "missing"),
    });
  }

  // Malformed JSON
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-mal-"));
    writePassingFixture(tmp);
    fs.writeFileSync(path.join(tmp, "w03-hash-proof.json"), "{not-json", "utf8");
    const r = evaluateUnityProofs(tmp, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_proof_malformed",
      pass: r.ok === false && r.failures.some((f) => f.file === "w03-hash-proof.json" && f.reason === "malformed"),
    });
  }

  // passed:false
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-false-"));
    writePassingFixture(dir);
    writeProof(dir, "w03-place-safety-proof.json", {
      passed: false,
      ranAt: new Date().toISOString(),
      scene: HERTZ_STUDIO_TEST_SCENE,
      checks: namedChecks(PLACE_REQUIRED_CHECKS),
    });
    const r = evaluateUnityProofs(dir, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_passed_false",
      pass: r.ok === false && r.failures.some((f) => f.reason === "passed_false"),
    });
  }

  // Stale
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-stale-"));
    writePassingFixture(dir);
    writeProof(dir, "w03-place-safety-proof.json", {
      passed: true,
      ranAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      scene: HERTZ_STUDIO_TEST_SCENE,
      checks: namedChecks(PLACE_REQUIRED_CHECKS),
    });
    const r = evaluateUnityProofs(dir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    results.push({
      name: "fails_when_proof_stale",
      pass: r.ok === false && r.failures.some((f) => f.reason === "stale"),
    });
  }

  // Missing scene
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-noscene-"));
    writePassingFixture(dir);
    writeProof(dir, "w03-place-safety-proof.json", {
      passed: true,
      ranAt: new Date().toISOString(),
      checks: namedChecks(PLACE_REQUIRED_CHECKS),
    });
    const r = evaluateUnityProofs(dir, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_scene_missing",
      pass:
        r.ok === false &&
        r.failures.some((f) => f.file === "w03-place-safety-proof.json" && f.reason === "bad_scene"),
    });
  }

  // Empty scene
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-emptyscene-"));
    writePassingFixture(dir);
    writeProof(dir, "w03-prefab-duplicate-proof.json", {
      passed: true,
      ranAt: new Date().toISOString(),
      scene: "",
      checks: namedChecks(PREFAB_REQUIRED_CHECKS),
    });
    const r = evaluateUnityProofs(dir, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_scene_empty",
      pass:
        r.ok === false &&
        r.failures.some((f) => f.file === "w03-prefab-duplicate-proof.json" && f.reason === "bad_scene"),
    });
  }

  // Incorrect scene (SampleScene must not satisfy the gate)
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-badscene-"));
    writePassingFixture(dir, { placeScene: "Assets/Scenes/SampleScene.unity" });
    const r = evaluateUnityProofs(dir, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_scene_incorrect",
      pass:
        r.ok === false &&
        r.failures.some((f) => f.file === "w03-place-safety-proof.json" && f.reason === "bad_scene"),
    });
  }

  // Arbitrary check names must not satisfy required named checks
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-w03-proof-fakechecks-"));
    const fake = Object.fromEntries(
      Array.from({ length: PLACE_REQUIRED_CHECKS.length }, (_, i) => [`fakeCheck${i}`, true]),
    );
    writePassingFixture(dir, { placeChecks: fake });
    const r = evaluateUnityProofs(dir, { maxAgeMs: PROOF_MAX_AGE_MS });
    results.push({
      name: "fails_when_required_check_names_missing",
      pass:
        r.ok === false &&
        r.failures.some(
          (f) => f.file === "w03-place-safety-proof.json" && f.reason === "missing_required_checks",
        ),
    });
  }

  for (const row of results) {
    assert.ok(row.pass, row.name);
  }
  return results;
}

const negative = selfTestFailClosed();
const aggregated = evaluateUnityProofs(PROOF_DIR);

if (!aggregated.ok) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        proofDir: PROOF_DIR,
        negativeChecks: negative.length,
        proofs: aggregated.proofs,
        failures: aggregated.failures,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      proofDir: PROOF_DIR,
      negativeChecks: negative.length,
      proofCount: aggregated.proofs.length,
      proofs: aggregated.proofs,
      failures: [],
    },
    null,
    2,
  ),
);
