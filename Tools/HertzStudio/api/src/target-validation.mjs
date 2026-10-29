/**
 * Authoritative typed-target validation for library drops and Apply.
 * Uses Unity-exported component/collider/surface metadata — not object names.
 */
import { validateLibraryDrop } from "./draft-commands.mjs";
import {
  TARGET_METADATA_SCHEMA,
  validateTargetForOperation,
  validateDropFreshness,
  objectHasRenderer,
  objectHasSpriteRenderer,
  objectHasUiImage,
  objectHasAudioSource,
  objectHasAnimator,
  surfaceKindOf,
} from "./target-checks.mjs";

export {
  TARGET_METADATA_SCHEMA,
  validateTargetForOperation,
  validateDropFreshness,
  objectHasRenderer,
  objectHasSpriteRenderer,
  objectHasUiImage,
  objectHasAudioSource,
  objectHasAnimator,
  surfaceKindOf,
};

/**
 * Validate a typed drop against draft + authoritative target metadata + freshness.
 */
export function validateTypedDrop({
  assetId,
  claimedType,
  operation,
  draft = null,
  draftId = null,
  targetObjectId = null,
  materialSlot = 0,
  expectedDraftVersion = undefined,
  expectedScenePath = undefined,
  expectedUnityRevision = undefined,
  expectedExportGeneration = undefined,
  expectedTargetMetadataSchema = undefined,
} = {}) {
  const op = operation || "instantiate_model";

  if (!draftId && !draft) {
    return { ok: false, status: 400, error: "draftId is required.", code: "missing_draft" };
  }
  if (!draft) {
    return { ok: false, status: 404, error: "Draft not found", code: "missing_draft" };
  }

  const fresh = validateDropFreshness({
    draft,
    expectedDraftVersion,
    expectedScenePath,
    expectedUnityRevision,
    expectedExportGeneration,
    expectedTargetMetadataSchema,
  });
  if (!fresh.ok) return fresh;

  // Authoritative target gates before asset-type pairing for protected/stale.
  if (op !== "instantiate_model" && targetObjectId) {
    const earlyTarget =
      (draft.objects || []).find((o) => o && (o.unityObjectId === targetObjectId || o.objectId === targetObjectId)) ||
      null;
    if (!earlyTarget) {
      return { ok: false, status: 400, error: `Target ${targetObjectId} not found in draft.`, code: "missing_target" };
    }
    const early = validateTargetForOperation(op, earlyTarget, materialSlot);
    if (!early.ok && (early.code === "protected" || early.code === "stale_metadata" || early.code === "stale_target")) {
      return { ...early, status: 400 };
    }
  }

  const base = validateLibraryDrop({ assetId, claimedType, operation });
  if (!base.ok) return { ...base, status: 400 };

  if (op === "instantiate_model") {
    return { ok: true, asset: base.asset, operation: op, status: 200 };
  }

  if (!targetObjectId) {
    return {
      ok: false,
      status: 400,
      error: "Typed assignment requires targetObjectId (GlobalObjectId).",
      code: "missing_target",
    };
  }

  const target =
    (draft.objects || []).find((o) => o && (o.unityObjectId === targetObjectId || o.objectId === targetObjectId)) ||
    null;
  if (!target) {
    return { ok: false, status: 400, error: `Target ${targetObjectId} not found in draft.`, code: "missing_target" };
  }
  if (target.removed) {
    return { ok: false, status: 400, error: "Target was removed from the draft.", code: "stale_target" };
  }
  const targetCheck = validateTargetForOperation(op, target, materialSlot);
  if (!targetCheck.ok) return { ...targetCheck, status: 400 };

  return {
    ok: true,
    status: 200,
    asset: base.asset,
    operation: op,
    target,
    materialSlot: Number(materialSlot) || 0,
  };
}
