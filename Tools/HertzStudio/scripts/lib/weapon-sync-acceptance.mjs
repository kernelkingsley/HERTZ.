/**
 * Fail-closed acceptance for Studio→Unity weapon sync evidence.
 * Does not treat disconnected/queued/applying as success.
 */

/**
 * @typedef {object} QueuedSync
 * @property {number|string} version
 * @property {string} payloadHash
 * @property {string} [weaponId]
 */

/**
 * @typedef {object} ObservedSync
 * @property {string} [state]
 * @property {string|null} [assetGuid]
 * @property {string|null} [assetPath]
 * @property {number|string|null} [observedVersion]
 * @property {string|null} [observedPayloadHash]
 * @property {string|null} [payloadHash]
 */

/**
 * @typedef {object} UnityResolve
 * @property {boolean} [ok]
 * @property {boolean} [exists]
 * @property {string} [assetType]
 * @property {string} [weaponId]
 * @property {number|string} [studioVersion]
 * @property {string} [studioPayloadHash]
 * @property {string} [error]
 * @property {boolean} [disconnected]
 */

/**
 * @param {{ queued: QueuedSync, sync: ObservedSync, unity?: UnityResolve|null }} args
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function acceptWeaponSyncEvidence({ queued, sync, unity = null } = {}) {
  const reasons = [];
  if (!queued || queued.version == null || !queued.payloadHash) {
    reasons.push("missing_queued_version_or_hash");
    return { ok: false, reasons };
  }
  if (!sync) {
    reasons.push("missing_sync");
    return { ok: false, reasons };
  }

  const state = String(sync.state || "disconnected").toLowerCase();
  if (state === "disconnected") {
    reasons.push("disconnected");
    return { ok: false, reasons };
  }
  if (state === "queued") {
    reasons.push("queued_only");
    return { ok: false, reasons };
  }
  if (state === "applying") {
    reasons.push("applying_only");
    return { ok: false, reasons };
  }
  if (state !== "applied") {
    reasons.push(`state_not_applied:${state}`);
    return { ok: false, reasons };
  }

  const guid = sync.assetGuid != null ? String(sync.assetGuid).trim() : "";
  const assetPath = sync.assetPath != null ? String(sync.assetPath).trim() : "";
  if (!guid) reasons.push("missing_guid");
  if (!assetPath || !assetPath.startsWith("Assets/")) reasons.push("missing_or_invalid_path");

  const observedVersion = sync.observedVersion;
  const observedHash = sync.observedPayloadHash || sync.payloadHash || null;
  if (observedVersion == null || Number(observedVersion) !== Number(queued.version)) {
    reasons.push("version_mismatch");
  }
  if (!observedHash || String(observedHash) !== String(queued.payloadHash)) {
    reasons.push("payload_hash_mismatch");
  }

  if (reasons.length) return { ok: false, reasons };

  if (!unity || unity.disconnected) {
    reasons.push("unity_resolve_missing_or_disconnected");
    return { ok: false, reasons };
  }
  if (!unity.ok || unity.exists === false) {
    reasons.push("unity_asset_nonexistent");
    return { ok: false, reasons };
  }
  if (String(unity.assetType || "") !== "HertzWeaponDefinition") {
    reasons.push("wrong_unity_asset_type");
    return { ok: false, reasons };
  }
  if (queued.weaponId && String(unity.weaponId || "") !== String(queued.weaponId)) {
    reasons.push("weapon_id_mismatch");
    return { ok: false, reasons };
  }
  if (Number(unity.studioVersion) !== Number(queued.version)) {
    reasons.push("unity_studio_version_mismatch");
    return { ok: false, reasons };
  }
  if (String(unity.studioPayloadHash || "") !== String(queued.payloadHash)) {
    reasons.push("unity_studio_payload_hash_mismatch");
    return { ok: false, reasons };
  }

  return { ok: true, reasons: [] };
}
