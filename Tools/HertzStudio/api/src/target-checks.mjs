/**
 * Authoritative typed-target component checks (no catalog / draft-commands imports).
 */
export const TARGET_METADATA_SCHEMA = 1;

export function isProtectedTarget(obj) {
  if (!obj) return false;
  if (obj.isProtected === true) return true;
  const cat = `${obj.renderCategory || ""} ${obj.renderRole || ""}`.toLowerCase();
  if (cat.includes("camera") || cat.includes("xr_protected") || cat.includes("xr ")) return true;
  const name = String(obj.name || "").toLowerCase();
  return (
    name.includes("main camera") ||
    name.includes("xr origin") ||
    name.includes("xr rig") ||
    name.includes("camera offset") ||
    name.includes("tracking origin")
  );
}

export function objectHasRenderer(obj) {
  return Boolean(obj?.hasRenderer || obj?.rendererType || obj?.materialSlotCount > 0);
}

export function objectHasSpriteRenderer(obj) {
  return Boolean(obj?.hasSpriteRenderer);
}

export function objectHasUiImage(obj) {
  return Boolean(obj?.hasUiImage);
}

export function objectHasAudioSource(obj) {
  return Boolean(obj?.hasAudioSource);
}

export function objectHasAnimator(obj) {
  return Boolean(obj?.hasAnimator);
}

/** Authoritative surface kind only — never names or geometry suggestions. */
export function surfaceKindOf(obj) {
  if (obj?.surfaceKindSource === "component_none") return null;
  if (obj?.surfaceKind === "floor" || obj?.surfaceKind === "wall") {
    // Require component source when present; accept legacy exports that only have surfaceKind.
    if (obj.surfaceKindSource && obj.surfaceKindSource !== "component") return null;
    return obj.surfaceKind;
  }
  return null;
}

/** Component/slot/surface checks only (no catalog lookup). */
export function validateTargetForOperation(operation, target, materialSlot = 0) {
  if (!target) return { ok: false, error: "Target not found in draft.", code: "missing_target" };
  if (target.removed) return { ok: false, error: "Target was removed from the draft.", code: "stale_target" };
  if (isProtectedTarget(target)) {
    return { ok: false, error: "Protected XR/camera target cannot receive typed assignments.", code: "protected" };
  }
  const metaVersion = Number(target.targetMetadataSchema ?? 0);
  if (metaVersion < TARGET_METADATA_SCHEMA) {
    return {
      ok: false,
      error: "Target metadata is missing or stale. Sync from Unity to refresh authoritative component data.",
      code: "stale_metadata",
    };
  }
  const op = operation;
  if (op === "assign_material") {
    if (!objectHasRenderer(target)) {
      return { ok: false, error: "Target has no Renderer for material assignment.", code: "incompatible_target" };
    }
    const slotCount = Number(target.materialSlotCount);
    const slot = Number(materialSlot) || 0;
    if (Number.isFinite(slotCount) && slotCount > 0 && (slot < 0 || slot >= slotCount)) {
      return { ok: false, error: `Material slot ${slot} out of range (count ${slotCount}).`, code: "invalid_slot" };
    }
  } else if (op === "assign_sprite") {
    if (!objectHasSpriteRenderer(target)) {
      return { ok: false, error: "Target has no SpriteRenderer.", code: "incompatible_target" };
    }
  } else if (op === "assign_ui") {
    if (!objectHasUiImage(target)) {
      return { ok: false, error: "Target has no Unity UI Image.", code: "incompatible_target" };
    }
  } else if (op === "assign_audio") {
    if (!objectHasAudioSource(target)) {
      return { ok: false, error: "Target has no AudioSource.", code: "incompatible_target" };
    }
  } else if (op === "assign_animation") {
    if (!objectHasAnimator(target)) {
      return { ok: false, error: "Target has no Animator.", code: "incompatible_target" };
    }
  } else if (op === "replace_floor_wall") {
    const kind = surfaceKindOf(target);
    if (kind !== "floor" && kind !== "wall") {
      return {
        ok: false,
        error:
          "Target has no explicit Floor/Wall classification. Add HertzStudioSurfaceKind in Unity, then Sync.",
        code: "invalid_floor_wall_target",
      };
    }
  }
  return { ok: true, target, materialSlot: Number(materialSlot) || 0 };
}

/**
 * Bind validate-drop to the current draft/scene/export snapshot.
 * Returns { ok:false, status:409, code } on freshness mismatches.
 */
export function validateDropFreshness({
  draft,
  expectedDraftVersion,
  expectedScenePath,
  expectedUnityRevision,
  expectedExportGeneration,
  expectedTargetMetadataSchema,
} = {}) {
  if (!draft) {
    return { ok: false, status: 400, code: "missing_draft", error: "Draft required." };
  }
  if (expectedDraftVersion === undefined || expectedDraftVersion === null) {
    return {
      ok: false,
      status: 400,
      code: "missing_expected_version",
      error: "expectedDraftVersion is required.",
    };
  }
  if (Number(expectedDraftVersion) !== Number(draft.version)) {
    return {
      ok: false,
      status: 409,
      code: "stale_draft_version",
      error: `Draft version mismatch: expected ${expectedDraftVersion}, current ${draft.version}. Sync and retry.`,
    };
  }
  if (expectedScenePath != null && expectedScenePath !== "") {
    if (String(expectedScenePath) !== String(draft.scenePath || "")) {
      return {
        ok: false,
        status: 409,
        code: "stale_scene",
        error: `Scene mismatch: expected ${expectedScenePath}, draft is ${draft.scenePath}. Sync and retry.`,
      };
    }
  }
  if (expectedUnityRevision !== undefined && expectedUnityRevision !== null) {
    if (Number(expectedUnityRevision) !== Number(draft.baseUnityRevision)) {
      return {
        ok: false,
        status: 409,
        code: "stale_unity_revision",
        error: `Unity revision mismatch: expected ${expectedUnityRevision}, draft base ${draft.baseUnityRevision}. Sync and retry.`,
      };
    }
  }
  if (expectedExportGeneration !== undefined && expectedExportGeneration !== null) {
    const gen = Number(draft.exportGeneration);
    if (Number(expectedExportGeneration) !== gen) {
      return {
        ok: false,
        status: 409,
        code: "stale_export_generation",
        error: `Export generation mismatch: expected ${expectedExportGeneration}, draft ${gen}. Sync and retry.`,
      };
    }
  }
  if (expectedTargetMetadataSchema !== undefined && expectedTargetMetadataSchema !== null) {
    if (Number(expectedTargetMetadataSchema) < TARGET_METADATA_SCHEMA) {
      return {
        ok: false,
        status: 409,
        code: "stale_metadata",
        error: "Target metadata schema is stale. Sync from Unity.",
      };
    }
  }
  return { ok: true };
}
