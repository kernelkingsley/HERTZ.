import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { rewriteModelDependencyUrl } from "../lib/modelDepUrl.js";
import { loadStudioModel } from "../lib/loadStudioModel.js";
import {
  PREVIEW_SLOTS,
  findExactEmbeddedClip,
  resolvePreviewPlayback,
} from "../lib/characterPreviewAnimation.js";

/**
 * Characters page 3D preview — truthful assigned vs playing state.
 * Plays an embedded GLB/FBX clip only on exact normalized identity match.
 * Unity-only .anim / controllers: explicit unavailable (no clips[0] fallback).
 */
export default function CharacterPreview({
  modelUrl,
  modelAssetId,
  modelFormat = null,
  modelFileName = null,
  previewSlot = "idle",
  slotAssignments = {},
  unityCompatibilityBySlot = {},
  onSlotChange,
}) {
  const mountRef = useRef(null);
  const apiRef = useRef(null);
  const previewSlotRef = useRef(previewSlot);
  const slotAssignmentsRef = useRef(slotAssignments);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clipNames, setClipNames] = useState([]);
  const [meshHasSkin, setMeshHasSkin] = useState(false);

  useEffect(() => {
    previewSlotRef.current = previewSlot;
  }, [previewSlot]);
  useEffect(() => {
    slotAssignmentsRef.current = slotAssignments;
  }, [slotAssignments]);

  const assignment = slotAssignments?.[previewSlot] || null;
  const unityCompat = unityCompatibilityBySlot?.[previewSlot] || null;

  const playback = useMemo(
    () =>
      resolvePreviewPlayback({
        slot: previewSlot,
        assignment,
        embeddedClipNames: clipNames,
        unityCompatibility: unityCompat,
      }),
    [previewSlot, assignment, clipNames, unityCompat],
  );

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const mount = mountRef.current;
    if (!mount || !modelUrl) return undefined;

    (async () => {
      try {
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        const loaded = await loadStudioModel({
          url: modelUrl,
          assetId: modelAssetId,
          format: modelFormat,
          fileName: modelFileName,
          onProgress: (pct) => setLoading(pct),
          urlModifier: modelAssetId
            ? (requestUrl) => rewriteModelDependencyUrl(requestUrl, modelAssetId, window.location.origin)
            : null,
        });
        if (cancelled) {
          disposeObject(loaded.root, loaded.THREE);
          return;
        }
        const THREE = loaded.THREE;

        const width = mount.clientWidth || 640;
        const height = Math.max(280, Math.round(width * 0.55));
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(Math.min(width, 1280), Math.min(height, 720));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x12151b);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000);
        camera.position.set(2, 1.5, 2.5);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
        const dir = new THREE.DirectionalLight(0xffffff, 0.85);
        dir.position.set(3, 5, 2);
        scene.add(dir);
        const grid = new THREE.GridHelper(4, 16, 0x3a4250, 0x242a33);
        scene.add(grid);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0.5, 0);

        const root = loaded.root;
        scene.add(root);
        const box = new THREE.Box3().setFromObject(root);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        root.position.sub(center);

        let hasSkin = false;
        root.traverse((obj) => {
          if (obj.isSkinnedMesh || obj.isBone || obj.isSkeleton) hasSkin = true;
        });
        setMeshHasSkin(hasSkin);

        const mixer = new THREE.AnimationMixer(root);
        const clips = loaded.animations || [];
        setClipNames(clips.map((c) => c.name || "").filter(Boolean));

        let action = null;
        let playingClip = null;
        const clock = new THREE.Clock();
        let paused = true;

        const stopAction = () => {
          if (action) action.stop();
          action = null;
          playingClip = null;
          paused = true;
          setPlaying(false);
        };

        const playExactClip = (clip) => {
          if (!clip) {
            stopAction();
            return false;
          }
          if (action) action.stop();
          action = mixer.clipAction(clip);
          action.reset();
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
          playingClip = clip.name || "clip";
          paused = false;
          setPlaying(true);
          return true;
        };

        const applySlot = (slot, assignments) => {
          const assign = assignments?.[slot] || null;
          const clip = findExactEmbeddedClip(clips, assign);
          if (!clip) {
            stopAction();
            return;
          }
          playExactClip(clip);
        };

        applySlot(previewSlot, slotAssignments);

        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        const dist = maxDim * 2.2;
        camera.position.set(dist, dist * 0.7, dist);
        controls.target.set(0, 0, 0);
        controls.update();

        apiRef.current = {
          applySlot,
          getPlayingClip: () => playingClip,
          play: () => {
            if (!action) return;
            paused = false;
            setPlaying(true);
            action.paused = false;
          },
          pause: () => {
            if (!action) return;
            paused = true;
            setPlaying(false);
            action.paused = true;
          },
          reset: () => {
            // Always current slot + assignment (refs) — never the load-time closure.
            applySlot(previewSlotRef.current, slotAssignmentsRef.current);
            const d = Math.max(size.x, size.y, size.z, 0.001) * 2.2;
            camera.position.set(d, d * 0.7, d);
            controls.target.set(0, 0, 0);
            controls.update();
          },
          dispose: () => {
            cancelAnimationFrame(raf);
            controls.dispose();
            mixer.stopAllAction();
            disposeObject(root, THREE);
            grid.geometry.dispose();
            grid.material.dispose();
            renderer.dispose();
            if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
          },
        };

        const tick = () => {
          raf = requestAnimationFrame(tick);
          const dt = clock.getDelta();
          if (!paused) mixer.update(dt);
          controls.update();
          renderer.render(scene, camera);
        };
        tick();
        setLoading(100);
        setError("");
      } catch (err) {
        if (!cancelled) setError(err.message || "Character preview failed");
      }
    })();

    return () => {
      cancelled = true;
      apiRef.current?.dispose?.();
      apiRef.current = null;
    };
  }, [modelUrl, modelAssetId, modelFormat, modelFileName]);

  useEffect(() => {
    apiRef.current?.applySlot?.(previewSlot, slotAssignments);
  }, [previewSlot, slotAssignments]);

  if (!modelUrl) {
    return (
      <div
        className="flex min-h-[220px] flex-col justify-center gap-2 rounded-2xl border border-dashed border-white/15 bg-black/30 px-4 py-6"
        data-testid="character-preview-empty"
      >
        <p className="text-sm text-foreground">No mesh selected yet</p>
        <p className="text-xs text-muted-foreground">
          Use <strong>Add as character</strong> / <strong>Add as enemy visual</strong> on a Unity-imported Asset
          Library model, or choose a mesh in the dropdown below. The viewport then shows that model and reports
          skinned-mesh / embedded-clip status for the idle, attack, and locomotion slots.
        </p>
      </div>
    );
  }

  const controlsEnabled = playback.canPlayInBrowser;

  return (
    <div className="space-y-2" data-testid="character-preview">
      <div
        ref={mountRef}
        className="relative min-h-[280px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black/40"
      />
      {loading > 0 && loading < 100 ? (
        <p className="text-xs text-muted-foreground">Loading character… {loading}%</p>
      ) : null}
      {error ? <p className="error text-sm">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {PREVIEW_SLOTS.map((slot) => (
          <Button
            key={slot}
            type="button"
            size="sm"
            variant={previewSlot === slot ? "default" : "outline"}
            data-testid={`character-preview-slot-${slot}`}
            onClick={() => onSlotChange?.(slot)}
          >
            Preview {slot}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="character-preview-play"
          disabled={!controlsEnabled}
          onClick={() => apiRef.current?.play?.()}
        >
          Play
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="character-preview-pause"
          disabled={!controlsEnabled}
          onClick={() => apiRef.current?.pause?.()}
        >
          Pause
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="character-preview-reset"
          disabled={!controlsEnabled}
          onClick={() => apiRef.current?.reset?.()}
        >
          Reset
        </Button>
      </div>
      <dl className="grid gap-1 text-xs text-muted-foreground" data-testid="character-preview-meta">
        <div>
          <dt className="inline font-medium text-foreground">Assigned ({playback.slot}): </dt>
          <dd className="inline" data-testid="character-preview-assigned">
            {playback.assignedLabel}
            {playback.assignedAssetId ? ` · ${playback.assignedAssetId.slice(0, 8)}…` : ""}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Playing in browser: </dt>
          <dd className="inline" data-testid="character-preview-playing">
            {playback.canPlayInBrowser && playback.playingClipName
              ? `${playback.playingClipName}${playing ? " (running)" : " (paused)"}`
              : "Nothing — browser not claiming this assignment"}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Compatibility: </dt>
          <dd className="inline" data-testid="character-preview-compat">
            {playback.compatibilityStatus}
            {playback.compatibilitySource ? ` (source: ${playback.compatibilitySource})` : " (no Unity evidence yet)"}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-foreground">Mesh skin (visual only): </dt>
          <dd className="inline">{meshHasSkin ? "skinned meshes present" : "none detected"} — not used as Unity rig proof</dd>
        </div>
        {clipNames.length ? (
          <div>
            <dt className="inline font-medium text-foreground">Embedded GLB clips: </dt>
            <dd className="inline">{clipNames.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      <p
        className="text-xs text-[var(--glow)]"
        data-testid="character-preview-hint"
        data-playback={playback.browserPlayback}
      >
        {playback.message}
      </p>
    </div>
  );
}

function disposeObject(root, THREE) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        Object.values(m).forEach((v) => {
          if (v && v.isTexture) v.dispose();
        });
        m.dispose?.();
      });
    }
  });
}
