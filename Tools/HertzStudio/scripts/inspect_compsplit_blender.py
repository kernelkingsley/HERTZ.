import bpy
import json
from pathlib import Path

fbx = Path(r"C:\Users\Kingsley\Downloads\newModelwithCompSplit.fbx")
out = Path(r"C:\Users\Kingsley\HERTZ\Tools\HertzStudio\data\forensics\compsplit-fbx-inspect.json")
out.parent.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
try:
    bpy.ops.import_scene.fbx(filepath=str(fbx), use_anim=False, automatic_bone_orientation=True)
except TypeError:
    bpy.ops.import_scene.fbx(filepath=str(fbx), use_anim=False)

armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
others = [o for o in bpy.data.objects if o.type not in ("ARMATURE", "MESH", "EMPTY")]

bone_names = []
for arm in armatures:
    bone_names.extend([b.name for b in arm.data.bones])

finger_re = ("thumb", "index", "middle", "ring", "pinky", "finger")
finger_bones = [n for n in bone_names if any(t in n.lower() for t in finger_re)]

images = [{"name": i.name, "filepath": i.filepath, "packed": bool(i.packed_file)} for i in bpy.data.images]
mats = [m.name for m in bpy.data.materials]

mesh_info = []
for o in meshes:
    mesh_info.append({
        "name": o.name,
        "verts": len(o.data.vertices),
        "parent": o.parent.name if o.parent else None,
        "materials": [s.material.name for s in o.material_slots if s.material],
    })

result = {
    "fbx": str(fbx),
    "byteSizeMB": round(fbx.stat().st_size / (1024 * 1024), 1),
    "blender": bpy.app.version_string,
    "objectCount": len(bpy.data.objects),
    "meshCount": len(meshes),
    "meshes": mesh_info,
    "armatureCount": len(armatures),
    "armatureNames": [a.name for a in armatures],
    "boneCount": len(bone_names),
    "bonesSample": bone_names[:60],
    "fingerBones": finger_bones,
    "fingerBoneCount": len(finger_bones),
    "hasFullFingerSet": all(
        any(t in n.lower() for n in finger_bones)
        for t in ("thumb", "index", "middle", "ring", "pinky")
    ) if finger_bones else False,
    "materialCount": len(mats),
    "materials": mats[:40],
    "imageCount": len(images),
    "images": images[:40],
    "otherTypes": sorted({o.type for o in others}),
    "mixamoReadyHint": (
        "already_rigged_inspect_download_settings"
        if armatures and len(finger_bones) >= 20
        else "join_meshes_then_mixamo_if_unrigged"
        if len(meshes) > 1 and not armatures
        else "mixamo_candidate"
    ),
}

out.write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps({
    "ok": True,
    "out": str(out),
    "meshCount": result["meshCount"],
    "armatureCount": result["armatureCount"],
    "boneCount": result["boneCount"],
    "fingerBoneCount": result["fingerBoneCount"],
    "hasFullFingerSet": result["hasFullFingerSet"],
    "imageCount": result["imageCount"],
    "hint": result["mixamoReadyHint"],
}))
