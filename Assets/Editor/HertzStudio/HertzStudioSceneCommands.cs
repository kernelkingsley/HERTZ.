using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Typed scene command execution for W03 (instantiate / transform / duplicate / remove).
    /// Called from HertzStudioHttpBridge apply route. Editor-only.
    /// </summary>
    internal static class HertzStudioSceneCommands
    {
        public sealed class SceneOperation
        {
            public string Op;
            public string ObjectId;
            public string DraftObjectId;
            public string AssetId;
            public string DisplayName;
            public string PrefabPath;
            public string ImportedPath;
            public string TargetObjectId;
            public string Space;
            public int MaterialSlot;
            public Vector3 Position;
            public Vector3 Rotation;
            public Vector3 Scale;
            public Vector3 LocalPosition;
            public Vector3 LocalRotation;
            public Vector3 LocalScale;
            public bool HasPosition;
            public bool HasRotation;
            public bool HasScale;
            public bool HasLocalPosition;
            public bool HasLocalRotation;
            public bool HasLocalScale;
        }

        public static List<SceneOperation> ParseOperations(string body)
        {
            var list = new List<SceneOperation>();
            if (string.IsNullOrEmpty(body)) return list;
            var key = "\"operations\"";
            var idx = body.IndexOf(key, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return list;
            var bracket = body.IndexOf('[', idx);
            if (bracket < 0) return list;
            var depth = 0;
            var end = -1;
            for (var i = bracket; i < body.Length; i++)
            {
                if (body[i] == '[') depth++;
                else if (body[i] == ']')
                {
                    depth--;
                    if (depth == 0)
                    {
                        end = i;
                        break;
                    }
                }
            }

            if (end < 0) return list;
            var array = body.Substring(bracket + 1, end - bracket - 1);
            foreach (var chunk in SplitObjects(array))
            {
                var wrapped = "{" + chunk + "}";
                var op = new SceneOperation
                {
                    Op = ReadString(wrapped, "op"),
                    ObjectId = ReadString(wrapped, "objectId"),
                    DraftObjectId = ReadString(wrapped, "draftObjectId"),
                    AssetId = ReadString(wrapped, "assetId"),
                    DisplayName = ReadString(wrapped, "displayName"),
                    PrefabPath = ReadString(wrapped, "prefabPath"),
                    ImportedPath = ReadString(wrapped, "importedPath"),
                    TargetObjectId = ReadString(wrapped, "targetObjectId"),
                    MaterialSlot = ReadInt(wrapped, "materialSlot"),
                };
                op.Space = ReadString(wrapped, "space");
                TryReadVec3(wrapped, "position", out op.Position, out op.HasPosition);
                TryReadVec3(wrapped, "rotation", out op.Rotation, out op.HasRotation);
                TryReadVec3(wrapped, "scale", out op.Scale, out op.HasScale);
                TryReadVec3(wrapped, "localPosition", out op.LocalPosition, out op.HasLocalPosition);
                TryReadVec3(wrapped, "localRotation", out op.LocalRotation, out op.HasLocalRotation);
                TryReadVec3(wrapped, "localScale", out op.LocalScale, out op.HasLocalScale);
                list.Add(op);
            }

            return list;
        }

        public static string HashOperations(string requestId, string scenePath, int baseRevision, List<SceneOperation> ops)
        {
            var sb = new StringBuilder();
            AppendString(sb, requestId);
            AppendString(sb, scenePath);
            sb.Append(baseRevision.ToString(CultureInfo.InvariantCulture)).Append(';');
            sb.Append(ops.Count.ToString(CultureInfo.InvariantCulture)).Append(';');
            foreach (var op in ops)
            {
                AppendString(sb, op.Op);
                AppendString(sb, op.ObjectId);
                AppendString(sb, op.DraftObjectId);
                AppendString(sb, op.AssetId);
                AppendString(sb, op.DisplayName);
                AppendString(sb, op.PrefabPath);
                AppendString(sb, AssetDatabase.AssetPathToGUID(op.PrefabPath ?? string.Empty));
                AppendString(sb, op.ImportedPath);
                AppendString(sb, AssetDatabase.AssetPathToGUID(op.ImportedPath ?? string.Empty));
                AppendString(sb, op.TargetObjectId);
                sb.Append(op.MaterialSlot.ToString(CultureInfo.InvariantCulture)).Append(';');
                AppendString(sb, op.Space);
                AppendVector(sb, op.HasPosition, op.Position);
                AppendVector(sb, op.HasRotation, op.Rotation);
                AppendVector(sb, op.HasScale, op.Scale);
                AppendVector(sb, op.HasLocalPosition, op.LocalPosition);
                AppendVector(sb, op.HasLocalRotation, op.LocalRotation);
                AppendVector(sb, op.HasLocalScale, op.LocalScale);
            }

            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
            var hex = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            return hex.ToString();
        }

        private static void AppendString(StringBuilder sb, string value)
        {
            value ??= string.Empty;
            sb.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append(';');
        }

        private static void AppendVector(StringBuilder sb, bool hasValue, Vector3 value)
        {
            sb.Append(hasValue ? "1;" : "0;");
            if (!hasValue) return;
            sb.Append(value.x.ToString("R", CultureInfo.InvariantCulture)).Append(',')
                .Append(value.y.ToString("R", CultureInfo.InvariantCulture)).Append(',')
                .Append(value.z.ToString("R", CultureInfo.InvariantCulture)).Append(';');
        }

        public static bool IsProtectedHierarchy(GameObject go)
        {
            if (go == null) return true;
            var t = go.transform;
            while (t != null)
            {
                var n = t.name ?? string.Empty;
                if (n.IndexOf("XR Origin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("XR Rig", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("Camera Offset", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    string.Equals(n, "Main Camera", StringComparison.OrdinalIgnoreCase) ||
                    n.IndexOf("Left Controller", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("Right Controller", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return true;
                }

                t = t.parent;
            }

            return false;
        }

        public static string FindImportedModelPath(string assetId) =>
            FindImportedAssetPath(assetId, new[] { ".prefab", ".gltf", ".glb", ".fbx" });

        public static string FindImportedAssetPath(string assetId, string[] preferredExtensions)
        {
            var folder = $"Assets/HertzStudio/Imported/{assetId}";
            if (!AssetDatabase.IsValidFolder(folder)) return null;
            var guids = AssetDatabase.FindAssets(string.Empty, new[] { folder });
            string fallback = null;
            foreach (var preferred in preferredExtensions ?? Array.Empty<string>())
            {
                foreach (var guid in guids)
                {
                    var p = AssetDatabase.GUIDToAssetPath(guid);
                    if (p.EndsWith(preferred, StringComparison.OrdinalIgnoreCase)) return p;
                }
            }

            foreach (var guid in guids)
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(fallback) && !p.EndsWith(".meta", StringComparison.OrdinalIgnoreCase))
                {
                    fallback = p;
                }
            }

            return fallback;
        }

        public static GameObject FindByObjectId(string objectId)
        {
            if (GlobalObjectId.TryParse(objectId, out var globalId))
            {
                return GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalId) as GameObject;
            }

            return GameObject.Find(objectId);
        }

        /// <summary>
        /// Validate all ops, then apply in one Undo group. Returns null on success (caller finalizes revision),
        /// or an error message string.
        /// </summary>
        public static string ApplyOrError(
            Scene scene,
            List<SceneOperation> operations,
            out List<string> bindingJsonObjects)
        {
            bindingJsonObjects = new List<string>();
            var planned = new List<(SceneOperation op, GameObject existing, string assetPath)>();
            foreach (var op in operations)
            {
                if (string.IsNullOrEmpty(op.Op)) return "Operation missing op.";
                switch (op.Op)
                {
                    case "instantiate_model":
                    {
                        if (string.IsNullOrEmpty(op.AssetId)) return "instantiate_model requires assetId.";
                        var assetPath = !string.IsNullOrEmpty(op.PrefabPath)
                            ? op.PrefabPath
                            : !string.IsNullOrEmpty(op.ImportedPath)
                                ? op.ImportedPath
                                : FindImportedModelPath(op.AssetId);
                        if (string.IsNullOrEmpty(assetPath) || AssetDatabase.LoadMainAssetAtPath(assetPath) == null)
                        {
                            return $"Imported model not found for asset {op.AssetId}. Import to Unity first.";
                        }

                        planned.Add((op, null, assetPath));
                        break;
                    }
                    case "transform":
                    case "duplicate":
                    case "remove":
                    {
                        var go = FindByObjectId(op.ObjectId);
                        if (go == null) return $"Object not found: {op.ObjectId}";
                        if (go.scene != scene) return $"Object not in active scene: {op.ObjectId}";
                        if (IsProtectedHierarchy(go))
                        {
                            return $"Refusing to mutate protected XR/camera object: {op.ObjectId}";
                        }

                        planned.Add((op, go, null));
                        break;
                    }
                    case "replace_floor_wall":
                    case "assign_material":
                    case "assign_sprite":
                    case "assign_ui":
                    case "assign_audio":
                    case "assign_animation":
                    {
                        var targetId = !string.IsNullOrEmpty(op.TargetObjectId) ? op.TargetObjectId : op.ObjectId;
                        var go = FindByObjectId(targetId);
                        if (go == null) return $"Target object not found: {targetId}";
                        if (go.scene != scene) return $"Target not in active scene: {targetId}";
                        if (IsProtectedHierarchy(go))
                        {
                            return $"Refusing typed assignment on protected XR/camera object: {targetId}";
                        }

                        string assetPath = null;
                        if (op.Op == "replace_floor_wall")
                        {
                            assetPath = !string.IsNullOrEmpty(op.PrefabPath)
                                ? op.PrefabPath
                                : !string.IsNullOrEmpty(op.ImportedPath)
                                    ? op.ImportedPath
                                    : FindImportedModelPath(op.AssetId);
                            if (string.IsNullOrEmpty(assetPath) || AssetDatabase.LoadMainAssetAtPath(assetPath) == null)
                            {
                                return $"Replacement model not found for asset {op.AssetId}.";
                            }
                        }
                        else if (op.Op == "assign_material")
                        {
                            assetPath = !string.IsNullOrEmpty(op.ImportedPath)
                                ? op.ImportedPath
                                : FindImportedAssetPath(op.AssetId, new[] { ".mat", ".png", ".jpg", ".jpeg", ".tga", ".psd" });
                            if (string.IsNullOrEmpty(assetPath))
                            {
                                return $"Material/texture asset not found for {op.AssetId}.";
                            }
                        }
                        else if (op.Op == "assign_sprite" || op.Op == "assign_ui")
                        {
                            assetPath = !string.IsNullOrEmpty(op.ImportedPath)
                                ? op.ImportedPath
                                : FindImportedAssetPath(op.AssetId, new[] { ".png", ".jpg", ".jpeg", ".psd", ".asset" });
                            if (string.IsNullOrEmpty(assetPath))
                            {
                                return $"Sprite/UI asset not found for {op.AssetId}.";
                            }
                        }
                        else if (op.Op == "assign_audio")
                        {
                            assetPath = !string.IsNullOrEmpty(op.ImportedPath)
                                ? op.ImportedPath
                                : FindImportedAssetPath(op.AssetId, new[] { ".wav", ".mp3", ".ogg", ".aiff" });
                            if (string.IsNullOrEmpty(assetPath))
                            {
                                return $"Audio clip not found for {op.AssetId}.";
                            }
                        }
                        else if (op.Op == "assign_animation")
                        {
                            assetPath = !string.IsNullOrEmpty(op.ImportedPath)
                                ? op.ImportedPath
                                : FindImportedAssetPath(op.AssetId, new[] { ".controller", ".anim", ".fbx", ".gltf", ".glb" });
                            if (string.IsNullOrEmpty(assetPath))
                            {
                                return $"Animation asset not found for {op.AssetId}.";
                            }
                        }

                        planned.Add((op, go, assetPath));
                        break;
                    }
                    default:
                        return $"Unsupported operation: {op.Op}";
                }
            }

            Undo.IncrementCurrentGroup();
            var group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("HERTZ Studio Apply Commands");
            var generatedAssetPaths = new List<string>();
            try
            {
                foreach (var step in planned)
                {
                    var op = step.op;
                    switch (op.Op)
                    {
                        case "instantiate_model":
                        {
                            var main = AssetDatabase.LoadMainAssetAtPath(step.assetPath);
                            GameObject instance = null;
                            if (main is GameObject prefab)
                            {
                                instance = PrefabUtility.InstantiatePrefab(prefab, scene) as GameObject;
                            }

                            if (instance == null && main != null)
                            {
                                instance = UnityEngine.Object.Instantiate(main) as GameObject;
                                if (instance != null) SceneManager.MoveGameObjectToScene(instance, scene);
                            }

                            if (instance == null) throw new InvalidOperationException($"Could not instantiate {step.assetPath}");
                            Undo.RegisterCreatedObjectUndo(instance, "HERTZ Studio Instantiate");
                            if (!string.IsNullOrEmpty(op.DisplayName)) instance.name = op.DisplayName;
                            if (op.HasPosition) instance.transform.position = op.Position;
                            if (op.HasRotation) instance.transform.eulerAngles = op.Rotation;
                            if (op.HasScale) instance.transform.localScale = op.Scale;
                            if (!string.IsNullOrEmpty(op.AssetId))
                            {
                                var guid = AssetDatabase.AssetPathToGUID(step.assetPath);
                                var provenance = HertzStudioAssetProvenance.EnsureOn(
                                    instance, op.AssetId, guid, step.assetPath);
                                if (provenance != null)
                                {
                                    Undo.RegisterCreatedObjectUndo(provenance, "HERTZ Studio asset provenance");
                                    EditorUtility.SetDirty(provenance);
                                }
                            }

                            var gid = GlobalObjectId.GetGlobalObjectIdSlow(instance).ToString();
                            bindingJsonObjects.Add(
                                "{\"draftObjectId\":\"" + Escape(op.DraftObjectId) +
                                "\",\"unityObjectId\":\"" + Escape(gid) +
                                "\",\"name\":\"" + Escape(instance.name) + "\"}");
                            break;
                        }
                        case "transform":
                        {
                            Undo.RecordObject(step.existing.transform, "HERTZ Studio Transform");
                            var useLocal =
                                string.Equals(op.Space, "local", StringComparison.OrdinalIgnoreCase) ||
                                (op.HasLocalPosition && !op.HasPosition);
                            if (useLocal)
                            {
                                if (op.HasLocalPosition) step.existing.transform.localPosition = op.LocalPosition;
                                else if (op.HasPosition) step.existing.transform.localPosition = op.Position;
                                if (op.HasLocalRotation) step.existing.transform.localEulerAngles = op.LocalRotation;
                                else if (op.HasRotation) step.existing.transform.localEulerAngles = op.Rotation;
                                if (op.HasLocalScale) step.existing.transform.localScale = op.LocalScale;
                                else if (op.HasScale) step.existing.transform.localScale = op.Scale;
                            }
                            else
                            {
                                // World space for hierarchy roots — children follow via Unity local hierarchy.
                                if (op.HasPosition) step.existing.transform.position = op.Position;
                                if (op.HasRotation) step.existing.transform.eulerAngles = op.Rotation;
                                if (op.HasLocalScale) step.existing.transform.localScale = op.LocalScale;
                                else if (op.HasScale) step.existing.transform.localScale = op.Scale;
                            }

                            EditorUtility.SetDirty(step.existing.transform);
                            break;
                        }
                        case "duplicate":
                        {
                            var sourceRoot = PrefabUtility.GetNearestPrefabInstanceRoot(step.existing) ?? step.existing;
                            var copy = HertzStudioPrefabDuplication.Duplicate(sourceRoot, scene);
                            Undo.RegisterCreatedObjectUndo(copy, "HERTZ Studio Duplicate");
                            if (sourceRoot.transform.parent != null)
                            {
                                Undo.SetTransformParent(
                                    copy.transform,
                                    sourceRoot.transform.parent,
                                    "HERTZ Studio Duplicate Parent");
                            }

                            copy.name = sourceRoot.name + " Copy";
                            if (op.HasPosition) copy.transform.position = op.Position;
                            else copy.transform.position = sourceRoot.transform.position + new Vector3(0.5f, 0f, 0.5f);
                            if (op.HasRotation) copy.transform.eulerAngles = op.Rotation;
                            else copy.transform.rotation = sourceRoot.transform.rotation;
                            if (op.HasScale) copy.transform.localScale = op.Scale;
                            else copy.transform.localScale = sourceRoot.transform.localScale;
                            var gid = GlobalObjectId.GetGlobalObjectIdSlow(copy).ToString();
                            bindingJsonObjects.Add(
                                "{\"draftObjectId\":\"" + Escape(op.DraftObjectId) +
                                "\",\"unityObjectId\":\"" + Escape(gid) +
                                "\",\"name\":\"" + Escape(copy.name) + "\"}");
                            break;
                        }
                        case "remove":
                            Undo.DestroyObjectImmediate(step.existing);
                            break;
                        case "assign_material":
                        {
                            var err = ApplyMaterialAssignment(
                                step.existing, step.assetPath, op.MaterialSlot, generatedAssetPaths);
                            if (err != null) throw new InvalidOperationException(err);
                            break;
                        }
                        case "assign_sprite":
                        {
                            var err = ApplySpriteAssignment(step.existing, step.assetPath);
                            if (err != null) throw new InvalidOperationException(err);
                            break;
                        }
                        case "assign_ui":
                        {
                            var err = ApplyUiImageAssignment(step.existing, step.assetPath);
                            if (err != null) throw new InvalidOperationException(err);
                            break;
                        }
                        case "assign_audio":
                        {
                            var err = ApplyAudioAssignment(step.existing, step.assetPath);
                            if (err != null) throw new InvalidOperationException(err);
                            break;
                        }
                        case "assign_animation":
                        {
                            var err = ApplyAnimationAssignment(step.existing, step.assetPath);
                            if (err != null) throw new InvalidOperationException(err);
                            break;
                        }
                        case "replace_floor_wall":
                        {
                            var err = ReplaceFloorOrWall(step.existing, step.assetPath, op, scene, bindingJsonObjects);
                            if (err != null) throw new InvalidOperationException(err);
                            break;
                        }
                    }
                }

                Undo.CollapseUndoOperations(group);
                return null;
            }
            catch (Exception ex)
            {
                Undo.RevertAllDownToGroup(group);
                // Undo does not delete project assets created during the batch — remove them explicitly.
                foreach (var path in generatedAssetPaths)
                {
                    if (string.IsNullOrEmpty(path)) continue;
                    if (AssetDatabase.LoadMainAssetAtPath(path) != null)
                    {
                        AssetDatabase.DeleteAsset(path);
                    }
                }

                if (generatedAssetPaths.Count > 0) AssetDatabase.Refresh();
                return $"Apply rolled back: {ex.Message}";
            }
        }

        private static string ApplyMaterialAssignment(
            GameObject go,
            string assetPath,
            int slot,
            List<string> generatedAssetPaths)
        {
            var renderer = go.GetComponent<Renderer>() ?? go.GetComponentInChildren<Renderer>(true);
            if (renderer == null) return "Target has no Renderer for material assignment.";
            var mats = renderer.sharedMaterials;
            if (mats == null || mats.Length == 0) return "Renderer has no material slots.";
            if (slot < 0 || slot >= mats.Length) return $"Material slot {slot} out of range (count {mats.Length}).";

            Material mat = null;
            var main = AssetDatabase.LoadMainAssetAtPath(assetPath);
            if (main is Material material) mat = material;
            else if (main is Texture2D tex)
            {
                // Create a non-leaking project material under HertzStudio/Generated when assigning a texture.
                var genFolder = "Assets/HertzStudio/GeneratedMaterials";
                if (!AssetDatabase.IsValidFolder("Assets/HertzStudio")) AssetDatabase.CreateFolder("Assets", "HertzStudio");
                if (!AssetDatabase.IsValidFolder(genFolder)) AssetDatabase.CreateFolder("Assets/HertzStudio", "GeneratedMaterials");
                var matPath = $"{genFolder}/{go.name}_slot{slot}_{System.IO.Path.GetFileNameWithoutExtension(assetPath)}.mat";
                mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
                if (mat == null)
                {
                    var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
                    mat = new Material(shader) { name = System.IO.Path.GetFileNameWithoutExtension(matPath) };
                    if (mat.HasProperty("_BaseMap")) mat.SetTexture("_BaseMap", tex);
                    else if (mat.HasProperty("_MainTex")) mat.SetTexture("_MainTex", tex);
                    AssetDatabase.CreateAsset(mat, matPath);
                    generatedAssetPaths?.Add(matPath);
                }
            }

            if (mat == null) return $"Could not load Material/Texture at {assetPath}.";
            Undo.RecordObject(renderer, "HERTZ Studio Assign Material");
            var next = (Material[])mats.Clone();
            next[slot] = mat;
            renderer.sharedMaterials = next;
            EditorUtility.SetDirty(renderer);
            return null;
        }

        private static string ApplySpriteAssignment(GameObject go, string assetPath)
        {
            var sr = go.GetComponent<SpriteRenderer>() ?? go.GetComponentInChildren<SpriteRenderer>(true);
            if (sr == null) return "Target has no SpriteRenderer.";
            var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
            if (sprite == null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
                if (tex != null)
                {
                    var sprites = AssetDatabase.LoadAllAssetsAtPath(assetPath);
                    foreach (var a in sprites)
                    {
                        if (a is Sprite s) { sprite = s; break; }
                    }
                }
            }

            if (sprite == null) return $"No Sprite found at {assetPath}.";
            Undo.RecordObject(sr, "HERTZ Studio Assign Sprite");
            sr.sprite = sprite;
            EditorUtility.SetDirty(sr);
            return null;
        }

        private static string ApplyUiImageAssignment(GameObject go, string assetPath)
        {
            var image = go.GetComponent<UnityEngine.UI.Image>() ?? go.GetComponentInChildren<UnityEngine.UI.Image>(true);
            if (image == null) return "Target has no UnityEngine.UI.Image.";
            var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
            if (sprite == null)
            {
                foreach (var a in AssetDatabase.LoadAllAssetsAtPath(assetPath))
                {
                    if (a is Sprite s) { sprite = s; break; }
                }
            }

            if (sprite == null) return $"No Sprite found for UI Image at {assetPath}.";
            Undo.RecordObject(image, "HERTZ Studio Assign UI Image");
            image.sprite = sprite;
            EditorUtility.SetDirty(image);
            return null;
        }

        private static string ApplyAudioAssignment(GameObject go, string assetPath)
        {
            var source = go.GetComponent<AudioSource>() ?? go.GetComponentInChildren<AudioSource>(true);
            if (source == null) return "Target has no AudioSource.";
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(assetPath);
            if (clip == null) return $"No AudioClip at {assetPath}.";
            Undo.RecordObject(source, "HERTZ Studio Assign Audio");
            source.clip = clip;
            EditorUtility.SetDirty(source);
            return null;
        }

        private static string ApplyAnimationAssignment(GameObject go, string assetPath)
        {
            var animator = go.GetComponent<Animator>() ?? go.GetComponentInChildren<Animator>(true);
            if (animator == null) return "Target has no Animator.";
            var controller = AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>(assetPath);
            if (controller == null)
            {
                // FBX/GLTF may contain an animator controller sub-asset.
                foreach (var a in AssetDatabase.LoadAllAssetsAtPath(assetPath))
                {
                    if (a is RuntimeAnimatorController c) { controller = c; break; }
                }
            }

            if (controller == null) return $"No RuntimeAnimatorController at {assetPath}.";
            Undo.RecordObject(animator, "HERTZ Studio Assign Animation");
            animator.runtimeAnimatorController = controller;
            EditorUtility.SetDirty(animator);
            return null;
        }

        private static string ReplaceFloorOrWall(
            GameObject existing,
            string assetPath,
            SceneOperation op,
            Scene scene,
            List<string> bindingJsonObjects)
        {
            var name = existing.name;
            var parent = existing.transform.parent;
            var sibling = existing.transform.GetSiblingIndex();
            var worldPos = existing.transform.position;
            var worldRot = existing.transform.rotation;
            var localScale = existing.transform.localScale;
            var active = existing.activeSelf;
            var layer = existing.layer;
            var tag = existing.tag;
            var colliderSnapshots = CaptureColliderSnapshots(existing);
            var preservedComponents = CapturePreservableStudioComponents(existing);

            var main = AssetDatabase.LoadMainAssetAtPath(assetPath);
            GameObject instance = null;
            if (main is GameObject prefab)
            {
                instance = PrefabUtility.InstantiatePrefab(prefab, scene) as GameObject;
            }

            if (instance == null && main != null)
            {
                instance = UnityEngine.Object.Instantiate(main) as GameObject;
                if (instance != null) SceneManager.MoveGameObjectToScene(instance, scene);
            }

            if (instance == null) return $"Could not instantiate replacement {assetPath}";
            Undo.RegisterCreatedObjectUndo(instance, "HERTZ Studio Replace Floor/Wall");
            instance.name = name;
            if (parent != null) Undo.SetTransformParent(instance.transform, parent, "HERTZ Studio Replace Parent");
            instance.transform.SetSiblingIndex(sibling);
            instance.transform.position = worldPos;
            instance.transform.rotation = worldRot;
            instance.transform.localScale = localScale;
            instance.SetActive(active);
            instance.layer = layer;
            try
            {
                instance.tag = tag;
            }
            catch (Exception tagEx)
            {
                Undo.DestroyObjectImmediate(instance);
                return $"Failed to migrate tag '{tag}' onto replacement: {tagEx.Message}";
            }

            var colliderErr = RestoreColliderSnapshots(instance, colliderSnapshots);
            if (colliderErr != null)
            {
                Undo.DestroyObjectImmediate(instance);
                return colliderErr;
            }

            var preserveErr = RestorePreservableStudioComponents(instance, preservedComponents);
            if (preserveErr != null)
            {
                Undo.DestroyObjectImmediate(instance);
                return preserveErr;
            }

            if (!string.IsNullOrEmpty(op.AssetId))
            {
                var guid = AssetDatabase.AssetPathToGUID(assetPath);
                var provenance = HertzStudioAssetProvenance.EnsureOn(instance, op.AssetId, guid, assetPath);
                if (provenance != null)
                {
                    Undo.RegisterCreatedObjectUndo(provenance, "HERTZ Studio asset provenance");
                    EditorUtility.SetDirty(provenance);
                }
            }
            else
            {
                // Keep prior provenance when the op does not supply a new asset id.
                var priorProv = existing.GetComponent<HertzStudioAssetProvenance>();
                if (priorProv != null)
                {
                    var migrated = HertzStudioAssetProvenance.EnsureOn(
                        instance, priorProv.AssetId, priorProv.SourceAssetGuid, priorProv.PrefabAssetPath);
                    if (migrated != null)
                    {
                        Undo.RegisterCreatedObjectUndo(migrated, "HERTZ Studio asset provenance");
                        EditorUtility.SetDirty(migrated);
                    }
                }
            }

            var gid = GlobalObjectId.GetGlobalObjectIdSlow(instance).ToString();
            bindingJsonObjects.Add(
                "{\"draftObjectId\":\"" + Escape(op.DraftObjectId) +
                "\",\"unityObjectId\":\"" + Escape(gid) +
                "\",\"name\":\"" + Escape(instance.name) +
                "\",\"replacedObjectId\":\"" + Escape(GlobalObjectId.GetGlobalObjectIdSlow(existing).ToString()) + "\"}");

            Undo.DestroyObjectImmediate(existing);
            return null;
        }

        /// <summary>
        /// Project-owned MonoBehaviours migrated on floor/wall replace.
        /// Contract: types in HertzStudio.Runtime whose full name starts with HertzStudio,
        /// excluding Transform/Renderer/Collider (handled separately). Unsafe engine
        /// components (Camera, AudioListener, Rigidbody, etc.) are never copied.
        /// </summary>
        private sealed class PreservedComponentSnapshot
        {
            public Type Type;
            public string Json;
        }

        private static readonly HashSet<string> ForbiddenPreserveTypeNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "UnityEngine.Camera",
            "UnityEngine.AudioListener",
            "UnityEngine.AudioSource",
            "UnityEngine.Rigidbody",
            "UnityEngine.Light",
            "UnityEngine.FlareLayer",
            "UnityEngine.Skybox",
        };

        private static bool IsPreservableStudioComponent(Component c)
        {
            if (c == null || c is Transform || c is Collider || c is Renderer || c is MeshFilter)
                return false;
            var type = c.GetType();
            if (ForbiddenPreserveTypeNames.Contains(type.FullName)) return false;
            // Project-owned Studio components only (runtime assembly / HertzStudio* types).
            if (type == typeof(HertzStudioSurfaceKind) ||
                type == typeof(HertzStudioPreservedNote) ||
                type == typeof(HertzStudioAssetProvenance))
            {
                return true;
            }

            return type.Namespace == null && type.Name.StartsWith("HertzStudio", StringComparison.Ordinal);
        }

        private static List<PreservedComponentSnapshot> CapturePreservableStudioComponents(GameObject go)
        {
            var list = new List<PreservedComponentSnapshot>();
            foreach (var c in go.GetComponents<Component>())
            {
                if (!IsPreservableStudioComponent(c)) continue;
                list.Add(new PreservedComponentSnapshot
                {
                    Type = c.GetType(),
                    Json = EditorJsonUtility.ToJson(c),
                });
            }

            return list;
        }

        private static string RestorePreservableStudioComponents(
            GameObject instance,
            List<PreservedComponentSnapshot> snapshots)
        {
            if (snapshots == null || snapshots.Count == 0) return null;
            foreach (var snap in snapshots)
            {
                if (snap?.Type == null) continue;
                // Provenance is applied from the op when AssetId is present.
                if (snap.Type == typeof(HertzStudioAssetProvenance)) continue;
                try
                {
                    var existing = instance.GetComponent(snap.Type);
                    if (existing == null)
                    {
                        existing = Undo.AddComponent(instance, snap.Type);
                    }

                    if (existing == null)
                        return $"Failed to add preserved component {snap.Type.Name}.";
                    EditorJsonUtility.FromJsonOverwrite(snap.Json, existing);
                    EditorUtility.SetDirty(existing);
                }
                catch (Exception ex)
                {
                    return $"Failed to migrate component {snap.Type.Name}: {ex.Message}";
                }
            }

            return null;
        }

        private sealed class ColliderSnapshot
        {
            public Type Type;
            public bool Enabled;
            public bool IsTrigger;
            public PhysicsMaterial Material;
            public Vector3 Center;
            public Vector3 Size;
            public float Radius;
            public float Height;
            public int Direction;
        }

        private static List<ColliderSnapshot> CaptureColliderSnapshots(GameObject go)
        {
            var list = new List<ColliderSnapshot>();
            foreach (var c in go.GetComponents<Collider>())
            {
                if (c == null) continue;
                var snap = new ColliderSnapshot
                {
                    Type = c.GetType(),
                    Enabled = c.enabled,
                    IsTrigger = c.isTrigger,
                    Material = c.sharedMaterial,
                };
                if (c is BoxCollider box)
                {
                    snap.Center = box.center;
                    snap.Size = box.size;
                }
                else if (c is SphereCollider sphere)
                {
                    snap.Center = sphere.center;
                    snap.Radius = sphere.radius;
                }
                else if (c is CapsuleCollider capsule)
                {
                    snap.Center = capsule.center;
                    snap.Radius = capsule.radius;
                    snap.Height = capsule.height;
                    snap.Direction = capsule.direction;
                }
                else if (c is MeshCollider mesh)
                {
                    // Mesh collider mesh comes from the replacement MeshFilter when present.
                    snap.IsTrigger = mesh.convex && mesh.isTrigger;
                }

                list.Add(snap);
            }

            return list;
        }

        private static string RestoreColliderSnapshots(GameObject instance, List<ColliderSnapshot> snapshots)
        {
            if (snapshots == null || snapshots.Count == 0) return null;

            // Remove auto-generated colliders from the replacement prefab before restoring.
            foreach (var existing in instance.GetComponents<Collider>())
            {
                if (existing != null) Undo.DestroyObjectImmediate(existing);
            }

            foreach (var snap in snapshots)
            {
                Collider created;
                try
                {
                    created = Undo.AddComponent(instance, snap.Type) as Collider;
                }
                catch (Exception ex)
                {
                    return $"Failed to migrate collider type {snap.Type?.Name}: {ex.Message}";
                }

                if (created == null) return $"Failed to add collider type {snap.Type?.Name}.";
                created.enabled = snap.Enabled;
                created.isTrigger = snap.IsTrigger;
                created.sharedMaterial = snap.Material;
                if (created is BoxCollider box)
                {
                    box.center = snap.Center;
                    box.size = snap.Size;
                }
                else if (created is SphereCollider sphere)
                {
                    sphere.center = snap.Center;
                    sphere.radius = snap.Radius;
                }
                else if (created is CapsuleCollider capsule)
                {
                    capsule.center = snap.Center;
                    capsule.radius = snap.Radius;
                    capsule.height = snap.Height;
                    capsule.direction = snap.Direction;
                }
                else if (created is MeshCollider meshCol)
                {
                    var mf = instance.GetComponent<MeshFilter>();
                    if (mf != null && mf.sharedMesh != null) meshCol.sharedMesh = mf.sharedMesh;
                    meshCol.convex = true; // required if trigger; safe default for walkable floors
                }

                EditorUtility.SetDirty(created);
            }

            return null;
        }

        private static string Escape(string s) =>
            (s ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"");

        private static void TryReadVec3(string json, string key, out Vector3 value, out bool ok)
        {
            value = Vector3.zero;
            ok = false;
            var block = ExtractObject(json, key);
            if (string.IsNullOrEmpty(block)) return;
            if (!TryFloat(block, "x", out var x) || !TryFloat(block, "y", out var y) || !TryFloat(block, "z", out var z))
            {
                return;
            }

            value = new Vector3(x, y, z);
            ok = true;
        }

        private static bool TryFloat(string json, string key, out float value)
        {
            value = 0;
            var token = $"\"{key}\"";
            var idx = json.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return false;
            var colon = json.IndexOf(':', idx + token.Length);
            if (colon < 0) return false;
            var slice = json.Substring(colon + 1).TrimStart();
            var end = 0;
            while (end < slice.Length && "0123456789+-.eE".IndexOf(slice[end]) >= 0) end++;
            return float.TryParse(slice.Substring(0, end), NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        private static int ReadInt(string json, string key)
        {
            if (!TryFloat(json, key, out var value) || value < int.MinValue || value > int.MaxValue)
            {
                return 0;
            }

            return (int)value;
        }

        private static string ReadString(string json, string key)
        {
            var token = $"\"{key}\"";
            var idx = json.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return null;
            var colon = json.IndexOf(':', idx + token.Length);
            if (colon < 0) return null;
            var slice = json.Substring(colon + 1).TrimStart();
            if (!slice.StartsWith("\"")) return null;
            var sb = new StringBuilder();
            for (var i = 1; i < slice.Length; i++)
            {
                if (slice[i] == '\\' && i + 1 < slice.Length)
                {
                    sb.Append(slice[i + 1]);
                    i++;
                    continue;
                }

                if (slice[i] == '"') break;
                sb.Append(slice[i]);
            }

            return sb.ToString();
        }

        private static string ExtractObject(string json, string key)
        {
            var token = $"\"{key}\"";
            var idx = json.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return null;
            var brace = json.IndexOf('{', idx);
            if (brace < 0) return null;
            var depth = 0;
            for (var i = brace; i < json.Length; i++)
            {
                if (json[i] == '{') depth++;
                else if (json[i] == '}')
                {
                    depth--;
                    if (depth == 0) return json.Substring(brace, i - brace + 1);
                }
            }

            return null;
        }

        private static List<string> SplitObjects(string arrayBody)
        {
            var list = new List<string>();
            var depth = 0;
            var start = -1;
            for (var i = 0; i < arrayBody.Length; i++)
            {
                var c = arrayBody[i];
                if (c == '{')
                {
                    if (depth == 0) start = i + 1;
                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0 && start >= 0)
                    {
                        list.Add(arrayBody.Substring(start, i - start));
                        start = -1;
                    }
                }
            }

            return list;
        }
    }
}
