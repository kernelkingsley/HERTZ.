import { RefreshCw } from "lucide-react";
import { useStudioTargetScene } from "../context/StudioTargetSceneContext.jsx";
import { Button } from "@/components/ui/button";

export default function TargetSceneControl() {
  const { scenes, targetScene, loading, saving, error, refresh, selectScene } = useStudioTargetScene();
  const selectedGuid = targetScene?.sceneGuid || "";

  return (
    <section className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-2" data-testid="studio-target-scene">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Target scene</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh Unity scenes"
          disabled={loading || saving}
          onClick={() => refresh().catch(() => {})}
        >
          <RefreshCw className="size-3" />
        </Button>
      </div>
      <select
        className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs"
        data-testid="studio-target-scene-select"
        aria-label="Studio target scene"
        value={selectedGuid}
        disabled={loading || saving}
        onChange={(event) => selectScene(event.target.value).catch(() => {})}
      >
        <option value="">Choose a scene</option>
        {scenes.filter((scene) => scene.guid).map((scene) => (
          <option key={scene.guid} value={scene.guid}>
            {scene.name || scene.path}
          </option>
        ))}
      </select>
      {targetScene ? (
        <p className="truncate text-[10px] text-muted-foreground" title={targetScene.scenePath} data-testid="studio-target-scene-path">
          {targetScene.available ? targetScene.scenePath : `Unavailable: ${targetScene.scenePath}`}
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">Sync and Deploy wait until you choose one scene.</p>
      )}
      {error ? <p className="text-[10px] text-[var(--glow)]">{error}</p> : null}
    </section>
  );
}