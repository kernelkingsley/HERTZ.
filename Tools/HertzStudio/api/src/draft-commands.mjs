/**
 * Versioned, allow-listed scene command schema for W03 apply.
 * Commands are validated on the API before Unity sees them; Unity re-validates before mutation.
 */
import { getAsset } from "./assets/catalog.mjs";
import { validateTargetForOperation } from "./target-checks.mjs";

export const COMMAND_SCHEMA_VERSION = 1;

export const ALLOWED_OPS = new Set([
  "instantiate_model",
  "transform",
  "duplicate",
  "remove",
  "replace_floor_wall",
  "assign_material",
  "assign_sprite",
  "assign_ui",
  "assign_audio",
  "assign_animation",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Axis epsilon for baseline vs draft transform comparison (Unity float noise). */
export const TRANSFORM_COMPARE_EPS = 1e-4;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function vec3(v, label) {
  if (!v || typeof v !== "object") return { error: `${label} required` };
  const x = Number(v.x);
  const y = Number(v.y);
  const z = Number(v.z);
  if (![x, y, z].every(Number.isFinite)) return { error: `${label} axes must be finite numbers` };
  return { value: { x, y, z } };
}

function readVec3(v, fallback = { x: 0, y: 0, z: 0 }) {
  const fx = Number(fallback?.x);
  const fy = Number(fallback?.y);
  const fz = Number(fallback?.z);
  const x = Number(v?.x);
  const y = Number(v?.y);
  const z = Number(v?.z);
  return {
    x: Number.isFinite(x) ? x : Number.isFinite(fx) ? fx : 0,
    y: Number.isFinite(y) ? y : Number.isFinite(fy) ? fy : 0,
    z: Number.isFinite(z) ? z : Number.isFinite(fz) ? fz : 0,
  };
}

function nearlyEqualAxis(a, b, eps = TRANSFORM_COMPARE_EPS) {
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
}

export function vec3NearlyEqual(a, b, eps = TRANSFORM_COMPARE_EPS) {
  if (!a && !b) return true;
  const aa = readVec3(a);
  const bb = readVec3(b);
  return nearlyEqualAxis(aa.x, bb.x, eps) && nearlyEqualAxis(aa.y, bb.y, eps) && nearlyEqualAxis(aa.z, bb.z, eps);
}

/**
 * Mirror Level Editor protected XR/camera policy so Apply never mutates those objects.
 */
export function isProtectedDraftObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.renderCategory === "xr_protected" || obj.renderRole === "camera") return true;
  const blob = `${obj.name || ""} ${obj.objectId || ""} ${obj.role || ""} ${obj.renderCategory || ""}`.toLowerCase();
  return /xr[\s_-]?rig|xr[\s_-]?origin|tracking[\s_-]?origin|main[\s_-]?camera|camera[\s_-]?offset|hmd|playspace|left[\s_-]?controller|right[\s_-]?controller/.test(
    blob,
  );
}

/**
 * Snapshot of Unity-synced local+world TRS keyed by stable objectId.
 */
export function captureUnityTransformBaseline(objects = []) {
  const baseline = Object.create(null);
  for (const obj of Array.isArray(objects) ? objects : []) {
    if (!obj?.objectId) continue;
    baseline[obj.objectId] = {
      localPosition: readVec3(obj.localPosition ?? obj.position),
      localRotation: readVec3(obj.localRotation ?? obj.rotation),
      localScale: readVec3(obj.localScale ?? obj.scale, { x: 1, y: 1, z: 1 }),
      position: readVec3(obj.position ?? obj.localPosition),
      rotation: readVec3(obj.rotation ?? obj.localRotation),
      scale: readVec3(obj.scale ?? obj.localScale, { x: 1, y: 1, z: 1 }),
    };
  }
  return baseline;
}

export function transformSnapshotFromObject(obj) {
  return {
    localPosition: readVec3(obj?.localPosition ?? obj?.position),
    localRotation: readVec3(obj?.localRotation ?? obj?.rotation),
    localScale: readVec3(obj?.localScale ?? obj?.scale, { x: 1, y: 1, z: 1 }),
    position: readVec3(obj?.position ?? obj?.localPosition),
    rotation: readVec3(obj?.rotation ?? obj?.localRotation),
    scale: readVec3(obj?.scale ?? obj?.localScale, { x: 1, y: 1, z: 1 }),
  };
}

/**
 * True when the draft object's transform differs from the Unity-synced baseline.
 * Missing baseline (orphan / never synced) is treated as changed so Apply can place it.
 */
export function objectTransformChanged(obj, baselineById) {
  if (!obj?.objectId) return false;
  const baseline = baselineById?.[obj.objectId];
  const current = transformSnapshotFromObject(obj);
  if (!baseline) return true;
  return !(
    vec3NearlyEqual(current.localPosition, baseline.localPosition) &&
    vec3NearlyEqual(current.localRotation, baseline.localRotation) &&
    vec3NearlyEqual(current.localScale, baseline.localScale) &&
    vec3NearlyEqual(current.position, baseline.position) &&
    vec3NearlyEqual(current.rotation, baseline.rotation) &&
    vec3NearlyEqual(current.scale, baseline.scale)
  );
}

/**
 * @deprecated Prefer objectTransformChanged — kept for tests that still import the name.
 * Orphans (parent id missing from draft) still emit when changed.
 */
export function shouldEmitTransformOp(obj, byId = null, baselineById = null) {
  if (!obj || obj.removed) return false;
  if (isProtectedDraftObject(obj)) return false;
  return objectTransformChanged(obj, baselineById || Object.create(null));
}

/**
 * Validate a library drop before mutating the draft.
 * Rejects forged/non-UUID ids and type mismatches without changing draft/scene.
 */
export function validateLibraryDrop({ assetId, claimedType, operation = "instantiate_model" }) {
  if (!isUuid(assetId)) {
    return { ok: false, error: "assetId must be a UUID.", code: "invalid_asset_id" };
  }
  const asset = getAsset(assetId);
  if (!asset) {
    return { ok: false, error: "Asset not found in library.", code: "missing_asset" };
  }
  if (claimedType && asset.assetType !== claimedType) {
    return {
      ok: false,
      error: `Claimed type "${claimedType}" does not match catalog type "${asset.assetType}".`,
      code: "type_mismatch",
    };
  }
  if (asset.validationState && asset.validationState !== "ok") {
    return { ok: false, error: "Asset failed content validation.", code: "invalid_content" };
  }
  if (asset.state === "unsupported" || asset.unity?.readiness === "unsupported") {
    return { ok: false, error: asset.importError || "Asset unsupported for Unity.", code: "unsupported" };
  }

  const type = asset.assetType;
  if (operation === "instantiate_model" && type !== "model_3d" && type !== "animation") {
    return {
      ok: false,
      error: `Cannot instantiate asset type "${type}" as a 3D model. Use a typed assignment target.`,
      code: "unsupported_target",
    };
  }
  if (operation === "assign_material" && type !== "texture" && type !== "material") {
    return { ok: false, error: `Type "${type}" cannot assign to a material slot.`, code: "unsupported_target" };
  }
  if (
    operation === "assign_sprite" &&
    type !== "sprite" &&
    type !== "sprite_2d" &&
    type !== "pixel"
  ) {
    return { ok: false, error: `Type "${type}" cannot assign to a sprite target.`, code: "unsupported_target" };
  }
  if (
    operation === "assign_ui" &&
    type !== "ui" &&
    type !== "sprite" &&
    type !== "sprite_2d" &&
    type !== "pixel"
  ) {
    return { ok: false, error: `Type "${type}" cannot assign to a UI slot.`, code: "unsupported_target" };
  }
  if (operation === "assign_audio" && type !== "audio") {
    return { ok: false, error: `Type "${type}" cannot assign to an audio emitter.`, code: "unsupported_target" };
  }
  if (operation === "assign_animation" && type !== "animation" && type !== "model_3d") {
    return { ok: false, error: `Type "${type}" cannot assign to an Animator.`, code: "unsupported_target" };
  }
  if (operation === "replace_floor_wall" && type !== "model_3d") {
    return { ok: false, error: `Floor/wall replace requires a model_3d asset.`, code: "unsupported_target" };
  }

  return { ok: true, asset };
}

/**
 * Build Unity-bound operations from a draft document.
 * Transform ops only for objects whose TRS changed vs unityTransformBaseline (by objectId).
 * Hierarchy children send local TRS; roots send world TRS. Unchanged descendants emit nothing.
 */
export function buildApplyOperations(draft) {
  const ops = [];
  const errors = [];
  const list = Array.isArray(draft?.objects) ? draft.objects : [];
  const byId = new Map(list.filter((o) => o?.objectId).map((o) => [o.objectId, o]));
  const baselineById = draft?.unityTransformBaseline || Object.create(null);

  for (const obj of list) {
    if (obj.removed && obj.unityObjectId) {
      if (isProtectedDraftObject(obj)) {
        errors.push({
          draftObjectId: obj.objectId,
          error: "Refusing to remove protected XR/camera object.",
          code: "protected",
        });
        continue;
      }
      ops.push({
        op: "remove",
        objectId: obj.unityObjectId,
        draftObjectId: obj.objectId,
      });
      continue;
    }

    if (obj.source === "library_drop" && obj.assetId && !obj.unityObjectId && !obj.assignmentApplied) {
      const check = validateLibraryDrop({
        assetId: obj.assetId,
        claimedType: obj.assetType,
        operation: obj.operation || (
          obj.assetType === "texture" || obj.assetType === "material"
            ? "assign_material"
            : obj.assetType === "audio"
              ? "assign_audio"
              : obj.assetType === "sprite" || obj.assetType === "sprite_2d" || obj.assetType === "pixel"
                ? "assign_sprite"
                : obj.assetType === "ui"
                  ? "assign_ui"
                  : obj.assetType === "animation"
                    ? "assign_animation"
                    : "instantiate_model"
        ),
      });
      if (!check.ok) {
        errors.push({ draftObjectId: obj.objectId, error: check.error, code: check.code });
        continue;
      }
      const opName =
        obj.operation ||
        (obj.assetType === "model_3d" && obj.replaceSurface
          ? "replace_floor_wall"
          : obj.assetType === "model_3d"
            ? "instantiate_model"
            : obj.assetType === "animation"
              ? "assign_animation"
              : obj.assetType === "audio"
                ? "assign_audio"
                : obj.assetType === "ui"
                  ? "assign_ui"
                  : obj.assetType === "sprite" || obj.assetType === "sprite_2d" || obj.assetType === "pixel"
                    ? "assign_sprite"
                    : "assign_material");
      if (opName === "instantiate_model") {
        const pos = vec3(obj.position || { x: 0, y: 0, z: 0 }, "position");
        const rot = vec3(obj.rotation || { x: 0, y: 0, z: 0 }, "rotation");
        const scale = vec3(obj.scale || { x: 1, y: 1, z: 1 }, "scale");
        if (pos.error || rot.error || scale.error) {
          errors.push({ draftObjectId: obj.objectId, error: pos.error || rot.error || scale.error });
          continue;
        }
        ops.push({
          op: "instantiate_model",
          draftObjectId: obj.objectId,
          assetId: obj.assetId,
          displayName: obj.name || check.asset.displayName,
          position: pos.value,
          rotation: rot.value,
          scale: scale.value,
          prefabPath: check.asset.unity?.prefabPath || null,
          importedPath: check.asset.unity?.importedPath || null,
        });
      } else if (obj.targetObjectId) {
        const target =
          byId.get(obj.targetObjectId) ||
          list.find((o) => o && (o.unityObjectId === obj.targetObjectId || o.objectId === obj.targetObjectId)) ||
          null;
        const targetCheck = validateTargetForOperation(opName, target, obj.materialSlot ?? 0);
        if (!targetCheck.ok) {
          errors.push({
            draftObjectId: obj.objectId,
            error: targetCheck.error,
            code: targetCheck.code,
          });
          continue;
        }
        ops.push({
          op: opName,
          draftObjectId: obj.objectId,
          assetId: obj.assetId,
          targetObjectId: obj.targetObjectId,
          objectId: obj.targetObjectId,
          materialSlot: obj.materialSlot ?? 0,
          prefabPath: check.asset.unity?.prefabPath || null,
          importedPath: check.asset.unity?.importedPath || null,
          displayName: obj.name || check.asset.displayName,
        });
      } else {
        errors.push({
          draftObjectId: obj.objectId,
          error: `Asset type "${obj.assetType}" requires an explicit Unity target (not a free scene drop).`,
          code: "unsupported_target",
        });
      }
      continue;
    }

    const objectId = obj.unityObjectId || obj.objectId;
    if (!objectId || String(objectId).startsWith("lib-")) {
      continue;
    }
    if (isProtectedDraftObject(obj)) {
      continue;
    }
    if (!objectTransformChanged(obj, baselineById)) {
      continue;
    }

    const parentId = obj.parentObjectId;
    const hasDraftParent = Boolean(parentId && byId.has(parentId));
    const space = hasDraftParent ? "local" : "world";

    const localPos = vec3(obj.localPosition ?? obj.position ?? { x: 0, y: 0, z: 0 }, "localPosition");
    const localRot = vec3(obj.localRotation ?? obj.rotation ?? { x: 0, y: 0, z: 0 }, "localRotation");
    const localScale = vec3(obj.localScale ?? obj.scale ?? { x: 1, y: 1, z: 1 }, "localScale");
    const pos = vec3(obj.position || { x: 0, y: 0, z: 0 }, "position");
    const rot = vec3(obj.rotation || { x: 0, y: 0, z: 0 }, "rotation");
    const scale = vec3(obj.scale || { x: 1, y: 1, z: 1 }, "scale");
    if (localPos.error || localRot.error || localScale.error || pos.error || rot.error || scale.error) {
      errors.push({
        draftObjectId: obj.objectId,
        error:
          localPos.error || localRot.error || localScale.error || pos.error || rot.error || scale.error,
      });
      continue;
    }

    ops.push({
      op: "transform",
      objectId,
      draftObjectId: obj.objectId,
      space,
      localPosition: localPos.value,
      localRotation: localRot.value,
      localScale: localScale.value,
      // Roots: world fields drive Apply. Children: local fields drive Apply; world retained for audit.
      position: pos.value,
      rotation: rot.value,
      scale: scale.value,
    });
  }

  return { schemaVersion: COMMAND_SCHEMA_VERSION, operations: ops, errors };
}

/**
 * After a successful Apply, advance the Unity baseline for every objectId that was transformed
 * so a second Apply without edits emits no transforms.
 */
export function advanceTransformBaselineAfterApply(draft, operations = []) {
  if (!draft || typeof draft !== "object") return draft;
  const byId = new Map((draft.objects || []).filter((o) => o?.objectId).map((o) => [o.objectId, o]));
  const next = { ...(draft.unityTransformBaseline || Object.create(null)) };
  for (const op of Array.isArray(operations) ? operations : []) {
    if (op?.op !== "transform" || !op.draftObjectId) continue;
    const obj = byId.get(op.draftObjectId);
    if (!obj) continue;
    next[op.draftObjectId] = transformSnapshotFromObject(obj);
  }
  draft.unityTransformBaseline = next;
  return draft;
}
