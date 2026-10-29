/**
 * Pure helpers for Level Editor scene viewport: hierarchy roots, selection, Unity Scene nav, Apply safety.
 */

import { applyViewportTransformToObject, isProtectedDraftObject } from "./levelEditorTransforms.js";

/** Objects that own a loaded catalog visual (one model load per catalog root). */
export function selectVisualRoots(objects = []) {
  const list = Array.isArray(objects) ? objects : [];
  const roots = [];
  const seenRoots = new Set();
  for (const obj of list) {
    if (!obj || obj.removed) continue;
    if (isProtectedDraftObject(obj)) continue;
    const role = obj.renderRole || null;
    const category = obj.renderCategory || null;
    if (role === "mesh" || role === "light" || role === "camera") continue;
    if (category === "native_mesh" || category === "skinned_mesh" || category === "empty") continue;
    const rootId = obj.rootObjectId || obj.objectId;
    const isRoot =
      category === "catalog_model_root" ||
      role === "model_root" ||
      obj.prefabInstanceRoot === true ||
      (obj.assetId && obj.objectId && obj.objectId === rootId) ||
      (obj.assetId && !role && !obj.parentObjectId);
    if (!isRoot) continue;
    if (seenRoots.has(obj.objectId)) continue;
    seenRoots.add(obj.objectId);
    roots.push(obj);
  }
  return roots;
}

/** Child mesh rows under an already-rendered catalog root must not load another model. */
export function shouldLoadModelForObject(obj, objects = []) {
  if (!obj || obj.removed || !obj.assetId) return false;
  if (isProtectedDraftObject(obj)) return false;
  if (obj.renderRole === "mesh" || obj.renderRole === "light" || obj.renderRole === "camera") return false;
  if (obj.renderCategory === "native_mesh" || obj.renderCategory === "skinned_mesh") return false;
  const roots = selectVisualRoots(objects);
  return roots.some((r) => r.objectId === obj.objectId);
}

export function shouldLoadNativeMeshForObject(obj, descriptor) {
  if (!obj || obj.removed || !obj.objectId) return false;
  if (isProtectedDraftObject(obj)) return false;
  if (obj.assetId && (obj.renderRole === "model_root" || obj.renderCategory === "catalog_model_root")) {
    return false;
  }
  const cat = obj.renderCategory || descriptor?.renderCategory;
  if (cat === "empty" || cat === "collider_only" || cat === "camera" || cat === "light" || cat === "xr_protected") {
    return false;
  }
  return Boolean(descriptor?.supported && descriptor?.sourceType === "native_snapshot" && descriptor?.modelUrl);
}

/**
 * Selecting a GLTF descendant or exported child mesh resolves to the editable model root
 * (same assetId / rootObjectId). Native mesh hits keep their own objectId.
 */
export function resolveSelectionObjectId(hitObjectId, objects = []) {
  if (!hitObjectId) return null;
  const list = Array.isArray(objects) ? objects : [];
  const hit = list.find((o) => o && o.objectId === hitObjectId);
  if (!hit) return hitObjectId;
  if (isProtectedDraftObject(hit)) return hit.objectId;
  // Standalone Unity-native meshes keep their own id; catalog descendants resolve upward.
  if (
    (hit.renderCategory === "native_mesh" || hit.renderCategory === "skinned_mesh") &&
    !hit.assetId
  ) {
    return hit.objectId;
  }
  if (hit.renderRole === "model_root" || hit.prefabInstanceRoot || hit.renderCategory === "catalog_model_root") {
    return hit.objectId;
  }
  const rootId = hit.rootObjectId;
  if (rootId) {
    const root = list.find((o) => o && o.objectId === rootId && !o.removed);
    if (root && !isProtectedDraftObject(root)) return root.objectId;
  }
  if (hit.assetId) {
    const root = list.find(
      (o) =>
        o &&
        !o.removed &&
        o.assetId === hit.assetId &&
        (o.renderRole === "model_root" ||
          o.renderCategory === "catalog_model_root" ||
          o.prefabInstanceRoot ||
          o.objectId === o.rootObjectId),
    );
    if (root) return root.objectId;
  }
  return hit.objectId;
}

export function fallbackKindForObject(obj, descriptor) {
  if (!obj || obj.removed) return "hidden";
  const cat = obj.renderCategory || descriptor?.renderCategory;
  if (isProtectedDraftObject(obj) || obj.renderRole === "camera" || cat === "xr_protected" || cat === "camera") {
    return "protected";
  }
  if (obj.renderRole === "light" || cat === "light") return "light";
  if (descriptor?.sourceType === "native_snapshot" && descriptor?.supported) return "native_mesh";
  if (obj.renderRole === "mesh" && obj.assetId) return "mesh_child";
  if (descriptor?.supported && descriptor?.modelUrl && descriptor?.sourceType === "catalog") return "model";
  if (descriptor?.status === "delegated_to_root") return "mesh_child";
  if (obj.renderRole === "empty" || cat === "empty" || cat === "collider_only") return "empty";
  return "unsupported";
}

/**
 * Unity (left-handed, Y-up) → Three.js (right-handed, Y-up): negate X on position and adjust quaternion.
 * Applies to local transforms only; parent chain carries the conversion once per node.
 */
export function unityLocalToThreePosition(pos = {}) {
  return {
    x: -(Number(pos.x) || 0),
    y: Number(pos.y) || 0,
    z: Number(pos.z) || 0,
  };
}

/** Unity Euler degrees (ZXY-ish local) → Three.js Euler radians with X flip for LH→RH. */
export function unityLocalEulerDegToThreeRadians(rot = {}, THREE) {
  const x = THREE.MathUtils.degToRad(Number(rot.x) || 0);
  const y = THREE.MathUtils.degToRad(-(Number(rot.y) || 0));
  const z = THREE.MathUtils.degToRad(-(Number(rot.z) || 0));
  return { x, y, z };
}

export function unityLocalToThreeScale(scale = {}) {
  return {
    x: Number(scale.x) || 1,
    y: Number(scale.y) || 1,
    z: Number(scale.z) || 1,
  };
}

/** Inverse of unityLocalToThreePosition (Three local → Unity local). */
export function threeLocalToUnityPosition(pos = {}) {
  return {
    x: -(Number(pos.x) || 0),
    y: Number(pos.y) || 0,
    z: Number(pos.z) || 0,
  };
}

/** Inverse of unityLocalEulerDegToThreeRadians (Three Euler rad → Unity Euler deg). */
export function threeLocalEulerToUnityDeg(rot = {}, THREE) {
  return {
    x: THREE.MathUtils.radToDeg(Number(rot.x) || 0),
    y: THREE.MathUtils.radToDeg(-(Number(rot.y) || 0)),
    z: THREE.MathUtils.radToDeg(-(Number(rot.z) || 0)),
  };
}

/** Minimum camera stand-off when framing a selected object (meters, Three/Unity world scale). */
export const FRAME_MIN_STAND_OFF_M = 2.5;
export const ORBIT_MIN_DISTANCE_M = 0.75;
export const ORBIT_MAX_DISTANCE_M = 250;

/**
 * Compute a comfortable look-at frame a few meters back from an object bounds.
 * @param {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number} } | null} box
 * @param {{ x:number,y:number,z:number } | null} [fallbackCenter]
 */
export function computeFrameCameraPlacement(box, fallbackCenter = null, opts = {}) {
  const minStandOff = Number(opts.minStandOff) > 0 ? Number(opts.minStandOff) : FRAME_MIN_STAND_OFF_M;
  let sizeX = 1;
  let sizeY = 1;
  let sizeZ = 1;
  let cx = Number(fallbackCenter?.x) || 0;
  let cy = Number(fallbackCenter?.y) || 0.5;
  let cz = Number(fallbackCenter?.z) || 0;

  if (
    box &&
    Number.isFinite(box.min?.x) &&
    Number.isFinite(box.max?.x) &&
    (box.max.x > box.min.x || box.max.y > box.min.y || box.max.z > box.min.z)
  ) {
    sizeX = Math.max(0.05, box.max.x - box.min.x);
    sizeY = Math.max(0.05, box.max.y - box.min.y);
    sizeZ = Math.max(0.05, box.max.z - box.min.z);
    cx = (box.min.x + box.max.x) * 0.5;
    cy = (box.min.y + box.max.y) * 0.5;
    cz = (box.min.z + box.max.z) * 0.5;
  }

  const maxDim = Math.max(sizeX, sizeY, sizeZ, 0.5);
  const radius = Math.sqrt(sizeX * sizeX + sizeY * sizeY + sizeZ * sizeZ) * 0.5;
  // Stay outside the object: stand-off past the radius, never closer than a few meters for tiny props.
  const dist = Math.max(maxDim * 2.4, minStandOff + maxDim * 0.6, radius + minStandOff);
  return {
    target: { x: cx, y: cy, z: cz },
    position: {
      x: cx + dist * 0.75,
      y: cy + dist * 0.45,
      z: cz + dist * 0.75,
    },
    distance: dist,
    near: Math.min(0.2, Math.max(0.05, dist / 80)),
    far: Math.max(200, dist * 40),
    // Keep dolly outside the bounds so wheel zoom cannot enter the mesh interior.
    minDistance: Math.max(ORBIT_MIN_DISTANCE_M, radius * 1.05, minStandOff * 0.45),
  };
}

/**
 * Build parent/child index and detect cycles. Missing parents become scene roots.
 */
export function buildHierarchyPlan(objects = []) {
  const list = Array.isArray(objects) ? objects.filter((o) => o && o.objectId && !o.removed) : [];
  const byId = new Map(list.map((o) => [o.objectId, o]));
  const children = new Map();
  const roots = [];
  const cyclic = new Set();

  for (const obj of list) {
    const parentId = obj.parentObjectId;
    if (parentId && byId.has(parentId) && parentId !== obj.objectId) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(obj);
    } else {
      roots.push(obj);
    }
  }

  for (const [, kids] of children) {
    kids.sort((a, b) => (Number(a.siblingIndex) || 0) - (Number(b.siblingIndex) || 0));
  }
  roots.sort((a, b) => (Number(a.siblingIndex) || 0) - (Number(b.siblingIndex) || 0));

  // Cycle detection via DFS.
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visited.has(id) || cyclic.has(id)) return;
    if (visiting.has(id)) {
      cyclic.add(id);
      return;
    }
    visiting.add(id);
    for (const child of children.get(id) || []) visit(child.objectId);
    visiting.delete(id);
    visited.add(id);
  }
  for (const r of roots) visit(r.objectId);
  for (const obj of list) visit(obj.objectId);

  return { byId, children, roots, cyclic };
}

/**
 * Unity Scene-adjacent OrbitControls defaults that work without a middle button:
 * LMB unused for nav (select / gizmo), RMB orbit, MMB pan, wheel zoom.
 * Alt+LMB also orbits (official Unity Scene shortcut) via applyUnityNavToOrbit.
 */
export function mapUnityMouseButtons(THREE) {
  return {
    LEFT: -1,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
}

/** @deprecated Use mapUnityMouseButtons — kept for older imports. */
export function mapBlenderMouseButtons(THREE) {
  return mapUnityMouseButtons(THREE);
}

/**
 * Modifier-aware pointer intent matching Unity Scene view navigation.
 * LMB select · Alt+LMB orbit · RMB orbit · MMB pan · wheel zoom.
 */
export function unityPointerNavIntent(event, { gizmoDragging = false } = {}) {
  if (gizmoDragging) return { action: "none", reason: "gizmo" };
  if (!event) return { action: "none", reason: "no_event" };
  const button = event.button;
  if (button === 0) {
    if (event.altKey) return { action: "orbit", reason: "alt_lmb" };
    return { action: "select", reason: "lmb" };
  }
  if (button === 1) return { action: "pan", reason: "mmb" };
  if (button === 2) return { action: "orbit", reason: "rmb" };
  return { action: "none", reason: "other" };
}

/** @deprecated Use unityPointerNavIntent. */
export function blenderPointerNavIntent(event, opts) {
  return unityPointerNavIntent(event, opts);
}

export function applyUnityNavToOrbit(orbit, THREE, intent) {
  if (!orbit || !THREE) return;
  orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  orbit.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  // Alt+LMB temporarily enables rotate on LEFT (Unity Scene).
  if (intent?.action === "orbit" && intent?.reason === "alt_lmb") {
    orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  } else {
    orbit.mouseButtons.LEFT = -1;
  }
}

/** @deprecated Use applyUnityNavToOrbit. */
export function applyBlenderNavToOrbit(orbit, THREE, intent) {
  return applyUnityNavToOrbit(orbit, THREE, intent);
}

export function emptyRenderStats() {
  return {
    modelRootsDiscovered: 0,
    modelsLoading: 0,
    modelsRendered: 0,
    nativeMeshesRendered: 0,
    fallbacks: 0,
    failed: 0,
    protectedHelpers: 0,
    lastModelError: null,
  };
}

export function summarizeRenderStats(stats) {
  const s = stats || emptyRenderStats();
  return {
    ...s,
    label: [
      `Model roots discovered: ${s.modelRootsDiscovered}`,
      `Loading: ${s.modelsLoading}`,
      `Catalog rendered: ${s.modelsRendered}`,
      `Native meshes: ${s.nativeMeshesRendered}`,
      `Fallbacks: ${s.fallbacks}`,
      `Failed: ${s.failed}`,
      `Protected helpers: ${s.protectedHelpers}`,
    ].join(" · "),
  };
}

/**
 * Unity Editor tool hotkeys: W translate, E rotate, R scale.
 * Also accepts G (move) and S (scale) as aliases.
 */
export function mapTransformToolKey(key) {
  const k = String(key || "").toLowerCase();
  if (k === "w" || k === "g") return "translate";
  if (k === "e") return "rotate";
  if (k === "r" || k === "s") return "scale";
  return null;
}

/** @deprecated Use mapTransformToolKey. */
export function mapBlenderKeyToTransformMode(key) {
  return mapTransformToolKey(key);
}

export function mapAxisConstraintKey(key, shiftKey) {
  const k = String(key || "").toLowerCase();
  if (k !== "x" && k !== "y" && k !== "z") return null;
  if (shiftKey) {
    if (k === "x") return { axis: "x", plane: true };
    if (k === "y") return { axis: "y", plane: true };
    if (k === "z") return { axis: "z", plane: true };
  }
  return { axis: k, plane: false };
}

export function viewPresetFromNumpad(code, ctrlKey) {
  if (code === "Numpad1") return ctrlKey ? "back" : "front";
  if (code === "Numpad3") return ctrlKey ? "left" : "right";
  if (code === "Numpad7") return ctrlKey ? "bottom" : "top";
  return null;
}

export function isFrameSelectedKey(code, key) {
  return code === "NumpadDecimal" || key === "." || String(key || "").toLowerCase() === "f";
}

export function isFrameAllKey(code) {
  return code === "Home";
}

export function buildSaveObjectsFromDraft(draft, selectedObjectId, transform, snapOpts = {}) {
  if (!draft || !Array.isArray(draft.objects)) {
    return { ok: false, reason: "no_draft", objects: [], expectedVersion: null };
  }
  const objects = draft.objects.map((obj) => {
    if (!obj || obj.objectId !== selectedObjectId) return obj;
    if (isProtectedDraftObject(obj)) return obj;
    // Numeric form / Apply builder: children commit local*; roots commit world (+ mirrored local).
    let payload = transform || {};
    if (
      obj.parentObjectId &&
      payload &&
      !payload.localPosition &&
      !payload.localRotation &&
      !payload.localScale &&
      (payload.position || payload.rotation || payload.scale)
    ) {
      payload = {
        space: "local",
        localPosition: payload.position,
        localRotation: payload.rotation,
        localScale: payload.scale,
      };
    }
    return applyViewportTransformToObject(obj, payload, snapOpts);
  });
  return {
    ok: true,
    reason: null,
    objects,
    expectedVersion: draft.version,
    draftId: draft.id,
  };
}

export function assertFreshApplySave(refreshedDraft, savePayload) {
  if (!refreshedDraft || !savePayload) {
    return { ok: false, reason: "missing_args" };
  }
  if (savePayload.draftId !== refreshedDraft.id) {
    return { ok: false, reason: "draft_id_mismatch" };
  }
  if (savePayload.expectedVersion !== refreshedDraft.version) {
    return { ok: false, reason: "stale_version" };
  }
  if (!Array.isArray(savePayload.objects)) {
    return { ok: false, reason: "missing_objects" };
  }
  if (savePayload.objects.length !== (refreshedDraft.objects || []).length) {
    return { ok: false, reason: "objects_length_mismatch" };
  }
  return { ok: true, reason: null };
}

export function containsMojibake(text) {
  if (typeof text !== "string") return false;
  return /â€™|Â·|â€”|â€“|â€¦|Ã./.test(text);
}

export function controlHelpText() {
  return [
    "Scene viewport (Unity-style nav — faithful static preview, not pixel-perfect URP)",
    "LMB select · RMB orbit · Alt+LMB orbit · MMB pan · Wheel zoom",
    "W move · E rotate · R scale · X/Y/Z axis (while transforming) · Esc cancel",
    "Numpad 1/3/7 views · Ctrl+Numpad opposite · F / Numpad . frame selected · Home frame all",
  ].join("\n");
}
