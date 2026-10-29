/**
 * Compatible typed drop targets for Level Editor library drops.
 * Uses Unity-exported authoritative metadata — not object-name heuristics.
 */
import { isProtectedDraftObject } from "./levelEditorTransforms.js";

export const TARGET_METADATA_SCHEMA = 1;

export function operationForAssetType(assetType) {
  if (assetType === "model_3d") return "instantiate_model";
  if (assetType === "animation") return "assign_animation";
  if (assetType === "audio") return "assign_audio";
  if (assetType === "ui") return "assign_ui";
  if (assetType === "sprite" || assetType === "sprite_2d" || assetType === "pixel") return "assign_sprite";
  if (assetType === "texture" || assetType === "material") return "assign_material";
  return null;
}

export function objectSupportsOperation(obj, operation) {
  if (!obj || obj.removed) return { ok: false, reason: "No object." };
  if (isProtectedDraftObject(obj) || obj.isProtected === true) {
    return { ok: false, reason: "Protected XR/camera object cannot receive library assignments." };
  }
  const metaVersion = Number(obj.targetMetadataSchema ?? 0);
  if (operation !== "instantiate_model" && metaVersion < TARGET_METADATA_SCHEMA) {
    return { ok: false, reason: "Target metadata stale — Sync from Unity first." };
  }
  switch (operation) {
    case "instantiate_model":
      return { ok: true, reason: "Scene placement (no target required)." };
    case "assign_material":
      if (obj.hasRenderer || obj.materialSlotCount > 0 || obj.rendererType) {
        return { ok: true, reason: "Renderer material slot available.", needsSlot: true };
      }
      return { ok: false, reason: "Needs a MeshRenderer / SkinnedMeshRenderer target." };
    case "assign_sprite":
      if (obj.hasSpriteRenderer) return { ok: true, reason: "SpriteRenderer target." };
      return { ok: false, reason: "Needs a SpriteRenderer." };
    case "assign_ui":
      if (obj.hasUiImage) return { ok: true, reason: "UI Image target." };
      return { ok: false, reason: "Needs a Unity UI Image (or compatible) target." };
    case "assign_audio":
      if (obj.hasAudioSource) return { ok: true, reason: "AudioSource present." };
      return { ok: false, reason: "Needs an AudioSource component." };
    case "assign_animation":
      if (obj.hasAnimator) return { ok: true, reason: "Animator target." };
      return { ok: false, reason: "Needs an Animator component." };
    case "replace_floor_wall": {
      if (
        obj.surfaceKindSource === "component" &&
        (obj.surfaceKind === "floor" || obj.surfaceKind === "wall")
      ) {
        return { ok: true, reason: `Explicit ${obj.surfaceKind} (HertzStudioSurfaceKind).` };
      }
      return {
        ok: false,
        reason:
          "Needs explicit HertzStudioSurfaceKind (Floor/Wall) in Unity. Names/geometry suggestions are not enough.",
      };
    }
    default:
      return { ok: false, reason: `Unknown operation ${operation}` };
  }
}

export function listCompatibleTargets(objects, assetType) {
  const operation = operationForAssetType(assetType);
  if (!operation) return { operation: null, compatible: [], incompatible: [] };
  if (operation === "instantiate_model") {
    return {
      operation,
      compatible: [{ objectId: null, label: "Scene root placement", reason: "Instantiate into active scene." }],
      incompatible: [],
    };
  }
  const compatible = [];
  const incompatible = [];
  for (const obj of objects || []) {
    if (!obj || obj.removed) continue;
    const check = objectSupportsOperation(obj, operation);
    const row = {
      objectId: obj.objectId,
      name: obj.name,
      reason: check.reason,
      needsSlot: Boolean(check.needsSlot),
      materialSlotCount: obj.materialSlotCount ?? null,
    };
    if (check.ok) compatible.push(row);
    else incompatible.push(row);
  }
  return { operation, compatible, incompatible };
}
