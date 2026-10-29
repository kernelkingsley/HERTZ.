import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptWeaponSyncEvidence } from "./weapon-sync-acceptance.mjs";

const queued = { version: 3, payloadHash: "hash-abc", weaponId: "w1" };
const appliedSync = {
  state: "applied",
  assetGuid: "guid-1",
  assetPath: "Assets/HertzStudio/Weapons/Definitions/w1.asset",
  observedVersion: 3,
  observedPayloadHash: "hash-abc",
};
const unityOk = {
  ok: true,
  exists: true,
  assetType: "HertzWeaponDefinition",
  weaponId: "w1",
  studioVersion: 3,
  studioPayloadHash: "hash-abc",
};

describe("acceptWeaponSyncEvidence", () => {
  it("accepts applied + hash/version + Unity resolve", () => {
    const r = acceptWeaponSyncEvidence({ queued, sync: appliedSync, unity: unityOk });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
  });

  it("rejects disconnected (not derived from applied string)", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: { state: "disconnected", assetGuid: null, assetPath: null },
      unity: unityOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("disconnected"));
  });

  it("rejects queued-only", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: { ...appliedSync, state: "queued" },
      unity: unityOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("queued_only"));
  });

  it("rejects applying-only", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: { ...appliedSync, state: "applying" },
      unity: unityOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("applying_only"));
  });

  it("rejects missing GUID/path", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: { ...appliedSync, assetGuid: "", assetPath: "relative/nope" },
      unity: unityOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("missing_guid"));
    assert.ok(r.reasons.includes("missing_or_invalid_path"));
  });

  it("rejects wrong payload hash", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: { ...appliedSync, observedPayloadHash: "other" },
      unity: unityOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("payload_hash_mismatch"));
  });

  it("rejects wrong version", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: { ...appliedSync, observedVersion: 99 },
      unity: unityOk,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("version_mismatch"));
  });

  it("rejects nonexistent Unity asset", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: appliedSync,
      unity: { ok: false, exists: false, error: "missing" },
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("unity_asset_nonexistent"));
  });

  it("rejects wrong Unity asset type", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: appliedSync,
      unity: { ...unityOk, assetType: "Material" },
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("wrong_unity_asset_type"));
  });

  it("rejects mismatched WeaponId", () => {
    const r = acceptWeaponSyncEvidence({
      queued,
      sync: appliedSync,
      unity: { ...unityOk, weaponId: "other" },
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.includes("weapon_id_mismatch"));
  });
});
