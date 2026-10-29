import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useStudioTargetScene } from "../context/StudioTargetSceneContext.jsx";
import { DEFAULT_PLACEMENT_TRANSFORM, UnityPlacementControls } from "./UnityPlacementControls.jsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function newRequestId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `deploy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePlacementTransform(transform) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    position: {
      x: number(transform.position.x, 0),
      y: number(transform.position.y, 0),
      z: number(transform.position.z, 0),
    },
    rotation: {
      x: number(transform.rotation.x, 0),
      y: number(transform.rotation.y, 0),
      z: number(transform.rotation.z, 0),
    },
    scale: {
      x: number(transform.scale.x, 1),
      y: number(transform.scale.y, 1),
      z: number(transform.scale.z, 1),
    },
  };
}

function confirmManagedDeploy({ kind, mode, scenePath, quantity = 1, transform }) {
  const action = mode === "test" ? "Test in Unity" : "Deploy to scene";
  const subject = kind === "weapon" ? "the managed dual-pistol definition" : `${quantity} managed character instance${quantity === 1 ? "" : "s"}`;
  const transformText =
    kind === "character"
      ? `\nPosition ${transform.position.x}, ${transform.position.y}, ${transform.position.z}` +
        `\nRotation ${transform.rotation.x}, ${transform.rotation.y}, ${transform.rotation.z}` +
        `\nScale ${transform.scale.x}, ${transform.scale.y}, ${transform.scale.z}`
      : "";
  return window.confirm(
    `${action}: apply ${subject} to ONE Unity scene and save?\n\n${scenePath}${transformText}\n\n` +
      "Repeated deployment updates the same managed runtime objects. The tracked XR Origin, headset camera, hands, and controllers are never replaced.",
  );
}

export default function CatalogSceneDeployPanel({
  kind = "character",
  weaponId = "",
  weaponVersion = null,
  characterId = "",
  characterVersion = null,
  characterProfiles = [],
  catalogLabel = "catalog entry",
  disabled = false,
  onMessage,
  onError,
  onDeployed,
}) {
  const [mode, setMode] = useState("test");
  const [profileId, setProfileId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [transform, setTransform] = useState(() => ({
    position: { ...DEFAULT_PLACEMENT_TRANSFORM.position },
    rotation: { ...DEFAULT_PLACEMENT_TRANSFORM.rotation },
    scale: { ...DEFAULT_PLACEMENT_TRANSFORM.scale },
  }));
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [scenesError, setScenesError] = useState("");
  const { scenes, targetScene, error: sharedScenesError, refresh } = useStudioTargetScene();

  const target = targetScene?.available ? targetScene : null;
  const selectedScene = target
    ? scenes.find((scene) => scene.path === target.scenePath && scene.guid === target.sceneGuid) || null
    : null;
  const compatibleProfiles = useMemo(
    () => characterProfiles.filter((profile) => profile.modelId === characterId),
    [characterProfiles, characterId],
  );

  async function refreshScenes() {
    setScenesError("");
    try {
      const response = await refresh();
      if (!(response?.scenes || []).length) setScenesError("No Unity scenes reported. Start connector + bridge, then Refresh.");
    } catch (error) {
      setScenesError(String(error.message || error));
    }
  }

  async function deploy() {
    onError?.("");
    onMessage?.("");
    const id = kind === "weapon" ? weaponId : characterId;
    if (!id) {
      onError?.(`Save and Sync the ${catalogLabel} before Test/Deploy.`);
      return;
    }
    if (!target || !selectedScene || !Number.isInteger(selectedScene.unityRevision)) {
      onError?.("Choose an available shared Target scene in the left panel, then Refresh scenes.");
      return;
    }
    const qty = kind === "character" ? Math.max(1, Math.min(8, Number(quantity) || 1)) : 1;
    const deploymentTransform = normalizePlacementTransform(transform);
    if (!confirmManagedDeploy({ kind, mode, scenePath: target.scenePath, quantity: qty, transform: deploymentTransform })) return;

    setBusy(true);
    setLastResult(null);
    try {
      const body = {
        requestId: newRequestId(),
        scenePath: target.scenePath,
        sceneGuid: target.sceneGuid,
        expectedUnityRevision: selectedScene.unityRevision,
        confirmSave: true,
        expectedVersion: kind === "weapon" ? weaponVersion : characterVersion,
      };
      if (kind === "character") {
        Object.assign(body, {
          profileId: profileId || null,
          quantity: qty,
          position: deploymentTransform.position,
          rotation: deploymentTransform.rotation,
          scale: deploymentTransform.scale,
        });
      }
      const endpoint =
        kind === "weapon"
          ? `/api/weapons/${weaponId}/deploy-to-scene`
          : `/api/characters/models/${characterId}/deploy-to-scene`;
      const queued = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      const result = {
        status: queued.deduplicated ? "deduplicated" : "queued",
        scenePath: target.scenePath,
        unityRevision: selectedScene.unityRevision,
        requestId: queued.requestId || null,
        jobId: queued.job?.id || null,
        quantity: qty,
      };
      setLastResult(result);
      onMessage?.(
        `${mode === "test" ? "Test" : "Deploy"} ${result.status} → managed ${kind} runtime in ${target.scenePath} (rev ${selectedScene.unityRevision}).`,
      );
      onDeployed?.(queued);
    } catch (error) {
      const message = String(error.message || error);
      setLastResult({ status: "failed", scenePath: target.scenePath, placeError: message });
      onError?.(message);
    } finally {
      setBusy(false);
      refreshScenes().catch(() => {});
    }
  }

  const canDeploy = Boolean(kind === "weapon" ? weaponId : characterId) && Boolean(selectedScene) && !disabled && !busy;

  return (
    <div className="space-y-3 rounded-xl border border-white/10 p-3" data-testid="catalog-scene-deploy" data-kind={kind}>
      <div>
        <p className="text-sm font-medium">Unity scene actions</p>
        <p className="text-xs text-muted-foreground" data-testid="catalog-scene-policy">
          Sync writes managed project definitions. Test / Deploy applies the saved {kind === "weapon" ? "weapon" : "character and optional behavior profile"} to the one shared Target scene. It never broadcasts or replaces tracked XR objects.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="catalog-scene-mode">
        <Button type="button" size="sm" variant={mode === "test" ? "default" : "outline"} data-testid="catalog-scene-mode-test" disabled={disabled || busy} onClick={() => setMode("test")}>Test in Unity</Button>
        <Button type="button" size="sm" variant={mode === "deploy" ? "default" : "outline"} data-testid="catalog-scene-mode-deploy" disabled={disabled || busy} onClick={() => setMode("deploy")}>Deploy to scene</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={refreshScenes}>Refresh scenes</Button>
      </div>

      <div className="space-y-1" data-testid="catalog-scene-shared-target">
        <p className="text-xs">
          Shared Target scene: <code>{target?.scenePath || "Not selected"}</code>
          {selectedScene ? ` · revision ${selectedScene.unityRevision}` : " · choose or refresh in the left panel"}
        </p>
        <p className="text-xs text-muted-foreground">Test scenes and SampleScene are valid when explicitly selected. This action affects one scene only.</p>
      </div>

      {scenesError || sharedScenesError ? <p className="text-xs text-[var(--glow)]" data-testid="catalog-scene-list-error">{scenesError || sharedScenesError}</p> : null}

      {kind === "character" ? (
        <>
          {compatibleProfiles.length ? (
            <div>
              <Label htmlFor="catalog-character-profile">Enemy behavior profile (optional)</Label>
              <select id="catalog-character-profile" data-testid="catalog-character-profile" className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm" value={profileId} disabled={disabled || busy} onChange={(event) => setProfileId(event.target.value)}>
                <option value="">Visual only</option>
                {compatibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}</option>)}
              </select>
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
            <div>
              <Label htmlFor="catalog-place-qty">Quantity</Label>
              <Input id="catalog-place-qty" data-testid="catalog-place-quantity" type="number" min="1" max="8" value={quantity} disabled={disabled || busy} onChange={(event) => setQuantity(event.target.value)} />
            </div>
            <p className="self-end text-xs text-muted-foreground">Repeated deployment updates stable managed roots. A synced profile enables the existing enemy runtime; visual-only deploy shows the saved model.</p>
          </div>
          <UnityPlacementControls value={transform} onChange={setTransform} disabled={disabled || busy} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Binds the saved dual-pistol definition into the selected scene runtime. Repeated deploys update the same managed binding.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" data-testid="catalog-scene-place" disabled={!canDeploy} onClick={deploy}>
          {busy ? "Deploying…" : mode === "test" ? "Confirm Test bind" : "Confirm Deploy bind"}
        </Button>
        {target?.scenePath ? (
          <>
            <Link to={`/level-editor?scene=${encodeURIComponent(target.scenePath)}`} className="inline-flex h-8 items-center rounded-md border border-white/15 px-3 text-xs" data-testid="catalog-open-level-editor">Open in Level Editor</Link>
            <span className="text-xs text-muted-foreground" data-testid="catalog-open-unity-hint">Open in Unity: File → Open Scene → {target.scenePath}</span>
          </>
        ) : null}
      </div>

      {lastResult ? (
        <div className="rounded-lg border border-white/10 px-2 py-1.5 text-xs" data-testid="catalog-scene-place-status" data-status={lastResult.status} data-scene={lastResult.scenePath || ""}>
          Last deploy: <strong>{lastResult.status}</strong> → {lastResult.scenePath}
          {lastResult.unityRevision != null ? ` (rev ${lastResult.unityRevision})` : ""}
          {lastResult.placeError ? ` — ${lastResult.placeError}` : ""}
        </div>
      ) : null}

      {!canDeploy && !(disabled || busy) ? <p className="text-xs text-muted-foreground" data-testid="catalog-scene-need-mesh">Save and Sync this {catalogLabel}, and choose an available shared Target scene.</p> : null}
    </div>
  );
}
