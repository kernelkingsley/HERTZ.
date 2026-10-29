import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  normalizeCharacterLibraryModel,
  normalizeCharacterLibraryModels,
} from "../lib/characterLibraryModel.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CatalogSceneDeployPanel from "../components/CatalogSceneDeployPanel.jsx";

const CharacterPreview = lazy(() => import("../components/CharacterPreview.jsx"));

const EMPTY_ANIMS = { idle: "", attack: "", locomotion: "" };

const EMPTY_MODEL = {
  displayName: "Enemy Visual",
  kind: "enemy_visual",
  enabled: true,
  modelAssetId: "",
  scale: "1",
  animations: { ...EMPTY_ANIMS },
};

const EMPTY_PROFILE = {
  displayName: "Hold Profile",
  enabled: true,
  modelId: "",
  moveSpeed: "2.5",
  detectionRangeMeters: "12",
  attackRangeMeters: "8",
  waitReactionDelaySeconds: "0.4",
  shotBurstIntervalSeconds: "0.75",
  approachDistanceMeters: "3",
  mode: "hold_position",
  animations: { ...EMPTY_ANIMS },
};

function normalizeAnims(src = {}) {
  const a = src.animations || src;
  return {
    idle: a.idle != null ? String(a.idle) : "",
    attack: a.attack != null ? String(a.attack) : "",
    locomotion: a.locomotion != null ? String(a.locomotion) : "",
  };
}

function normalizeModel(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  return {
    displayName: src.displayName != null && src.displayName !== "" ? String(src.displayName) : EMPTY_MODEL.displayName,
    kind: src.kind === "player_character" ? "player_character" : "enemy_visual",
    enabled: src.enabled !== false && src.enabled !== "false",
    modelAssetId: src.modelAssetId != null ? String(src.modelAssetId) : "",
    scale: String(src.scale ?? EMPTY_MODEL.scale),
    animations: normalizeAnims(src),
  };
}

function normalizeProfile(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  const b = src.behavior || src;
  return {
    displayName: src.displayName != null && src.displayName !== "" ? String(src.displayName) : EMPTY_PROFILE.displayName,
    enabled: src.enabled !== false && src.enabled !== "false",
    modelId: src.modelId != null ? String(src.modelId) : "",
    moveSpeed: String(b.moveSpeed ?? EMPTY_PROFILE.moveSpeed),
    detectionRangeMeters: String(b.detectionRangeMeters ?? EMPTY_PROFILE.detectionRangeMeters),
    attackRangeMeters: String(b.attackRangeMeters ?? EMPTY_PROFILE.attackRangeMeters),
    waitReactionDelaySeconds: String(b.waitReactionDelaySeconds ?? EMPTY_PROFILE.waitReactionDelaySeconds),
    shotBurstIntervalSeconds: String(b.shotBurstIntervalSeconds ?? EMPTY_PROFILE.shotBurstIntervalSeconds),
    approachDistanceMeters: String(b.approachDistanceMeters ?? EMPTY_PROFILE.approachDistanceMeters),
    mode: ["idle", "patrol", "hold_position", "rush"].includes(b.mode) ? b.mode : "hold_position",
    animations: normalizeAnims(src),
  };
}

function unityLabel(state) {
  switch (state) {
    case "queued":
      return "Unity: Queued";
    case "applying":
      return "Unity: Applying";
    case "applied":
      return "Unity: Applied";
    case "failed":
      return "Unity: Failed";
    case "conflict":
      return "Unity: Conflict";
    case "stale":
      return "Unity: Stale";
    default:
      return "Unity: Not synced";
  }
}

/**
 * W05 Characters & Enemies — models separate from behavior profiles.
 * Never replaces tracked XR rig/camera. Shared milestone badge.
 */
export default function Characters() {
  const w05Status = getMilestoneStatus("W05");
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("models");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [modelForm, setModelForm] = useState(() => normalizeModel(EMPTY_MODEL));
  const [profileForm, setProfileForm] = useState(() => normalizeProfile(EMPTY_PROFILE));
  const [modelSnap, setModelSnap] = useState("");
  const [profileSnap, setProfileSnap] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState([]);
  const [animAssets, setAnimAssets] = useState([]);
  const [deps, setDeps] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewSlot, setPreviewSlot] = useState("idle");
  const [draftFromLibrary, setDraftFromLibrary] = useState(false);
  const modelEditorRef = useRef(null);
  const saveModelLockRef = useRef(false);

  const modelDirty = useMemo(() => JSON.stringify(modelForm) !== modelSnap, [modelForm, modelSnap]);
  const profileDirty = useMemo(() => JSON.stringify(profileForm) !== profileSnap, [profileForm, profileSnap]);
  const isUnsavedModelDraft = !selectedModelId && (modelDirty || draftFromLibrary);

  const slotAssignments = useMemo(() => {
    const out = {};
    for (const slot of ["idle", "attack", "locomotion"]) {
      const id = modelForm.animations?.[slot];
      if (!id) {
        out[slot] = null;
        continue;
      }
      const asset = animAssets.find((a) => a.id === id);
      out[slot] = asset
        ? {
            assetId: asset.id,
            displayName: asset.displayName || asset.name || "",
            name: asset.name || "",
            assetType: asset.assetType,
            fileFormat: asset.fileFormat || "",
            unityPath:
              asset.unity?.clipPath ||
              asset.unity?.controllerPath ||
              asset.unity?.prefabPath ||
              asset.unity?.assetPath ||
              null,
            embeddedClipName: asset.unity?.embeddedClipName || asset.meta?.embeddedClipName || null,
          }
        : {
            assetId: id,
            displayName: "",
            assetType: "unknown",
            fileFormat: "",
            unityPath: null,
          };
    }
    return out;
  }, [modelForm.animations, animAssets]);

  const [unityCompatibilityBySlot, setUnityCompatibilityBySlot] = useState({});

  useEffect(() => {
    let cancelled = false;
    const slots = ["idle", "attack", "locomotion"];
    (async () => {
      const next = {};
      for (const slot of slots) {
        const assign = slotAssignments[slot];
        if (!assign?.assetId || !modelForm.modelAssetId) {
          next[slot] = null;
          continue;
        }
        try {
          const res = await api("/api/characters/animation-compatibility", {
            method: "POST",
            body: JSON.stringify({
              modelAssetId: modelForm.modelAssetId,
              animationAssetId: assign.assetId,
              slot,
            }),
          });
          next[slot] = res?.unityCompatibility || {
            status: "pending",
            source: null,
            reason: res?.message || "Unity validation pending",
          };
        } catch {
          next[slot] = { status: "pending", source: null, reason: "Unity bridge unavailable" };
        }
      }
      if (!cancelled) setUnityCompatibilityBySlot(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [slotAssignments, modelForm.modelAssetId]);

  async function refresh() {
    const next = await api("/api/characters");
    setData(next);
    return next;
  }

  async function refreshReadyModels() {
    const res = await api("/api/characters/models/ready");
    const normalized = normalizeCharacterLibraryModels(res.models || []);
    setModels(normalized);
    return normalized;
  }

  async function refreshReadyAnimations() {
    const res = await api("/api/characters/animations/ready");
    setAnimAssets(res.animations || []);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
    refreshReadyModels().catch(() => {});
    refreshReadyAnimations().catch(() => {});
  }, []);

  // Auto-refresh picker while any model is importing / pending Unity.
  useEffect(() => {
    const busyImport = models.some(
      (m) => m.state === "importing_unity" || m.state === "pending_unity",
    );
    if (!busyImport) return undefined;
    const id = setInterval(() => {
      refreshReadyModels().catch(() => {});
    }, 2500);
    return () => clearInterval(id);
  }, [models]);

  useEffect(() => {
    if (!modelForm.modelAssetId) {
      setPreviewUrl("");
      return;
    }
    // Browser GLTFLoader must use /model (owner route). /file is connector-only and
    // was rewritten by the dep URL modifier into /model-dep/file → 404.
    setPreviewUrl(`/api/assets/${modelForm.modelAssetId}/model`);
  }, [modelForm.modelAssetId]);

  function selectModel(m) {
    setSelectedModelId(m.id);
    setDeps(null);
    setDraftFromLibrary(false);
    const form = normalizeModel(m);
    setModelForm(form);
    setModelSnap(JSON.stringify(form));
    setMessage("");
    setError("");
  }

  /**
   * Start a new unsaved catalog entry from a Unity-imported Asset Library mesh.
   * Does not POST until Kingsley presses Save. Never syncs or creates profiles.
   */
  function beginCatalogEntryFromLibrary(libraryModel, kind) {
    const entry = normalizeCharacterLibraryModel(libraryModel);
    if (!entry?.id || !entry.canAddToCatalog) {
      setError(entry?.blockReason || "Model must be Unity-imported before adding to the catalog.");
      return;
    }
    setTab("models");
    setSelectedModelId("");
    setDeps(null);
    setDraftFromLibrary(true);
    const form = normalizeModel({
      displayName: entry.displayName || "Character model",
      kind: kind === "player_character" ? "player_character" : "enemy_visual",
      enabled: true,
      modelAssetId: entry.id,
      scale: "1",
      animations: { ...EMPTY_ANIMS },
    });
    // Snap to empty so the draft is dirty until Save.
    setModelSnap(JSON.stringify(normalizeModel(EMPTY_MODEL)));
    setModelForm(form);
    setError("");
    setMessage(
      kind === "player_character"
        ? "Draft player-visible character — press Save to add it to the Characters catalog. Asset Library mesh is unchanged."
        : "Draft enemy visual — press Save to add it to the Characters catalog. Asset Library mesh is unchanged.",
    );
    requestAnimationFrame(() => {
      modelEditorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      document.getElementById("char-name")?.focus?.();
    });
  }

  async function importLibraryModelToUnity(libraryModel) {
    const entry = normalizeCharacterLibraryModel(libraryModel);
    if (!entry?.id || !entry.canEnqueueImport) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api(`/api/assets/${entry.id}/import-unity`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const offline = result?.connectorOnline === false || result?.unityConnected === false;
      const jobState = result?.job?.status || result?.status;
      setMessage(
        offline
          ? `Import queued (${jobState || "pending"}) — connector/Unity looks offline. Start connector + Unity bridge (8791).`
          : result?.deduplicated
            ? `Import already queued (${jobState || "pending"}) — waiting for connector/Unity.`
            : result?.message || `Import queued (${jobState || "pending_unity"}) — list refreshes when Unity finishes.`,
      );
      await refreshReadyModels();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  function selectProfile(p) {
    setSelectedProfileId(p.id);
    setDeps(null);
    const form = normalizeProfile(p);
    setProfileForm(form);
    setProfileSnap(JSON.stringify(form));
    setMessage("");
    setError("");
  }

  async function saveModel() {
    if (saveModelLockRef.current || busy) return;
    saveModelLockRef.current = true;
    setBusy(true);
    setError("");
    const creating = !selectedModelId;
    try {
      const body = {
        ...(selectedModelId ? { id: selectedModelId, expectedVersion: data?.models?.find((m) => m.id === selectedModelId)?.version } : {}),
        displayName: modelForm.displayName,
        kind: modelForm.kind,
        enabled: modelForm.enabled,
        modelAssetId: modelForm.modelAssetId || null,
        scale: Number(modelForm.scale),
        replaceTrackedXrRig: false,
        animations: {
          idle: modelForm.animations.idle || null,
          attack: modelForm.animations.attack || null,
          locomotion: modelForm.animations.locomotion || null,
        },
      };
      const saved = await api("/api/characters/models", { method: "POST", body: JSON.stringify(body) });
      await refresh();
      selectModel(saved);
      setDraftFromLibrary(false);
      setMessage(
        creating
          ? `Added “${saved.displayName}” to the Characters catalog (${saved.kind === "player_character" ? "player-visible" : "enemy visual"}). Asset Library mesh preserved; no Unity scene sync.`
          : "Saved character model. Tracked XR rig/camera are never replaced.",
      );
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
      saveModelLockRef.current = false;
    }
  }

  async function saveProfile() {
    setBusy(true);
    setError("");
    try {
      const body = {
        ...(selectedProfileId
          ? { id: selectedProfileId, expectedVersion: data?.profiles?.find((p) => p.id === selectedProfileId)?.version }
          : {}),
        displayName: profileForm.displayName,
        enabled: profileForm.enabled,
        modelId: profileForm.modelId || null,
        behavior: {
          moveSpeed: Number(profileForm.moveSpeed),
          detectionRangeMeters: Number(profileForm.detectionRangeMeters),
          attackRangeMeters: Number(profileForm.attackRangeMeters),
          waitReactionDelaySeconds: Number(profileForm.waitReactionDelaySeconds),
          shotBurstIntervalSeconds: Number(profileForm.shotBurstIntervalSeconds),
          approachDistanceMeters: Number(profileForm.approachDistanceMeters),
          mode: profileForm.mode,
        },
        animations: {
          idle: profileForm.animations.idle || null,
          attack: profileForm.animations.attack || null,
          locomotion: profileForm.animations.locomotion || null,
        },
      };
      const saved = await api("/api/characters/profiles", { method: "POST", body: JSON.stringify(body) });
      await refresh();
      selectProfile(saved);
      setMessage("Saved enemy behavior profile (separate from visual model).");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function syncModel() {
    if (!selectedModelId) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/characters/models/${selectedModelId}/sync`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh();
      setMessage("Character model sync queued.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function syncProfile() {
    if (!selectedProfileId) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/characters/profiles/${selectedProfileId}/sync`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh();
      setMessage("Enemy profile sync queued.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeModel() {
    if (!selectedModelId) return;
    setBusy(true);
    setError("");
    setDeps(null);
    try {
      await api(`/api/characters/models/${selectedModelId}`, { method: "DELETE" });
      setSelectedModelId("");
      setModelForm(normalizeModel(EMPTY_MODEL));
      setModelSnap(JSON.stringify(normalizeModel(EMPTY_MODEL)));
      await refresh();
      setMessage("Character model removed.");
    } catch (e) {
      if (e.data?.code === "dependency_blocked") {
        setDeps(e.data.dependencies || []);
      }
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile() {
    if (!selectedProfileId) return;
    setBusy(true);
    setError("");
    setDeps(null);
    try {
      await api(`/api/characters/profiles/${selectedProfileId}`, { method: "DELETE" });
      setSelectedProfileId("");
      setProfileForm(normalizeProfile(EMPTY_PROFILE));
      setProfileSnap(JSON.stringify(normalizeProfile(EMPTY_PROFILE)));
      await refresh();
      setMessage("Enemy profile removed.");
    } catch (e) {
      if (e.data?.code === "dependency_blocked") {
        setDeps(e.data.dependencies || []);
      }
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  const enemyVisuals = (data?.models || []).filter((m) => m.kind === "enemy_visual");

  return (
    <div className="space-y-4 p-4" data-testid="characters-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Characters &amp; Enemies</h1>
          <p className="text-sm text-muted-foreground">
            Visual models stay separate from enemy behavior profiles. Tracked XR rig/camera are never replaced.
          </p>
        </div>
        <Badge variant={statusBadgeVariant(w05Status)} data-testid="characters-milestone-badge">
          {w05Status}
        </Badge>
      </div>

      <div className="flex gap-2">
        <Button type="button" variant={tab === "models" ? "default" : "outline"} onClick={() => setTab("models")}>
          Models
        </Button>
        <Button type="button" variant={tab === "profiles" ? "default" : "outline"} onClick={() => setTab("profiles")}>
          Behavior profiles
        </Button>
      </div>

      {error ? (
        <div className="error rounded-xl border border-red-500/40 px-3 py-2 text-sm" data-testid="characters-error">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-white/10 px-3 py-2 text-sm" data-testid="characters-message">
          {message}
        </div>
      ) : null}

      {tab === "models" ? (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Catalog</CardTitle>
              <CardDescription>Player-visible and enemy visuals</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setSelectedModelId("");
                  setDraftFromLibrary(false);
                  const form = normalizeModel(EMPTY_MODEL);
                  setModelForm(form);
                  setModelSnap(JSON.stringify(form));
                  setMessage("New unsaved catalog entry — assign a Unity-imported mesh below, then Save.");
                }}
              >
                New model
              </Button>
              {(data?.models || []).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-testid={`character-model-row-${m.kind}`}
                  data-character-id={m.id}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${
                    selectedModelId === m.id ? "border-primary/50 bg-primary/10" : "border-white/10 bg-black/20"
                  }`}
                  onClick={() => selectModel(m)}
                >
                  <span>
                    {m.displayName}{" "}
                    <Badge variant="outline" className="ml-1 text-[10px]">
                      {m.kind === "player_character" ? "Player" : "Enemy visual"}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground text-xs">{unityLabel(m.unitySync?.state)}</span>
                </button>
              ))}
            </CardContent>
          </Card>

          <div ref={modelEditorRef} data-testid="character-model-editor">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Model editor</CardTitle>
              {isUnsavedModelDraft ? (
                <CardDescription data-testid="character-model-unsaved">
                  Unsaved catalog draft — press Save to create one Characters catalog entry. Does not sync Unity or
                  create an enemy profile.
                </CardDescription>
              ) : (
                <CardDescription>
                  Viewport first: pick a mesh (Add from library or Mesh dropdown), preview the model, then assign
                  idle / attack / locomotion clips. Save when ready.
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                className="space-y-2 rounded-xl border border-white/10 p-3"
                data-testid="character-preview-panel"
              >
                <p className="text-sm font-medium">Character viewport</p>
                <p className="text-xs text-muted-foreground" data-testid="character-preview-workflow-note">
                  Shows the selected mesh when one is assigned. Studio configures already-rigged / skinned characters
                  and maps Unity AnimationClips or RuntimeAnimatorControllers to idle, attack, and locomotion — it
                  does not rig a static mesh. Browser playback only when an embedded GLB clip exactly matches the
                  assignment; Unity-only .anim / controllers stay “Assigned in Unity; browser preview unavailable.”
                </p>
                <Suspense fallback={<div className="text-xs">Loading preview…</div>}>
                  <CharacterPreview
                    modelUrl={previewUrl}
                    modelAssetId={modelForm.modelAssetId || undefined}
                    modelFormat={
                      models.find((m) => m.id === modelForm.modelAssetId)?.fileFormat || null
                    }
                    modelFileName={
                      models.find((m) => m.id === modelForm.modelAssetId)?.entrypointFileName ||
                      models.find((m) => m.id === modelForm.modelAssetId)?.displayName ||
                      null
                    }
                    previewSlot={previewSlot}
                    slotAssignments={slotAssignments}
                    unityCompatibilityBySlot={unityCompatibilityBySlot}
                    onSlotChange={setPreviewSlot}
                  />
                </Suspense>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="sm:col-span-1">
                  <Label htmlFor="char-name">Display name</Label>
                  <Input
                    id="char-name"
                    data-testid="character-name"
                    value={modelForm.displayName}
                    onChange={(e) => setModelForm(normalizeModel({ ...modelForm, displayName: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="char-kind">Kind</Label>
                  <select
                    id="char-kind"
                    data-testid="character-kind"
                    className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm"
                    value={modelForm.kind}
                    onChange={(e) => setModelForm(normalizeModel({ ...modelForm, kind: e.target.value }))}
                  >
                    <option value="enemy_visual">Enemy visual</option>
                    <option value="player_character">Player character (visible only)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="char-scale">Scale</Label>
                  <Input
                    id="char-scale"
                    data-testid="character-scale"
                    value={modelForm.scale}
                    onChange={(e) => setModelForm(normalizeModel({ ...modelForm, scale: e.target.value }))}
                  />
                </div>
              </div>
              <div data-testid="character-model-picker" className="space-y-2">
                <Label htmlFor="char-model">Mesh on this catalog entry</Label>
                <p className="text-xs text-muted-foreground">
                  Assigns or replaces the mesh for the catalog entry you are editing (New model or Add from library).
                  Only Unity-imported meshes appear here. To create a new catalog entry from the library, use Add as
                  character / Add as enemy visual below — not this dropdown alone.
                </p>
                <select
                  id="char-model"
                  data-testid="character-model-select"
                  className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm"
                  value={modelForm.modelAssetId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const entry = models.find((m) => m.id === nextId);
                    if (nextId && entry && !entry.assignable) {
                      setError(entry.blockReason || "Model is not Unity-imported yet.");
                      return;
                    }
                    setError("");
                    setModelForm(normalizeModel({ ...modelForm, modelAssetId: nextId }));
                  }}
                >
                  <option value="">No mesh yet</option>
                  {models
                    .filter((m) => m.assignable || m.id === modelForm.modelAssetId)
                    .map((m) => (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={!m.assignable}
                        data-assignable={m.assignable ? "true" : "false"}
                        data-state={m.state}
                      >
                        {m.displayName} — {m.stateLabel || m.state}
                      </option>
                    ))}
                </select>
                <div
                  className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-white/10 p-2"
                  data-testid="character-model-library-list"
                >
                  <p className="text-xs font-medium text-foreground">Asset Library model_3d → Characters catalog</p>
                  {models.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No model_3d assets in the library yet.</p>
                  ) : (
                    models.map((m) => (
                      <div
                        key={m.id}
                        className="flex flex-wrap items-center gap-2 border-b border-white/5 py-2 text-xs last:border-0"
                        data-testid={`character-model-library-row-${m.id}`}
                        data-state={m.state}
                        data-assignable={m.assignable ? "true" : "false"}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {m.displayName}{" "}
                          <span className="text-muted-foreground">({m.stateLabel || m.state})</span>
                        </span>
                        {m.importInFlight ? (
                          <span className="text-[var(--glow)]" data-testid={`character-model-importing-${m.id}`}>
                            {m.blockReason || "Importing to Unity…"}
                          </span>
                        ) : null}
                        {m.state === "failed" && m.lastError ? (
                          <span className="text-[var(--glow)]" data-testid={`character-model-error-${m.id}`}>
                            {m.lastError}
                          </span>
                        ) : null}
                        {!m.assignable && !m.importInFlight && m.state !== "failed" && m.blockReason ? (
                          <span className="text-muted-foreground" title={m.blockReason}>
                            {m.blockReason}
                          </span>
                        ) : null}
                        {m.canAddToCatalog ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              data-testid={`character-model-add-character-${m.id}`}
                              disabled={busy}
                              onClick={() => beginCatalogEntryFromLibrary(m, "player_character")}
                            >
                              Add as character
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              data-testid={`character-model-add-enemy-${m.id}`}
                              disabled={busy}
                              onClick={() => beginCatalogEntryFromLibrary(m, "enemy_visual")}
                            >
                              Add as enemy visual
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled
                            data-testid={`character-model-add-disabled-${m.id}`}
                            title={m.blockReason || "Import to Unity first"}
                          >
                            Add (Unity import required)
                          </Button>
                        )}
                        {m.canEnqueueImport ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid={
                              m.canRetryImport
                                ? `character-model-retry-import-${m.id}`
                                : `character-model-import-${m.id}`
                            }
                            disabled={busy || m.importInFlight}
                            onClick={() => importLibraryModelToUnity(m)}
                          >
                            {m.canRetryImport ? "Retry import" : "Import to Unity"}
                          </Button>
                        ) : null}
                        <Link
                          to={`/assets/${m.id}/view`}
                          className="inline-flex h-8 items-center rounded-md border border-white/15 px-3 text-xs"
                          data-testid={`character-model-open-${m.id}`}
                        >
                          Open asset
                        </Link>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="character-xr-safety-note">
                Safety: imported models never replace the tracked XR rig or headset camera.
              </p>
              <div className="space-y-2 rounded-xl border border-white/10 p-3" data-testid="character-animation-slots">
                <p className="text-sm font-medium">Animation slots</p>
                <p className="text-xs text-muted-foreground">
                  Map Unity-imported AnimationClip or RuntimeAnimatorController assets to idle, attack, and
                  locomotion for this catalog entry. Mixamo download integration is W09. A static unrigged mesh will
                  not become animatable here.
                </p>
                {["idle", "attack", "locomotion"].map((slot) => (
                  <div key={slot}>
                    <Label htmlFor={`char-anim-${slot}`}>{slot}</Label>
                    <select
                      id={`char-anim-${slot}`}
                      data-testid={`character-anim-${slot}`}
                      className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm"
                      value={modelForm.animations[slot]}
                      onChange={(e) =>
                        setModelForm(
                          normalizeModel({
                            ...modelForm,
                            animations: { ...modelForm.animations, [slot]: e.target.value },
                          }),
                        )
                      }
                    >
                      <option value="">Unassigned</option>
                      {animAssets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.displayName} ({a.assetType})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  data-testid="character-model-save"
                  disabled={busy || (!modelDirty && Boolean(selectedModelId))}
                  onClick={saveModel}
                >
                  Save
                </Button>
                <Button type="button" variant="outline" data-testid="character-model-sync" disabled={busy || !selectedModelId} onClick={syncModel}>
                  Sync Unity
                </Button>
                <Button type="button" variant="destructive" data-testid="character-model-remove" disabled={busy || !selectedModelId} onClick={removeModel}>
                  Remove
                </Button>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="character-sync-no-place-note">
                Sync Unity writes ScriptableObject definitions under Assets/HertzStudio — it does not place meshes into
                any scene. Use Test / Deploy below for explicit one-scene placement.
              </p>
              {selectedModelId ? (
                <div className="rounded-xl border border-white/10 px-3 py-2 text-xs" data-testid="character-model-sync-status">
                  {unityLabel(data?.models?.find((m) => m.id === selectedModelId)?.unitySync?.state)}
                </div>
              ) : null}
            </CardContent>
          </Card>
          <div className="mt-3">
            <CatalogSceneDeployPanel
              kind="character"
              catalogLabel="character catalog entry"
              characterId={selectedModelId || ""}
              characterVersion={data?.models?.find((model) => model.id === selectedModelId)?.version || null}
              characterProfiles={data?.profiles || []}
              disabled={busy}
              onMessage={setMessage}
              onError={setError}
              onDeployed={refresh}
            />
          </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Profiles</CardTitle>
              <CardDescription>idle / patrol / hold / rush</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setSelectedProfileId("");
                  const form = normalizeProfile(EMPTY_PROFILE);
                  setProfileForm(form);
                  setProfileSnap(JSON.stringify(form));
                }}
              >
                New profile
              </Button>
              {(data?.profiles || []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid="enemy-profile-row"
                  data-profile-id={p.id}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${
                    selectedProfileId === p.id ? "border-primary/50 bg-primary/10" : "border-white/10 bg-black/20"
                  }`}
                  onClick={() => selectProfile(p)}
                >
                  <span>
                    {p.displayName}{" "}
                    <Badge variant="outline" className="ml-1 text-[10px]">
                      {p.behavior?.mode}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground text-xs">{unityLabel(p.unitySync?.state)}</span>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Behavior editor</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label htmlFor="prof-name">Display name</Label>
                <Input
                  id="prof-name"
                  data-testid="profile-name"
                  value={profileForm.displayName}
                  onChange={(e) => setProfileForm(normalizeProfile({ ...profileForm, displayName: e.target.value }))}
                />
              </div>
              <div>
                <Label htmlFor="prof-mode">Mode</Label>
                <select
                  id="prof-mode"
                  data-testid="profile-mode"
                  className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm"
                  value={profileForm.mode}
                  onChange={(e) => setProfileForm(normalizeProfile({ ...profileForm, mode: e.target.value }))}
                >
                  <option value="idle">Idle</option>
                  <option value="patrol">Patrol</option>
                  <option value="hold_position">Hold position</option>
                  <option value="rush">Rush</option>
                </select>
              </div>
              <div>
                <Label htmlFor="prof-model">Enemy visual model</Label>
                <select
                  id="prof-model"
                  data-testid="profile-model-select"
                  className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm"
                  value={profileForm.modelId}
                  onChange={(e) => setProfileForm(normalizeProfile({ ...profileForm, modelId: e.target.value }))}
                >
                  <option value="">Unassigned</option>
                  {enemyVisuals.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>
              {[
                ["moveSpeed", "Move speed"],
                ["detectionRangeMeters", "Detection range"],
                ["attackRangeMeters", "Attack range"],
                ["waitReactionDelaySeconds", "Wait / reaction delay"],
                ["shotBurstIntervalSeconds", "Shot / burst interval"],
                ["approachDistanceMeters", "Approach distance"],
              ].map(([key, label]) => (
                <div key={key}>
                  <Label htmlFor={`prof-${key}`}>{label}</Label>
                  <Input
                    id={`prof-${key}`}
                    data-testid={`profile-${key}`}
                    value={profileForm[key]}
                    onChange={(e) => setProfileForm(normalizeProfile({ ...profileForm, [key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="space-y-2 rounded-xl border border-white/10 p-3" data-testid="profile-animation-slots">
                <p className="text-sm font-medium">Animation overrides</p>
                <p className="text-xs text-muted-foreground">
                  Optional — leave empty to inherit from the linked enemy visual model.
                </p>
                {["idle", "attack", "locomotion"].map((slot) => (
                  <div key={slot}>
                    <Label htmlFor={`prof-anim-${slot}`}>{slot}</Label>
                    <select
                      id={`prof-anim-${slot}`}
                      data-testid={`profile-anim-${slot}`}
                      className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm"
                      value={profileForm.animations[slot]}
                      onChange={(e) =>
                        setProfileForm(
                          normalizeProfile({
                            ...profileForm,
                            animations: { ...profileForm.animations, [slot]: e.target.value },
                          }),
                        )
                      }
                    >
                      <option value="">Inherit from model</option>
                      {animAssets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.displayName} ({a.assetType})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" data-testid="profile-save" disabled={busy || (!profileDirty && selectedProfileId)} onClick={saveProfile}>
                  Save
                </Button>
                <Button type="button" variant="outline" data-testid="profile-sync" disabled={busy || !selectedProfileId} onClick={syncProfile}>
                  Sync Unity
                </Button>
                <Button type="button" variant="destructive" data-testid="profile-remove" disabled={busy || !selectedProfileId} onClick={removeProfile}>
                  Remove
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {deps?.length ? (
        <div className="rounded-xl border border-amber-500/40 px-3 py-2 text-xs" data-testid="character-deps">
          Blocked by dependencies:
          <ul>
            {deps.map((d, i) => (
              <li key={`${d.kind}-${i}`} data-testid={`character-dep-${d.kind}`}>
                {d.kind}: {d.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
