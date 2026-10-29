import { useCallback, useEffect, useState, lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { getMilestoneStatus, statusBadgeVariant } from "../lib/milestoneStatus.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const AudioPreview = lazy(() => import("../components/AudioPreview.jsx"));

/**
 * W07 Sound editor — Kenney/local audio assign, emitters, explicit footstep maps.
 * Single audition via AudioPreview (no overlapping playback).
 */
export default function Sound() {
  const w07Status = getMilestoneStatus("W07");
  const [board, setBoard] = useState(null);
  const [library, setLibrary] = useState([]);
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("");
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [emitterForm, setEmitterForm] = useState({
    name: "Ambient Emitter",
    volume: 0.7,
    loop: true,
    spatialBlend: 1,
    minDistance: 1,
    maxDistance: 25,
    x: 0,
    y: 0,
    z: 0,
  });
  const [footSurface, setFootSurface] = useState("floor_wood");
  const [footLabel, setFootLabel] = useState("Wood floor");

  const refresh = useCallback(async () => {
    const [b, lib] = await Promise.all([
      api("/api/sound"),
      api(`/api/sound/library?q=${encodeURIComponent(q)}&provider=${encodeURIComponent(provider)}`),
    ]);
    setBoard(b);
    setLibrary(lib.assets || []);
  }, [q, provider]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e.message || e)));
  }, []);

  async function searchLibrary() {
    setBusy(true);
    setError("");
    try {
      await refresh();
      setMessage("Library refreshed.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function assignSlot(category, slotKey, targetId = null) {
    if (!selected?.id) {
      setError("Select an audio clip first (or drop one onto the slot).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/sound/slots", {
        method: "POST",
        body: JSON.stringify({
          category,
          slotKey,
          targetId,
          audioAssetId: selected.id,
        }),
      });
      await refresh();
      setMessage(`Assigned ${selected.name || selected.id} → ${category}:${slotKey}`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function onDropSlot(category, slotKey, targetId, e) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/hertz-audio-id") || dragId;
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/sound/slots", {
        method: "POST",
        body: JSON.stringify({ category, slotKey, targetId, audioAssetId: id }),
      });
      await refresh();
      setMessage(`Dropped clip onto ${category}:${slotKey}`);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
      setDragId(null);
    }
  }

  async function clearSlot(id) {
    setBusy(true);
    try {
      await api(`/api/sound/slots/${id}/clear`, { method: "POST", body: "{}" });
      await refresh();
      setMessage("Slot cleared.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createEmitter() {
    if (!selected?.id) {
      setError("Select an audio clip for the emitter.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/sound/emitters", {
        method: "POST",
        body: JSON.stringify({
          name: emitterForm.name,
          volume: Number(emitterForm.volume),
          loop: Boolean(emitterForm.loop),
          spatialBlend: Number(emitterForm.spatialBlend),
          minDistance: Number(emitterForm.minDistance),
          maxDistance: Number(emitterForm.maxDistance),
          position: { x: Number(emitterForm.x), y: Number(emitterForm.y), z: Number(emitterForm.z) },
          audioAssetId: selected.id,
        }),
      });
      await refresh();
      setMessage("Emitter saved.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeEmitter(id) {
    setBusy(true);
    try {
      await api(`/api/sound/emitters/${id}`, { method: "DELETE" });
      await refresh();
      setMessage("Emitter removed.");
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function saveFootstep() {
    if (!selected?.id) {
      setError("Select an audio clip for the footstep mapping.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/sound/footsteps", {
        method: "POST",
        body: JSON.stringify({
          surfaceId: footSurface,
          surfaceLabel: footLabel,
          audioAssetId: selected.id,
        }),
      });
      await refresh();
      setMessage(`Footstep map ${footSurface} → clip (explicit only).`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function removeFootstep(id) {
    setBusy(true);
    try {
      await api(`/api/sound/footsteps/${id}`, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function checkUsages(audioAssetId) {
    setBusy(true);
    try {
      const u = await api(`/api/sound/usages/${audioAssetId}`);
      setMessage(`Usages for ${audioAssetId}: ${u.total} (slots ${u.slots.length}, emitters ${u.emitters.length}, footsteps ${u.footsteps.length})`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function syncUnity() {
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/sound/sync", { method: "POST", body: "{}" });
      await refresh();
      setMessage(`Sound sync queued (${r.requestId}). Connector → Unity applies SoundBoard.`);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  const slots = board?.slots || [];
  const emitters = board?.emitters || [];
  const footsteps = board?.footstepMappings || [];

  function slotFor(category, slotKey, targetId = null) {
    return slots.find(
      (s) => s.category === category && s.slotKey === slotKey && (s.targetId || null) === targetId,
    );
  }

  function SlotRow({ category, slotKey, targetId = null, label }) {
    const s = slotFor(category, slotKey, targetId);
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 px-2 py-2 text-sm"
        data-testid={`sound-slot-${category}-${slotKey}${targetId ? `-${targetId}` : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDropSlot(category, slotKey, targetId, e)}
      >
        <span className="min-w-[10rem] font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">
          {s?.audio?.unsupported ? (
            <span className="text-amber-400">Unsupported format</span>
          ) : (
            s?.audio?.name || s?.audioAssetId || "— unassigned —"
          )}
        </span>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => assignSlot(category, slotKey, targetId)}>
          Assign selected
        </Button>
        {s?.id ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => clearSlot(s.id)}>
            Clear
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4" data-testid="sound-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sound</h1>
          <p className="text-sm text-muted-foreground">
            Kenney/local audio slots, scene emitters, explicit footstep maps. Material appearance does not change footsteps.
          </p>
        </div>
        <Badge variant={statusBadgeVariant(w07Status)} data-testid="sound-milestone-badge">
          {w07Status}
        </Badge>
      </div>

      {error ? (
        <div className="error rounded-xl border border-red-500/40 px-3 py-2 text-sm" data-testid="sound-error">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-white/10 px-3 py-2 text-sm" data-testid="sound-message">
          {message}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" data-testid="sound-sync" disabled={busy} onClick={syncUnity}>
          Sync to Unity
        </Button>
        <span className="text-xs text-muted-foreground self-center">
          Sync: {board?.sync?.state || "—"} {board?.lastSyncedAt ? `· ${board.lastSyncedAt}` : ""}
        </span>
        <Link className="text-sm underline self-center" to="/find?provider=kenney&category=Audio">
          Browse Kenney Audio
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Audio library</CardTitle>
            <CardDescription>Search imported Kenney/local clips. One audition at a time.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                data-testid="sound-library-q"
                placeholder="Search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <Input
                data-testid="sound-library-provider"
                placeholder="provider (kenney)"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="max-w-[10rem]"
              />
              <Button type="button" data-testid="sound-library-search" disabled={busy} onClick={searchLibrary}>
                Search
              </Button>
            </div>
            <ul className="max-h-64 space-y-2 overflow-y-auto text-sm" data-testid="sound-library-list">
              {library.length === 0 ? (
                <li className="text-muted-foreground">No audio yet — import a Kenney Audio pack or upload locally.</li>
              ) : (
                library.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={`w-full rounded-lg border px-2 py-2 text-left ${selected?.id === a.id ? "border-white/40 bg-white/5" : "border-white/10"}`}
                      data-testid={`sound-lib-item-${a.id}`}
                      draggable
                      onDragStart={(e) => {
                        setDragId(a.id);
                        e.dataTransfer.setData("text/hertz-audio-id", a.id);
                      }}
                      onClick={() => setSelected(a)}
                    >
                      <div className="font-medium">{a.displayName || a.name || a.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.provider || "local"} · {a.fileFormat || "?"}
                        {a.unsupported || a.state === "unsupported" ? " · unsupported" : ""}
                        {a.license ? ` · ${a.license}` : ""}
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
            {selected ? (
              <div data-testid="sound-audition">
                <p className="mb-1 text-xs text-muted-foreground">Audition (stops previous clip)</p>
                <Suspense fallback={<p className="text-xs">Loading preview…</p>}>
                  <AudioPreview asset={selected} />
                </Suspense>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  data-testid="sound-check-usages"
                  onClick={() => checkUsages(selected.id)}
                >
                  Check usages
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Slots</CardTitle>
            <CardDescription>Weapon / enemy / character / ambience. Drag a clip onto a row.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2" data-testid="sound-slots">
            <SlotRow category="weapon" slotKey="shot" targetId="left_pistol" label="Weapon L shot" />
            <SlotRow category="weapon" slotKey="shot" targetId="right_pistol" label="Weapon R shot" />
            <SlotRow category="weapon" slotKey="reload" targetId="left_pistol" label="Weapon L reload" />
            <SlotRow category="enemy" slotKey="attack" label="Enemy attack" />
            <SlotRow category="enemy" slotKey="defeat" label="Enemy defeat" />
            <SlotRow category="enemy" slotKey="hit" label="Enemy hit" />
            <SlotRow category="enemy" slotKey="idle" label="Enemy idle" />
            <SlotRow category="character" slotKey="generic" label="Character" />
            <SlotRow category="ambience" slotKey="loop" label="Ambience loop" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Scene emitters</CardTitle>
          <CardDescription>Volume, loop, spatial blend, attenuation. Defaults favor VR comfort.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3" data-testid="sound-emitters">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label>Name</Label>
              <Input value={emitterForm.name} onChange={(e) => setEmitterForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label>Volume</Label>
              <Input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={emitterForm.volume}
                onChange={(e) => setEmitterForm((f) => ({ ...f, volume: e.target.value }))}
              />
            </div>
            <div>
              <Label>Spatial blend</Label>
              <Input
                type="number"
                step="0.1"
                min="0"
                max="1"
                value={emitterForm.spatialBlend}
                onChange={(e) => setEmitterForm((f) => ({ ...f, spatialBlend: e.target.value }))}
              />
            </div>
            <div>
              <Label>Max distance</Label>
              <Input
                type="number"
                value={emitterForm.maxDistance}
                onChange={(e) => setEmitterForm((f) => ({ ...f, maxDistance: e.target.value }))}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={emitterForm.loop}
              onChange={(e) => setEmitterForm((f) => ({ ...f, loop: e.target.checked }))}
            />
            Loop
          </label>
          <Button type="button" data-testid="sound-emitter-create" disabled={busy} onClick={createEmitter}>
            Create / update emitter with selected clip
          </Button>
          <ul className="space-y-2 text-sm">
            {emitters.map((em) => (
              <li key={em.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2">
                <span>
                  {em.name} · vol {em.volume} · spatial {em.spatialBlend} · {em.loop ? "loop" : "oneshot"} ·{" "}
                  {em.audio?.name || "no clip"}
                </span>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeEmitter(em.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Footstep surface mappings</CardTitle>
          <CardDescription>
            Explicit surfaceId → clip only. Changing a floor material does not rewrite these rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3" data-testid="sound-footsteps">
          <div className="flex flex-wrap gap-2">
            <Input
              data-testid="sound-foot-surface"
              value={footSurface}
              onChange={(e) => setFootSurface(e.target.value)}
              placeholder="surfaceId e.g. floor_wood"
            />
            <Input value={footLabel} onChange={(e) => setFootLabel(e.target.value)} placeholder="Label" />
            <Button type="button" data-testid="sound-foot-save" disabled={busy} onClick={saveFootstep}>
              Map selected clip
            </Button>
          </div>
          <ul className="space-y-2 text-sm">
            {footsteps.map((m) => (
              <li key={m.id} className="flex justify-between gap-2 border-t border-white/10 pt-2">
                <span>
                  {m.surfaceLabel} ({m.surfaceId}) → {m.audio?.name || "—"}
                </span>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeFootstep(m.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
