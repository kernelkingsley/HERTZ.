import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { resolveWeaponShotAudio } from "../lib/weaponShotAudio.js";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CatalogSceneDeployPanel from "../components/CatalogSceneDeployPanel.jsx";
import WeaponStudioFirePreview from "../components/WeaponStudioFirePreview.jsx";
import WeaponRemovePanel from "../components/WeaponRemovePanel.jsx";

const ModelViewer = lazy(() => import("../components/ModelViewer.jsx"));

const EMPTY_FORM = {
  displayName: "Left Pistol",
  role: "left_pistol",
  enabled: true,
  frequencyFlipRequired: true,
  modelAssetId: "",
  damage: "10",
  fireIntervalSeconds: "0.2",
  rangeMeters: "40",
  recoil: "0.15",
  leftHandAnchor: "LeftHand",
  rightHandAnchor: "RightHand",
  gripAnchor: "Grip",
  muzzleAnchor: "Muzzle",
};

/** Every controlled field is always a defined string/boolean — never undefined/null. */
function normalizeForm(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  return {
    displayName: src.displayName != null && src.displayName !== "" ? String(src.displayName) : EMPTY_FORM.displayName,
    role: src.role === "right_pistol" ? "right_pistol" : "left_pistol",
    enabled: src.enabled !== false && src.enabled !== "false",
    frequencyFlipRequired: src.frequencyFlipRequired !== false && src.frequencyFlipRequired !== "false",
    modelAssetId: src.modelAssetId != null ? String(src.modelAssetId) : "",
    damage: String(src.damage ?? EMPTY_FORM.damage),
    fireIntervalSeconds: String(src.fireIntervalSeconds ?? EMPTY_FORM.fireIntervalSeconds),
    rangeMeters: String(src.rangeMeters ?? EMPTY_FORM.rangeMeters),
    recoil: String(src.recoil ?? EMPTY_FORM.recoil),
    leftHandAnchor: String(src.leftHandAnchor || EMPTY_FORM.leftHandAnchor),
    rightHandAnchor: String(src.rightHandAnchor || EMPTY_FORM.rightHandAnchor),
    gripAnchor: String(src.gripAnchor || EMPTY_FORM.gripAnchor),
    muzzleAnchor: String(src.muzzleAnchor || EMPTY_FORM.muzzleAnchor),
  };
}

/** True when a managed wrapper must be Confirmed before Sync/Deploy (provisional or legacy). */
export function wrapperNeedsStudioConfirm(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.needsConfirmation === true) return true;
  if (meta.recoveryReason === "missing_metadata") return true;
  if (meta.provisional === true && meta.confirmed !== true) return true;
  if (meta.confirmed !== true && meta.path) return true;
  return false;
}

/** Display-only label for per-weapon Unity definition sync (not Studio connection). */
export function unitySyncDisplayLabel(state) {
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
    case "disconnected":
    default:
      return "Unity: Not synced";
  }
}

export const UNITY_SYNC_STATUS_HELP =
  "This status describes this weapon definition’s synchronization with Unity. It is separate from the overall Studio connection.";

/**
 * W04 weapon catalog — dual pistols only; frequency-flip gate preserved.
 * No rarity, currency, shop, or unlock systems. Milestone label from shared status.
 */
export default function Weapons() {
  const w04Status = getMilestoneStatus("W04");
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState(() => normalizeForm(EMPTY_FORM));
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState([]);
  const [modelQuery, setModelQuery] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeInspection, setRemoveInspection] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [soundBoard, setSoundBoard] = useState(null);
  const [viewerReadyEpoch, setViewerReadyEpoch] = useState(0);
  const [prefabInspect, setPrefabInspect] = useState(null);
  const [anchorBusy, setAnchorBusy] = useState(false);
  const viewerApiRef = useRef(null);
  // Only a non-null ready API advances the epoch — cleanup null must not reload or re-resolve.
  const handleViewerReady = useCallback((api) => {
    if (!api) return;
    setViewerReadyEpoch((n) => n + 1);
  }, []);

  const dirty = useMemo(() => JSON.stringify(form) !== savedSnapshot, [form, savedSnapshot]);
  const shotAudio = useMemo(
    () => resolveWeaponShotAudio(soundBoard, form.role),
    [soundBoard, form.role],
  );

  async function refresh() {
    const next = await api("/api/weapons");
    setData(next);
    return next;
  }

  async function refreshSound() {
    try {
      const board = await api("/api/sound");
      setSoundBoard(board);
    } catch {
      setSoundBoard({ slots: [] });
    }
  }

  async function refreshModels(q = modelQuery) {
    const res = await api(`/api/weapons/models/library?q=${encodeURIComponent(q || "")}`);
    setModels(res.models || []);
  }

  async function importModelToUnity(modelAssetId, { retry = false } = {}) {
    if (!modelAssetId || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const requestId =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `imp-${Date.now()}`;
      await api(`/api/assets/${modelAssetId}/import-unity`, {
        method: "POST",
        body: JSON.stringify({ requestId }),
      });
      setMessage(retry ? "Retry import queued." : "Import to Unity queued.");
      await refreshModels(modelQuery);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    refreshModels("").catch(() => {});
    refreshSound().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      if (!form.modelAssetId) {
        setPreviewUrl("");
        return;
      }
      try {
        if (!cancelled) {
          setPreviewUrl(`/api/assets/${form.modelAssetId}/model`);
        }
      } catch {
        if (!cancelled) setPreviewUrl("");
      }
    }
    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [form.modelAssetId]);

  function formFromWeapon(w) {
    return normalizeForm({
      displayName: w?.displayName,
      role: w?.role,
      enabled: w?.enabled,
      frequencyFlipRequired: w?.frequencyFlipRequired,
      modelAssetId: w?.modelAssetId,
      damage: w?.tuning?.damage,
      fireIntervalSeconds: w?.tuning?.fireIntervalSeconds,
      rangeMeters: w?.tuning?.rangeMeters,
      recoil: w?.tuning?.recoil,
      leftHandAnchor: w?.tuning?.leftHandAnchor,
      rightHandAnchor: w?.tuning?.rightHandAnchor,
      gripAnchor: w?.tuning?.gripAnchor,
      muzzleAnchor: w?.tuning?.muzzleAnchor,
    });
  }

  function selectWeapon(w) {
    setSelectedId(w.id);
    setRemoveOpen(false);
    setRemoveInspection(null);
    const next = formFromWeapon(w);
    setForm(next);
    setSavedSnapshot(JSON.stringify(next));
    setError("");
    setMessage("");
  }

  function startNew() {
    setSelectedId("");
    setRemoveOpen(false);
    setRemoveInspection(null);
    const next = normalizeForm(EMPTY_FORM);
    setForm(next);
    setSavedSnapshot(JSON.stringify(next));
  }

  async function saveWeapon(e) {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = {
        id: selectedId || undefined,
        expectedVersion: selectedId
          ? data?.weapons?.find((w) => w.id === selectedId)?.version
          : undefined,
        displayName: form.displayName,
        role: form.role,
        enabled: form.enabled,
        frequencyFlipRequired: form.frequencyFlipRequired,
        modelAssetId: form.modelAssetId || null,
        tuning: {
          damage: Number(form.damage),
          fireIntervalSeconds: Number(form.fireIntervalSeconds),
          rangeMeters: Number(form.rangeMeters),
          recoil: Number(form.recoil),
          leftHandAnchor: form.leftHandAnchor,
          rightHandAnchor: form.rightHandAnchor,
          gripAnchor: form.gripAnchor,
          muzzleAnchor: form.muzzleAnchor,
        },
      };
      const saved = await api("/api/weapons", { method: "POST", body: JSON.stringify(body) });
      setSelectedId(saved.id);
      const next = formFromWeapon(saved);
      setForm(next);
      setSavedSnapshot(JSON.stringify(next));
      setMessage(
        `Saved ${saved.displayName}. Imports never auto-equip. Frequency flip still gates firing.`,
      );
      await refresh();
    } catch (err) {
      // Stale-version / validation: keep every field defined so inputs stay controlled.
      setForm((prev) => normalizeForm(prev));
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function syncToUnity() {
    if (!selectedId || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const weapon = data?.weapons?.find((w) => w.id === selectedId);
      const result = await api(`/api/weapons/${selectedId}/sync`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: weapon?.version }),
      });
      setMessage(
        result.deduplicated
          ? "Sync request deduplicated (idempotent delivery)."
          : `Sync queued (${result.requestId}). Status updates when Unity acknowledges.`,
      );
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function assignLoadout() {
    if (!selectedId || busy) return;
    setBusy(true);
    setError("");
    try {
      const key = form.role === "right_pistol" ? "rightWeaponId" : "leftWeaponId";
      await api("/api/weapons/loadout", {
        method: "PATCH",
        body: JSON.stringify({ [key]: selectedId }),
      });
      setMessage(`Assigned to ${key}. Still does not bypass frequency flip.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function newRemovalRequestId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `rm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function openRemoveWorkflow() {
    if (!selectedId || busy || removeBusy) return;
    setError("");
    setMessage("");
    setRemoveBusy(true);
    try {
      const inspection = await api(`/api/weapons/${selectedId}/dependencies`);
      setRemoveInspection(inspection);
      setRemoveOpen(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setRemoveBusy(false);
    }
  }

  async function refreshRemoveInspection() {
    if (!selectedId) return;
    setRemoveBusy(true);
    setError("");
    try {
      const inspection = await api(`/api/weapons/${selectedId}/guided-remove`, {
        method: "POST",
        body: JSON.stringify({ action: "refresh" }),
      });
      if (inspection.deleted) {
        setRemoveOpen(false);
        setRemoveInspection(null);
        setSelectedId("");
        startNew();
        setMessage(inspection.note || "Catalog entry removed after Unity acknowledgement.");
        await refresh();
        return;
      }
      setRemoveInspection(inspection);
      if (inspection.nextAction) setMessage(inspection.nextAction);
    } catch (err) {
      setError(err.message);
    } finally {
      setRemoveBusy(false);
    }
  }

  async function runGuidedRemove(action, { sides } = {}) {
    if (!selectedId || removeBusy) return;
    // Deletion must use the currently selected weapon id — never a stale list index.
    const weaponId = selectedId;
    const live = data?.weapons?.find((w) => w.id === weaponId);
    if (!live && action !== "refresh" && action !== "preview") {
      setError("Selected weapon is no longer in the catalog. Refresh the list.");
      return;
    }
    setRemoveBusy(true);
    setError("");
    setMessage("");
    const requestId = newRemovalRequestId();
    try {
      const result = await api(`/api/weapons/${weaponId}/guided-remove`, {
        method: "POST",
        body: JSON.stringify({ action, requestId, sides }),
      });
      if (result.deleted || result.status === "completed") {
        setRemoveOpen(false);
        setRemoveInspection(null);
        setSelectedId("");
        startNew();
        setMessage(result.note || "Catalog entry removed. Linked Asset Library model preserved.");
        await refresh();
        return;
      }
      setRemoveInspection(result);
      if (result.status === "failed" || result.status === "conflict") {
        setError(result.error || result.nextAction || "Removal did not complete.");
      } else {
        setMessage(result.note || result.nextAction || "Removal in progress.");
      }
      await refresh();
    } catch (err) {
      if (err.data?.code === "idempotency_conflict") {
        setError(err.data?.error || err.message);
      } else if (err.data?.dependencies || err.data?.actions) {
        setRemoveInspection({
          dependencies: err.data.dependencies || [],
          actions: err.data.actions || {},
          nextAction: err.data.nextAction || err.message,
          status: "blocked",
        });
        setError(err.data?.nextAction || err.message);
      } else {
        setError(err.data?.nextAction || err.message);
      }
    } finally {
      setRemoveBusy(false);
    }
  }

  const weapons = data?.weapons || [];
  const selected = weapons.find((w) => w.id === selectedId);
  const wrapNeedsConfirm = wrapperNeedsStudioConfirm(selected?.wrapperAnchorMeta);
  const sync = selected?.unitySync;

  return (
    <div className="page-enter space-y-6" data-testid="weapons-page">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Dual pistols</div>
          <h1>Weapons</h1>
          <p>
            Catalog and sync left/right pistol definitions. Imports never auto-equip. Frequency flip remains the fire
            gate. No rarity, shop, or unlock systems.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusBadgeVariant(w04Status)} data-testid="weapons-milestone-badge">
            {w04Status}
          </Badge>
          <Link to="/assets" className={cn(buttonVariants({ variant: "outline" }))}>
            Asset Library
          </Link>
        </div>
      </div>

      {error ? (
        <p className="error" role="alert" data-testid="weapons-error">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="ok" data-testid="weapons-message">
          {message}
        </p>
      ) : null}

      <Card data-testid="weapons-loadout-policy">
        <CardHeader>
          <CardTitle>Loadout policy</CardTitle>
          <CardDescription>
            Frequency-flip required:{" "}
            <strong data-testid="frequency-flip-required">
              {data?.loadout?.frequencyFlipRequired === false ? "No" : "Yes"}
            </strong>
            . Left: {data?.loadout?.leftWeaponId?.slice(0, 8) || "unassigned"} · Right:{" "}
            {data?.loadout?.rightWeaponId?.slice(0, 8) || "unassigned"}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {data?.loadout?.note ||
            "Catalog imports never auto-equip new weapon types. Frequency flip remains the gate."}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Catalog</CardTitle>
            <Button type="button" variant="outline" size="sm" onClick={startNew}>
              New
            </Button>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="weapons-catalog">
            {weapons.length === 0 ? (
              <p className="muted text-sm" data-testid="weapons-empty">
                No entries yet — create the dual pistols.
              </p>
            ) : (
              weapons.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  data-testid={`weapon-row-${w.role}`}
                  data-weapon-id={w.id}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${
                    selectedId === w.id ? "border-primary/50 bg-primary/10" : "border-white/10 bg-black/20"
                  }`}
                  onClick={() => selectWeapon(w)}
                >
                  <span>
                    {w.displayName}{" "}
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      {w.role === "left_pistol" ? "Left pistol" : "Right pistol"}
                    </Badge>
                  </span>
                  <span
                    className="text-muted-foreground"
                    data-testid="weapon-unity-sync-label"
                    title={UNITY_SYNC_STATUS_HELP}
                    aria-label={UNITY_SYNC_STATUS_HELP}
                  >
                    {unitySyncDisplayLabel(w.unitySync?.state)}
                  </span>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selectedId ? "Edit entry" : "New entry"}</CardTitle>
            <CardDescription>
              {dirty ? "Unsaved changes" : "Saved"} · Role{" "}
              <strong data-testid="weapons-role-display">
                {form.role === "right_pistol" ? "Right pistol" : "Left pistol"}
              </strong>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={saveWeapon} data-testid="weapons-form">
              <div className="space-y-1">
                <Label htmlFor="w-name">Display name</Label>
                <Input
                  id="w-name"
                  data-testid="weapon-name"
                  value={form.displayName}
                  onChange={(e) => setForm(normalizeForm({ ...form, displayName: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="w-role">Pistol role</Label>
                <select
                  id="w-role"
                  data-testid="weapon-role"
                  className="h-9 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm"
                  value={form.role}
                  onChange={(e) => setForm(normalizeForm({ ...form, role: e.target.value }))}
                >
                  <option value="left_pistol">Left pistol</option>
                  <option value="right_pistol">Right pistol</option>
                </select>
              </div>

              <div className="space-y-2 rounded-xl border border-white/10 p-3" data-testid="model-picker">
                <Label>Weapon viewport (Studio preview)</Label>
                <p className="text-xs text-muted-foreground">
                  Browser preview of the selected library mesh. Not Unity Play Mode proof. Search filters the full
                  model_3d collection (not ready-only).
                </p>
                <div className="flex gap-2">
                  <Input
                    data-testid="model-search"
                    value={modelQuery}
                    onChange={(e) => setModelQuery(e.target.value)}
                    placeholder="Search library…"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => refreshModels(modelQuery).catch((err) => setError(err.message))}
                  >
                    Search
                  </Button>
                </div>
                <select
                  data-testid="model-select"
                  className="h-9 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm"
                  value={form.modelAssetId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const entry = models.find((m) => m.id === nextId || m.modelAssetId === nextId);
                    if (nextId && entry && !entry.assignable) {
                      setError(entry.blockReason || "Model is not Unity-imported yet — Import to Unity first.");
                      return;
                    }
                    setError("");
                    setForm(normalizeForm({ ...form, modelAssetId: nextId }));
                  }}
                >
                  <option value="">No model</option>
                  {models
                    .filter((m) => m.assignable || m.id === form.modelAssetId)
                    .map((m) => (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={!m.assignable}
                        data-assignable={m.assignable ? "true" : "false"}
                        data-state={m.state}
                      >
                        {m.displayName || m.id} — {m.stateLabel || m.state} [{String(m.id).slice(0, 8)}]
                      </option>
                    ))}
                </select>
                <div
                  className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-white/10 p-2"
                  data-testid="weapon-model-library-list"
                >
                  {models.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No model_3d assets in the library yet.</p>
                  ) : (
                    models.map((m) => (
                      <div
                        key={m.id}
                        className="flex flex-wrap items-center gap-2 border-b border-white/5 py-2 text-xs last:border-0"
                        data-testid={`weapon-model-row-${m.id}`}
                        data-state={m.state}
                        data-assignable={m.assignable ? "true" : "false"}
                        data-model-asset-id={m.modelAssetId || m.id}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {m.displayName}{" "}
                          <span className="text-muted-foreground">
                            ({m.stateLabel || m.state} · id {String(m.id).slice(0, 8)})
                          </span>
                        </span>
                        {m.importInFlight ? (
                          <span className="text-[var(--glow)]" data-testid={`weapon-model-pending-${m.id}`}>
                            {m.blockReason || "Importing…"}
                          </span>
                        ) : null}
                        {m.state === "failed" && m.lastError ? (
                          <span className="text-[var(--glow)]" data-testid={`weapon-model-error-${m.id}`}>
                            {m.lastError}
                          </span>
                        ) : null}
                        {!m.assignable && !m.importInFlight && m.blockReason ? (
                          <span className="text-muted-foreground" title={m.blockReason}>
                            {m.blockReason}
                          </span>
                        ) : null}
                        {m.assignable ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid={`weapon-model-select-${m.id}`}
                            disabled={busy}
                            onClick={() => {
                              setError("");
                              setForm(normalizeForm({ ...form, modelAssetId: m.id }));
                            }}
                          >
                            Select
                          </Button>
                        ) : null}
                        {m.browserPreviewReady && !m.assignable ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            data-testid={`weapon-model-preview-${m.id}`}
                            onClick={() => {
                              setPreviewUrl(`/api/assets/${m.id}/model`);
                              setMessage(`Previewing ${m.displayName} (browser only — not assigned).`);
                            }}
                          >
                            Preview
                          </Button>
                        ) : null}
                        {m.canEnqueueImport ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid={`weapon-model-import-${m.id}`}
                            disabled={busy}
                            onClick={() => importModelToUnity(m.id, { retry: m.canRetryImport })}
                          >
                            {m.canRetryImport ? "Retry import" : "Import to Unity"}
                          </Button>
                        ) : null}
                        {m.state === "unsupported" || (!m.assignable && !m.canEnqueueImport && !m.importInFlight) ? (
                          <Link
                            to={`/assets/${m.id}`}
                            className="inline-flex h-8 items-center rounded-md border border-white/15 px-2"
                            data-testid={`weapon-model-open-${m.id}`}
                          >
                            Open asset
                          </Link>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
                {form.modelAssetId && previewUrl ? (
                  <Suspense fallback={<p className="muted text-xs">Loading preview…</p>}>
                    <div className="min-h-[280px] overflow-hidden rounded-xl border border-white/10" data-testid="model-preview">
                      <ModelViewer
                        url={previewUrl}
                        assetId={form.modelAssetId}
                        format={models.find((m) => m.id === form.modelAssetId)?.fileFormat || null}
                        fileName={
                          models.find((m) => m.id === form.modelAssetId)?.entrypointFileName ||
                          models.find((m) => m.id === form.modelAssetId)?.displayName ||
                          null
                        }
                        viewerApiRef={viewerApiRef}
                        onViewerReady={handleViewerReady}
                      />
                    </div>
                  </Suspense>
                ) : (
                  <div
                    className="flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/30 px-3 text-xs text-muted-foreground"
                    data-testid="model-preview-empty"
                  >
                    Select a Unity-imported model to assign, or Preview a browser-ready mesh above.
                  </div>
                )}
                <WeaponStudioFirePreview
                  form={form}
                  hasModel={Boolean(form.modelAssetId && previewUrl)}
                  viewerApiRef={viewerApiRef}
                  shotAudio={shotAudio}
                  viewerReadyEpoch={viewerReadyEpoch}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="w-dmg">Damage</Label>
                  <Input
                    id="w-dmg"
                    data-testid="weapon-damage"
                    type="number"
                    step="0.1"
                    value={form.damage}
                    onChange={(e) => setForm(normalizeForm({ ...form, damage: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="w-fire">Fire interval (s)</Label>
                  <Input
                    id="w-fire"
                    data-testid="weapon-fire"
                    type="number"
                    step="0.01"
                    value={form.fireIntervalSeconds}
                    onChange={(e) => setForm(normalizeForm({ ...form, fireIntervalSeconds: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="w-range">Range (m)</Label>
                  <Input
                    id="w-range"
                    data-testid="weapon-range"
                    type="number"
                    step="0.1"
                    value={form.rangeMeters}
                    onChange={(e) => setForm(normalizeForm({ ...form, rangeMeters: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="w-recoil">Recoil</Label>
                  <Input
                    id="w-recoil"
                    data-testid="weapon-recoil"
                    type="number"
                    step="0.01"
                    value={form.recoil}
                    onChange={(e) => setForm(normalizeForm({ ...form, recoil: e.target.value }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>Left hand anchor</Label>
                  <Input
                    data-testid="anchor-left"
                    value={form.leftHandAnchor}
                    onChange={(e) => setForm(normalizeForm({ ...form, leftHandAnchor: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Right hand anchor</Label>
                  <Input
                    data-testid="anchor-right"
                    value={form.rightHandAnchor}
                    onChange={(e) => setForm(normalizeForm({ ...form, rightHandAnchor: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Grip anchor</Label>
                  <Input
                    data-testid="anchor-grip"
                    value={form.gripAnchor}
                    onChange={(e) => setForm(normalizeForm({ ...form, gripAnchor: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Muzzle anchor</Label>
                  <Input
                    data-testid="anchor-muzzle"
                    value={form.muzzleAnchor}
                    onChange={(e) => setForm(normalizeForm({ ...form, muzzleAnchor: e.target.value }))}
                  />
                </div>
              </div>

              <div
                className="space-y-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs"
                data-testid="weapon-anchor-authoring"
              >
                <p className="font-medium text-foreground">Unity prefab anchors</p>
                <p className="text-muted-foreground">
                  Grip aligns the hand; Muzzle is flash/tracer origin and direction. Validity comes from the Unity
                  prefab hierarchy — not browser GLB names alone. Sync/deploy stay non-ready until both resolve.
                </p>
                {selected?.runtimeReadiness ? (
                  <dl className="grid gap-1" data-testid="weapon-runtime-readiness">
                    <div>model imported: {String(selected.runtimeReadiness.modelImported)}</div>
                    <div>definition synced: {String(selected.runtimeReadiness.definitionSynced)}</div>
                    <div>anchors valid: {String(selected.runtimeReadiness.anchorsValid)}</div>
                    <div>runtime deploy applied: {String(selected.runtimeReadiness.runtimeDeployApplied)}</div>
                    <div>runtime playable: {String(selected.runtimeReadiness.runtimePlayable)}</div>
                    {selected.runtimeModelPrefabPath ? (
                      <div data-testid="weapon-runtime-prefab-path">wrapper: {selected.runtimeModelPrefabPath}</div>
                    ) : null}
                  </dl>
                ) : null}
                {wrapNeedsConfirm ? (
                  <p
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-100"
                    data-testid="weapon-wrapper-confirm-required"
                  >
                    Confirmation required
                    {selected?.wrapperAnchorMeta?.recoveryReason === "missing_metadata"
                      ? " (legacy wrapper missing metadata). Confirm writes .anchors.json without overwriting Grip/Muzzle."
                      : ". Position Grip/Muzzle in Prefab Mode if needed, then Confirm before Sync/Deploy."}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!selectedId || anchorBusy}
                    data-testid="weapon-inspect-prefab"
                    onClick={async () => {
                      if (!selectedId) return;
                      setAnchorBusy(true);
                      setError("");
                      try {
                        const result = await api(`/api/weapons/${selectedId}/inspect-prefab-anchors`, {
                          method: "POST",
                          body: JSON.stringify({
                            gripAnchor: form.gripAnchor,
                            muzzleAnchor: form.muzzleAnchor,
                          }),
                        });
                        setPrefabInspect(result);
                        setMessage(
                          result.anchorsValid
                            ? "Unity prefab anchors valid."
                            : `Missing on Unity prefab: ${(result.missingAnchors || []).join(", ") || "unknown"}`,
                        );
                      } catch (err) {
                        setPrefabInspect(null);
                        setError(err.message || "Prefab inspect failed");
                      } finally {
                        setAnchorBusy(false);
                      }
                    }}
                  >
                    Inspect Unity prefab
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!selectedId || anchorBusy}
                    data-testid="weapon-create-anchor-wrapper"
                    onClick={async () => {
                      if (!selectedId) return;
                      setAnchorBusy(true);
                      setError("");
                      try {
                        const gripSource =
                          prefabInspect?.hierarchy?.includes?.("GripAttach") ? "GripAttach" : form.gripAnchor;
                        const muzzleSource =
                          prefabInspect?.hierarchy?.includes?.("MuzzlePoint") ? "MuzzlePoint" : form.muzzleAnchor;
                        const result = await api(`/api/weapons/${selectedId}/create-anchor-wrapper`, {
                          method: "POST",
                          body: JSON.stringify({
                            gripSourceNode: gripSource,
                            muzzleSourceNode: muzzleSource,
                            replaceExisting: false,
                          }),
                        });
                        await refresh();
                        if (result.weapon) selectWeapon(result.weapon);
                        setForm((prev) =>
                          normalizeForm({
                            ...prev,
                            gripAnchor: "Grip",
                            muzzleAnchor: "Muzzle",
                          }),
                        );
                        setMessage(
                          result.nextAction ||
                            `Wrapper at ${result.wrapperPrefabPath}. ${
                              result.needsConfirmation || result.anchorsProvisional
                                ? "Confirmation required — Sync/Deploy blocked until Confirm."
                                : result.idempotentReuse
                                  ? "Existing wrapper preserved."
                                  : "Sync to Unity next."
                            }`,
                        );
                        setPrefabInspect(result);
                      } catch (err) {
                        setError(err.message || "Wrapper creation failed");
                      } finally {
                        setAnchorBusy(false);
                      }
                    }}
                  >
                    Create managed Grip+Muzzle wrapper
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!selectedId || anchorBusy || !wrapNeedsConfirm}
                    data-testid="weapon-confirm-anchor-wrapper"
                    onClick={async () => {
                      if (!selectedId) return;
                      setAnchorBusy(true);
                      setError("");
                      try {
                        const result = await api(`/api/weapons/${selectedId}/confirm-anchor-wrapper`, {
                          method: "POST",
                          body: JSON.stringify({}),
                        });
                        await refresh();
                        if (result.weapon) selectWeapon(result.weapon);
                        setMessage(result.note || "Anchors confirmed. Sync to Unity next.");
                      } catch (err) {
                        setError(err.message || "Confirm failed");
                      } finally {
                        setAnchorBusy(false);
                      }
                    }}
                  >
                    Confirm wrapper anchors
                  </Button>
                </div>
                {prefabInspect?.hierarchy?.length ? (
                  <div className="space-y-1" data-testid="weapon-prefab-hierarchy">
                    <Label>Select existing transform for Grip</Label>
                    <select
                      className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1"
                      data-testid="weapon-pick-grip-node"
                      value={form.gripAnchor}
                      onChange={(e) => setForm(normalizeForm({ ...form, gripAnchor: e.target.value }))}
                    >
                      {[form.gripAnchor, ...prefabInspect.hierarchy]
                        .filter((v, i, a) => v && a.indexOf(v) === i)
                        .map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                    </select>
                    <Label>Select existing transform for Muzzle</Label>
                    <select
                      className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1"
                      data-testid="weapon-pick-muzzle-node"
                      value={form.muzzleAnchor}
                      onChange={(e) => setForm(normalizeForm({ ...form, muzzleAnchor: e.target.value }))}
                    >
                      {[form.muzzleAnchor, ...prefabInspect.hierarchy]
                        .filter((v, i, a) => v && a.indexOf(v) === i)
                        .map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground">
                      After picking names, Save then Sync. Or create a managed wrapper that adds Grip/Muzzle empties
                      without editing the imported source.
                    </p>
                  </div>
                ) : null}
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="weapon-enabled"
                  checked={form.enabled}
                  onChange={(e) => setForm(normalizeForm({ ...form, enabled: e.target.checked }))}
                />
                Enabled
              </label>
              <label className="flex items-center gap-2 text-sm font-medium text-[var(--glow)]">
                <input
                  type="checkbox"
                  data-testid="weapon-frequency-required"
                  checked={form.frequencyFlipRequired}
                  onChange={(e) => setForm(normalizeForm({ ...form, frequencyFlipRequired: e.target.checked }))}
                />
                Frequency-flip required to fire
              </label>

              <div
                className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs"
                data-testid="unity-sync-status"
              >
                Unity sync:{" "}
                <strong>{selectedId ? unitySyncDisplayLabel(sync?.state) : "none"}</strong>
                {sync?.assetGuid ? (
                  <div data-testid="unity-asset-guid">GUID {sync.assetGuid}</div>
                ) : null}
                {sync?.assetPath ? (
                  <div data-testid="unity-asset-path">{sync.assetPath}</div>
                ) : null}
                {sync?.lastError ? <div className="error">{sync.lastError}</div> : null}
              </div>

              <p className="text-xs opacity-70" data-testid="placeholder-content-note">
                Final pistol models are not bundled. Studio sync stays asset-driven via
                HertzWeaponDefinition. Test placeholders live only in HertzWeaponTest /
                TestAssets and are labelled PLACEHOLDER. Gunshot audio is optional and assigned
                later by the Sound section — firing works silently when unassigned.
              </p>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !dirty} data-testid="weapon-save">
                  {busy ? "Working…" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selectedId || busy || wrapNeedsConfirm}
                  data-testid="weapon-sync"
                  title={
                    wrapNeedsConfirm
                      ? "Confirm managed Grip/Muzzle wrapper before Sync"
                      : undefined
                  }
                  onClick={syncToUnity}
                >
                  Sync to Unity
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selectedId || busy}
                  data-testid="weapon-assign-loadout"
                  onClick={assignLoadout}
                >
                  Assign loadout
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selectedId || busy || removeBusy}
                  data-testid="weapon-remove"
                  onClick={() => openRemoveWorkflow()}
                >
                  Remove
                </Button>
              </div>
              <WeaponRemovePanel
                open={removeOpen}
                inspection={removeInspection}
                busy={removeBusy}
                onClose={() => {
                  setRemoveOpen(false);
                  setRemoveInspection(null);
                }}
                onRefresh={() => refreshRemoveInspection()}
                onAction={(action, opts) => runGuidedRemove(action, opts)}
              />
              <p className="text-xs text-muted-foreground" data-testid="weapon-sync-no-place-note">
                Sync to Unity writes HertzWeaponDefinition assets only — it does not place into scenes. Assign loadout
                updates Studio store only. Use Test / Deploy to bind the managed definition into DualPistolRuntime in
                one explicit scene (not a raw mesh place).
              </p>
            </form>
            <div className="mt-3">
              <CatalogSceneDeployPanel
                kind="weapon"
                catalogLabel="weapon definition"
                modelAssetId={form.modelAssetId || ""}
                weaponId={selectedId || ""}
                weaponVersion={selected?.version ?? null}
                disabled={busy || removeBusy || dirty || wrapNeedsConfirm}
                onMessage={setMessage}
                onError={setError}
                onDeployed={() => refresh().catch(() => {})}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
