import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const DEFAULT_PLACEMENT_TRANSFORM = Object.freeze({
  position: { x: "0", y: "0", z: "0" },
  rotation: { x: "0", y: "0", z: "0" },
  scale: { x: "1", y: "1", z: "1" },
});

export function buildPlacementBody({ assetId, scenePath, scenes, transform }) {
  const scene = scenes.find((candidate) => candidate.path === scenePath);
  if (!scene || !Number.isInteger(scene.unityRevision) || scene.unityRevision < 0) {
    throw new Error("The selected scene revision is unknown. Refresh Unity's scene list and choose it again.");
  }
  const readVector = (name) => {
    const value = transform[name];
    const parsed = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
    if (![parsed.x, parsed.y, parsed.z].every(Number.isFinite)) {
      throw new Error(`${name} must contain finite X, Y, and Z values.`);
    }
    return parsed;
  };
  const position = readVector("position");
  const rotation = readVector("rotation");
  const scale = readVector("scale");
  if (![scale.x, scale.y, scale.z].every((value) => value >= 0.001 && value <= 1000)) {
    throw new Error("Scale values must be between 0.001 and 1000.");
  }
  return {
    scenePath,
    placement: {
      assetId,
      scenePath,
      expectedUnityRevision: scene.unityRevision,
      confirmSave: true,
      position,
      rotation,
      scale,
    },
  };
}

export function UnityPlacementControls({ value, onChange, disabled = false }) {
  const update = (group, axis, nextValue) => {
    onChange({ ...value, [group]: { ...value[group], [axis]: nextValue } });
  };
  return (
    <div className="grid gap-2 rounded-xl border border-white/10 p-3">
      {[
        ["position", "Position"],
        ["rotation", "Rotation (degrees)"],
        ["scale", "Scale"],
      ].map(([group, label]) => (
        <div key={group} className="space-y-1">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          <div className="grid grid-cols-3 gap-2">
            {["x", "y", "z"].map((axis) => (
              <Input
                key={axis}
                type="number"
                step={group === "scale" ? "0.1" : "0.25"}
                min={group === "scale" ? "0.001" : undefined}
                max={group === "scale" ? "1000" : undefined}
                aria-label={`${label} ${axis.toUpperCase()}`}
                value={value[group][axis]}
                disabled={disabled}
                onChange={(event) => update(group, axis, event.target.value)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
