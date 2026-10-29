import bpy
import json
import sys
from pathlib import Path

fbx = Path(r"C:\Users\Kingsley\HERTZ\Tools\HertzStudio\data\private\assets\ab7afcbf-a39e-4b94-ba9a-912d83ef1288.fbx")
out = Path(r"C:\Users\Kingsley\HERTZ\Tools\HertzStudio\data\forensics\tpose-fbx-inspect.json")
out.parent.mkdir(parents=True, exist_ok=True)

# Fresh scene
bpy.ops.wm.read_factory_settings(use_empty=True)

kwargs = {
    "filepath": str(fbx),
    "automatic_bone_orientation": True,
    "use_anim": False,
}
# Blender FBX importer option names vary slightly by version; keep compatible.
try:
    bpy.ops.import_scene.fbx(**kwargs)
except TypeError:
    kwargs.pop("automatic_bone_orientation", None)
    bpy.ops.import_scene.fbx(**kwargs)

armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]

bone_names = []
bone_parents = {}
for arm in armatures:
    for b in arm.data.bones:
        bone_names.append(b.name)
        bone_parents[b.name] = b.parent.name if b.parent else None

finger_re = ("thumb", "index", "middle", "ring", "pinky", "finger")
hand_re = ("hand",) + finger_re
finger_bones = [n for n in bone_names if any(t in n.lower() for t in finger_re)]
hand_bones = [n for n in bone_names if any(t in n.lower() for t in hand_re)]

# Approximate rest-pose hand centers (armature local / world)
hand_centers = {}
for arm in armatures:
    mw = arm.matrix_world
    for side in ("Left", "Right", "L", "R"):
        candidates = [b for b in arm.data.bones if "hand" in b.name.lower() and side.lower() in b.name.lower().replace("left", "l").replace("right", "r")]
        # Prefer exact Mixamo names
        preferred = [b for b in arm.data.bones if b.name in (f"mixamorig:{side}Hand", f"mixamorig_{side}Hand", f"{side}Hand")]
        use = preferred or [b for b in arm.data.bones if b.name.lower().endswith("hand") and side.lower()[:1] in b.name.lower()]
        if not use and side in ("Left", "Right"):
            use = [b for b in arm.data.bones if "hand" in b.name.lower() and side.lower() in b.name.lower()]
        if use:
            b = use[0]
            loc = mw @ b.head_local.to_4d()
            hand_centers[b.name] = [round(loc.x, 4), round(loc.y, 4), round(loc.z, 4)]

# Materials / images
mats = []
for m in bpy.data.materials:
    imgs = []
    if m.use_nodes and m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image:
                imgs.append({"name": n.image.name, "filepath": n.image.filepath, "size": list(n.image.size) if n.image.has_data else None})
    mats.append({"name": m.name, "images": imgs})

images = [{"name": i.name, "filepath": i.filepath, "packed": bool(i.packed_file), "size": list(i.size) if i.has_data else None} for i in bpy.data.images]

# Mesh bounds for hands stuck-together clue
mesh_bounds = []
for o in meshes:
    pts = [o.matrix_world @ v.co for v in o.data.vertices] if o.data.vertices else []
    if not pts:
        continue
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    zs = [p.z for p in pts]
    mesh_bounds.append({
        "name": o.name,
        "verts": len(o.data.vertices),
        "min": [round(min(xs), 4), round(min(ys), 4), round(min(zs), 4)],
        "max": [round(max(xs), 4), round(max(ys), 4), round(max(zs), 4)],
    })

result = {
    "fbx": str(fbx),
    "blender": bpy.app.version_string,
    "armatureCount": len(armatures),
    "armatureNames": [a.name for a in armatures],
    "meshCount": len(meshes),
    "meshNames": [m.name for m in meshes],
    "boneCount": len(bone_names),
    "bones": bone_names,
    "boneParents": bone_parents,
    "handBones": hand_bones,
    "fingerBones": finger_bones,
    "fingerBoneCount": len(finger_bones),
    "hasFingerRig": len(finger_bones) >= 6,
    "handCenters": hand_centers,
    "materials": mats,
    "images": images,
    "meshBounds": mesh_bounds,
    "note": "Mixamo T-Pose often has palms facing body; hands can look glued until rest pose / animation. Finger grip needs finger bones + animation or IK, not just presence.",
}

out.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({"ok": True, "out": str(out), "fingerBoneCount": result["fingerBoneCount"], "hasFingerRig": result["hasFingerRig"], "boneCount": result["boneCount"], "imageCount": len(images)}))
