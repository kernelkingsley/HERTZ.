import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  W06_CHECK_SET_VERSION,
  W06_FINGERPRINT_FILES,
  W06_SCENE,
  computeW06Fingerprint,
  readProjectUnityVersion,
  readSceneGuid,
  validateProofFreshness,
} from "./proof-fingerprint.mjs";

function currentArtifact(overrides = {}) {
  const guid = readSceneGuid(W06_SCENE);
  const projectVersion = readProjectUnityVersion();
  assert.equal(projectVersion.ok, true);
  return {
    schemaVersion: 5,
    checkSetVersion: W06_CHECK_SET_VERSION,
    sourceFingerprint: computeW06Fingerprint(guid),
    unityVersion: projectVersion.version,
    scenePath: W06_SCENE,
    sceneGuid: guid,
    generatedAt: new Date(Date.now() + 1000).toISOString(),
    ...overrides,
  };
}

function options() {
  const guid = readSceneGuid(W06_SCENE);
  return {
    expectedFingerprint: computeW06Fingerprint(guid),
    expectedUnityVersion: readProjectUnityVersion().version,
    expectedScenePath: W06_SCENE,
    expectedSceneGuid: guid,
    expectedCheckSetVersion: W06_CHECK_SET_VERSION,
    expectedSchemaVersion: 5,
    sourceFiles: W06_FINGERPRINT_FILES,
  };
}

describe("proof fingerprint freshness", () => {
  it("parses and matches the current project Unity version", () => {
    const v = readProjectUnityVersion();
    assert.equal(v.ok, true);
    assert.match(v.version, /^\d+\.\d+\.\d+[abfp]\d+$/);
    assert.equal(validateProofFreshness(currentArtifact(), options()).ok, true);
  });

  it("rejects mismatching and missing artifact Unity versions", () => {
    assert.equal(validateProofFreshness(currentArtifact({ unityVersion: "1.2.3f4" }), options()).reason, "unityVersion_mismatch");
    assert.equal(validateProofFreshness(currentArtifact({ unityVersion: undefined }), options()).reason, "unityVersion_missing");
  });

  it("fails closed for missing or malformed ProjectVersion.txt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hertz-version-"));
    assert.equal(readProjectUnityVersion(root).reason, "project_version_missing");
    fs.mkdirSync(path.join(root, "ProjectSettings"));
    fs.writeFileSync(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: banana\n");
    assert.equal(readProjectUnityVersion(root).reason, "project_version_malformed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects source fingerprint, scene path/GUID, schema and check-set mismatches", () => {
    assert.equal(validateProofFreshness(currentArtifact({ sourceFingerprint: "0".repeat(64) }), options()).reason, "sourceFingerprint_mismatch");
    assert.equal(validateProofFreshness(currentArtifact({ scenePath: "Assets/Scenes/Other.unity" }), options()).reason, "scenePath_mismatch");
    assert.equal(validateProofFreshness(currentArtifact({ sceneGuid: "0".repeat(32) }), options()).reason, "sceneGuid_mismatch");
    assert.match(validateProofFreshness(currentArtifact({ schemaVersion: 999 }), options()).reason, /^schemaVersion_/);
    assert.equal(validateProofFreshness(currentArtifact({ checkSetVersion: "old" }), options()).reason, "checkSetVersion_mismatch");
  });

  it("rejects an artifact older than a fingerprint source", () => {
    const stale = validateProofFreshness(currentArtifact({ generatedAt: "2000-01-01T00:00:00.000Z" }), options());
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /^stale_vs_/);
  });
});
