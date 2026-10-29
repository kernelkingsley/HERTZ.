import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, ExternalLink, Package } from "lucide-react";
import { api, apiForm } from "../api.js";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_PLACEMENT_TRANSFORM,
  UnityPlacementControls,
  buildPlacementBody,
} from "../components/UnityPlacementControls.jsx";

const SketchfabEmbed = lazy(() => import("../components/SketchfabEmbed.jsx"));
const ImageLightbox = lazy(() => import("../components/ImageLightbox.jsx"));

function formatBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function MetaRow({ label, value, testId }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-white/5 py-2 text-sm" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value ?? "Unknown"}</span>
    </div>
  );
}

export default function AssetDetail({ mode }) {
  const params = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ModelViewer, setModelViewer] = useState(null);
  const [AudioComp, setAudioComp] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [scenes, setScenes] = useState([]);
  /** Empty until the user explicitly picks a scene this session — never auto SampleScene. */
  const [scenePath, setScenePath] = useState("");
  const [suggestedScenePath, setSuggestedScenePath] = useState("");
  const [unityOnline, setUnityOnline] = useState(false);
  const [placeTransform, setPlaceTransform] = useState(DEFAULT_PLACEMENT_TRANSFORM);

  const isKenney = mode === "kenney";
  const isSketchfab = mode === "sketchfab";
  const isLibrary = mode === "library";
  const alreadyImported =
    data?.state === "unity_imported" || data?.unity?.readiness === "ready";
  const importPending =
    data?.state === "pending_unity" || data?.state === "importing_unity";

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    const path = isKenney
      ? `/api/find/kenney/${encodeURIComponent(params.id)}`
      : isSketchfab
        ? `/api/find/sketchfab/${encodeURIComponent(params.uid)}`
        : `/api/assets/${encodeURIComponent(params.id)}`;
    api(path)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isKenney, isSketchfab, isLibrary, params.id, params.uid]);

  useEffect(() => {
    if (!isLibrary) return undefined;
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
        // Keep prior explicit user choice if still valid; otherwise stay empty.
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
  }, [isLibrary]);

  const assetType = data?.assetType || (data?.category === "3D" || data?.provider === "sketchfab" ? "model_3d" : null);
  const isModel =
    assetType === "model_3d" ||
    /\.(glb|gltf)$/i.test(data?.fileFormat || "") ||
    (isSketchfab && !isKenney);

  useEffect(() => {
    // Three.js ModelViewer only for library-owned blobs — never on Find/provider routes.
    if (!isLibrary || !isModel || !data?.id) return undefined;
    let cancelled = false;
    import("../components/ModelViewer.jsx").then((m) => {
      if (!cancelled) setModelViewer(() => m.default);
    });
    return () => {
      cancelled = true;
      setModelViewer(null);
    };
  }, [isLibrary, isModel, data?.id]);

  useEffect(() => {
    if (!isLibrary || data?.assetType !== "audio") return undefined;
    let cancelled = false;
    import("../components/AudioPreview.jsx").then((m) => {
      if (!cancelled) setAudioComp(() => m.default);
    });
    return () => {
      cancelled = true;
      setAudioComp(null);
    };
  }, [isLibrary, data?.assetType, data?.id]);

  const modelUrl = useMemo(() => {
    if (!isLibrary || !data?.id) return null;
    const fmt = String(data.fileFormat || "").toLowerCase().replace(/^\./, "");
    // GLB/GLTF/FBX all stream from the owner /model route (FBXLoader + GLTFLoader).
    if (fmt === "glb" || fmt === "gltf" || fmt === "fbx") {
      return `/api/assets/${data.id}/model`;
    }
    return data.preview?.url || null;
  }, [isLibrary, data]);

  async function importSketchfab() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await api("/api/assets/sketchfab/download", {
        method: "POST",
        body: JSON.stringify({ uid: params.uid }),
      });
      setMessage(
        res.deduplicated
          ? "Already in library (content hash)."
          : `Imported ${res.asset?.displayName}. Open library view for inspected metadata.`,
      );
      if (res.asset?.id) navigate(`/assets/${res.asset.id}/view`);
    } catch (err) {
      setError(err.message || "Import failed");
      // Failed import must not navigate or leave optimistic UI state.
    } finally {
      setBusy(false);
    }
  }

  async function importKenneyZip(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("packName", data?.name || file.name.replace(/\.zip$/i, ""));
      const result = await apiForm("/api/assets/kenney/import", fd);
      setMessage(`Kenney import: ${result.created} assets (${result.license}).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function pollAssetUntilSettled(assetId, { expectPlace = false, priorPlacedAt = null } = {}) {
    let refreshed = await api(`/api/assets/${assetId}`);
    for (let i = 0; i < 20; i += 1) {
      const pending =
        refreshed?.state === "pending_unity" || refreshed?.state === "importing_unity";
      const placeDone =
        !expectPlace ||
        Boolean(refreshed?.placeError) ||
        (refreshed?.unity?.lastPlacedAt && refreshed.unity.lastPlacedAt !== priorPlacedAt);
      if (!pending && placeDone) break;
      await new Promise((r) => setTimeout(r, 750));
      refreshed = await api(`/api/assets/${assetId}`);
    }
    return refreshed;
  }

  function confirmPersistentPlace(targetScenePath, transform) {
    const sceneLabel = targetScenePath;
    return window.confirm(
      `Place this asset into Unity scene and save?\n\n${sceneLabel}\n\n` +
        `Position ${transform.position.x}, ${transform.position.y}, ${transform.position.z}\n` +
        `Rotation ${transform.rotation.x}, ${transform.rotation.y}, ${transform.rotation.z}\n` +
        `Scale ${transform.scale.x}, ${transform.scale.y}, ${transform.scale.z}\n\n` +
        "Unity will instantiate the imported prefab/model into that scene and save the scene file. " +
        "Unsaved Editor changes in other open scenes will block the operation — save or discard them in Unity first.",
    );
  }

  async function importUnity() {
    if (!data?.id) return;
    if (alreadyImported) return;
    let placementBody = null;
    try {
      if (scenePath) placementBody = buildPlacementBody({ assetId: data.id, scenePath, scenes, transform: placeTransform });
    } catch (err) {
      setError(err.message);
      return;
    }
    if (placementBody && !confirmPersistentPlace(scenePath, placementBody.placement)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const body = JSON.stringify(placementBody || {});
      const result = await api(`/api/assets/${data.id}/import-unity`, { method: "POST", body });
      setMessage(
        result.deduplicated
          ? "Import already queued."
          : unityOnline
            ? scenePath
              ? `Queued for Unity — will import and place into ${scenePath}.`
              : "Queued for Unity — connector is online; import should apply shortly."
            : "Queued for Unity — connector/Unity looks offline. Start the connector (`npm run start:connector` in Tools/HertzStudio) and ensure the Unity bridge is healthy, then wait or re-click Import.",
      );
      const priorPlacedAt = data.unity?.lastPlacedAt || null;
      const refreshed = await pollAssetUntilSettled(data.id, {
        expectPlace: Boolean(scenePath),
        priorPlacedAt,
      });
      setData(refreshed);
      if (refreshed?.placeError) {
        setError(refreshed.placeError);
      }
      if (refreshed?.state === "unity_imported" || refreshed?.unity?.readiness === "ready") {
        const placed =
          refreshed.unity?.lastPlacedAt !== priorPlacedAt ? refreshed.unity?.lastPlacedScene : null;
        setMessage(
          placed
            ? `Imported and placed in ${placed}.`
            : `Imported to Unity: ${refreshed.unity?.importedPath || refreshed.unity?.prefabPath || "ready"}.`,
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function placeInScene() {
    if (!data?.id || !scenePath) return;
    let placementBody;
    try {
      placementBody = buildPlacementBody({ assetId: data.id, scenePath, scenes, transform: placeTransform });
    } catch (err) {
      setError(err.message);
      return;
    }
    if (!confirmPersistentPlace(scenePath, placementBody.placement)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api(`/api/assets/${data.id}/place-in-scene`, {
        method: "POST",
        body: JSON.stringify(placementBody),
      });
      setMessage(
        result.deduplicated
          ? "Place already queued."
          : unityOnline
            ? `Placing into ${scenePath}…`
            : "Queued place — connector/Unity looks offline. Start connector + Unity, then wait.",
      );
      const priorPlacedAt = data.unity?.lastPlacedAt || null;
      const refreshed = await pollAssetUntilSettled(data.id, {
        expectPlace: true,
        priorPlacedAt,
      });
      setData(refreshed);
      if (refreshed?.placeError) {
        setError(refreshed.placeError);
      } else if (refreshed?.unity?.lastPlacedScene) {
        setMessage(`Placed in ${refreshed.unity.lastPlacedScene}.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteFromLibrary() {
    if (!data?.id) return;
    const unityNote = data.unity?.importedPath
      ? " The Unity Imported copy will be preserved and will not be deleted."
      : "";
    const ok = window.confirm(
      `Delete "${data.displayName || data.name}" from the Asset Library?\n\nThis removes the catalog entry, private blobs, dependencies, preview, and queued jobs.${unityNote}`,
    );
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/assets/${data.id}`, { method: "DELETE" });
      setMessage(result.message || "Deleted from library.");
      navigate("/assets");
    } catch (err) {
      setError(err.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const title = data?.name || data?.displayName || params.id || params.uid || "Asset";
  const sourceUrl = data?.sourceUrl || data?.openOnKenney || data?.actions?.openOnKenney || null;
  const providerReported = {
    dimensions: data?.providerDimensions ?? data?.geometry?.dimensions ?? "Unknown",
    triangles: data?.providerTriangles ?? data?.faceCount ?? data?.geometry?.faceCount ?? "Unknown",
    vertices: data?.providerVertices ?? data?.vertexCount ?? data?.geometry?.vertexCount ?? "Unknown",
    rigged: data?.providerRigged ?? data?.isRigged ?? "Unknown",
    animations: data?.providerAnimations ?? data?.animationCount ?? "Unknown",
  };
  const thumbSrc = data?.thumbnailUrl || data?.thumbnails || data?.preview?.url || null;

  return (
    <div className="page-enter space-y-6" data-testid="asset-detail-page">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4" />
          Back to results
        </Button>
        <Link to="/find" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          Find Assets
        </Link>
        <Link to="/assets" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          Asset Library
        </Link>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="ok">{message}</p> : null}
      {busy && !data ? <p className="text-sm text-muted-foreground">Loading details…</p> : null}

      {data ? (
        <>
          <div className="page-head">
            <div>
              <div className="eyebrow mb-3">{data.provider || mode}</div>
              <h1>{title}</h1>
              <p>{data.description || data.note || data.message || "Provider and library metadata."}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                <Badge variant="outline">{data.provider || mode}</Badge>
                {data.kind === "library" || isLibrary ? (
                  <Badge data-testid="detail-import-state">{data.stateLabel || data.state || "In library"}</Badge>
                ) : (
                  <Badge variant="outline" data-testid="detail-pending-import">
                    Not imported yet
                  </Badge>
                )}
                {data.license ? <Badge variant="outline">{data.license}</Badge> : null}
                {data.category ? <Badge variant="outline">{data.category}</Badge> : null}
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Preview</CardTitle>
                <CardDescription>
                  {isModel && isLibrary
                    ? "3D engine loads only on this details route."
                    : isKenney
                      ? "Kenney discovery — open the official pack page or import a downloaded ZIP."
                      : isSketchfab && !isLibrary
                        ? "Official Sketchfab embed loads on demand before Import to Library."
                        : "Type-appropriate preview."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isSketchfab && !isLibrary ? (
                  <Suspense fallback={<p className="text-sm text-muted-foreground">Loading Sketchfab preview…</p>}>
                    <SketchfabEmbed
                      uid={params.uid || data.uid}
                      fallbackThumb={thumbSrc}
                      fallbackMessage={data.embedUnavailableMessage || null}
                    />
                  </Suspense>
                ) : null}
                {isLibrary && isModel && ModelViewer && modelUrl ? (
                  <ModelViewer
                    url={modelUrl}
                    assetId={data.id}
                    format={data.fileFormat || null}
                    fileName={data.entrypointFileName || data.originalName || null}
                  />
                ) : null}
                {isLibrary && data.assetType === "audio" && AudioComp ? <AudioComp asset={data} /> : null}
                {isLibrary &&
                data.preview?.url &&
                ["sprite", "image_2d", "ui", "pixel", "texture"].includes(data.assetType) ? (
                  <button
                    type="button"
                    className="block w-full"
                    onClick={() => setLightbox({ src: data.preview.url, alt: title, originalUrl: data.preview.url })}
                  >
                    <img
                      src={data.preview.url}
                      alt={title}
                      loading="lazy"
                      className="max-h-96 w-full rounded-2xl object-contain bg-black/30"
                      style={data.assetType === "pixel" ? { imageRendering: "pixelated" } : undefined}
                      data-testid="image-preview"
                    />
                  </button>
                ) : null}
                {!isLibrary && !isSketchfab && thumbSrc ? (
                  <button
                    type="button"
                    className="block w-full"
                    data-testid="provider-image-open"
                    onClick={() =>
                      setLightbox({
                        src: thumbSrc,
                        alt: title,
                        originalUrl: data.sourceUrl && /^https?:/i.test(data.sourceUrl) ? thumbSrc : thumbSrc,
                      })
                    }
                  >
                    <img
                      src={thumbSrc}
                      alt=""
                      loading="lazy"
                      className="max-h-80 w-full rounded-2xl object-contain bg-black/30"
                      data-testid="provider-image"
                    />
                  </button>
                ) : null}
                {isKenney ? (
                  <p className="text-sm text-muted-foreground" data-testid="kenney-no-direct-download">
                    Direct download URL: not verified — use Open on Kenney or Import downloaded ZIP. Never invented.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Metadata</CardTitle>
                <CardDescription>
                  Provider-reported values stay Unknown until verified. Inspected values appear after library parse /
                  viewer load.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                <MetaRow label="Name" value={title} />
                <MetaRow label="Provider" value={data.provider || mode} />
                <MetaRow label="Author" value={data.author || "Unknown"} />
                <MetaRow label="Source" value={sourceUrl || "Unknown"} />
                <MetaRow label="License" value={data.license || "Unknown"} />
                <MetaRow label="Attribution" value={data.author || data.license || "Unknown"} />
                <MetaRow label="File size" value={data.byteSize != null ? formatBytes(data.byteSize) : "Unknown"} />
                <MetaRow label="Format" value={data.fileFormat || data.category || "Unknown"} />
                <MetaRow label="Provider dimensions" value={String(providerReported.dimensions)} testId="provider-dimensions" />
                <MetaRow label="Provider triangles" value={String(providerReported.triangles)} />
                <MetaRow label="Provider vertices" value={String(providerReported.vertices)} />
                <MetaRow label="Provider rigged" value={String(providerReported.rigged)} testId="provider-rigged" />
                <MetaRow label="Provider animations" value={String(providerReported.animations)} />
                <MetaRow label="Unity readiness" value={data.unity?.readiness || "Unknown"} />
                <MetaRow label="Import state" value={data.stateLabel || data.state || (isLibrary ? "In library" : "Pending")} />
                <MetaRow
                  label="Project import path"
                  value={data.unity?.prefabPath || data.unity?.importedPath || "Not imported to project yet"}
                  testId="detail-import-path"
                />
                <MetaRow
                  label="Last placed scene"
                  value={data.unity?.lastPlacedScene || "Not placed in any scene yet"}
                  testId="detail-last-placed"
                />
                <div className="pt-1 text-sm" data-testid="detail-placed-scenes">
                  <div className="text-muted-foreground">Scenes placed into</div>
                  {(data.unity?.placedScenes || []).length ? (
                    <ul className="mt-1 list-inside list-disc text-xs">
                      {data.unity.placedScenes.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      None yet — Unity imported means the prefab exists under Assets, not that it is in a scene.
                      Use Place in scene below.
                    </p>
                  )}
                </div>
                {data.placeError ? (
                  <p className="text-xs text-[var(--glow)]" data-testid="detail-place-error">
                    Last place error: {data.placeError}
                  </p>
                ) : null}
                {(data.unity?.dependencies || []).length ? (
                  <div className="pt-2 text-sm">
                    <div className="text-muted-foreground">Dependencies</div>
                    <ul className="mt-1 list-inside list-disc text-xs">
                      {data.unity.dependencies.map((d) => (
                        <li key={d.blobName || d.relativePath}>{d.relativePath}</li>
                      ))}
                    </ul>
                  </div>
                ) : isLibrary && isModel ? (
                  <MetaRow label="Dependencies" value="None recorded" />
                ) : null}
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap gap-2">
            {isKenney ? (
              <>
                <a
                  href={sourceUrl || "#"}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonVariants(), "gap-2")}
                  data-testid="open-on-kenney"
                >
                  <ExternalLink className="size-4" />
                  Open on Kenney
                </a>
                <Label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm hover:bg-white/10">
                  <Package className="size-4" />
                  Import downloaded ZIP
                  <input type="file" accept=".zip" className="hidden" disabled={busy} onChange={importKenneyZip} />
                </Label>
              </>
            ) : null}
            {isSketchfab && !isLibrary ? (
              <Button type="button" className="gap-2" disabled={busy} onClick={importSketchfab} data-testid="import-sketchfab">
                <Download className="size-4" />
                Import to Library
              </Button>
            ) : null}
            {isLibrary ? (
              <>
                <div className="flex w-full flex-col gap-2 sm:max-w-md">
                  <Label htmlFor="unity-scene-select" className="text-sm text-muted-foreground">
                    Place into Unity scene (explicit choice required)
                  </Label>
                  <select
                    id="unity-scene-select"
                    className="h-10 w-full rounded-md border border-white/10 bg-black/40 px-3 text-sm"
                    value={scenePath}
                    onChange={(e) => setScenePath(e.target.value)}
                    disabled={busy || scenes.length === 0}
                    data-testid="unity-scene-select"
                  >
                    <option value="">
                      {scenes.length === 0
                        ? unityOnline
                          ? "Waiting for scene list…"
                          : "Connect Unity to list scenes"
                        : "Choose a scene…"}
                    </option>
                    {scenes.map((s) => (
                      <option key={s.path} value={s.path}>
                        {s.name || s.path} — {s.path}
                      </option>
                    ))}
                  </select>
                  {suggestedScenePath ? (
                    <p className="text-xs text-muted-foreground" data-testid="suggested-active-scene">
                      Active in Unity (suggestion only): {suggestedScenePath}.{" "}
                      <button
                        type="button"
                        className="underline"
                        disabled={busy}
                        onClick={() => setScenePath(suggestedScenePath)}
                      >
                        Use this scene
                      </button>
                    </p>
                  ) : null}
                  {scenePath ? (
                    <p className="text-xs text-amber-200/90" data-testid="place-consequence">
                      Will instantiate into and save: {scenePath}
                    </p>
                  ) : null}
                  <UnityPlacementControls value={placeTransform} onChange={setPlaceTransform} disabled={busy} />
                  {data.placeStatus ? (
                    <p className="text-xs text-muted-foreground" data-testid="place-status">
                      Place status: {data.placeStatus}
                      {data.placeError ? ` — ${data.placeError}` : ""}
                    </p>
                  ) : null}
                </div>
                {alreadyImported ? (
                  <>
                    <Button type="button" variant="secondary" disabled data-testid="import-unity-done">
                      Imported to Unity
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || data.state === "unsupported" || !scenePath}
                      onClick={placeInScene}
                      data-testid="place-in-scene"
                    >
                      Place in scene
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    disabled={busy || data.state === "unsupported" || importPending}
                    onClick={importUnity}
                    data-testid="import-unity"
                  >
                    {importPending
                      ? "Importing…"
                      : scenePath
                        ? "Import & place in scene"
                        : "Import to Unity"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={deleteFromLibrary}
                  data-testid="delete-asset-detail"
                >
                  Delete from library
                </Button>
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
                  >
                    <ExternalLink className="size-4" />
                    Open source
                  </a>
                ) : null}
              </>
            ) : null}
          </div>
          {lightbox ? (
            <Suspense fallback={null}>
              <ImageLightbox
                open
                src={lightbox.src}
                alt={lightbox.alt}
                originalUrl={lightbox.originalUrl}
                onClose={() => setLightbox(null)}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
