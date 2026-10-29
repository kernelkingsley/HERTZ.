import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useStudioTargetScene } from "../context/StudioTargetSceneContext.jsx";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Animation() {
  const status = getMilestoneStatus("W09");
  const { targetScene } = useStudioTargetScene();
  const [characters, setCharacters] = useState({ models: [], profiles: [] });
  const [assets, setAssets] = useState([]);
  const [slots, setSlots] = useState(["idle", "locomotion", "attack"]);
  const [subjectKey, setSubjectKey] = useState("");
  const [assetId, setAssetId] = useState("");
  const [slot, setSlot] = useState("idle");
  const [probe, setProbe] = useState(null);
  const [clipName, setClipName] = useState("");
  const [speed, setSpeed] = useState(1);
  const [assignments, setAssignments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const subjects = useMemo(() => [
    ...(characters.models || []).map((entry) => ({ ...entry, subjectType: "model", key: `model:${entry.id}` })),
    ...(characters.profiles || []).map((entry) => ({ ...entry, subjectType: "profile", key: `profile:${entry.id}` })),
  ], [characters]);
  const subject = subjects.find((entry) => entry.key === subjectKey) || null;
  const selectedAsset = assets.find((entry) => entry.id === assetId) || null;
  const canAssign = Boolean(
    targetScene?.available &&
      subject &&
      assetId &&
      clipName &&
      probe &&
      probe.compatible !== false,
  );

  const refresh = useCallback(async () => {
    const [catalog, ready, slotData, studioClips, saved] = await Promise.all([
      api("/api/characters"),
      api("/api/characters/animations/ready"),
      api("/api/animation/slots"),
      api("/api/animation/studio-clips"),
      api("/api/animation/assignments"),
    ]);
    const library = (ready.animations || []).map((entry) => ({
      ...entry,
      label: `${entry.displayName} · library`,
    }));
    const studio = (studioClips.clips || []).map((entry) => ({
      ...entry,
      assetType: "animation",
      label: `${entry.displayName} · studio placeholder`,
    }));
    const merged = [...studio, ...library];
    setCharacters(catalog);
    setAssets(merged);
    setSlots(slotData.slots || ["idle", "locomotion", "attack"]);
    setAssignments(saved.assignments || []);
    const nextSubjects = [
      ...(catalog.models || []).map((entry) => ({ ...entry, subjectType: "model", key: `model:${entry.id}` })),
      ...(catalog.profiles || []).map((entry) => ({ ...entry, subjectType: "profile", key: `profile:${entry.id}` })),
    ];
    setSubjectKey((current) => nextSubjects.some((entry) => entry.key === current) ? current : nextSubjects[0]?.key || "");
    setAssetId((current) => (merged.some((entry) => entry.id === current) ? current : merged[0]?.id || ""));
  }, []);

  useEffect(() => { refresh().catch((err) => setError(String(err.message || err))); }, [refresh]);
  useEffect(() => { setProbe(null); setClipName(""); }, [assetId, subjectKey]);

  function subjectBody() {
    if (!subject) return {};
    return subject.subjectType === "profile"
      ? { enemyProfileId: subject.id }
      : { characterId: subject.id };
  }

  async function inspectClips() {
    if (!assetId || !subject) {
      setError("Choose a character/profile and an animation clip.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/animation/probe", {
        method: "POST",
        body: JSON.stringify({
          assetId,
          unityPath: selectedAsset?.unityPath || undefined,
          ...subjectBody(),
        }),
      });
      setProbe(result);
      setClipName(result.clipNames?.[0] || result.clips?.[0]?.name || selectedAsset?.clipName || "");
      if (result.humanoidValid) {
        setMessage("Unity validated a Humanoid clip.");
      } else if (result.compatible !== false) {
        setMessage("Unity found a Generic/Legacy clip — assignable to non-Humanoid characters.");
      } else {
        setMessage("Unity found no usable clips on this asset.");
      }
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!canAssign) {
      setError("Choose a target scene, character/profile, animation asset, and clip first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/animation/assign", {
        method: "POST",
        body: JSON.stringify({
          ...subjectBody(),
          scenePath: targetScene.scenePath,
          sceneGuid: targetScene.sceneGuid,
          expectedUnityRevision: targetScene.unityRevision,
          slot,
          clipAssetId: assetId,
          clipName,
          clipUnityPath: selectedAsset?.unityPath || undefined,
          loop: slot !== "attack" && slot !== "shoot",
          speed: Number(speed) || 1,
          transitionSeconds: 0.15,
          rootMotionPolicy: "ignore",
        }),
      });
      await refresh();
      setMessage(`Assigned ${result.assignment.clipName} to ${subject.displayName} / ${slot}. Unity saved the character definition.`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter space-y-6">
      <div className="page-head"><div><div className="eyebrow mb-3">Motion</div><h1>Animation</h1><p>Inspect Unity clips and bind them to character definitions or enemy profiles in the shared target scene. Mixamo Humanoid FBX uploads and Studio placeholder clips are both supported.</p></div><Badge variant={statusBadgeVariant(status)} className="rounded-full">W09: {status}</Badge></div>
      <Card><CardHeader><CardTitle>Current target</CardTitle><CardDescription>{targetScene?.available ? targetScene.scenePath : "Choose a target scene in the left panel."}</CardDescription></CardHeader></Card>
      {error ? <p className="error">{error}</p> : null}{message ? <p className="muted">{message}</p> : null}
      <Card>
        <CardHeader><CardTitle>Character animation slots</CardTitle><CardDescription>Unity validates compatibility and saves a generated AnimatorController into the selected definition/profile.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label>Character or enemy profile</Label><select className="w-full rounded-md border bg-background p-2" value={subjectKey} onChange={(event) => setSubjectKey(event.target.value)}>{subjects.length ? subjects.map((entry) => <option key={entry.key} value={entry.key}>{entry.displayName} · {entry.subjectType}</option>) : <option value="">Create and sync a character first</option>}</select></div>
            <div><Label>Animation clip</Label><select className="w-full rounded-md border bg-background p-2" value={assetId} onChange={(event) => setAssetId(event.target.value)}>{assets.length ? assets.map((entry) => <option key={entry.id} value={entry.id}>{entry.label || entry.displayName}</option>) : <option value="">No clips available</option>}</select></div>
          </div>
          <Button variant="outline" disabled={busy || !subject || !assetId} onClick={inspectClips}>Inspect clips in Unity</Button>
          {probe ? <div className="rounded border p-3 text-sm"><p>Rig: {probe.rigType || "unknown"} · Humanoid: {probe.humanoidValid ? "valid" : "no"} · Compatible: {probe.compatible === false ? "no" : "yes"}</p><p>{probe.clipNames?.length || 0} clip(s) found</p></div> : null}
          <div className="grid gap-3 md:grid-cols-3">
            <div><Label>Slot</Label><select className="w-full rounded-md border bg-background p-2" value={slot} onChange={(event) => setSlot(event.target.value)}>{slots.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></div>
            <div><Label>Clip</Label><select className="w-full rounded-md border bg-background p-2" value={clipName} onChange={(event) => setClipName(event.target.value)}>{(probe?.clipNames || []).map((entry) => <option key={entry} value={entry}>{entry}</option>)}{!probe?.clipNames?.length ? <option value="">Inspect clips first</option> : null}</select></div>
            <div><Label>Playback speed</Label><Input type="number" step="0.05" min="0.05" value={speed} onChange={(event) => setSpeed(event.target.value)} /></div>
          </div>
          <Button disabled={busy || !canAssign} onClick={assign}>Assign and save in Unity</Button>
        </CardContent>
      </Card>
      <Card><CardHeader><CardTitle>Saved bindings</CardTitle></CardHeader><CardContent><ul className="space-y-2 text-sm">{assignments.map((entry) => <li key={entry.id} className="rounded border p-2">{entry.characterId} · {entry.slot}: {entry.clipName} · {entry.controllerPath}</li>)}</ul></CardContent></Card>
    </div>
  );
}
