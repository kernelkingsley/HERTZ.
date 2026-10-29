import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useStudioTargetScene } from "../context/StudioTargetSceneContext.jsx";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Materials() {
  const status = getMilestoneStatus("W08");
  const { targetScene, refresh: refreshScenes } = useStudioTargetScene();
  const [type, setType] = useState("textures");
  const [q, setQ] = useState("");
  const [discovery, setDiscovery] = useState([]);
  const [library, setLibrary] = useState([]);
  const [board, setBoard] = useState(null);
  const [targets, setTargets] = useState([]);
  const [targetObjectId, setTargetObjectId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const target = useMemo(
    () => targets.find((entry) => entry.objectId === targetObjectId) || null,
    [targets, targetObjectId],
  );
  const selectedAsset = library.find((entry) => entry.id === assetId) || null;

  const refresh = useCallback(async () => {
    if (!targetScene?.available) {
      setTargets([]);
      setBoard(null);
      return;
    }
    const [mats, sceneTargets, assets] = await Promise.all([
      api("/api/materials"),
      api("/api/materials/targets"),
      api("/api/assets?state=unity_imported&page=1&pageSize=200"),
    ]);
    const usable = (assets.assets || []).filter((entry) => ["texture", "material", "image_2d"].includes(entry.assetType));
    setBoard(mats);
    setTargets(sceneTargets.targets || []);
    setLibrary(usable);
    setTargetObjectId((current) =>
      (sceneTargets.targets || []).some((entry) => entry.objectId === current)
        ? current
        : sceneTargets.targets?.[0]?.objectId || "",
    );
    setAssetId((current) => (usable.some((entry) => entry.id === current) ? current : usable[0]?.id || ""));
  }, [targetScene?.sceneGuid, targetScene?.available]);

  useEffect(() => {
    refresh().catch((err) => setError(String(err.message || err)));
  }, [refresh]);

  async function browse() {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/polyhaven/assets?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`);
      setDiscovery(result.assets || []);
      setMessage("Poly Haven metadata refreshed. Import an asset before applying it in Unity.");
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function importDiscovery(entry) {
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/polyhaven/import", {
        method: "POST",
        body: JSON.stringify({ assetId: entry.id, type: entry.type || type, resolution: entry.resolutions?.[0] || "1k" }),
      });
      setMessage(`Import ${result.record?.status || "started"}. It becomes selectable after Unity import finishes.`);
      await refresh();
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function applySurface() {
    if (!targetScene?.available || !target || !selectedAsset) {
      setError("Choose a target scene, a Renderer/Terrain, and a Unity-imported material or texture.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const inspect = await api("/api/materials/inspect", {
        method: "POST",
        body: JSON.stringify({ scenePath: targetScene.scenePath, sceneGuid: targetScene.sceneGuid, targetObjectId, materialSlot: 0 }),
      });
      const assignment = await api("/api/materials/assign", {
        method: "POST",
        body: JSON.stringify({
          scenePath: targetScene.scenePath,
          sceneGuid: targetScene.sceneGuid,
          targetKind: target.kind,
          targetObjectId,
          materialSlot: 0,
          assetId,
          expectedUnityRevision: inspect.unityRevision,
          expectedDependencyVersion: inspect.dependencyVersion,
          sharedMaterial: inspect.sharedMaterial,
          confirmSharedEdit: false,
          tilingX: 1,
          tilingY: 1,
          smoothness: 0.45,
        }),
      });
      await Promise.all([refresh(), refreshScenes()]);
      setMessage(`Applied ${selectedAsset.displayName} to ${target.hierarchyPath} at Unity revision ${assignment.unityRevision}.`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    const latest = [...(board?.assignments || [])].reverse().find((entry) => entry.operationId && !entry.undone);
    if (!latest) {
      setError("There is no applied material operation to undo for this scene.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/materials/undo", {
        method: "POST",
        body: JSON.stringify({
          scenePath: targetScene.scenePath,
          sceneGuid: targetScene.sceneGuid,
          operationId: latest.operationId,
          expectedUnityRevision: latest.unityRevision,
        }),
      });
      await Promise.all([refresh(), refreshScenes()]);
      setMessage("Unity restored the prior material assignment.");
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function applyHdri() {
    if (!targetScene?.available || !selectedAsset) {
      setError("Choose a target scene and a Unity-imported HDRI/texture.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/materials/hdri", {
        method: "POST",
        body: JSON.stringify({
          scenePath: targetScene.scenePath,
          sceneGuid: targetScene.sceneGuid,
          assetId,
          expectedUnityRevision: targetScene.unityRevision,
          intensity: 1,
          enableRealtimeGi: false,
        }),
      });
      await Promise.all([refresh(), refreshScenes()]);
      setMessage(`Applied the environment in Unity at revision ${result.unityRevision}.`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="page-head">
        <div>
          <div className="eyebrow mb-3">Surfaces</div>
          <h1>Materials &amp; Lighting</h1>
          <p>Apply Unity-imported materials, textures, and HDRIs to the shared target scene. XR and camera hierarchies are excluded.</p>
        </div>
        <Badge variant={statusBadgeVariant(status)} className="rounded-full">W08: {status}</Badge>
      </div>

      <Card>
        <CardHeader><CardTitle>Current target</CardTitle><CardDescription>{targetScene?.available ? targetScene.scenePath : "Choose a target scene in the left panel."}</CardDescription></CardHeader>
      </Card>
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Unity scene assignment</CardTitle><CardDescription>Targets and revisions come directly from Unity.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>Renderer or Terrain</Label><select className="w-full rounded-md border bg-background p-2" value={targetObjectId} onChange={(event) => setTargetObjectId(event.target.value)}>{targets.length ? targets.map((entry) => <option key={entry.objectId} value={entry.objectId}>{entry.hierarchyPath} · {entry.kind}</option>) : <option value="">No editable targets reported</option>}</select></div>
            <div><Label>Unity-imported material / texture</Label><select className="w-full rounded-md border bg-background p-2" value={assetId} onChange={(event) => setAssetId(event.target.value)}>{library.length ? library.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName} · {entry.assetType}</option>) : <option value="">No compatible Unity assets</option>}</select></div>
            <div className="flex flex-wrap gap-2"><Button disabled={busy || !target || !selectedAsset} onClick={applySurface}>Apply to selected object</Button><Button variant="outline" disabled={busy} onClick={undo}>Undo last apply</Button><Button variant="secondary" disabled={busy || !selectedAsset} onClick={applyHdri}>Use as HDRI</Button></div>
            <p className="text-xs text-muted-foreground">{board?.assignments?.length || 0} saved assignment(s) for this target scene.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Find on Poly Haven</CardTitle><CardDescription>CC0 discovery and import. Imported assets appear above after Unity finishes.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2"><select className="rounded-md border bg-background px-2" value={type} onChange={(event) => setType(event.target.value)}><option value="textures">Textures</option><option value="hdris">HDRIs</option></select><Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search Poly Haven"/><Button disabled={busy} onClick={browse}>Search</Button></div>
            <ul className="max-h-80 space-y-2 overflow-auto">{discovery.map((entry) => <li key={entry.id} className="flex items-center justify-between gap-3 rounded border p-2 text-sm"><span>{entry.name || entry.id}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => importDiscovery(entry)}>Import</Button></li>)}</ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}