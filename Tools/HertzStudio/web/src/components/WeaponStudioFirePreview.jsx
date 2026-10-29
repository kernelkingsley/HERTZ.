import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const ANCHOR_KEYS = [
  { key: "Grip", formField: "gripAnchor", defaultName: "Grip" },
  { key: "Muzzle", formField: "muzzleAnchor", defaultName: "Muzzle" },
  { key: "LeftHand", formField: "leftHandAnchor", defaultName: "LeftHand" },
  { key: "RightHand", formField: "rightHandAnchor", defaultName: "RightHand" },
];

/**
 * Studio weapon fire simulation driven through ModelViewer's preview/effects API.
 * Browser-only — not Unity XR/physics/runtime audio proof.
 */
export default function WeaponStudioFirePreview({
  form,
  hasModel = false,
  viewerApiRef = null,
  shotAudio = null,
  viewerReadyEpoch = 0,
}) {
  const [frequencyOn, setFrequencyOn] = useState(true);
  const [lastShot, setLastShot] = useState(null);
  const [flash, setFlash] = useState(false);
  const [blockedReason, setBlockedReason] = useState("");
  const [anchorReport, setAnchorReport] = useState(null);
  const [recoilActive, setRecoilActive] = useState(false);
  const [playCount, setPlayCount] = useState(0);
  const lastShotAtRef = useRef(0);
  const flashTimerRef = useRef(0);
  const recoilTimerRef = useRef(0);
  const tracerTimerRef = useRef(0);
  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);

  const intervalMs = Math.max(50, Math.round(Number(form.fireIntervalSeconds || 0.2) * 1000));
  const recoil = Number(form.recoil || 0);
  const range = Number(form.rangeMeters || 0);
  const frequencyRequired = form.frequencyFlipRequired !== false;
  const muzzleName = form.muzzleAnchor || "Muzzle";
  const audioAssigned = Boolean(shotAudio?.assigned && shotAudio?.previewUrl && !shotAudio?.error);
  const audioSilent = !shotAudio?.assigned;
  const audioError = shotAudio?.error || null;
  const muzzleStatus = anchorReport?.Muzzle || { state: "pending", detail: "Waiting for model…" };

  useEffect(
    () => () => {
      clearTimeout(flashTimerRef.current);
      clearTimeout(recoilTimerRef.current);
      clearTimeout(tracerTimerRef.current);
      stopAudio();
      clearViewerFx();
      try {
        viewerApiRef?.current?.clearAnchorMarkers?.();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  // Resolve anchors when model / names / async viewer readiness changes — do not wait for a click.
  useEffect(() => {
    clearViewerFx();
    viewerApiRef?.current?.resetRecoil?.();
    setRecoilActive(false);
    setFlash(false);
    setLastShot(null);
    resolveAllAnchors();
  }, [
    form.muzzleAnchor,
    form.gripAnchor,
    form.leftHandAnchor,
    form.rightHandAnchor,
    form.modelAssetId,
    hasModel,
    viewerApiRef,
    viewerReadyEpoch,
  ]);

  // Keep audio element src in sync; stop on change.
  useEffect(() => {
    const nextUrl = audioAssigned ? shotAudio.previewUrl : null;
    if (audioUrlRef.current !== nextUrl) {
      stopAudio();
      audioUrlRef.current = nextUrl;
      if (audioRef.current) {
        if (nextUrl) {
          audioRef.current.src = nextUrl;
          audioRef.current.load();
        } else {
          audioRef.current.removeAttribute("src");
          audioRef.current.load();
        }
      }
    }
  }, [audioAssigned, shotAudio?.previewUrl]);

  function clearViewerFx() {
    try {
      viewerApiRef?.current?.clearTransients?.();
    } catch {
      /* ignore */
    }
  }

  function stopAudio() {
    const el = audioRef.current;
    if (!el) return;
    try {
      el.pause();
      el.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  function resolveAllAnchors() {
    const api = viewerApiRef?.current;
    if (!hasModel) {
      setAnchorReport({
        Grip: { state: "no_model", configured: form.gripAnchor || "Grip", found: false },
        Muzzle: {
          state: "no_model",
          configured: muzzleName,
          found: false,
          detail: "No model loaded — preview fallback only.",
        },
        LeftHand: { state: "no_model", configured: form.leftHandAnchor || "LeftHand", found: false },
        RightHand: { state: "no_model", configured: form.rightHandAnchor || "RightHand", found: false },
      });
      return null;
    }
    if (!api?.ready) {
      setAnchorReport({
        Grip: { state: "pending", configured: form.gripAnchor || "Grip", found: false },
        Muzzle: {
          state: "pending",
          configured: muzzleName,
          found: false,
          detail: "Model still loading…",
        },
        LeftHand: { state: "pending", configured: form.leftHandAnchor || "LeftHand", found: false },
        RightHand: { state: "pending", configured: form.rightHandAnchor || "RightHand", found: false },
      });
      return null;
    }

    const names = {
      Grip: form.gripAnchor || "Grip",
      Muzzle: muzzleName,
      LeftHand: form.leftHandAnchor || "LeftHand",
      RightHand: form.rightHandAnchor || "RightHand",
    };
    const report = api.resolveAnchors?.(names) || {};
    const normalized = {};
    for (const { key, defaultName } of ANCHOR_KEYS) {
      const row = report[key] || {};
      const found = Boolean(row.found);
      normalized[key] = {
        ...row,
        configured: row.configured || names[key] || defaultName,
        found,
        state: found ? "found" : "missing",
        detail: found
          ? `${key} "${row.configured || names[key]}" found on loaded model.`
          : `${key} "${row.configured || names[key]}" not found — labelled preview fallback only. Not validated.`,
      };
    }
    setAnchorReport(normalized);
    return normalized;
  }

  function playAcceptedAudio() {
    if (!audioAssigned || !audioRef.current?.src) return false;
    try {
      audioRef.current.currentTime = 0;
      const p = audioRef.current.play();
      setPlayCount((n) => n + 1);
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* browser autoplay rejection — non-fatal */
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function spawnTracer(api, origin, direction, length) {
    const THREE = api.THREE;
    if (!THREE) return;
    const dir = direction.clone();
    if (typeof dir.normalize === "function") dir.normalize();
    const end = origin.clone().add(dir.multiplyScalar(length));
    const positions = new Float32Array([origin.x, origin.y, origin.z, end.x, end.y, end.z]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffcc66 });
    const line = new THREE.Line(geo, mat);
    line.name = "HertzStudioPreviewTracer";
    api.addTransient(line);

    const impactGeo = new THREE.SphereGeometry(Math.max(0.02, length * 0.01), 8, 8);
    const impactMat = new THREE.MeshBasicMaterial({ color: 0xff8844 });
    const impact = new THREE.Mesh(impactGeo, impactMat);
    impact.position.copy(end);
    impact.name = "HertzStudioPreviewImpact";
    api.addTransient(impact);

    clearTimeout(tracerTimerRef.current);
    tracerTimerRef.current = setTimeout(() => {
      clearViewerFx();
    }, 180);
  }

  function testFire() {
    setBlockedReason("");
    if (!form.enabled) {
      setBlockedReason("Weapon disabled — Studio preview will not fire.");
      return;
    }
    if (frequencyRequired && !frequencyOn) {
      setBlockedReason("Frequency off — shot blocked (Studio preview of frequency gate).");
      setLastShot({ ok: false, at: Date.now() });
      return;
    }
    const now = Date.now();
    if (now - lastShotAtRef.current < intervalMs) {
      setBlockedReason(`Cadence wait — next shot after ${intervalMs}ms fire interval.`);
      return;
    }
    lastShotAtRef.current = now;

    const api = viewerApiRef?.current;
    const report = resolveAllAnchors() || anchorReport;
    const muzzleNode =
      report?.Muzzle?.found && api?.findByName?.(report.Muzzle.configured || muzzleName)
        ? api.findByName(report.Muzzle.configured || muzzleName)
        : null;
    let origin = null;
    let direction = null;
    let usedFallback = false;
    if (api?.ready && muzzleNode) {
      origin = api.getWorldPosition(muzzleNode);
      direction = api.getWorldDirection?.(muzzleNode) || null;
    } else if (api?.ready) {
      usedFallback = true;
      origin = api.THREE ? new api.THREE.Vector3(0, 0.15, 0.35) : null;
      direction = api.THREE ? new api.THREE.Vector3(0, 0, 1) : null;
    }

    // Recoil the real preview pivot (not orbit camera).
    if (api?.ready) {
      const kick = Math.min(0.12, Math.max(0.01, recoil * 0.25));
      api.setRecoilOffset(kick);
      setRecoilActive(true);
      clearTimeout(recoilTimerRef.current);
      recoilTimerRef.current = setTimeout(() => {
        api.resetRecoil?.();
        setRecoilActive(false);
      }, 140);
    }

    setFlash(true);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(false), 120);

    if (api?.ready && origin && direction && api.THREE) {
      void spawnTracer(api, origin, direction, Math.max(0.5, range * 0.05));
    }

    playAcceptedAudio();

    setLastShot({
      ok: true,
      at: now,
      recoil,
      range,
      muzzle: muzzleName,
      muzzleState:
        report?.Muzzle?.found && muzzleNode ? "found" : usedFallback || report?.Muzzle?.state === "missing" ? "fallback" : report?.Muzzle?.state,
      direction: usedFallback
        ? `preview fallback forward · ~${range}m cue`
        : `muzzle local forward (world) · ~${range}m cue`,
      audio: audioAssigned
        ? "assigned Sound clip (browser cue only)"
        : audioSilent
          ? "silent — no Sound assignment"
          : audioError || "audio unavailable",
      modelRecoil: Boolean(api?.ready),
    });
  }

  return (
    <div
      className="space-y-2 rounded-xl border border-white/10 p-3"
      data-testid="weapon-studio-fire-preview"
      data-recoil-active={recoilActive ? "true" : "false"}
      data-muzzle-state={muzzleStatus.state}
    >
      <p className="text-sm font-medium">Studio fire preview</p>
      <p className="text-xs text-muted-foreground" data-testid="weapon-preview-vs-unity">
        Browser simulation on the loaded model viewport — not Unity-verified gunfire, physics, XR input, or final
        runtime behavior. Prove those in <code>HertzWeaponTest</code> Play Mode (managed definition, hand binding,
        frequency gate, real muzzle flash, hit/shot, recoil, assigned audio, fire interval).
      </p>

      <dl className="grid gap-1 text-xs text-muted-foreground" data-testid="weapon-anchor-report">
        {ANCHOR_KEYS.map(({ key }) => {
          const row = anchorReport?.[key];
          return (
            <div key={key} data-testid={`weapon-anchor-${key.toLowerCase()}`} data-state={row?.state || "pending"}>
              <dt className="inline font-medium text-foreground">{key}: </dt>
              <dd className="inline">
                {row?.detail ||
                  `${row?.configured || "—"} — ${row?.state || "pending"}${row?.found ? " (marker on model)" : ""}`}
              </dd>
            </div>
          );
        })}
        <div>
          <dt className="inline font-medium text-foreground">Tuning: </dt>
          <dd className="inline" data-testid="weapon-preview-tuning">
            interval {form.fireIntervalSeconds}s · range {form.rangeMeters}m · recoil {form.recoil} · dmg{" "}
            {form.damage}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Mesh: </dt>
          <dd className="inline">{hasModel ? "library model in viewport" : "no mesh — visual empty"}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Audio: </dt>
          <dd className="inline" data-testid="weapon-preview-audio-state">
            {audioError
              ? audioError
              : audioAssigned
                ? shotAudio.label
                : "Silent — no firing sound assigned."}
          </dd>
        </div>
      </dl>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="weapon-preview-frequency"
          checked={frequencyOn}
          onChange={(e) => setFrequencyOn(e.target.checked)}
        />
        Frequency flip ON (preview)
      </label>

      <div
        className={`rounded-lg border border-white/10 px-3 py-2 text-xs ${flash ? "bg-amber-300/20" : "bg-black/30"}`}
        data-testid="weapon-preview-muzzle-flash"
        data-flash={flash ? "true" : "false"}
      >
        {flash
          ? `Muzzle flash + model recoil (preview) @ ${muzzleName}`
          : "Test fire drives the loaded model pivot, muzzle flash, tracer (muzzle forward), and impact cues."}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" data-testid="weapon-test-fire" onClick={testFire}>
          Test fire
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="weapon-resolve-anchors"
          onClick={() => resolveAllAnchors()}
        >
          Resolve anchors
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="weapon-resolve-muzzle"
          onClick={() => resolveAllAnchors()}
        >
          Resolve muzzle
        </Button>
      </div>

      <audio
        ref={audioRef}
        data-testid="weapon-preview-audio"
        data-play-count={playCount}
        preload="none"
        crossOrigin="use-credentials"
      />

      {blockedReason ? (
        <p className="text-xs text-[var(--glow)]" data-testid="weapon-test-fire-blocked">
          {blockedReason}
        </p>
      ) : null}
      {lastShot?.ok ? (
        <p className="text-xs text-muted-foreground" data-testid="weapon-test-fire-ok">
          Shot accepted · muzzle {lastShot.muzzleState} · {lastShot.direction} · {lastShot.audio}
          {lastShot.modelRecoil ? " · model pivot recoiled" : ""}
        </p>
      ) : null}
      <p className="sr-only" data-testid="weapon-muzzle-status">
        {muzzleStatus.detail || muzzleStatus.state}
      </p>
    </div>
  );
}
