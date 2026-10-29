/**
 * Pure transform helpers for the Level Editor viewport (W03 Priority 2 #8).
 * Kept free of Three.js so Vitest can cover snap/finalize without WebGL.
 */

export const DEFAULT_POSITION_SNAP = 0.25;
export const DEFAULT_ROTATION_SNAP_DEG = 15;
export const DEFAULT_SCALE_SNAP = 0.1;

/** XR / camera hierarchy must never be moved from the browser viewport. */
export function isProtectedDraftObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  const blob = `${obj.name || ""} ${obj.objectId || ""} ${obj.role || ""}`.toLowerCase();
  return /xr[\s_-]?rig|tracking[\s_-]?origin|main[\s_-]?camera|camera[\s_-]?offset|hmd|playspace/.test(blob);
}

export function snapScalar(value, step) {
  const n = Number(value);
  const s = Number(step);
  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(s) || s <= 0) return n;
  return Math.round(n / s) * s;
}

export function snapVec3(vec, step) {
  const v = vec || {};
  return {
    x: snapScalar(v.x ?? 0, step),
    y: snapScalar(v.y ?? 0, step),
    z: snapScalar(v.z ?? 0, step),
  };
}

export function normalizeEulerDegrees(deg) {
  let d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

export function snapEulerDegrees(euler, stepDeg) {
  const e = euler || {};
  return {
    x: normalizeEulerDegrees(snapScalar(e.x ?? 0, stepDeg)),
    y: normalizeEulerDegrees(snapScalar(e.y ?? 0, stepDeg)),
    z: normalizeEulerDegrees(snapScalar(e.z ?? 0, stepDeg)),
  };
}

export function snapScaleVec(scale, step) {
  const snapped = snapVec3(scale || { x: 1, y: 1, z: 1 }, step);
  return {
    x: Math.max(0.01, snapped.x),
    y: Math.max(0.01, snapped.y),
    z: Math.max(0.01, snapped.z),
  };
}

/** Hierarchy children use local numeric fields; roots use world (== local when unparented). */
export function usesLocalNumericEdit(obj) {
  return Boolean(obj && obj.parentObjectId);
}

/**
 * Values for the Level Editor numeric form. Children always show local TRS.
 */
export function formValuesFromObject(obj) {
  if (usesLocalNumericEdit(obj)) {
    return {
      space: "local",
      position: {
        x: obj?.localPosition?.x ?? obj?.position?.x ?? 0,
        y: obj?.localPosition?.y ?? obj?.position?.y ?? 0,
        z: obj?.localPosition?.z ?? obj?.position?.z ?? 0,
      },
      rotation: {
        x: obj?.localRotation?.x ?? obj?.rotation?.x ?? 0,
        y: obj?.localRotation?.y ?? obj?.rotation?.y ?? 0,
        z: obj?.localRotation?.z ?? obj?.rotation?.z ?? 0,
      },
      scale: {
        x: obj?.localScale?.x ?? obj?.scale?.x ?? 1,
        y: obj?.localScale?.y ?? obj?.scale?.y ?? 1,
        z: obj?.localScale?.z ?? obj?.scale?.z ?? 1,
      },
    };
  }
  return {
    space: "world",
    position: {
      x: obj?.position?.x ?? obj?.localPosition?.x ?? 0,
      y: obj?.position?.y ?? obj?.localPosition?.y ?? 0,
      z: obj?.position?.z ?? obj?.localPosition?.z ?? 0,
    },
    rotation: {
      x: obj?.rotation?.x ?? obj?.localRotation?.x ?? 0,
      y: obj?.rotation?.y ?? obj?.localRotation?.y ?? 0,
      z: obj?.rotation?.z ?? obj?.localRotation?.z ?? 0,
    },
    scale: {
      x: obj?.scale?.x ?? obj?.localScale?.x ?? 1,
      y: obj?.scale?.y ?? obj?.localScale?.y ?? 1,
      z: obj?.scale?.z ?? obj?.localScale?.z ?? 1,
    },
  };
}

/**
 * Build a transform commit from numeric form fields.
 * Children → local*; roots → world + matching local*.
 */
export function buildNumericTransformPayload(obj, { position, rotation, scale } = {}) {
  const pos = {
    x: Number(position?.x) || 0,
    y: Number(position?.y) || 0,
    z: Number(position?.z) || 0,
  };
  const rot = {
    x: Number(rotation?.x) || 0,
    y: Number(rotation?.y) || 0,
    z: Number(rotation?.z) || 0,
  };
  const scl = {
    x: Number(scale?.x) || 1,
    y: Number(scale?.y) || 1,
    z: Number(scale?.z) || 1,
  };
  if (usesLocalNumericEdit(obj)) {
    return {
      space: "local",
      localPosition: pos,
      localRotation: rot,
      localScale: scl,
    };
  }
  return {
    space: "world",
    position: pos,
    rotation: rot,
    scale: scl,
    localPosition: pos,
    localRotation: rot,
    localScale: scl,
  };
}

/**
 * Apply a viewport commit onto a draft object. Protected objects are returned unchanged.
 * Always keeps local* and world* fields aligned so hierarchy sync cannot snap the proxy back.
 */
export function applyViewportTransformToObject(obj, transform, { snap = false, snaps = {} } = {}) {
  if (!obj || isProtectedDraftObject(obj)) return obj;

  const hasLocal = Boolean(transform?.localPosition || transform?.localRotation || transform?.localScale);
  const localOnlyChild =
    hasLocal && Boolean(obj.parentObjectId) && transform?.position == null && transform?.rotation == null;
  let localPosition = {
    x: Number(transform?.localPosition?.x ?? transform?.position?.x ?? obj.localPosition?.x ?? obj.position?.x ?? 0),
    y: Number(transform?.localPosition?.y ?? transform?.position?.y ?? obj.localPosition?.y ?? obj.position?.y ?? 0),
    z: Number(transform?.localPosition?.z ?? transform?.position?.z ?? obj.localPosition?.z ?? obj.position?.z ?? 0),
  };
  let localRotation = {
    x: Number(transform?.localRotation?.x ?? transform?.rotation?.x ?? obj.localRotation?.x ?? obj.rotation?.x ?? 0),
    y: Number(transform?.localRotation?.y ?? transform?.rotation?.y ?? obj.localRotation?.y ?? obj.rotation?.y ?? 0),
    z: Number(transform?.localRotation?.z ?? transform?.rotation?.z ?? obj.localRotation?.z ?? obj.rotation?.z ?? 0),
  };
  let localScale = {
    x: Number(transform?.localScale?.x ?? transform?.scale?.x ?? obj.localScale?.x ?? obj.scale?.x ?? 1),
    y: Number(transform?.localScale?.y ?? transform?.scale?.y ?? obj.localScale?.y ?? obj.scale?.y ?? 1),
    z: Number(transform?.localScale?.z ?? transform?.scale?.z ?? obj.localScale?.z ?? obj.scale?.z ?? 1),
  };

  // World fields: prefer explicit world from commit; for local-only child numeric edits keep prior world
  // (Apply uses space:local — do not invent stale world by copying local into world).
  let position = {
    x: Number(
      transform?.position?.x ??
        (localOnlyChild ? obj.position?.x ?? localPosition.x : hasLocal ? localPosition.x : obj.position?.x ?? localPosition.x),
    ),
    y: Number(
      transform?.position?.y ??
        (localOnlyChild ? obj.position?.y ?? localPosition.y : hasLocal ? localPosition.y : obj.position?.y ?? localPosition.y),
    ),
    z: Number(
      transform?.position?.z ??
        (localOnlyChild ? obj.position?.z ?? localPosition.z : hasLocal ? localPosition.z : obj.position?.z ?? localPosition.z),
    ),
  };
  let rotation = {
    x: Number(
      transform?.rotation?.x ??
        (localOnlyChild ? obj.rotation?.x ?? localRotation.x : hasLocal ? localRotation.x : obj.rotation?.x ?? localRotation.x),
    ),
    y: Number(
      transform?.rotation?.y ??
        (localOnlyChild ? obj.rotation?.y ?? localRotation.y : hasLocal ? localRotation.y : obj.rotation?.y ?? localRotation.y),
    ),
    z: Number(
      transform?.rotation?.z ??
        (localOnlyChild ? obj.rotation?.z ?? localRotation.z : hasLocal ? localRotation.z : obj.rotation?.z ?? localRotation.z),
    ),
  };
  let scale = {
    x: Number(
      transform?.scale?.x ??
        (localOnlyChild ? obj.scale?.x ?? localScale.x : hasLocal ? localScale.x : obj.scale?.x ?? localScale.x),
    ),
    y: Number(
      transform?.scale?.y ??
        (localOnlyChild ? obj.scale?.y ?? localScale.y : hasLocal ? localScale.y : obj.scale?.y ?? localScale.y),
    ),
    z: Number(
      transform?.scale?.z ??
        (localOnlyChild ? obj.scale?.z ?? localScale.z : hasLocal ? localScale.z : obj.scale?.z ?? localScale.z),
    ),
  };

  if (snap) {
    localPosition = snapVec3(localPosition, snaps.position ?? DEFAULT_POSITION_SNAP);
    localRotation = snapEulerDegrees(localRotation, snaps.rotationDeg ?? DEFAULT_ROTATION_SNAP_DEG);
    localScale = snapScaleVec(localScale, snaps.scale ?? DEFAULT_SCALE_SNAP);
    position = snapVec3(position, snaps.position ?? DEFAULT_POSITION_SNAP);
    rotation = snapEulerDegrees(rotation, snaps.rotationDeg ?? DEFAULT_ROTATION_SNAP_DEG);
    scale = snapScaleVec(scale, snaps.scale ?? DEFAULT_SCALE_SNAP);
  } else {
    localRotation = {
      x: normalizeEulerDegrees(localRotation.x),
      y: normalizeEulerDegrees(localRotation.y),
      z: normalizeEulerDegrees(localRotation.z),
    };
    rotation = {
      x: normalizeEulerDegrees(rotation.x),
      y: normalizeEulerDegrees(rotation.y),
      z: normalizeEulerDegrees(rotation.z),
    };
    localScale = {
      x: Math.max(0.01, localScale.x),
      y: Math.max(0.01, localScale.y),
      z: Math.max(0.01, localScale.z),
    };
    scale = {
      x: Math.max(0.01, scale.x),
      y: Math.max(0.01, scale.y),
      z: Math.max(0.01, scale.z),
    };
  }

  // When the UI only edited world fields (inspector), keep local in lockstep for unparented objects
  // so the viewport (which prefers local*) does not snap back to stale export locals.
  if (!hasLocal && !obj.parentObjectId) {
    localPosition = { ...position };
    localRotation = { ...rotation };
    localScale = { ...scale };
  }

  // Child numeric/local edit: if transform only provided world fields (legacy path), treat as local.
  if (!hasLocal && obj.parentObjectId && transform?.position) {
    localPosition = { ...position };
    localRotation = { ...rotation };
    localScale = { ...scale };
    position = {
      x: Number(obj.position?.x ?? localPosition.x),
      y: Number(obj.position?.y ?? localPosition.y),
      z: Number(obj.position?.z ?? localPosition.z),
    };
    rotation = {
      x: Number(obj.rotation?.x ?? localRotation.x),
      y: Number(obj.rotation?.y ?? localRotation.y),
      z: Number(obj.rotation?.z ?? localRotation.z),
    };
    scale = {
      x: Number(obj.scale?.x ?? localScale.x),
      y: Number(obj.scale?.y ?? localScale.y),
      z: Number(obj.scale?.z ?? localScale.z),
    };
  }

  return {
    ...obj,
    position,
    rotation,
    scale,
    localPosition,
    localRotation,
    localScale,
  };
}

/** Throttle helper: returns true when enough ms elapsed since last stamp. */
export function shouldEmitThrottled(nowMs, lastMs, minIntervalMs) {
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= (minIntervalMs || 0);
}

/**
 * Apply a viewport commit by stable objectId. Returns null when the object is missing/protected
 * or when a commit is already in flight (caller should ignore overlapping gizmo events).
 */
export function applyTransformCommitByObjectId(
  objects,
  objectId,
  transform,
  { snap = false, snaps = {}, commitInFlight = false } = {},
) {
  if (commitInFlight) return { ok: false, reason: "commit_in_flight", objects };
  if (!objectId || !Array.isArray(objects)) {
    return { ok: false, reason: "invalid_target", objects: Array.isArray(objects) ? objects : [] };
  }
  const index = objects.findIndex((o) => o && o.objectId === objectId);
  if (index < 0) return { ok: false, reason: "missing_object", objects };
  const src = objects[index];
  if (isProtectedDraftObject(src)) {
    return { ok: false, reason: "protected", objects };
  }
  const nextObj = applyViewportTransformToObject(src, transform, { snap, snaps });
  const nextObjects = objects.map((o, i) => (i === index ? nextObj : o));
  return { ok: true, reason: null, objects: nextObjects, object: nextObj, index };
}
