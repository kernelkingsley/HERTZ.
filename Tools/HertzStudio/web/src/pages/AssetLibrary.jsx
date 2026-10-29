import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Upload, Package, RefreshCw, Box, Search, Eraser, ExternalLink } from "lucide-react";
import { api, apiForm } from "../api.js";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_PLACEMENT_TRANSFORM,
  UnityPlacementControls,
  buildPlacementBody,
} from "../components/UnityPlacementControls.jsx";
import {
  uploadFileChunked,
  resumeChunkedUpload,
  loadResumeMeta,
  clearResumeMeta,
  LIBRARY_DRAG_MIME,
  libraryDragPayload,
} from "../lib/chunkedUpload.js";
import {
  TYPE_OPTIONS,
  PROVIDER_OPTIONS,
  LICENSE_OPTIONS,
  STATE_OPTIONS,
  LIBRARY_SCOPE_NOTE,
  createEmptyFilters,
  buildAssetQuery,
  submitSearch,
  clearAllFilters,
  changePage,
  resolveListState,
  hasActiveFilters,
} from "./assetLibrarySearch.js";

function formatBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const selectClass =
  "h-9 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-foreground outline-none focus-visible:border-ring";

function Thumbnail({ asset }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!asset.preview?.url) {
      setSrc(null);
      return undefined;
    }
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (!cancelled) setSrc(asset.preview.url);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [asset.preview?.url]);

  if (asset.preview?.kind === "audio") {
    return <div className="grid h-28 place-items-center rounded-xl bg-white/5 text-xs text-muted-foreground">Audio</div>;
  }
  // Prefer validated local image still (Sketchfab/Kenney). Generic model placeholder only when no image.
  const isImagePreview =
    asset.preview?.kind === "image" ||
    (asset.preview?.url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(asset.preview.url));
  if (!isImagePreview && (asset.preview?.kind === "model" || asset.assetType === "model_3d")) {
    return (
      <div className="grid h-28 place-items-center rounded-xl bg-white/5 text-xs text-muted-foreground">
        <Box className="mb-1 size-5 opacity-70" />
        3D (on demand)
      </div>
    );
  }
  if (!src) {
    return <div className="grid h-28 place-items-center rounded-xl bg-white/5 text-xs text-muted-foreground">No preview</div>;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-28 w-full rounded-xl object-contain bg-black/30"
      style={asset.assetType === "pixel" ? { imageRendering: "pixelated" } : undefined}
    />
  );
}

function AssetDetailPreview({ asset }) {
  const [AudioComp, setAudioComp] = useState(null);
  useEffect(() => {
    if (asset?.assetType !== "audio") return undefined;
    let cancelled = false;
    import("../components/AudioPreview.jsx").then((m) => {
      if (!cancelled) setAudioComp(() => m.default);
    });
    return () => {
      cancelled = true;
    };
  }, [asset?.assetType, asset?.id]);

  if (!asset) return null;
  if (asset.assetType === "audio" && AudioComp) {
    return <AudioComp asset={asset} />;
  }
  if (asset.preview?.url) {
    return (
      <img
        src={asset.preview.url}
        alt={asset.displayName}
        className="max-h-48 rounded-xl object-contain"
        style={asset.assetType === "pixel" ? { imageRendering: "pixelated" } : undefined}
      />
    );
  }
  return <p className="muted text-sm">Preview unavailable for this type in the library list.</p>;
}

function FilterField({ id, label, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export default function AssetLibrary() {
  const formId = useId();
  const uploadRef = useRef(null);
  const kenneyRef = useRef(null);
  const navigate = useNavigate();
  const uploadAbortRef = useRef(null);
  const resumeRef = useRef(null);

  const [data, setData] = useState(null);
  const [kenney, setKenney] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);
  const [canResume, setCanResume] = useState(false);
  const [typeOverride, setTypeOverride] = useState("");
  const [selected, setSelected] = useState(null);
  const [scenes, setScenes] = useState([]);
  const [scenePath, setScenePath] = useState("");
  const [suggestedScenePath, setSuggestedScenePath] = useState("");
  const [unityOnline, setUnityOnline] = useState(false);
  const [placeTransform, setPlaceTransform] = useState(DEFAULT_PLACEMENT_TRANSFORM);

  useEffect(() => {
    let cancelled = false;
    async function loadScenes() {
      try {
        const res = await api("/api/unity/scenes");
        if (cancelled) return;
        const list = Array.isArray(res.scenes) ? res.scenes : [];
        setScenes(list);
        setUnityOnline(Boolean(res.unityConnected));
        const active =
          res.activeScenePath && list.some((s) => s.path === res.activeScenePath)
            ? res.activeScenePath
            : "";
        setSuggestedScenePath(active);
        setScenePath((prev) => (prev && list.some((s) => s.path === prev) ? prev : prev || ""));
      } catch {
        if (!cancelled) {
          setScenes([]);
          setUnityOnline(false);
          setSuggestedScenePath("");
        }
      }
    }
    loadScenes();
    const timer = setInterval(loadScenes, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const meta = loadResumeMeta();
    if (meta?.uploadId) {
      setCanResume(true);
      resumeRef.current = { file: null, uploadId: meta.uploadId, offset: meta.offset || 0, meta };
    }
  }, []);
  /** Form values — editing these does not hit the API until Search. */
  const [draft, setDraft] = useState(createEmptyFilters);
  /** Last submitted query — drives fetch + pagination. */
  const [applied, setApplied] = useState(createEmptyFilters);

  const fetchWith = useCallback(async (filters) => {
    const next = await api(`/api/assets?${buildAssetQuery(filters)}`);
    setData(next);
    return next;
  }, []);

  useEffect(() => {
    fetchWith(applied).catch((err) => setError(err.message));
  }, [applied, fetchWith]);

  useEffect(() => {
    api("/api/assets/kenney/info")
      .then(setKenney)
      .catch(() => {});
  }, []);

  function updateDraft(patch) {
    setDraft((f) => ({ ...f, ...patch }));
  }

  function onSearchSubmit(e) {
    e?.preventDefault?.();
    setError("");
    setApplied(submitSearch(draft));
  }

  async function onDeleteAsset(asset, ev) {
    ev?.stopPropagation?.();
    if (!asset?.id) return;
    const unityNote = asset.unity?.importedPath
      ? " The Unity Imported copy will be preserved and will not be deleted."
      : "";
    const ok = window.confirm(
      `Delete "${asset.displayName}" from the Asset Library?\n\nThis removes the catalog entry, private blobs, dependency files, preview, and queued import jobs.${unityNote}\n\nUnrelated assets are not touched.`,
    );
    if (!ok) return;
    setError("");
    try {
      const result = await api(`/api/assets/${asset.id}`, { method: "DELETE" });
      if (selected?.id === asset.id) setSelected(null);
      await fetchWith(applied);
      if (result.message) setError(""); // success — avoid sticky errors
      if (result.storageUsedBytes != null) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                storageUsedBytes: result.storageUsedBytes,
                assets: (prev.assets || []).filter((a) => a.id !== asset.id),
              }
            : prev,
        );
      }
    } catch (err) {
      setError(err.message || "Delete failed");
    }
  }

  function onClearFilters() {
    const empty = clearAllFilters();
    setDraft(empty);
    setApplied(empty);
    setError("");
    setMessage("");
  }

  function onPageChange(nextPage) {
    setApplied((prev) => changePage(prev, nextPage));
    setDraft((prev) => ({ ...prev, page: Math.max(1, nextPage) }));
  }

  async function onUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    setUploadPct(0);
    const ctrl = new AbortController();
    uploadAbortRef.current = ctrl;
    try {
      // ZIPs still use the single-shot safe extract route; other files use resumable chunks.
      if (/\.zip$/i.test(file.name)) {
        const fd = new FormData();
        fd.append("file", file);
        const result = await apiForm("/api/assets/upload", fd);
        setMessage(
          result.kind === "zip"
            ? `ZIP: ${result.created} created, ${result.skipped?.length || 0} skipped.`
            : `Uploaded ${result.asset?.displayName || "asset"}.`,
        );
      } else {
        const result = await uploadFileChunked(file, {
          signal: ctrl.signal,
          onProgress: (p) => setUploadPct(p.pct),
          assetTypeOverride: typeOverride || null,
        });
        setMessage(
          result.deduplicated
            ? "Duplicate content hash — existing asset reused."
            : `Uploaded ${result.asset?.displayName || file.name}.`,
        );
        setCanResume(false);
      }
      await fetchWith(applied);
    } catch (err) {
      if (err.code === "cancelled") {
        setMessage("Upload cancelled.");
        setCanResume(false);
        clearResumeMeta();
      } else {
        setError(err.message);
        if (err.uploadId != null) {
          resumeRef.current = { file, uploadId: err.uploadId, offset: err.offset || 0 };
          setCanResume(true);
          setMessage("Upload interrupted — reselect the same file and Retry/resume.");
        }
      }
    } finally {
      setBusy(false);
      setUploadPct(null);
      uploadAbortRef.current = null;
    }
  }

  function cancelUpload() {
    uploadAbortRef.current?.abort();
  }

  async function resumeUpload(e) {
    const fileFromPicker = e?.target?.files?.[0];
    if (e?.target) e.target.value = "";
    const pending = resumeRef.current;
    const meta = loadResumeMeta();
    const file = fileFromPicker || pending?.file;
    const uploadId = pending?.uploadId || meta?.uploadId;
    if (!uploadId) return;
    if (!file) {
      setMessage("Reselect the same file to resume the interrupted upload.");
      return;
    }
    if (meta && (file.name !== meta.fileName || file.size !== meta.byteSize)) {
      setError("Selected file does not match the interrupted upload (name/size). Clear resume or pick the original file.");
      return;
    }
    setBusy(true);
    setError("");
    const ctrl = new AbortController();
    uploadAbortRef.current = ctrl;
    try {
      const result = await resumeChunkedUpload(file, uploadId, pending?.offset ?? meta?.offset ?? 0, {
        signal: ctrl.signal,
        onProgress: (p) => setUploadPct(p.pct),
        assetTypeOverride: typeOverride || meta?.assetTypeOverride || null,
      });
      resumeRef.current = null;
      setCanResume(false);
      setMessage(`Resumed upload — ${result.asset?.displayName || file.name}.`);
      await fetchWith(applied);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setUploadPct(null);
      uploadAbortRef.current = null;
    }
  }

  async function onKenneyImport(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("packName", file.name.replace(/\.zip$/i, ""));
      const result = await apiForm("/api/assets/kenney/import", fd);
      setMessage(
        `Kenney ${result.category}: ${result.created} assets (${result.license}). Skipped ${result.skipped}.`,
      );
      await fetchWith(applied);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function confirmPersistentPlace(targetScenePath, transform) {
    return window.confirm(
      `Place this asset into Unity scene and save?\n\n${targetScenePath}\n\n` +
        `Position ${transform.position.x}, ${transform.position.y}, ${transform.position.z}\n` +
        `Rotation ${transform.rotation.x}, ${transform.rotation.y}, ${transform.rotation.z}\n` +
        `Scale ${transform.scale.x}, ${transform.scale.y}, ${transform.scale.z}\n\n` +
        "Unity will instantiate into that scene and save it. Unsaved Editor changes block the operation.",
    );
  }

  async function importToUnity(assetId) {
    let placementBody = null;
    try {
      if (scenePath) placementBody = buildPlacementBody({ assetId, scenePath, scenes, transform: placeTransform });
    } catch (err) {
      setError(err.message);
      return;
    }
    if (placementBody && !confirmPersistentPlace(scenePath, placementBody.placement)) return;
    setBusy(true);
    setError("");
    try {
      const body = JSON.stringify(placementBody || {});
      const result = await api(`/api/assets/${assetId}/import-unity`, {
        method: "POST",
        body,
      });
      setMessage(
        result.deduplicated
          ? "Import already queued (idempotent)."
          : unityOnline
            ? scenePath
              ? `Queued — import and place into ${scenePath}.`
              : "Queued for Unity — connector online; applying shortly."
            : "Queued for Unity — connector/Unity offline. Start connector + Unity bridge, then retry.",
      );
      await fetchWith(applied);
      if (selected?.id === assetId) {
        const refreshed = await api(`/api/assets/${assetId}`);
        setSelected(refreshed);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function placeSelectedInScene(assetId) {
    if (!scenePath) {
      setError("Choose a Unity scene first.");
      return;
    }
    let placementBody;
    try {
      placementBody = buildPlacementBody({ assetId, scenePath, scenes, transform: placeTransform });
    } catch (err) {
      setError(err.message);
      return;
    }
    if (!confirmPersistentPlace(scenePath, placementBody.placement)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/assets/${assetId}/place-in-scene`, {
        method: "POST",
        body: JSON.stringify(placementBody),
      });
      setMessage(
        result.deduplicated
          ? "Place already queued."
          : `Placing into ${scenePath}…`,
      );
      await fetchWith(applied);
      const refreshed = await api(`/api/assets/${assetId}`);
      setSelected(refreshed);
      if (refreshed.placeError) setError(refreshed.placeError);
      else if (refreshed.unity?.lastPlacedScene) {
        setMessage(`Placed in ${refreshed.unity.lastPlacedScene}.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const listState = resolveListState({ data, applied });
  const quotaPct = data
    ? Math.min(100, Math.round((100 * data.storageUsedBytes) / (data.storageQuotaBytes || 1)))
    : 0;
  const filtersDirty =
    JSON.stringify({ ...draft, page: 1 }) !== JSON.stringify({ ...applied, page: 1 });

  return (
    <div className="page-enter space-y-6" data-testid="asset-library-page">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Library</div>
          <h1>
            Typed assets with <span className="text-[var(--glow)]">provenance</span>.
          </h1>
          <p>
            Upload files or Kenney free packs. Previews stay separate from private source blobs. Unity import queues when
            the connector is offline. Packs are never bundled into the Studio frontend build.
          </p>
          <p className="mt-3 text-sm text-muted-foreground" data-testid="library-scope-note">
            {LIBRARY_SCOPE_NOTE}
          </p>
        </div>
        <div className="actions flex flex-wrap gap-2">
          <Button variant="outline" className="gap-2" disabled={busy} onClick={() => fetchWith(applied)} type="button">
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          <Link
            to="/find"
            data-testid="link-find-assets-header"
            className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
          >
            <ExternalLink className="size-4" />
            Search Sketchfab
          </Link>
          <select
            className={selectClass + " w-auto min-w-[9rem]"}
            value={typeOverride}
            onChange={(e) => setTypeOverride(e.target.value)}
            data-testid="upload-type-override"
            title="Optional type override for FBX model vs animation"
          >
            <option value="">Auto type</option>
            <option value="model_3d">Force model</option>
            <option value="animation">Force animation</option>
          </select>
          <Label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
            <Upload className="size-4" />
            Upload
            <input ref={uploadRef} type="file" className="hidden" onChange={onUpload} disabled={busy} />
          </Label>
          <Label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
            <Package className="size-4" />
            Kenney ZIP
            <input
              ref={kenneyRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={onKenneyImport}
              disabled={busy}
            />
          </Label>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="ok">{message}</p> : null}
      {data?.catalogRecovery?.recoveredAt || data?.catalogRecovery?.emptyReset ? (
        <p className="text-sm text-[var(--glow)]" data-testid="catalog-recovery-banner">
          Catalog recovery active
          {data.catalogRecovery.restoredFrom ? ` from ${data.catalogRecovery.restoredFrom}` : ""}
          {data.catalogRecovery.reason ? ` (${data.catalogRecovery.reason})` : ""}. Some recent writes may be missing.
        </p>
      ) : null}
      {uploadPct != null ? (
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="upload-progress">
          <span>Upload {uploadPct}%</span>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-primary" style={{ width: `${uploadPct}%` }} />
          </div>
          <Button type="button" size="sm" variant="outline" onClick={cancelUpload} data-testid="upload-cancel">
            Cancel
          </Button>
        </div>
      ) : null}
      {canResume ? (
        <Label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
          Retry / resume (reselect file)
          <input type="file" className="hidden" onChange={resumeUpload} disabled={busy} data-testid="upload-resume" />
        </Label>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Search imported assets</CardTitle>
          <CardDescription>
            Filter the local catalog only. Press Search (or Enter) to run — changing fields alone does not query.
            {kenney ? ` Kenney: ${kenney.categories?.join(", ")} (no API key).` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            id={formId}
            data-testid="asset-library-search-form"
            onSubmit={onSearchSubmit}
            className="space-y-4"
          >
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              <FilterField id={`${formId}-q`} label="Keywords">
                <Input
                  id={`${formId}-q`}
                  name="q"
                  value={draft.q}
                  onChange={(e) => updateDraft({ q: e.target.value })}
                  placeholder="Name, pack, author…"
                  autoComplete="off"
                />
              </FilterField>
              <FilterField id={`${formId}-type`} label="Type">
                <select
                  id={`${formId}-type`}
                  name="type"
                  className={selectClass}
                  value={draft.type}
                  onChange={(e) => updateDraft({ type: e.target.value })}
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t.value || "all-types"} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField id={`${formId}-provider`} label="Provider">
                <select
                  id={`${formId}-provider`}
                  name="provider"
                  className={selectClass}
                  value={draft.provider}
                  onChange={(e) => updateDraft({ provider: e.target.value })}
                >
                  {PROVIDER_OPTIONS.map((t) => (
                    <option key={t.value || "all-providers"} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField id={`${formId}-pack`} label="Pack name">
                <Input
                  id={`${formId}-pack`}
                  name="pack"
                  value={draft.pack}
                  onChange={(e) => updateDraft({ pack: e.target.value })}
                  placeholder="Optional pack name"
                  autoComplete="off"
                />
              </FilterField>
              <FilterField id={`${formId}-license`} label="License">
                <select
                  id={`${formId}-license`}
                  name="license"
                  className={selectClass}
                  value={draft.license}
                  onChange={(e) => updateDraft({ license: e.target.value })}
                >
                  {LICENSE_OPTIONS.map((t) => (
                    <option key={t.value || "all-licenses"} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField id={`${formId}-state`} label="Import state">
                <select
                  id={`${formId}-state`}
                  name="state"
                  className={selectClass}
                  value={draft.state}
                  onChange={(e) => updateDraft({ state: e.target.value })}
                >
                  {STATE_OPTIONS.map((t) => (
                    <option key={t.value || "all-states"} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FilterField>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" className="gap-2" disabled={busy} data-testid="search-button">
                <Search className="size-4" />
                Search
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={busy || (!hasActiveFilters(draft) && !hasActiveFilters(applied))}
                onClick={onClearFilters}
                data-testid="clear-filters-button"
              >
                <Eraser className="size-4" />
                Clear all filters
              </Button>
              <Link
                to="/find"
                data-testid="link-find-assets-filters"
                className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
              >
                <ExternalLink className="size-4" />
                Search Sketchfab / Find new assets
              </Link>
              {filtersDirty ? (
                <span className="text-xs text-muted-foreground" data-testid="filters-dirty-hint">
                  Filters changed — press Search to apply.
                </span>
              ) : null}
            </div>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span data-testid="storage-summary">
              Storage {formatBytes(data?.storageUsedBytes)} / {formatBytes(data?.storageQuotaBytes)} ({quotaPct}%)
            </span>
            <span data-testid="result-summary">
              {data?.total ?? 0} assets · page {data?.page ?? 1}/{data?.pageCount ?? 1}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-primary transition-all" style={{ width: `${quotaPct}%` }} />
          </div>
        </CardContent>
      </Card>

      {listState === "empty_library" ? (
        <Card data-testid="empty-library-state">
          <CardHeader>
            <CardTitle>No assets in this library yet</CardTitle>
            <CardDescription>
              Storage shows 0 B because nothing has been imported. Filters above only search the local catalog — they
              cannot find Sketchfab or Kenney packs until you add them here.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="gap-2"
              disabled={busy}
              onClick={() => uploadRef.current?.click()}
              data-testid="empty-upload"
            >
              <Upload className="size-4" />
              Upload
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={busy}
              onClick={() => kenneyRef.current?.click()}
              data-testid="empty-kenney"
            >
              <Package className="size-4" />
              Import Kenney ZIP
            </Button>
            <Link
              to="/find"
              data-testid="empty-sketchfab"
              className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
            >
              <ExternalLink className="size-4" />
              Search Sketchfab
            </Link>
            {hasActiveFilters(draft) || hasActiveFilters(applied) ? (
              <Button type="button" variant="ghost" onClick={onClearFilters} data-testid="empty-clear-filters">
                Clear all filters
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {listState === "no_matches" ? (
        <Card data-testid="no-matches-state">
          <CardHeader>
            <CardTitle>No assets match these filters</CardTitle>
            <CardDescription>
              The library has stored assets, but none match the current search. Clear filters or broaden the query.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" className="gap-2" onClick={onClearFilters} data-testid="no-matches-clear">
              <Eraser className="size-4" />
              Clear filters
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {listState === "results" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="asset-grid">
            {(data?.assets || []).map((asset) => (
              <Card
                key={asset.id}
                draggable
                data-testid="library-asset-card"
                className={`cursor-grab transition hover:border-white/20 ${selected?.id === asset.id ? "border-primary/50" : ""}`}
                onClick={() => {
                  setSelected(asset);
                  navigate(`/assets/${asset.id}/view`);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData(LIBRARY_DRAG_MIME, libraryDragPayload(asset));
                  e.dataTransfer.setData("text/plain", asset.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <CardContent className="space-y-3 pt-4">
                  <Thumbnail asset={asset} />
                  <div className="space-y-1">
                    <div className="truncate font-medium">{asset.displayName}</div>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className="rounded-full text-[10px]">
                        {asset.assetType}
                      </Badge>
                      <Badge variant="outline" className="rounded-full text-[10px]">
                        {asset.provider}
                      </Badge>
                      <Badge variant="outline" className="rounded-full text-[10px] text-[var(--glow)]">
                        {asset.stateLabel}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {asset.license}
                      {asset.packName ? ` · ${asset.packName}` : ""} · {formatBytes(asset.byteSize)}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      data-testid="delete-asset-card"
                      onClick={(e) => onDeleteAsset(asset, e)}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="flex justify-center gap-2">
            <Button
              variant="outline"
              type="button"
              disabled={!data || data.page <= 1}
              onClick={() => onPageChange(data.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              type="button"
              disabled={!data || data.page >= data.pageCount}
              onClick={() => onPageChange(data.page + 1)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{selected.displayName}</CardTitle>
            <CardDescription>
              {selected.author || "Unknown author"} · {selected.sourceUrl || "no source URL"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div className="space-y-2 text-sm">
              <AssetDetailPreview asset={selected} />
              <p>{selected.description || "No description."}</p>
              <p className="muted">
                Hash {selected.contentHash?.slice(0, 12)}… · format .{selected.fileFormat} · Unity{" "}
                {selected.unity?.readiness}
                {selected.unity?.prefabPath ? ` · ${selected.unity.prefabPath}` : ""}
              </p>
              <div className="text-xs text-muted-foreground" data-testid="library-placed-scenes">
                <p className="font-medium text-foreground">Scenes placed into</p>
                {(selected.unity?.placedScenes || []).length ? (
                  <ul className="mt-1 list-inside list-disc">
                    {selected.unity.placedScenes.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1">
                    None yet. “Unity imported” is the project prefab only — choose a scene and Place in scene to
                    add it to the Hierarchy.
                  </p>
                )}
                {selected.placeError ? (
                  <p className="mt-1 text-[var(--glow)]">Last place error: {selected.placeError}</p>
                ) : null}
              </div>
              {selected.importError ? <p className="error">{selected.importError}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="library-unity-scene" className="text-xs text-muted-foreground">
                Unity scene (explicit choice)
              </Label>
              <select
                id="library-unity-scene"
                className={selectClass}
                value={scenePath}
                onChange={(e) => setScenePath(e.target.value)}
                disabled={busy || scenes.length === 0}
                data-testid="library-unity-scene-select"
              >
                <option value="">
                  {scenes.length === 0
                    ? unityOnline
                      ? "Waiting for scenes…"
                      : "Connect Unity"
                    : "Choose a scene…"}
                </option>
                {scenes.map((s) => (
                  <option key={s.path} value={s.path}>
                    {s.name || s.path} — {s.path}
                  </option>
                ))}
              </select>
              {suggestedScenePath ? (
                <p className="text-xs text-muted-foreground">
                  Active suggestion: {suggestedScenePath}{" "}
                  <button type="button" className="underline" disabled={busy} onClick={() => setScenePath(suggestedScenePath)}>
                    Use
                  </button>
                </p>
              ) : null}
              {scenePath ? <p className="text-xs text-amber-200/90">Will save into: {scenePath}</p> : null}
              <UnityPlacementControls value={placeTransform} onChange={setPlaceTransform} disabled={busy} />
              {selected.state === "unity_imported" || selected.unity?.readiness === "ready" ? (
                <>
                  <Button type="button" variant="secondary" disabled>
                    Imported to Unity
                  </Button>
                  <Button
                    disabled={busy || selected.state === "unsupported" || !scenePath}
                    onClick={() => placeSelectedInScene(selected.id)}
                  >
                    Place in scene
                  </Button>
                </>
              ) : (
                <Button
                  disabled={
                    busy ||
                    selected.state === "unsupported" ||
                    selected.state === "pending_unity" ||
                    selected.state === "importing_unity"
                  }
                  onClick={() => importToUnity(selected.id)}
                >
                  {selected.state === "pending_unity" || selected.state === "importing_unity"
                    ? "Importing…"
                    : scenePath
                      ? "Import & place in scene"
                      : "Import to Unity"}
                </Button>
              )}
              <Button variant="outline" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
