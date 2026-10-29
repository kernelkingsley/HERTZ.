/**
 * W03 #14 — deterministic collider / walkability validation for draft objects.
 * Statuses: Valid | Warning | Invalid | Unknown
 */
import { isProtectedDraftObject } from "./draft-commands.mjs";

export const VALIDATION_STATUS = Object.freeze({
  VALID: "Valid",
  WARNING: "Warning",
  INVALID: "Invalid",
  UNKNOWN: "Unknown",
});

/** Max floor tilt from world-up (degrees) treated as walkable. */
export const MAX_WALKABLE_SLOPE_DEG = 35;

/** Scale axes below this are treated as near-zero / invalid. */
export const MIN_SCALE_AXIS = 0.01;

function readVec3(v, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: Number.isFinite(Number(v?.x)) ? Number(v.x) : fallback.x,
    y: Number.isFinite(Number(v?.y)) ? Number(v.y) : fallback.y,
    z: Number.isFinite(Number(v?.z)) ? Number(v.z) : fallback.z,
  };
}

export function isEnvironmentSurface(obj) {
  if (!obj || isProtectedDraftObject(obj)) return false;
  // Authoritative only: explicit HertzStudioSurfaceKind export (component source).
  const kind = surfaceKindOf(obj);
  return kind === "floor" || kind === "wall";
}

/** Authoritative surface kind — never object/mesh names or geometry suggestions. */
export function surfaceKindOf(obj) {
  if (obj?.surfaceKindSource && obj.surfaceKindSource !== "component") return null;
  if (obj?.surfaceKind === "floor" || obj?.surfaceKind === "wall") return obj.surfaceKind;
  return null;
}

function scaleIssues(obj) {
  const scale = readVec3(obj.localScale ?? obj.scale, { x: 1, y: 1, z: 1 });
  const issues = [];
  for (const axis of ["x", "y", "z"]) {
    if (Math.abs(scale[axis]) < MIN_SCALE_AXIS) {
      issues.push({
        code: "near_zero_scale",
        severity: VALIDATION_STATUS.INVALID,
        message: `Scale.${axis} is near zero (${scale[axis]}).`,
        blocksApply: true,
      });
    }
  }
  return issues;
}

function colliderIssues(obj) {
  const issues = [];
  const kind = surfaceKindOf(obj);
  if (!kind || kind === "ceiling") return issues;
  const solidExpected = kind === "floor" || kind === "wall";
  if (!solidExpected) return issues;

  const collider = obj.collider || obj.physics || null;
  if (!collider || collider.present === undefined) {
    issues.push({
      code: "collider_unknown",
      severity: VALIDATION_STATUS.UNKNOWN,
      message: "Collider state unknown until Unity Sync provides physics metadata.",
      blocksApply: false,
    });
    return issues;
  }
  if (!collider.present) {
    issues.push({
      code: "missing_collider",
      severity: VALIDATION_STATUS.INVALID,
      message: "Expected solid/walkable surface is missing a collider.",
      blocksApply: true,
    });
    return issues;
  }
  if (collider.enabled === false) {
    issues.push({
      code: "disabled_collider",
      severity: VALIDATION_STATUS.INVALID,
      message: "Collider is disabled on a surface expected to be solid.",
      blocksApply: true,
    });
  }
  if (collider.isTrigger === true && collider.hasNonTrigger !== true) {
    issues.push({
      code: "trigger_only_collider",
      severity: VALIDATION_STATUS.INVALID,
      message: "Only trigger colliders present; solid collider required.",
      blocksApply: true,
    });
  }
  if (collider.stale === true) {
    issues.push({
      code: "stale_collider",
      severity: VALIDATION_STATUS.WARNING,
      message: "Collider may be stale after geometry replacement — revalidate in Unity.",
      blocksApply: false,
    });
  }
  return issues;
}

function floorOrientationIssues(obj) {
  const issues = [];
  if (surfaceKindOf(obj) !== "floor") return issues;
  const rot = readVec3(obj.localRotation ?? obj.rotation);
  // Simple rule: |pitch| or |roll| beyond threshold → non-walkable.
  const tilt = Math.max(Math.abs(rot.x), Math.abs(rot.z));
  if (tilt > MAX_WALKABLE_SLOPE_DEG) {
    issues.push({
      code: "floor_slope",
      severity: VALIDATION_STATUS.INVALID,
      message: `Floor tilt ${tilt.toFixed(1)}° exceeds walkable max ${MAX_WALKABLE_SLOPE_DEG}°.`,
      blocksApply: true,
    });
  } else if (tilt > MAX_WALKABLE_SLOPE_DEG * 0.7) {
    issues.push({
      code: "floor_slope_warning",
      severity: VALIDATION_STATUS.WARNING,
      message: `Floor tilt ${tilt.toFixed(1)}° is steep but within hard limit.`,
      blocksApply: false,
    });
  }
  const pos = readVec3(obj.position ?? obj.localPosition);
  if (pos.y < -50 || pos.y > 200) {
    issues.push({
      code: "floor_placement",
      severity: VALIDATION_STATUS.WARNING,
      message: `Floor Y=${pos.y} looks unusual for a walkable surface.`,
      blocksApply: false,
    });
  }
  return issues;
}

export function validateDraftObject(obj) {
  if (!obj) {
    return {
      objectId: null,
      status: VALIDATION_STATUS.UNKNOWN,
      issues: [{ code: "missing_object", severity: VALIDATION_STATUS.UNKNOWN, message: "No object", blocksApply: false }],
      blocksApply: false,
    };
  }
  if (isProtectedDraftObject(obj)) {
    return {
      objectId: obj.objectId,
      status: VALIDATION_STATUS.VALID,
      issues: [],
      blocksApply: false,
      excluded: true,
      reason: "Protected XR/camera object excluded from environment validation.",
    };
  }
  // Suggested geometry without an explicit marker is Unknown (not Valid) and does not classify as surface.
  if (
    !isEnvironmentSurface(obj) &&
    (obj.surfaceKindSuggested === "floor" || obj.surfaceKindSuggested === "wall") &&
    obj.surfaceKindSource !== "component"
  ) {
    return {
      objectId: obj.objectId,
      name: obj.name,
      surfaceKind: null,
      status: VALIDATION_STATUS.UNKNOWN,
      issues: [
        {
          code: "surface_unclassified",
          severity: VALIDATION_STATUS.UNKNOWN,
          message:
            "Surface classification unknown. Add HertzStudioSurfaceKind (Floor/Wall) in Unity, then Sync. Geometry suggestions are not authoritative.",
          blocksApply: false,
        },
      ],
      blocksApply: false,
    };
  }

  if (!isEnvironmentSurface(obj) && obj.renderCategory !== "native_mesh" && !obj.surfaceKind) {
    return {
      objectId: obj.objectId,
      status: VALIDATION_STATUS.VALID,
      issues: [],
      blocksApply: false,
      skipped: true,
    };
  }

  const issues = [...scaleIssues(obj), ...colliderIssues(obj), ...floorOrientationIssues(obj)];
  let status = VALIDATION_STATUS.VALID;
  if (issues.some((i) => i.severity === VALIDATION_STATUS.INVALID)) status = VALIDATION_STATUS.INVALID;
  else if (issues.some((i) => i.severity === VALIDATION_STATUS.WARNING)) status = VALIDATION_STATUS.WARNING;
  else if (issues.some((i) => i.severity === VALIDATION_STATUS.UNKNOWN)) status = VALIDATION_STATUS.UNKNOWN;

  return {
    objectId: obj.objectId,
    name: obj.name,
    surfaceKind: surfaceKindOf(obj),
    status,
    issues,
    blocksApply: issues.some((i) => i.blocksApply),
  };
}

export function validateDraftScene(draft) {
  const objects = Array.isArray(draft?.objects) ? draft.objects : [];
  const results = [];
  const seenColliderKeys = new Map();
  for (const obj of objects) {
    if (obj?.removed) continue;
    const row = validateDraftObject(obj);
    if (row.skipped || row.excluded) {
      results.push(row);
      continue;
    }
    const collider = obj.collider;
    if (collider?.present && collider.boundsKey) {
      const prev = seenColliderKeys.get(collider.boundsKey);
      if (prev) {
        row.issues.push({
          code: "duplicate_collider_bounds",
          severity: VALIDATION_STATUS.WARNING,
          message: `Collider bounds overlap key also used by ${prev}.`,
          blocksApply: false,
        });
        if (row.status === VALIDATION_STATUS.VALID) row.status = VALIDATION_STATUS.WARNING;
      } else {
        seenColliderKeys.set(collider.boundsKey, obj.name || obj.objectId);
      }
    }
    results.push(row);
  }

  const blocking = results.filter((r) => r.blocksApply);
  const invalid = results.filter((r) => r.status === VALIDATION_STATUS.INVALID);
  const warnings = results.filter((r) => r.status === VALIDATION_STATUS.WARNING);
  const unknown = results.filter((r) => r.status === VALIDATION_STATUS.UNKNOWN);
  let sceneStatus = VALIDATION_STATUS.VALID;
  if (invalid.length) sceneStatus = VALIDATION_STATUS.INVALID;
  else if (warnings.length) sceneStatus = VALIDATION_STATUS.WARNING;
  else if (unknown.length) sceneStatus = VALIDATION_STATUS.UNKNOWN;

  return {
    status: sceneStatus,
    blocksApply: blocking.length > 0,
    counts: {
      valid: results.filter((r) => r.status === VALIDATION_STATUS.VALID && !r.skipped && !r.excluded).length,
      warning: warnings.length,
      invalid: invalid.length,
      unknown: unknown.length,
      excluded: results.filter((r) => r.excluded).length,
    },
    objects: results,
  };
}
