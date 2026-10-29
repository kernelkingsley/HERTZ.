import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { v4 as uuidv4 } from "./uuid.js";
import { LIBRARY_DRAG_MIME } from "../lib/chunkedUpload.js";
import {
  applyTransformCommitByObjectId,
  applyViewportTransformToObject,
  buildNumericTransformPayload,
  DEFAULT_POSITION_SNAP,
  DEFAULT_ROTATION_SNAP_DEG,
  DEFAULT_SCALE_SNAP,
  formValuesFromObject,
  isProtectedDraftObject,
  usesLocalNumericEdit,
} from "../lib/levelEditorTransforms.js";
import {
  draftMatchesActiveScene,
  findObjectIndexById,
  getApplyBlockReason,
  sceneDisplayName,
  selectNewestDraftForActiveScene,
  shouldShowDraftSceneSelector,
} from "../lib/levelEditorDraftSelection.js";
import {
  assertFreshApplySave,
  buildSaveObjectsFromDraft,
} from "../lib/levelEditorSceneViewport.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { resolveConnectionStatus } from "../lib/connectionStatus.js";
import { isHertzE2eMode } from "../lib/e2eMode.js";
import {
  listCompatibleTargets,
  objectSupportsOperation,
  operationForAssetType,
} from "../lib/typedDropTargets.js";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DROP_TYPES = new Set([
  "model_3d",
  "texture",
  "material",
  "sprite",
  "sprite_2d",
  "ui",
  "audio",
  "pixel",
  "animation",
]);

/** Three.js viewport is a second lazy chunk inside the already-split Level Editor route. */
const LevelEditorViewport = lazy(() => import("../components/LevelEditorViewport.jsx"));

/**
 * W03 level editor: cloud drafts + typed library drops + undo/redo + lazy 3D viewport.
 * Dashboard never pays for Three.js; geometry loads only on this route after the editor chunk.
 */
export default function LevelEditor() {
  const [draft, setDraft] = useState(null);
  const [draftId, setDraftId] = useState("");
  const [draftSummaries, setDraftSummaries] = useState([]);
  const [activeScenePath, setActiveScenePath] = useState(null);
  const [activeSceneName, setActiveSceneName] = useState(null);
  const [unityConnected, setUnityConnected] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [x, setX] = useState("0");
  const [y, setY] = useState("0");
  const [z, setZ] = useState("0");
  const [rx, setRx] = useState("0");
  const [ry, setRy] = useState("0");
  const [rz, setRz] = useState("0");
  const [sx, setSx] = useState("1");
  const [sy, setSy] = useState("1");
  const [sz, setSz] = useState("1");
  const [transformMode, setTransformMode] = useState("translate");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [hasSceneExport, setHasSceneExport] = useState(false);
  const [unityRevision, setUnityRevision] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [dropHover, setDropHover] = useState(false);
  const [transformCommitInFlight, setTransformCommitInFlight] = useState(false);
  const [proxySyncToken, setProxySyncToken] = useState(0);
  const [descriptorsByObjectId, setDescriptorsByObjectId] = useState({});
  const [selectedFallback, setSelectedFallback] = useState("");
  const [materialSlot, setMaterialSlot] = useState(0);
  const [dropPreview, setDropPreview] = useState(null);
  const [apiReachable, setApiReachable] = useState(true);
  const [connectorOnline, setConnectorOnline] = useState(true);
  const [sceneValidation, setSceneValidation] = useState(null);
  const draftRef = useRef(null);
  const commitLockRef = useRef(false);
  const viewportApiRef = useRef(null);
  const pollTimerRef = useRef(null);
  const numericFieldsRef = useRef({
    x: "0",
    y: "0",
    z: "0",
    rx: "0",
    ry: "0",
    rz: "0",
    sx: "1",
    sy: "1",
    sz: "1",
  });
  const saveDraftRef = useRef(null);
  const selectedIndexRef = useRef(0);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    numericFieldsRef.current = { x, y, z, rx, ry, rz, sx, sy, sz };
  }, [x, y, z, rx, ry, rz, sx, sy, sz]);

  async function loadDescriptors(id) {
    if (!id) {
      setDescriptorsByObjectId({});
      return;
    }
    try {
      const batch = await api(`/api/drafts/${id}/render-descriptors`);
      const map = {};
      for (const row of batch.objects || []) {
        if (row?.objectId) map[row.objectId] = row;
      }
      setDescriptorsByObjectId(map);
    } catch {
      setDescriptorsByObjectId({});
    }
  }

  function syncFormFromObject(obj) {
    const values = formValuesFromObject(obj);
    setX(String(values.position.x));
    setY(String(values.position.y));
    setZ(String(values.position.z));
    setRx(String(values.rotation.x));
    setRy(String(values.rotation.y));
    setRz(String(values.rotation.z));
    setSx(String(values.scale.x));
    setSy(String(values.scale.y));
    setSz(String(values.scale.z));
  }

  function numericTransformFromForm(obj) {
    const f = numericFieldsRef.current;
    return buildNumericTransformPayload(obj, {
      position: { x: Number(f.x), y: Number(f.y), z: Number(f.z) },
      rotation: { x: Number(f.rx), y: Number(f.ry), z: Number(f.rz) },
      scale: { x: Number(f.sx), y: Number(f.sy), z: Number(f.sz) },
    });
  }

  function clearDraftUi(reason) {
    setDraft(null);
    setDraftId("");
    setSelectedIndex(0);
    draftRef.current = null;
    setDescriptorsByObjectId({});
    setSelectedFallback("");
    if (reason) setMessage(reason);
  }

  function applyDraftToForm(next, preferredObjectId = null, preferredIndex = selectedIndex) {
    setDraft(next);
    setDraftId(next.id);
    draftRef.current = next;
    let index = preferredIndex;
    if (preferredObjectId) {
      const byId = findObjectIndexById(next.objects || [], preferredObjectId);
      if (byId >= 0) index = byId;
    }
    const obj = next.objects?.[index] || next.objects?.[0];
    if (obj) {
      const resolved = next.objects.indexOf(obj);
      setSelectedIndex(resolved >= 0 ? resolved : 0);
      syncFormFromObject(obj);
    } else {
      setSelectedIndex(0);
    }
    setProxySyncToken((n) => n + 1);
  }

  async function refreshValidation(id) {
    if (!id) {
      setSceneValidation(null);
      return;
    }
    try {
      const v = await api(`/api/drafts/${id}/validation`);
      setSceneValidation(v);
    } catch {
      setSceneValidation(null);
    }
  }

  async function refresh(preferredDraftId = draftId) {
    let project;
    try {
      project = await api("/api/project");
      setApiReachable(true);
    } catch (err) {
      setApiReachable(false);
      throw err;
    }
    const scenePath = project.activeScenePath || project.project?.scenePath || null;
    const sceneName = project.project?.activeSceneName || sceneDisplayName(scenePath);
    const summaries = Array.isArray(project.drafts) ? project.drafts : [];
    const connected = Boolean(project.connection?.unityConnected ?? project.project?.unityConnected);
    const connectorOk = Boolean(
      project.connection?.connectorOnline ?? project.connectorOnline ?? project.project?.connectorOnline ?? true,
    );

    setHasSceneExport(Boolean(project.hasSceneExport));
    setUnityRevision(project.project?.unityRevision ?? null);
    setActiveScenePath(scenePath);
    setActiveSceneName(sceneName);
    setUnityConnected(connected);
    setConnectorOnline(connectorOk);
    setDraftSummaries(summaries);

    const matching = selectNewestDraftForActiveScene(summaries, scenePath);
    let id = preferredDraftId || draftRef.current?.id || null;

    if (id) {
      const summary = summaries.find((d) => d.id === id);
      // Summaries can lag right after Sync/Apply — do not drop an explicit draft id solely because
      // it is missing from the project summary list. Only reject on hard scene-path mismatch.
      if (summary && scenePath && summary.scenePath && summary.scenePath !== scenePath) {
        id = matching?.id || null;
      }
    } else {
      id = matching?.id || null;
    }

    if (!id) {
      clearDraftUi(
        scenePath
          ? `No draft for Unity's active scene (${scenePath}). Use Sync from Unity to create one.`
          : "Unity active scene unknown. Pair the connector, then Sync from Unity.",
      );
      return null;
    }

    const next = await api(`/api/drafts/${id}`);
    if (scenePath && next.scenePath && next.scenePath !== scenePath) {
      clearDraftUi(
        `Server returned draft for ${next.scenePath}, but Unity is on ${scenePath}. Showing mismatch state.`,
      );
      setError("Draft scene does not match Unity's active scene.");
      return null;
    }
    applyDraftToForm(next);
    await loadDescriptors(next.id);
    await refreshValidation(next.id);
    return next;
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!draftId) return undefined;
    if (!draft || (draft.status !== "pending_unity" && draft.status !== "applying")) {
      return undefined;
    }
    pollTimerRef.current = setInterval(() => {
      refresh(draftId)
        .then((next) => {
          if (!next) return;
          if (next.status === "applied") {
            setMessage(
              `Applied to Unity (rev ${next.baseUnityRevision}). Acknowledged — check the Scene view.`,
            );
            setError("");
          } else if (next.status === "conflict") {
            setError(
              next.lastError ||
                "Revision conflict: Unity changed since this draft was based. Click Sync from Unity, edit again, then Apply.",
            );
            setMessage("");
          } else if (next.status === "failed") {
            setError(next.lastError || "Apply failed. Draft proxy restored where possible.");
            setMessage("");
          }
        })
        .catch(() => {
          setApiReachable(false);
        });
    }, 1500);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [draftId, draft?.status]);

  function selectObject(index, { frameInViewport = true } = {}) {
    const obj = draft.objects[index];
    setSelectedIndex(index);
    syncFormFromObject(obj);
    const desc = obj?.objectId ? descriptorsByObjectId[obj.objectId] : null;
    setSelectedFallback(
      desc?.fallbackReason ||
        (obj?.renderRole === "mesh" ? "Child mesh of a model root (not loaded separately)." : "") ||
        "",
    );
    if (frameInViewport && obj?.objectId) {
      // Pass objectId so framing does not race selectedIndex props flush.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          viewportApiRef.current?.frameSelected?.(obj.objectId);
        });
      });
    }
  }

  async function openFromScene(rebase = false) {
    setError("");
    setMessage("");
    try {
      const result = await api("/api/drafts/from-scene", {
        method: "POST",
        body: JSON.stringify({ rebase }),
      });
      await refresh(result.draft.id);
      if (result.rebased) {
        setMessage(
          `Synced draft from Unity (base rev ${result.draft.baseUnityRevision}). Re-enter your position, then Apply.`,
        );
      } else if (result.created) {
        setMessage(`Created draft ${result.draft.id} from Unity export.`);
      } else {
        setMessage(`Opened existing draft ${result.draft.id}.`);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function onSelectDraftFromSelector(nextId) {
    setError("");
    setMessage("");
    if (!nextId) return;
    try {
      await refresh(nextId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function commitObjects(nextObjects, note, { preferredObjectId = null } = {}) {
    const current = draftRef.current;
    if (!current?.id) throw new Error("No draft loaded.");
    const prior = structuredClone(current.objects || []);
    const result = await api(`/api/drafts/${current.id}`, {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: current.version, objects: nextObjects }),
    });
    setUndoStack((s) => [...s.slice(-39), prior]);
    setRedoStack([]);
    applyDraftToForm(result, preferredObjectId);
    await refreshValidation(result.id);
    if (note) setMessage(note.replace("{v}", String(result.version)));
    return result;
  }

  async function saveDraft(baseDraft = null, forcedObjectId = null) {
    setError("");
    setMessage("");
    const current = baseDraft || draftRef.current;
    if (!current?.id) {
      throw new Error("No draft loaded.");
    }
    const selectedObjectId =
      forcedObjectId ||
      current.objects?.[selectedIndex]?.objectId ||
      null;
    const selected = current.objects?.find((o) => o && o.objectId === selectedObjectId) || null;
    if (selected && isProtectedDraftObject(selected)) {
      throw new Error("Cannot edit XR/camera objects from the Level Editor.");
    }
    const built = buildSaveObjectsFromDraft(
      current,
      selectedObjectId,
      numericTransformFromForm(selected),
      {
        snap: snapEnabled,
        snaps: {
          position: DEFAULT_POSITION_SNAP,
          rotationDeg: DEFAULT_ROTATION_SNAP_DEG,
          scale: DEFAULT_SCALE_SNAP,
        },
      },
    );
    if (!built.ok) throw new Error("Cannot save draft.");
    // Ensure we PUT against the exact draft version we built from.
    draftRef.current = current;
    setDraft(current);
    return commitObjects(built.objects, "Draft saved (v{v}). Unity apply not required for this save.", {
      preferredObjectId: selectedObjectId,
    });
  }
  saveDraftRef.current = saveDraft;

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    // Production Studio never installs Playwright hooks unless E2E mode was frozen at boot.
    if (!isHertzE2eMode()) {
      window.__HERTZ_LEVEL_EDITOR_TEST__ = undefined;
      return undefined;
    }
    const prev = window.__HERTZ_LEVEL_EDITOR_TEST__ || {};
    window.__HERTZ_LEVEL_EDITOR_TEST__ = {
      ...prev,
      getSelectedObjectId: () =>
        draftRef.current?.objects?.[selectedIndexRef.current]?.objectId || null,
      clearUiError: () => {
        setError("");
        setMessage("");
      },
      /**
       * Playwright hook: set React numeric form state (not DOM-only) and invoke production saveDraft.
       * Does not bypass the draft PUT — same path as Save draft.
       */
      fillNumericAndSave: async (partial = {}) => {
        flushSync(() => {
          const next = { ...numericFieldsRef.current };
          if (partial.x != null) {
            next.x = String(partial.x);
            setX(next.x);
          }
          if (partial.y != null) {
            next.y = String(partial.y);
            setY(next.y);
          }
          if (partial.z != null) {
            next.z = String(partial.z);
            setZ(next.z);
          }
          if (partial.rx != null) {
            next.rx = String(partial.rx);
            setRx(next.rx);
          }
          if (partial.ry != null) {
            next.ry = String(partial.ry);
            setRy(next.ry);
          }
          if (partial.rz != null) {
            next.rz = String(partial.rz);
            setRz(next.rz);
          }
          if (partial.sx != null) {
            next.sx = String(partial.sx);
            setSx(next.sx);
          }
          if (partial.sy != null) {
            next.sy = String(partial.sy);
            setSy(next.sy);
          }
          if (partial.sz != null) {
            next.sz = String(partial.sz);
            setSz(next.sz);
          }
          // Keep ref in lockstep inside flushSync — useEffect would run too late for saveDraft.
          numericFieldsRef.current = next;
        });
        try {
          return await saveDraftRef.current?.();
        } catch (err) {
          setError(err?.message || "Save failed.");
          throw err;
        }
      },
    };
    return () => {
      if (window.__HERTZ_LEVEL_EDITOR_TEST__) {
        delete window.__HERTZ_LEVEL_EDITOR_TEST__.fillNumericAndSave;
        delete window.__HERTZ_LEVEL_EDITOR_TEST__.clearUiError;
      }
    };
  }, []);

  async function onViewportTransformCommit(objectId, transform) {
    const current = draftRef.current;
    if (!current || !current.id) {
      throw new Error("No draft loaded.");
    }
    if (commitLockRef.current) {
      throw new Error("Transform commit already in flight.");
    }

    const prepared = applyTransformCommitByObjectId(current.objects || [], objectId, transform, {
      snap: snapEnabled,
      snaps: {
        position: DEFAULT_POSITION_SNAP,
        rotationDeg: DEFAULT_ROTATION_SNAP_DEG,
        scale: DEFAULT_SCALE_SNAP,
      },
      commitInFlight: false,
    });
    if (!prepared.ok) {
      throw new Error(prepared.reason || "Transform rejected.");
    }

    commitLockRef.current = true;
    setTransformCommitInFlight(true);
    setError("");
    // Optimistic local mirror so the proxy matches the gizmo until the PUT returns.
    const optimistic = { ...current, objects: prepared.objects };
    setDraft(optimistic);
    draftRef.current = optimistic;
    setSelectedIndex(prepared.index);
    syncFormFromObject(prepared.object);

    try {
      await commitObjects(prepared.objects, "Viewport transform saved to draft (v{v}).", {
        preferredObjectId: objectId,
      });
    } catch (err) {
      setError(err.message || "Transform save failed. Restoring last persisted draft.");
      try {
        const restored = await api(`/api/drafts/${current.id}`);
        applyDraftToForm(restored, objectId);
        setMessage("Proxy restored to last persisted transform after failed commit.");
      } catch (reloadErr) {
        applyDraftToForm(current, objectId);
        setProxySyncToken((n) => n + 1);
        setError(`${err.message}. Also failed to reload draft: ${reloadErr.message}`);
      }
      throw err;
    } finally {
      commitLockRef.current = false;
      setTransformCommitInFlight(false);
    }
  }

  function parseLibraryPayload(dataTransfer) {
    const typedRaw = dataTransfer?.getData?.(LIBRARY_DRAG_MIME);
    if (!typedRaw) return { error: "Forged or non-library drop rejected. Use an Asset Library card." };
    let payload = null;
    try {
      payload = JSON.parse(typedRaw);
    } catch {
      payload = null;
    }
    if (!payload?.id || !payload?.assetType) {
      return { error: "Drop a typed asset from the Asset Library (drag a library card)." };
    }
    if (!DROP_TYPES.has(payload.assetType)) {
      return { error: `Unsupported drop type "${payload.assetType}".` };
    }
    if (payload.state === "unsupported") {
      return { error: "That asset is unsupported for Unity." };
    }
    return { payload };
  }

  function updateDropPreviewFromTransfer(dataTransfer) {
    const parsed = parseLibraryPayload(dataTransfer);
    if (parsed.error || !parsed.payload) {
      setDropPreview(null);
      return;
    }
    const operation = operationForAssetType(parsed.payload.assetType);
    const targets = listCompatibleTargets(draft?.objects || [], parsed.payload.assetType);
    setDropPreview({
      assetType: parsed.payload.assetType,
      name: parsed.payload.displayName || parsed.payload.id,
      operation,
      ...targets,
    });
  }

  async function onLibraryDrop(e) {
    e.preventDefault();
    setDropHover(false);
    setDropPreview(null);
    setError("");
    setMessage("");
    if (!draft || !draftId) {
      setError("Open or sync a scene draft before dropping library assets.");
      return;
    }
    const parsed = parseLibraryPayload(e.dataTransfer);
    if (parsed.error || !parsed.payload) {
      setError(`${parsed.error || "Invalid drop"} Draft unchanged.`);
      return;
    }
    const payload = parsed.payload;
    let operation = operationForAssetType(payload.assetType);
    if (!operation) {
      setError(`No typed operation for "${payload.assetType}". Draft unchanged.`);
      return;
    }

    const selectedObj = draft.objects?.[selectedIndex] || null;
    const replaceSurface =
      payload.assetType === "model_3d" &&
      selectedObj &&
      objectSupportsOperation(selectedObj, "replace_floor_wall").ok &&
      e.altKey;
    if (replaceSurface) operation = "replace_floor_wall";

    try {
      await api("/api/drafts/validate-drop", {
        method: "POST",
        body: JSON.stringify({
          assetId: payload.id,
          claimedType: payload.assetType,
          operation,
          draftId: draft.id,
          targetObjectId:
            operation === "instantiate_model"
              ? null
              : selectedObj?.unityObjectId || selectedObj?.objectId || null,
          materialSlot: operation === "assign_material" ? Number(materialSlot) || 0 : 0,
          expectedDraftVersion: draft.version,
          expectedScenePath: draft.scenePath,
          expectedUnityRevision: draft.baseUnityRevision,
          expectedExportGeneration: draft.exportGeneration ?? undefined,
          expectedTargetMetadataSchema: 1,
        }),
      });
    } catch (err) {
      const msg = err.message || "Drop rejected by server. Draft unchanged.";
      if (err.status === 409 || /mismatch|stale|resync/i.test(msg)) {
        setError(`${msg} Click Sync from Unity, then retry the drop.`);
      } else {
        setError(msg);
      }
      return;
    }

    if (operation === "instantiate_model") {
      const placed = {
        objectId: `lib-${payload.id.slice(0, 8)}-${uuidv4().slice(0, 8)}`,
        name: payload.displayName || payload.id,
        assetId: payload.id,
        assetType: payload.assetType,
        provider: payload.provider || null,
        operation,
        position: { x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        source: "library_drop",
      };
      try {
        const result = await commitObjects(
          [...(draft.objects || []), placed],
          `Queued instantiate ${placed.name} in draft (v{v}). Not in Unity until Apply is acknowledged.`,
          { preferredObjectId: placed.objectId },
        );
        setSelectedIndex((result.objects || []).length - 1);
      } catch (err) {
        setError(err.message);
      }
      return;
    }

    const target = selectedObj;
    if (!target?.objectId) {
      setError("Select a compatible target object before assigning this asset. Draft unchanged.");
      return;
    }
    if (!target.unityObjectId) {
      setError("Target has no Unity GlobalObjectId yet. Sync from Unity first. Draft unchanged.");
      return;
    }
    const support = objectSupportsOperation(target, operation);
    if (!support.ok) {
      setError(`${support.reason} Draft unchanged.`);
      return;
    }
    if (operation === "assign_material") {
      const slotCount = Number(target.materialSlotCount);
      if (Number.isFinite(slotCount) && slotCount > 0 && (materialSlot < 0 || materialSlot >= slotCount)) {
        setError(`Material slot ${materialSlot} out of range (0–${slotCount - 1}). Draft unchanged.`);
        return;
      }
    }

    const targetUnityId = target.unityObjectId;
    const pending = {
      objectId: `op-${payload.id.slice(0, 8)}-${uuidv4().slice(0, 8)}`,
      name: `${operation} → ${target.name || target.objectId}`,
      assetId: payload.id,
      assetType: payload.assetType,
      provider: payload.provider || null,
      operation,
      targetObjectId: targetUnityId,
      targetDraftObjectId: target.objectId,
      materialSlot: operation === "assign_material" ? Number(materialSlot) || 0 : undefined,
      replaceSurface: operation === "replace_floor_wall" || undefined,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      source: "library_drop",
      pendingAssignment: true,
    };
    try {
      await commitObjects(
        [...(draft.objects || []), pending],
        `Queued ${operation} on ${target.name || target.objectId} (v{v}). Pending Unity until Apply acknowledges.`,
        { preferredObjectId: target.objectId },
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeSelected() {
    if (!draft?.objects?.length) return;
    const src = draft.objects[selectedIndex];
    if (isProtectedDraftObject(src)) {
      setError("Cannot remove XR/camera objects from the Level Editor.");
      return;
    }
    let objects;
    if (src?.unityObjectId) {
      objects = draft.objects.map((o, i) => (i === selectedIndex ? { ...o, removed: true } : o));
    } else {
      objects = draft.objects.filter((_, i) => i !== selectedIndex);
    }
    try {
      await commitObjects(objects, "Removed selected object from draft (v{v}).");
      setSelectedIndex(0);
    } catch (err) {
      setError(err.message);
    }
  }

  async function duplicateSelected() {
    if (!draft?.objects?.[selectedIndex]) return;
    const src = draft.objects[selectedIndex];
    if (isProtectedDraftObject(src)) {
      setError("Cannot duplicate XR/camera objects from the Level Editor.");
      return;
    }
    const copy = {
      ...structuredClone(src),
      objectId: `${src.objectId || "obj"}-copy-${uuidv4().slice(0, 6)}`,
      unityObjectId: null,
      name: `${src.name || "Object"} Copy`,
      source: src.source === "library_drop" ? "library_drop" : "duplicate",
      duplicateOf: src.unityObjectId || src.objectId,
      position: {
        x: (src.position?.x || 0) + 0.5,
        y: src.position?.y || 0,
        z: (src.position?.z || 0) + 0.5,
      },
      rotation: src.rotation || { x: 0, y: 0, z: 0 },
      scale: src.scale || { x: 1, y: 1, z: 1 },
    };
    const objects = [...draft.objects, copy];
    try {
      const result = await commitObjects(objects, "Duplicated object in draft (v{v}).", {
        preferredObjectId: copy.objectId,
      });
      setSelectedIndex((result.objects || objects).length - 1);
    } catch (err) {
      setError(err.message);
    }
  }

  async function undo() {
    if (!undoStack.length || !draft) return;
    const previous = undoStack[undoStack.length - 1];
    const current = structuredClone(draft.objects || []);
    try {
      await api(`/api/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: draft.version, objects: previous }),
      }).then((result) => {
        setUndoStack((s) => s.slice(0, -1));
        setRedoStack((s) => [...s, current]);
        applyDraftToForm(result);
        setMessage(`Undo applied to draft (v${result.version}).`);
      });
    } catch (err) {
      setError(err.message);
    }
  }

  async function redo() {
    if (!redoStack.length || !draft) return;
    const next = redoStack[redoStack.length - 1];
    const current = structuredClone(draft.objects || []);
    try {
      await api(`/api/drafts/${draftId}`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: draft.version, objects: next }),
      }).then((result) => {
        setRedoStack((s) => s.slice(0, -1));
        setUndoStack((s) => [...s, current]);
        applyDraftToForm(result);
        setMessage(`Redo applied to draft (v${result.version}).`);
      });
    } catch (err) {
      setError(err.message);
    }
  }

  async function queueApply() {
    setError("");
    setMessage("");
    try {
      const latest = await refresh(draftId);
      if (!latest) {
        setError("No draft available to Apply.");
        return;
      }
      const project = await api("/api/project");
      const liveRev = project.project?.unityRevision ?? unityRevision;
      const connected = Boolean(project.connection?.unityConnected ?? project.project?.unityConnected);
      const scenePath = project.activeScenePath || project.project?.scenePath || null;
      setUnityRevision(liveRev);
      setUnityConnected(connected);

      const reblock = getApplyBlockReason({
        draft: latest,
        activeScenePath: scenePath,
        unityConnected: connected,
        unityRevision: liveRev,
      });
      if (reblock) {
        setError(reblock);
        return;
      }

      const selectedObjectId =
        latest.objects?.[selectedIndex]?.objectId ||
        draftRef.current?.objects?.[selectedIndex]?.objectId ||
        null;
      const selectedForApply =
        latest.objects?.find((o) => o && o.objectId === selectedObjectId) || null;
      const built = buildSaveObjectsFromDraft(
        latest,
        selectedObjectId,
        numericTransformFromForm(selectedForApply),
        {
          snap: snapEnabled,
          snaps: {
            position: DEFAULT_POSITION_SNAP,
            rotationDeg: DEFAULT_ROTATION_SNAP_DEG,
            scale: DEFAULT_SCALE_SNAP,
          },
        },
      );
      const fresh = assertFreshApplySave(latest, built);
      if (!fresh.ok) {
        setError(`Apply aborted: stale draft state (${fresh.reason}). Refresh and try again.`);
        return;
      }

      const saved = await saveDraft(latest, selectedObjectId);
      const requestId = uuidv4();
      const result = await api(`/api/drafts/${saved.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ requestId, expectedDraftVersion: saved.version }),
      });
      setMessage(
        result.deduplicated
          ? `Duplicate requestId ignored - existing command ${result.command.status}.`
          : `Queued apply ${result.requestId} (${result.command.statusLabel || result.command.status}). Watch Unity Scene view.`,
      );
      await refresh(saved.id);
    } catch (err) {
      setError(err.message);
    }
  }

  const objects = draft?.objects || [];
  const selected = objects[selectedIndex];
  const selectedProtected = isProtectedDraftObject(selected);
  const sceneMismatch = Boolean(draft && activeScenePath && !draftMatchesActiveScene(draft, activeScenePath));
  const connection = resolveConnectionStatus({
    apiReachable,
    connectorOnline,
    unityConnected,
    activeScenePath,
    draftScenePath: draft?.scenePath || null,
    unityRevision,
    draftBaseRevision: draft?.baseUnityRevision ?? null,
    draftStatus: draft?.status || null,
    bindingResyncRequired: Boolean(draft?.bindingResyncRequired),
  });
  const applyBlockReason =
    getApplyBlockReason({
      draft,
      activeScenePath,
      unityConnected,
      unityRevision,
    }) ||
    (connection.blocksApply ? connection.primary?.message : null) ||
    (sceneValidation?.blocksApply
      ? `Walkability/collider validation: ${sceneValidation.status}`
      : null);
  const applyDisabled = Boolean(applyBlockReason);
  const showSelector = shouldShowDraftSceneSelector(draftSummaries, activeScenePath);
  const matchingDrafts = draftSummaries.filter((d) => !activeScenePath || d.scenePath === activeScenePath);
  const noMatchingDraft = !draft && Boolean(activeScenePath);
  const selectedValidation = sceneValidation?.objects?.find((o) => o.objectId === selected?.objectId) || null;

  return (
    <div className="page-enter">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Draft / apply · W03 {getMilestoneStatus("W03")}</div>
          <h1>Level editor</h1>
          <p>
            Cloud drafts, typed Asset Library drops, undo/redo, lazy 3D viewport with move/rotate/scale gizmos and
            snapping. Placement agrees with Unity after Apply. Child numeric fields edit local TRS.
          </p>
          <Badge variant={statusBadgeVariant(getMilestoneStatus("W03"))} className="mt-2 rounded-full">
            W03: {getMilestoneStatus("W03")}
          </Badge>
        </div>
        <div className="actions flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="border-white/15 bg-white/5"
            onClick={() => openFromScene(false)}
            disabled={!hasSceneExport && !draft}
          >
            Open scene draft
          </Button>
          <Button
            variant="outline"
            className="border-white/15 bg-white/5"
            onClick={() => openFromScene(true)}
            disabled={!hasSceneExport}
          >
            Sync from Unity
          </Button>
          <Button variant="outline" className="border-white/15 bg-white/5" onClick={undo} disabled={!undoStack.length}>
            Undo
          </Button>
          <Button variant="outline" className="border-white/15 bg-white/5" onClick={redo} disabled={!redoStack.length}>
            Redo
          </Button>
          <Button
            variant="outline"
            className="border-white/15 bg-white/5"
            data-testid="save-draft-button"
            onClick={() => {
              saveDraft().catch((err) => setError(err.message));
            }}
            disabled={!draft || sceneMismatch}
          >
            Save draft
          </Button>
          <Button
            className="font-semibold"
            data-testid="apply-to-unity-button"
            onClick={queueApply}
            disabled={applyDisabled}
            title={applyBlockReason || ""}
          >
            Apply to Unity
          </Button>
          <Link to="/assets" className={cn(buttonVariants({ variant: "outline" }), "border-white/15 bg-white/5")}>
            Asset Library
          </Link>
        </div>
      </div>

      <Card className="mb-4 border-white/10" data-testid="connection-status-panel">
        <CardHeader className="pb-2">
          <CardTitle>Connection & apply state</CardTitle>
          <CardDescription>
            Draft edits stay usable while Unity is offline. Apply waits for acknowledgment — never implied success.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <ul className="list text-sm" data-testid="connection-status-list">
            {connection.states.map((s) => (
              <li key={s.kind} data-kind={s.kind} data-severity={s.severity}>
                <Badge
                  variant={s.severity === "error" ? "destructive" : s.severity === "ok" ? "default" : "secondary"}
                  className="mr-2 rounded-full"
                >
                  {s.kind}
                </Badge>
                {s.message}
              </li>
            ))}
          </ul>
          {draft?.bindingResyncRequired ? (
            <p className="error text-sm" data-testid="binding-resync-warning">
              Stale/deleted Unity bindings detected. Use Sync from Unity before Apply.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-white/15 bg-white/5"
              onClick={() => refresh(draftId).catch((err) => setError(err.message))}
            >
              Refresh health
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-white/15 bg-white/5"
              onClick={() => {
                if (
                  draft &&
                  !window.confirm(
                    "Sync from Unity will rebase this draft and may discard unapplied local edits. Continue?",
                  )
                ) {
                  return;
                }
                openFromScene(true);
              }}
              disabled={!hasSceneExport}
            >
              Sync from Unity (warn)
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card
        className={`mb-4 border-dashed ${dropHover ? "border-primary/60 bg-primary/5" : "border-white/15"}`}
        data-testid="level-drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setDropHover(true);
          updateDropPreviewFromTransfer(e.dataTransfer);
        }}
        onDragLeave={() => {
          setDropHover(false);
          setDropPreview(null);
        }}
        onDrop={onLibraryDrop}
      >
        <CardHeader>
          <CardTitle>Library drop target</CardTitle>
          <CardDescription>
            Drag a typed card (model / texture / material / sprite / UI / audio / pixel / animation). Assignments need a
            selected compatible Unity-bound target. Alt+drop a model on a floor/wall to replace surface. XR rig is never
            a target.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="material-slot">Material slot (assign_material)</Label>
            <Input
              id="material-slot"
              type="number"
              min={0}
              className="h-10 w-32 rounded-full border-white/10 bg-white/5"
              value={materialSlot}
              onChange={(e) => setMaterialSlot(Number(e.target.value) || 0)}
            />
          </div>
          {dropPreview ? (
            <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm" data-testid="drop-preview">
              <p>
                <strong>{dropPreview.name}</strong> → <code>{dropPreview.operation}</code>
              </p>
              <p className="muted mt-1">Compatible:</p>
              <ul className="list">
                {(dropPreview.compatible || []).slice(0, 8).map((row) => (
                  <li key={row.objectId || row.label}>
                    {row.name || row.label}: {row.reason}
                    {row.needsSlot ? ` (slot ${materialSlot})` : ""}
                  </li>
                ))}
              </ul>
              {(dropPreview.incompatible || []).length ? (
                <>
                  <p className="muted mt-2">Incompatible (why disabled):</p>
                  <ul className="list">
                    {(dropPreview.incompatible || []).slice(0, 6).map((row) => (
                      <li key={row.objectId}>
                        {row.name}: {row.reason}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? <p className="error mb-4">{error}</p> : null}
      {message ? <p className="ok mb-4">{message}</p> : null}
      {draft?.lastError ? <p className="error mb-4">{draft.lastError}</p> : null}
      {applyBlockReason ? (
        <p className="error mb-4" data-testid="apply-block-reason">
          Apply disabled: {applyBlockReason}
        </p>
      ) : null}
      {sceneValidation ? (
        <p className="mb-4 text-sm" data-testid="scene-validation-summary">
          Scene validation: <strong>{sceneValidation.status}</strong>
          {sceneValidation.counts
            ? ` · valid ${sceneValidation.counts.valid ?? 0} · warn ${sceneValidation.counts.warning ?? 0} · invalid ${sceneValidation.counts.invalid ?? 0} · unknown ${sceneValidation.counts.unknown ?? 0}`
            : ""}
          {sceneValidation.blocksApply ? " · blocks Apply" : ""}
        </p>
      ) : null}

      <Card className="mb-4 border-white/10">
        <CardHeader className="pb-3">
          <CardTitle>Scene viewport</CardTitle>
          <CardDescription>
            Supported Hertz GLTF/GLB models at instance roots; Unity materials/shaders may differ. Unsupported objects
            show labeled fallbacks. Transforms commit on gizmo release
            {snapEnabled
              ? ` with snap ${DEFAULT_POSITION_SNAP}m / ${DEFAULT_ROTATION_SNAP_DEG} deg / ${DEFAULT_SCALE_SNAP}.`
              : " (snap off)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2"
            data-testid="scene-identity-bar"
          >
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Loaded draft scene</div>
              <div className="font-medium" data-testid="draft-scene-label">
                {draft?.scenePath
                  ? `${sceneDisplayName(draft.scenePath)} | ${draft.scenePath}`
                  : noMatchingDraft
                    ? "(no matching draft)"
                    : "(no draft loaded)"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Unity active scene</div>
              <div className="font-medium" data-testid="unity-active-scene-label">
                {activeScenePath
                  ? `${activeSceneName || sceneDisplayName(activeScenePath)} | ${activeScenePath}`
                  : "(unknown - connector offline or no scene report)"}
              </div>
            </div>
          </div>

          {showSelector ? (
            <div className="space-y-2" data-testid="scene-draft-selector">
              <Label htmlFor="draft-selector">Scene / draft</Label>
              <select
                id="draft-selector"
                className="h-10 w-full rounded-full border border-white/10 bg-white/5 px-3 text-sm"
                value={draftId || ""}
                onChange={(e) => onSelectDraftFromSelector(e.target.value)}
              >
                <option value="">Select a draft…</option>
                {draftSummaries.map((d) => (
                  <option key={d.id} value={d.id} disabled={activeScenePath && d.scenePath !== activeScenePath}>
                    {sceneDisplayName(d.scenePath)} | {d.id.slice(0, 8)} | v{d.version}
                    {d.scenePath === activeScenePath ? " (active scene)" : " (other scene - blocked)"}
                  </option>
                ))}
              </select>
              <p className="muted text-xs">
                Only drafts for Unity's active scene can be opened. Other-scene options stay disabled so the editor never
                silently shows the wrong scene.
              </p>
            </div>
          ) : null}

          {noMatchingDraft || sceneMismatch ? (
            <div
              className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm"
              data-testid="scene-mismatch-empty"
            >
              {sceneMismatch ? (
                <p>
                  Loaded draft belongs to <code>{draft.scenePath}</code>, but Unity is on{" "}
                  <code>{activeScenePath}</code>. Apply stays disabled. Sync from Unity or pick a matching draft.
                </p>
              ) : (
                <p>
                  No draft matches Unity's active scene
                  {activeScenePath ? (
                    <>
                      {" "}
                      (<code>{activeScenePath}</code>)
                    </>
                  ) : null}
                  . Use <strong>Sync from Unity</strong> to create one for this scene.
                </p>
              )}
              <div className="mt-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-white/15 bg-white/5"
                  onClick={() => openFromScene(true)}
                  disabled={!hasSceneExport}
                >
                  Sync from Unity
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2" data-testid="viewport-transform-toolbar">
            <Button
              type="button"
              size="sm"
              variant={transformMode === "translate" ? "default" : "outline"}
              onClick={() => setTransformMode("translate")}
              disabled={transformCommitInFlight}
            >
              Move
            </Button>
            <Button
              type="button"
              size="sm"
              variant={transformMode === "rotate" ? "default" : "outline"}
              onClick={() => setTransformMode("rotate")}
              disabled={transformCommitInFlight}
            >
              Rotate
            </Button>
            <Button
              type="button"
              size="sm"
              variant={transformMode === "scale" ? "default" : "outline"}
              onClick={() => setTransformMode("scale")}
              disabled={transformCommitInFlight}
            >
              Scale
            </Button>
            <Button
              type="button"
              size="sm"
              variant={snapEnabled ? "default" : "outline"}
              onClick={() => setSnapEnabled((v) => !v)}
              disabled={transformCommitInFlight}
            >
              Snap {snapEnabled ? "on" : "off"}
            </Button>
            {transformCommitInFlight ? (
              <span className="muted self-center text-xs" data-testid="transform-commit-lock">
                Saving transform…
              </span>
            ) : null}
          </div>
          <Suspense fallback={<p className="muted text-sm">Loading 3D viewport module…</p>}>
            <LevelEditorViewport
              objects={objects}
              selectedIndex={selectedIndex}
              transformMode={transformMode}
              snapEnabled={snapEnabled}
              positionSnap={DEFAULT_POSITION_SNAP}
              rotationSnapDeg={DEFAULT_ROTATION_SNAP_DEG}
              scaleSnap={DEFAULT_SCALE_SNAP}
              commitsLocked={transformCommitInFlight}
              syncToken={proxySyncToken}
              draftId={draftId || null}
              descriptorsByObjectId={descriptorsByObjectId}
              onSelectIndex={(index) => {
                if (draft?.objects?.[index]) selectObject(index, { frameInViewport: true });
              }}
              onTransformCommit={onViewportTransformCommit}
              onTransformModeChange={setTransformMode}
              onViewportApi={(api) => {
                viewportApiRef.current = api;
                // Stable Playwright/E2E hook — only when E2E mode was frozen at boot.
                if (typeof window !== "undefined" && isHertzE2eMode()) {
                  const existing = window.__HERTZ_LEVEL_EDITOR_TEST__ || {};
                  window.__HERTZ_LEVEL_EDITOR_TEST__ = api
                    ? {
                        ...existing,
                        commitTestGizmoDelta: (objectId, delta) => api.commitTestGizmoDelta?.(objectId, delta),
                        getSelectedObjectId: () =>
                          draftRef.current?.objects?.[selectedIndexRef.current]?.objectId || null,
                      }
                    : { ...existing, commitTestGizmoDelta: undefined };
                }
              }}
            />
          </Suspense>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Draft objects</CardTitle>
            <CardDescription>
              Status: {draft?.statusLabel || "..."} | version {draft?.version ?? "-"} | base Unity rev{" "}
              {draft?.baseUnityRevision ?? "-"}
              {unityRevision != null ? ` | live Unity rev ${unityRevision}` : ""}
              {matchingDrafts.length ? ` | ${matchingDrafts.length} draft(s) for active scene` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {objects.length === 0 ? (
              <p className="muted">
                {noMatchingDraft
                  ? "No matching draft for the active Unity scene. Pair the connector and click Sync from Unity."
                  : "No objects in this draft yet."}
              </p>
            ) : (
              <ul className="list">
                {objects.map((obj, index) => (
                  <li key={obj.objectId || index}>
                    <Button
                      variant={index === selectedIndex ? "default" : "outline"}
                      className={index === selectedIndex ? "" : "border-white/15 bg-white/5"}
                      onClick={() => selectObject(index)}
                    >
                      {obj.name || obj.objectId}
                      {isProtectedDraftObject(obj) ? " (protected)" : ""}
                    </Button>
                    <span className="muted">
                      {obj.position?.x}, {obj.position?.y}, {obj.position?.z}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Transform edit</CardTitle>
            <CardDescription>
              Selected: {selected?.name || "none"}
              {selectedProtected ? " | protected" : ""}
              {selected && !selectedProtected
                ? usesLocalNumericEdit(selected)
                  ? " | local Position / Rotation / Scale"
                  : " | world Position / Rotation / Scale"
                : ""}
              {selected?.renderRole ? ` | ${selected.renderRole}` : ""}
              {selected?.assetId ? ` | asset ${selected.assetId.slice(0, 8)}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {selected && !selectedProtected ? (
              <p className="muted text-sm" data-testid="transform-space-label">
                {usesLocalNumericEdit(selected)
                  ? "Numeric fields are local (parented object). Apply sends localPosition / localRotation / localScale."
                  : "Numeric fields are world (root object). Apply sends world position / rotation / scale."}
              </p>
            ) : null}
            {[
              ["pos-x", "Position X", x, setX],
              ["pos-y", "Position Y", y, setY],
              ["pos-z", "Position Z", z, setZ],
              ["rot-x", "Rotation X", rx, setRx],
              ["rot-y", "Rotation Y", ry, setRy],
              ["rot-z", "Rotation Z", rz, setRz],
              ["scl-x", "Scale X", sx, setSx],
              ["scl-y", "Scale Y", sy, setSy],
              ["scl-z", "Scale Z", sz, setSz],
            ].map(([id, label, value, setter]) => (
              <div className="space-y-2" key={id}>
                <Label htmlFor={id}>{label}</Label>
                <Input
                  id={id}
                  data-testid={`transform-${id}`}
                  className="h-10 rounded-full border-white/10 bg-white/5"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  disabled={selectedProtected || transformCommitInFlight}
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!draft?.objects?.length || selectedProtected || transformCommitInFlight}
                onClick={duplicateSelected}
              >
                Duplicate
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!draft?.objects?.length || selectedProtected || transformCommitInFlight}
                onClick={removeSelected}
              >
                Remove
              </Button>
            </div>
            {selectedFallback ? (
              <p className="muted text-sm" data-testid="object-fallback-reason">
                Viewport: {selectedFallback}
              </p>
            ) : null}
            {selectedValidation ? (
              <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm" data-testid="object-validation">
                <p>
                  Object validation: <strong>{selectedValidation.status}</strong>
                  {selectedValidation.status === "Unknown"
                    ? " (not treated as Valid)"
                    : ""}
                </p>
                <ul className="list mt-1">
                  {(selectedValidation.issues || []).map((issue) => (
                    <li key={`${issue.code}-${issue.message}`}>
                      [{issue.severity}] {issue.message}
                      {issue.blocksApply ? " — blocks Apply" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {selected?.bindingStale ? (
              <p className="error text-sm" data-testid="object-binding-stale">
                Binding conflict: {selected.bindingError || "stale Unity binding"}. Resync from Unity.
              </p>
            ) : null}
            <p className="muted">
              After Apply is acknowledged by Unity, verify transforms in the Scene view. HMSH2 materials remain
              baseColor+alpha only (no full shader/texture export in W03).
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
