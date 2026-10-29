import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useStudioTargetScene } from "../context/StudioTargetSceneContext.jsx";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Encounters() {
  const status = getMilestoneStatus("W12");
  const { targetScene, refresh: refreshScenes } = useStudioTargetScene();
  const [list, setList] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [displayName, setDisplayName] = useState("New encounter");
  const [profileId, setProfileId] = useState("");
  const [delay, setDelay] = useState(0);
  const [count, setCount] = useState(1);
  const [spacing, setSpacing] = useState(1.5);
  const [position, setPosition] = useState({ x: 0, y: 0, z: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const [encounters, characters] = await Promise.all([api("/api/encounters"), api("/api/characters")]);
    const usableProfiles = (characters.profiles || []).filter((entry) => entry.enabled !== false);
    setList(encounters.encounters || []);
    setProfiles(usableProfiles);
    setProfileId((current) => usableProfiles.some((entry) => entry.id === current) ? current : usableProfiles[0]?.id || "");
  }, []);

  useEffect(() => { refresh().catch((err) => setError(String(err.message || err))); }, [refresh, targetScene?.sceneGuid]);

  function edit(entry) {
    const spawn = entry.spawns?.[0] || {};
    setSelectedId(entry.id);
    setDisplayName(entry.displayName);
    setProfileId(spawn.enemyProfileId || "");
    setDelay(spawn.delaySeconds ?? 0);
    setCount(spawn.count ?? 1);
    setSpacing(spawn.spacingMeters ?? 1.5);
    setPosition(spawn.position || { x: 0, y: 0, z: 0 });
  }

  async function save() {
    if (!targetScene?.available || !profileId) {
      setError("Choose a target scene and a synced enemy profile first.");
      return;
    }
    const existing = list.find((entry) => entry.id === selectedId);
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/encounters", {
        method: "POST",
        body: JSON.stringify({
          id: selectedId || undefined,
          expectedVersion: existing?.version,
          displayName,
          scenePath: targetScene.scenePath,
          sceneGuid: targetScene.sceneGuid,
          expectedUnityRevision: targetScene.unityRevision,
          applyToUnity: true,
          startCondition: "manual",
          completionCondition: "all_cleared",
          spawns: [{
            delaySeconds: Number(delay),
            count: Number(count),
            spacingMeters: Number(spacing),
            enemyProfileId: profileId,
            behaviorProfileId: profileId,
            position: { x: Number(position.x), y: Number(position.y), z: Number(position.z) },
            trigger: "on_start",
          }],
        }),
      });
      setSelectedId(result.id);
      await Promise.all([refresh(), refreshScenes()]);
      setMessage(`Saved and applied ${result.displayName} v${result.version} to ${targetScene.scenePath}.`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function resetRuntime(entry) {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/encounters/${entry.id}/reset`, {
        method: "POST",
        body: JSON.stringify({ requestId: `studio-reset-${entry.id}-${entry.version}-${Date.now()}` }),
      });
      const cleared = result.unityAck?.clearedRuntimeCount ?? result.clearedRuntimeCount;
      const markers = result.unityAck?.markerCount ?? result.markerCount;
      setMessage(
        cleared != null
          ? `Reset ${entry.displayName}: cleared ${cleared} runtime instance(s), ${markers ?? "?"} marker(s) kept.`
          : `Unity reset ${entry.displayName} (${result.requestId.slice(0, 12)}…).`,
      );
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function spawnRuntime(entry) {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/encounters/${entry.id}/reset`, {
        method: "POST",
        body: JSON.stringify({
          requestId: `studio-spawn-${entry.id}-${entry.version}-${Date.now()}`,
          command: "spawn",
        }),
      });
      const spawned = result.unityAck?.spawnedRuntimeCount ?? result.spawnedRuntimeCount;
      setMessage(
        spawned != null
          ? `Spawned ${spawned} runtime enemy instance(s) for ${entry.displayName}.`
          : `Unity spawn for ${entry.displayName} completed.`,
      );
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="page-head"><div><div className="eyebrow mb-3">Tide</div><h1>Encounters</h1><p>Build timed enemy spawn definitions from real synced profiles and apply them to the shared target scene.</p></div><Badge variant={statusBadgeVariant(status)} className="rounded-full">W12: {status}</Badge></div>
      <Card><CardHeader><CardTitle>Current target</CardTitle><CardDescription>{targetScene?.available ? `${targetScene.scenePath} · revision ${targetScene.unityRevision ?? "unknown"}` : "Choose a target scene in the left panel."}</CardDescription></CardHeader></Card>
      {error ? <p className="error">{error}</p> : null}{message ? <p className="muted">{message}</p> : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Card><CardHeader><CardTitle>Saved encounters</CardTitle><CardDescription>Select one to edit.</CardDescription></CardHeader><CardContent><div className="space-y-2"><Button variant="outline" className="w-full" onClick={() => { setSelectedId(""); setDisplayName("New encounter"); }}>New encounter</Button>{list.map((entry) => <button type="button" key={entry.id} className={`w-full rounded border p-3 text-left text-sm ${selectedId === entry.id ? "bg-muted" : ""}`} onClick={() => edit(entry)}><strong>{entry.displayName}</strong><br/>v{entry.version} · {entry.spawns?.length || 0} spawn row(s) · {entry.applied ? "applied" : "draft"}</button>)}</div></CardContent></Card>
        <Card><CardHeader><CardTitle>{selectedId ? "Edit encounter" : "New encounter"}</CardTitle><CardDescription>Save performs Unity validation and applies to the selected scene.</CardDescription></CardHeader><CardContent className="space-y-4">
          <div><Label>Name</Label><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></div>
          <div><Label>Enemy profile</Label><select className="w-full rounded-md border bg-background p-2" value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.length ? profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName} · Unity {entry.unitySync?.state || "not synced"}</option>) : <option value="">Create and sync an enemy profile first</option>}</select></div>
          <div className="grid gap-3 sm:grid-cols-3"><div><Label>Delay (s)</Label><Input type="number" min="0" step="0.1" value={delay} onChange={(event) => setDelay(event.target.value)} /></div><div><Label>Count</Label><Input type="number" min="1" max="100" value={count} onChange={(event) => setCount(event.target.value)} /></div><div><Label>Spacing (m)</Label><Input type="number" min="0" step="0.1" value={spacing} onChange={(event) => setSpacing(event.target.value)} /></div></div>
          <div className="grid gap-3 sm:grid-cols-3">{["x", "y", "z"].map((axis) => <div key={axis}><Label>Position {axis.toUpperCase()}</Label><Input type="number" step="0.1" value={position[axis]} onChange={(event) => setPosition((current) => ({ ...current, [axis]: event.target.value }))} /></div>)}</div>
          <div className="flex flex-wrap gap-2"><Button disabled={busy || !targetScene?.available || !profileId} onClick={save}>Save and apply to Unity</Button>{selectedId ? <Button variant="outline" disabled={busy} onClick={() => spawnRuntime(list.find((entry) => entry.id === selectedId))}>Spawn now</Button> : null}{selectedId ? <Button variant="outline" disabled={busy} onClick={() => resetRuntime(list.find((entry) => entry.id === selectedId))}>Reset runtime</Button> : null}</div>
        </CardContent></Card>
      </div>
    </div>
  );
}