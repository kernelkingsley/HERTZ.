/**
 * Fail-closed helpers for W03 browser E2E. Pure functions — no tautologies.
 */

export function assertLocalSpaceLabel(text) {
  const t = String(text || "");
  if (!/local/i.test(t)) {
    throw new Error(`Expected local transform space label, got: ${t.slice(0, 120)}`);
  }
  return true;
}

export function assertWorldSpaceLabel(text) {
  const t = String(text || "");
  if (!/world/i.test(t)) {
    throw new Error(`Expected world transform space label, got: ${t.slice(0, 120)}`);
  }
  return true;
}

export function assertNoTautologyPass(expressionSource) {
  const src = String(expressionSource || "");
  if (/\|\|\s*true\b/.test(src) || /Boolean\([^)]+\)\s*\|\|\s*true/.test(src)) {
    throw new Error(`Tautology detected in E2E source: ${src.slice(0, 160)}`);
  }
  if (/space\.length\s*>=\s*0/.test(src)) {
    throw new Error(`Meaningless length check in E2E source: ${src.slice(0, 160)}`);
  }
  return true;
}

export function assertPersistedPositionChanged(before, after, axis = "x", minDelta = 0.05) {
  const b = Number(before?.[axis]);
  const a = Number(after?.[axis]);
  if (!Number.isFinite(b) || !Number.isFinite(a)) {
    throw new Error(`Non-finite position.${axis}: before=${b} after=${a}`);
  }
  if (Math.abs(a - b) < minDelta) {
    throw new Error(`Position.${axis} did not change enough: ${b} → ${a}`);
  }
  return true;
}

export function assertErrorVisible(text, pattern) {
  const t = String(text || "");
  if (!t.trim()) throw new Error("Expected visible error text, got empty");
  if (pattern && !pattern.test(t)) {
    throw new Error(`Error text did not match ${pattern}: ${t.slice(0, 200)}`);
  }
  return true;
}

export function assertConnectionKind(panelText, kind) {
  const t = String(panelText || "").toLowerCase();
  const k = String(kind || "").toLowerCase();
  if (!t.includes(k)) {
    throw new Error(`Connection panel missing kind "${kind}": ${t.slice(0, 200)}`);
  }
  return true;
}

/** Fail when Main Camera was not selected before a protected drop. */
export function assertProtectedObjectSelected({ selectedLabel, selectedObjectId, cameraObjectId }) {
  const label = String(selectedLabel || "");
  if (!/main\s*camera/i.test(label)) {
    throw new Error(`Expected Selected: Main Camera, got: ${label.slice(0, 120)}`);
  }
  if (!selectedObjectId) {
    throw new Error("Protected selection missing objectId");
  }
  if (cameraObjectId && selectedObjectId !== cameraObjectId) {
    throw new Error(`Selected objectId ${selectedObjectId} !== camera ${cameraObjectId}`);
  }
  return true;
}

/**
 * Fresh protected-target error must match protect/camera and must not equal a prior error
 * (e.g. incompatible-drop message reused as a false positive).
 */
export function assertFreshProtectedError(protErr, priorIncompatErr) {
  const t = String(protErr || "").trim();
  if (!t) throw new Error("Expected fresh protected-target error, got empty");
  const prior = String(priorIncompatErr || "").trim();
  if (prior && t === prior) {
    throw new Error("Protected error reused the incompatible-drop error verbatim");
  }
  if (prior && /audio|does not match catalog/i.test(t) && !/protect|camera|xr/i.test(t)) {
    throw new Error(`Protected check reused incompatible messaging: ${t.slice(0, 200)}`);
  }
  if (!/protect|camera|xr/i.test(t)) {
    throw new Error(`Protected error did not mention protect/camera: ${t.slice(0, 200)}`);
  }
  return true;
}

export function objectIdFingerprint(objects) {
  return (Array.isArray(objects) ? objects : [])
    .map((o) => o?.objectId)
    .filter(Boolean)
    .slice()
    .sort()
    .join("|");
}

/** Draft identities + version + queue must be unchanged (incompatible / protected rejects). */
export function assertDraftAndQueueUnchanged(before, after, { label = "drop" } = {}) {
  if (!before || !after) throw new Error(`${label}: missing before/after snapshot`);
  if (Number(before.version) !== Number(after.version)) {
    throw new Error(`${label}: draft version changed ${before.version} → ${after.version}`);
  }
  const beforeIds = objectIdFingerprint(before.objects);
  const afterIds = objectIdFingerprint(after.objects);
  if (beforeIds !== afterIds) {
    throw new Error(`${label}: draft object identities changed`);
  }
  if (Number(before.queueCount) !== Number(after.queueCount)) {
    throw new Error(`${label}: queue count changed ${before.queueCount} → ${after.queueCount}`);
  }
  const queueDelta = Number(after.queueCount) - Number(before.queueCount);
  if (queueDelta !== 0) {
    throw new Error(`${label}: queueDelta ${queueDelta} !== 0`);
  }
  return true;
}

/** Compatible drop must add an object and bump version; no drop / “No draft loaded” errors. */
export function assertCompatibleDropResult({
  before,
  after,
  modelId,
  dropErrorText = "",
  applyBlockText = "",
}) {
  if (!before || !after) throw new Error("compatible drop: missing snapshots");
  if (Number(after.version) !== Number(before.version) + 1) {
    throw new Error(
      `compatible drop: expected version ${Number(before.version) + 1}, got ${after.version}`,
    );
  }
  const placed = (after.objects || []).find(
    (o) =>
      o?.assetId === modelId ||
      o?.operation === "instantiate_model" ||
      /^lib-/i.test(o?.objectId || ""),
  );
  if (!placed) {
    throw new Error("compatible drop: expected new instantiate/lib draft object");
  }
  const errBlob = `${dropErrorText || ""}\n${applyBlockText || ""}`;
  if (/No draft loaded/i.test(errBlob)) {
    throw new Error("compatible drop left No draft loaded state");
  }
  if (/rejected by server|stale|mismatch|does not match catalog|Forged|non-library/i.test(dropErrorText || "")) {
    throw new Error(`compatible drop surfaced error: ${String(dropErrorText).slice(0, 200)}`);
  }
  return { placed };
}

export function assertE2eRunnerEnablesMode(source) {
  const src = String(source || "");
  if (!/addInitScript/.test(src) || !/__HERTZ_E2E_MODE__\s*=\s*true/.test(src)) {
    throw new Error("E2E runner must enable __HERTZ_E2E_MODE__ via addInitScript before navigation");
  }
  if (/\.catch\s*\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(src) && /main camera/i.test(src)) {
    // Soft signal — detailed swallow check is in assertNoProtectedSelectionSwallow
  }
  return true;
}

export function assertNoProtectedSelectionSwallow(source) {
  const src = String(source || "");
  // Disallow swallowing Main Camera click failure before protected drop.
  if (/main camera[\s\S]{0,120}\.catch\s*\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/i.test(src)) {
    throw new Error("Protected drop must not swallow Main Camera selection failure with empty catch");
  }
  if (/protErr\s*\|\|\s*incompatErr/.test(src)) {
    throw new Error("Protected drop must not fall back to incompatErr");
  }
  return true;
}

export function assertLevelEditorHooksGated(source) {
  const src = String(source || "");
  if (!/isHertzE2eMode\s*\(/.test(src)) {
    throw new Error("LevelEditor must gate __HERTZ_LEVEL_EDITOR_TEST__ with isHertzE2eMode()");
  }
  if (/__HERTZ_LEVEL_EDITOR_TEST__\s*=/.test(src) && !/isHertzE2eMode/.test(src)) {
    throw new Error("LevelEditor assigns test hooks without E2E mode gate");
  }
  return true;
}
