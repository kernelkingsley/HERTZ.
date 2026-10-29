using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Priority 1 #5 proof: prefab duplicate PropertyModification remapping + serialized refs.
    /// HertzStudioTest only. Creates temporary prefabs/scripts under Assets/HertzStudio/ProofTemp/.
    /// </summary>
    public static class HertzStudioPrefabDuplicateProof
    {
        private const string TestScene = "Assets/Scenes/HertzStudioTest.unity";
        private const string ProofTempFolder = "Assets/HertzStudio/ProofTemp";
        private const string ProbeScriptPath = ProofTempFolder + "/HertzPrefabDupRefProbe.cs";
        private const string ProbeTypeName = "HertzPrefabDupRefProbe";
        private const string ProofLogRelative = "Tools/HertzStudio/data/w03-prefab-duplicate-proof.json";
        private const string ObjectPrefix = "HertzP1PrefabDup_";

        [MenuItem("Tools/HERTZ Studio/Run Prefab Duplicate Proof (HertzStudioTest)")]
        public static void RunFromMenu()
        {
            var report = Run();
            var abs = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ProofLogRelative));
            Directory.CreateDirectory(Path.GetDirectoryName(abs) ?? ".");
            File.WriteAllText(abs, report, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            Debug.Log($"HERTZ prefab duplicate proof written to {ProofLogRelative}\n{report}");
        }

        public static string Run()
        {
            var runId = Guid.NewGuid().ToString("N").Substring(0, 8);
            var tracked = new List<GameObject>();
            var createdAssetPaths = new List<string>();
            var sb = new StringBuilder();
            var checks = new Dictionary<string, bool>();
            string sourceGoid = null;
            string copyGoid = null;
            string copyName = null;
            string sourceName = null;

            try
            {
                EnsureProofTempFolder();
                EnsureProbeScript();
                var probeType = ResolveProbeType();
                if (probeType == null)
                {
                    throw new InvalidOperationException(
                        "HertzPrefabDupRefProbe type not loaded. Wait for script compile, then re-run the proof.");
                }

                var scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);

                sb.AppendLine("{");
                sb.AppendLine($"\"ranAt\":{Quote(DateTime.UtcNow.ToString("o"))},");
                sb.AppendLine($"\"runId\":{Quote(runId)},");
                sb.AppendLine($"\"scene\":{Quote(TestScene)},");

                // --- Build fixture prefabs ---
                var innerPath = $"{ProofTempFolder}/Inner_{runId}.prefab";
                var outerPath = $"{ProofTempFolder}/Outer_{runId}.prefab";

                var innerAsset = CreateInnerPrefab(innerPath, runId);
                createdAssetPaths.Add(innerPath);
                var outerAsset = CreateOuterPrefab(outerPath, innerAsset, probeType, runId);
                createdAssetPaths.Add(outerPath);

                // Parent anchor in scene
                var parentAnchor = new GameObject($"{ObjectPrefix}Parent_{runId}");
                Track(tracked, parentAnchor);
                Undo.RegisterCreatedObjectUndo(parentAnchor, "HERTZ Prefab Dup Proof Parent");

                // Root prefab instance with overrides (root transform + child + component)
                var source = PrefabUtility.InstantiatePrefab(outerAsset, scene) as GameObject;
                Track(tracked, source);
                Undo.RegisterCreatedObjectUndo(source, "HERTZ Prefab Dup Proof Source");
                source.name = $"{ObjectPrefix}Source_{runId}";
                sourceName = source.name;
                source.transform.SetParent(parentAnchor.transform, false);
                source.transform.localPosition = new Vector3(1.5f, 0.25f, -0.75f);
                source.transform.localEulerAngles = new Vector3(5f, 15f, 0f);
                source.transform.localScale = new Vector3(1.1f, 0.9f, 1.2f);

                var nestedChild = FindChild(source.transform, "InnerChild");
                if (nestedChild == null)
                {
                    throw new InvalidOperationException("InnerChild missing on source instance.");
                }

                // Component override on nested child
                var renderer = nestedChild.GetComponent<MeshRenderer>();
                if (renderer == null)
                {
                    renderer = nestedChild.gameObject.AddComponent<MeshRenderer>();
                }

                Undo.RecordObject(renderer, "HERTZ Prefab Dup Proof Renderer");
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;

                // Nested child transform override
                Undo.RecordObject(nestedChild, "HERTZ Prefab Dup Proof Nested Child");
                nestedChild.localPosition = new Vector3(0.2f, 0.4f, 0.1f);

                // Re-assert serialized cross-refs on the instance so PropertyModifications carry them.
                var sourceProbe = source.GetComponent(probeType);
                if (sourceProbe == null)
                {
                    throw new InvalidOperationException("Probe missing on source OuterRoot.");
                }

                var nestedMeshFilter = nestedChild.GetComponent<MeshFilter>();
                SetProbeRefs(sourceProbe, nestedChild.gameObject, nestedMeshFilter != null
                    ? (Component)nestedMeshFilter
                    : nestedChild);
                PrefabUtility.RecordPrefabInstancePropertyModifications(sourceProbe);

                // Ensure nested transform override is recorded on the nested instance root.
                var nestedInstanceRoot = PrefabUtility.GetNearestPrefabInstanceRoot(nestedChild.gameObject);
                PrefabUtility.RecordPrefabInstancePropertyModifications(nestedChild);
                PrefabUtility.RecordPrefabInstancePropertyModifications(renderer);
                if (nestedInstanceRoot != null)
                {
                    PrefabUtility.RecordPrefabInstancePropertyModifications(nestedInstanceRoot);
                }

                PrefabUtility.RecordPrefabInstancePropertyModifications(source);

                sourceGoid = GlobalObjectId.GetGlobalObjectIdSlow(source).ToString();
                sb.AppendLine($"\"sourceName\":{Quote(source.name)},");
                sb.AppendLine($"\"sourceGlobalObjectId\":{Quote(sourceGoid)},");

                // --- Duplicate via production helper ---
                var copy = HertzStudioPrefabDuplication.Duplicate(source, scene);
                Track(tracked, copy);
                Undo.RegisterCreatedObjectUndo(copy, "HERTZ Prefab Dup Proof Copy");

                // Assert remapped mods before parenting (SetParent would change root locals).
                var copyMods = PrefabUtility.GetPropertyModifications(copy);
                checks["overridesPointAtCopyNotSource"] =
                    HertzStudioPrefabDuplication.OverridesPointOnlyAtCopy(source, copy, copyMods);
                checks["copyIsPrefabInstance"] = PrefabUtility.IsPartOfPrefabInstance(copy);
                checks["copyCorrespondingAssetMatches"] =
                    PrefabUtility.GetCorrespondingObjectFromSource(copy) == outerAsset;

                var copyNestedChildBeforeParent = FindChild(copy.transform, "InnerChild");
                checks["nestedChildPresent"] = copyNestedChildBeforeParent != null;
                var nestedPosOk = copyNestedChildBeforeParent != null &&
                    Vector3.Distance(copyNestedChildBeforeParent.localPosition, nestedChild.localPosition) < 0.0001f;
                checks["nestedChildOverridePosition"] = nestedPosOk;
                sb.AppendLine(
                    $"\"nestedChildPositions\":{{\"source\":{VectorJson(nestedChild.localPosition)},\"copy\":{VectorJson(copyNestedChildBeforeParent != null ? copyNestedChildBeforeParent.localPosition : Vector3.zero)}}},");
                var copyRenderer = copyNestedChildBeforeParent != null
                    ? copyNestedChildBeforeParent.GetComponent<MeshRenderer>()
                    : null;
                checks["componentOverride"] = copyRenderer != null &&
                    copyRenderer.shadowCastingMode == UnityEngine.Rendering.ShadowCastingMode.Off;
                var copyInner = FindChild(copy.transform, "InnerRoot");
                checks["nestedPrefabInstance"] = copyInner != null &&
                    PrefabUtility.IsPartOfPrefabInstance(copyInner.gameObject);

                AssertSerializedRefs(
                    checks,
                    "serializedRef",
                    source,
                    copy,
                    probeType,
                    nestedChild.gameObject,
                    nestedMeshFilter != null ? (Component)nestedMeshFilter : nestedChild);

                // Match SceneCommands parenting + world transform copy when no explicit op.
                Undo.SetTransformParent(copy.transform, parentAnchor.transform, "HERTZ Prefab Dup Proof Copy Parent");
                copy.name = $"{ObjectPrefix}Copy_{runId}";
                copyName = copy.name;
                copy.transform.position = source.transform.position;
                copy.transform.rotation = source.transform.rotation;
                copy.transform.localScale = source.transform.localScale;
                copyGoid = GlobalObjectId.GetGlobalObjectIdSlow(copy).ToString();
                sb.AppendLine($"\"copyName\":{Quote(copy.name)},");
                sb.AppendLine($"\"copyGlobalObjectId\":{Quote(copyGoid)},");

                checks["rootOverridePosition"] =
                    Vector3.Distance(copy.transform.position, source.transform.position) < 0.0001f;
                checks["rootOverrideScale"] =
                    Vector3.Distance(copy.transform.localScale, source.transform.localScale) < 0.0001f;
                checks["parentedUnderAnchor"] = copy.transform.parent == parentAnchor.transform;

                // Non-prefab GameObject
                var loose = new GameObject($"{ObjectPrefix}Loose_{runId}");
                Track(tracked, loose);
                loose.transform.position = new Vector3(3f, 0f, 0f);
                var looseCopy = HertzStudioPrefabDuplication.Duplicate(loose, scene);
                Track(tracked, looseCopy);
                looseCopy.name = $"{ObjectPrefix}LooseCopy_{runId}";
                checks["nonPrefabDuplicate"] = looseCopy != null &&
                    !PrefabUtility.IsPartOfAnyPrefab(looseCopy) &&
                    Vector3.Distance(looseCopy.transform.position, loose.transform.position) < 0.0001f;

                // Unity 6000 GetNearestPrefabInstanceRoot returns the outermost instance root.
                var fromChild = HertzStudioPrefabDuplication.Duplicate(nestedChild.gameObject, scene);
                Track(tracked, fromChild);
                fromChild.name = $"{ObjectPrefix}FromChild_{runId}";
                var fromPath = fromChild != null
                    ? AssetDatabase.GetAssetPath(PrefabUtility.GetCorrespondingObjectFromSource(fromChild))
                    : string.Empty;
                var outerPathExpected = AssetDatabase.GetAssetPath(outerAsset);
                checks["childSelectionDuplicatesNearestRoot"] =
                    PrefabUtility.IsPartOfPrefabInstance(fromChild) &&
                    !string.IsNullOrEmpty(fromPath) &&
                    string.Equals(fromPath, outerPathExpected, StringComparison.Ordinal);
                sb.AppendLine(
                    $"\"childDuplicatePaths\":{{\"from\":{Quote(fromPath)},\"expectedOuter\":{Quote(outerPathExpected)}}},");

                // Destroy ephemeral duplicates before save/reopen; keep source+copy+parent for persistence.
                DestroyImmediateSafe(loose);
                DestroyImmediateSafe(looseCopy);
                DestroyImmediateSafe(fromChild);
                tracked.Remove(loose);
                tracked.Remove(looseCopy);
                tracked.Remove(fromChild);

                EditorSceneManager.MarkSceneDirty(scene);
                EditorSceneManager.SaveScene(scene);

                // Reopen and verify serialized refs still point into the duplicate hierarchy.
                scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                var reopenedSource = FindNamedRoot(scene, sourceName);
                var reopenedCopy = FindNamedRoot(scene, copyName);
                Track(tracked, reopenedSource);
                Track(tracked, reopenedCopy);
                var reopenedParent = FindNamedRoot(scene, $"{ObjectPrefix}Parent_{runId}");
                Track(tracked, reopenedParent);

                checks["reopenedCopyPresent"] = reopenedCopy != null && reopenedSource != null;
                if (reopenedCopy != null && reopenedSource != null)
                {
                    AssertSerializedRefs(
                        checks,
                        "serializedRefAfterReopen",
                        reopenedSource,
                        reopenedCopy,
                        probeType,
                        null,
                        null);
                }
                else
                {
                    checks["serializedRefAfterReopenPointsIntoCopy"] = false;
                    checks["serializedRefAfterReopenNotSource"] = false;
                    checks["serializedRefAfterReopenComponentPointsIntoCopy"] = false;
                    checks["serializedRefAfterReopenComponentNotSource"] = false;
                }

                var passed = true;
                foreach (var kv in checks)
                {
                    if (!kv.Value)
                    {
                        passed = false;
                        break;
                    }
                }

                sb.AppendLine($"\"passed\":{(passed ? "true" : "false")},");
                sb.Append("\"checks\":{");
                var first = true;
                foreach (var kv in checks)
                {
                    if (!first)
                    {
                        sb.Append(',');
                    }

                    first = false;
                    sb.Append(Quote(kv.Key)).Append(':').Append(kv.Value ? "true" : "false");
                }

                sb.AppendLine("}");
                sb.AppendLine("}");

                // Destroy scene objects BEFORE deleting prefab assets, then save clean scene.
                CleanupTracked(tracked);
                tracked.Clear();
                DestroyProofPrefixed(scene, ObjectPrefix);
                EditorSceneManager.MarkSceneDirty(scene);
                EditorSceneManager.SaveScene(scene);
                DeleteProofAssets(createdAssetPaths);
                createdAssetPaths.Clear();
                DeleteProbeScriptAndFolder();
                EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);

                return sb.ToString();
            }
            catch (Exception ex)
            {
                sb.Clear();
                sb.AppendLine("{");
                sb.AppendLine($"\"ranAt\":{Quote(DateTime.UtcNow.ToString("o"))},");
                sb.AppendLine($"\"runId\":{Quote(runId)},");
                sb.AppendLine($"\"passed\":false,");
                sb.AppendLine($"\"sourceGlobalObjectId\":{Quote(sourceGoid)},");
                sb.AppendLine($"\"copyGlobalObjectId\":{Quote(copyGoid)},");
                sb.AppendLine($"\"error\":{Quote(ex.Message)}");
                sb.AppendLine("}");
                return sb.ToString();
            }
            finally
            {
                try
                {
                    CleanupTracked(tracked);
                    var scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                    DestroyProofPrefixed(scene, ObjectPrefix);
                    if (scene.isDirty)
                    {
                        EditorSceneManager.SaveScene(scene);
                    }

                    DeleteProofAssets(createdAssetPaths);
                    createdAssetPaths.Clear();
                    DeleteProbeScriptAndFolder();
                    EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                }
                catch
                {
                    // Best-effort HertzStudioTest restore.
                }

                AssetDatabase.Refresh(ImportAssetOptions.Default);
            }
        }

        private static void AssertSerializedRefs(
            Dictionary<string, bool> checks,
            string keyPrefix,
            GameObject sourceRoot,
            GameObject copyRoot,
            Type probeType,
            GameObject expectedSourceNestedGo,
            Component expectedSourceNestedComp)
        {
            var sourceProbe = sourceRoot != null ? sourceRoot.GetComponent(probeType) : null;
            var copyProbe = copyRoot != null ? copyRoot.GetComponent(probeType) : null;
            var sourceGo = GetProbeGameObject(sourceProbe);
            var copyGo = GetProbeGameObject(copyProbe);
            var sourceComp = GetProbeComponent(sourceProbe);
            var copyComp = GetProbeComponent(copyProbe);

            var sourceSet = CollectHierarchy(sourceRoot);
            var copySet = CollectHierarchy(copyRoot);

            if (expectedSourceNestedGo != null)
            {
                checks[keyPrefix + "SourceWired"] = sourceGo == expectedSourceNestedGo;
            }

            if (expectedSourceNestedComp != null)
            {
                checks[keyPrefix + "SourceComponentWired"] = sourceComp == expectedSourceNestedComp;
            }

            checks[keyPrefix + "PointsIntoCopy"] =
                copyGo != null && copySet.Contains(copyGo) && IsUnder(copyRoot.transform, copyGo.transform);
            checks[keyPrefix + "NotSource"] =
                copyGo != null && !sourceSet.Contains(copyGo) && copyGo != sourceGo;
            checks[keyPrefix + "ComponentPointsIntoCopy"] =
                copyComp != null && copySet.Contains(copyComp) &&
                IsUnder(copyRoot.transform, copyComp.transform);
            checks[keyPrefix + "ComponentNotSource"] =
                copyComp != null && !sourceSet.Contains(copyComp) && copyComp != sourceComp;
        }

        private static bool IsUnder(Transform root, Transform node)
        {
            if (root == null || node == null)
            {
                return false;
            }

            var t = node;
            while (t != null)
            {
                if (t == root)
                {
                    return true;
                }

                t = t.parent;
            }

            return false;
        }

        private static HashSet<UnityEngine.Object> CollectHierarchy(GameObject root)
        {
            var set = new HashSet<UnityEngine.Object>();
            if (root == null)
            {
                return set;
            }

            var transforms = root.GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < transforms.Length; i++)
            {
                set.Add(transforms[i]);
                set.Add(transforms[i].gameObject);
                var comps = transforms[i].GetComponents<Component>();
                for (var c = 0; c < comps.Length; c++)
                {
                    if (comps[c] != null)
                    {
                        set.Add(comps[c]);
                    }
                }
            }

            return set;
        }

        private static void SetProbeRefs(Component probe, GameObject nestedObject, Component nestedComponent)
        {
            var so = new SerializedObject(probe);
            var goProp = so.FindProperty("nestedObject");
            var compProp = so.FindProperty("nestedComponent");
            if (goProp != null)
            {
                goProp.objectReferenceValue = nestedObject;
            }

            if (compProp != null)
            {
                compProp.objectReferenceValue = nestedComponent;
            }

            so.ApplyModifiedPropertiesWithoutUndo();
        }

        private static GameObject GetProbeGameObject(Component probe)
        {
            if (probe == null)
            {
                return null;
            }

            var so = new SerializedObject(probe);
            var prop = so.FindProperty("nestedObject");
            return prop != null ? prop.objectReferenceValue as GameObject : null;
        }

        private static Component GetProbeComponent(Component probe)
        {
            if (probe == null)
            {
                return null;
            }

            var so = new SerializedObject(probe);
            var prop = so.FindProperty("nestedComponent");
            return prop != null ? prop.objectReferenceValue as Component : null;
        }

        private static Type ResolveProbeType()
        {
            var assemblies = AppDomain.CurrentDomain.GetAssemblies();
            for (var i = 0; i < assemblies.Length; i++)
            {
                Type type;
                try
                {
                    type = assemblies[i].GetType(ProbeTypeName, throwOnError: false);
                }
                catch (ReflectionTypeLoadException)
                {
                    continue;
                }

                if (type != null && typeof(MonoBehaviour).IsAssignableFrom(type))
                {
                    return type;
                }
            }

            return null;
        }

        private static void EnsureProbeScript()
        {
            if (File.Exists(ProbeScriptPath))
            {
                return;
            }

            EnsureProofTempFolder();
            const string source =
                "using UnityEngine;\n" +
                "\n" +
                "/// <summary>\n" +
                "/// Temporary HertzStudio PrefabDuplicateProof fixture. Deleted after the proof run.\n" +
                "/// </summary>\n" +
                "public sealed class HertzPrefabDupRefProbe : MonoBehaviour\n" +
                "{\n" +
                "    [SerializeField] private GameObject nestedObject;\n" +
                "    [SerializeField] private Component nestedComponent;\n" +
                "\n" +
                "    public GameObject NestedObject\n" +
                "    {\n" +
                "        get { return nestedObject; }\n" +
                "        set { nestedObject = value; }\n" +
                "    }\n" +
                "\n" +
                "    public Component NestedComponent\n" +
                "    {\n" +
                "        get { return nestedComponent; }\n" +
                "        set { nestedComponent = value; }\n" +
                "    }\n" +
                "}\n";
            File.WriteAllText(ProbeScriptPath, source, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            AssetDatabase.ImportAsset(ProbeScriptPath, ImportAssetOptions.ForceUpdate);
        }

        private static void DeleteProbeScriptAndFolder()
        {
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(ProbeScriptPath) != null ||
                File.Exists(ProbeScriptPath))
            {
                AssetDatabase.DeleteAsset(ProbeScriptPath);
            }

            var meta = ProbeScriptPath + ".meta";
            if (File.Exists(meta))
            {
                File.Delete(meta);
            }

            if (AssetDatabase.IsValidFolder(ProofTempFolder))
            {
                var leftovers = AssetDatabase.FindAssets(string.Empty, new[] { ProofTempFolder });
                if (leftovers == null || leftovers.Length == 0)
                {
                    AssetDatabase.DeleteAsset(ProofTempFolder);
                }
            }
        }

        private static GameObject CreateInnerPrefab(string path, string runId)
        {
            var root = new GameObject("InnerRoot");
            var child = GameObject.CreatePrimitive(PrimitiveType.Cube);
            child.name = "InnerChild";
            child.transform.SetParent(root.transform, false);
            child.transform.localPosition = Vector3.zero;
            PrefabUtility.SaveAsPrefabAsset(root, path);
            UnityEngine.Object.DestroyImmediate(root);
            return AssetDatabase.LoadAssetAtPath<GameObject>(path);
        }

        private static GameObject CreateOuterPrefab(
            string path,
            GameObject innerAsset,
            Type probeType,
            string runId)
        {
            var root = new GameObject("OuterRoot");
            var nested = PrefabUtility.InstantiatePrefab(innerAsset) as GameObject;
            nested.name = "InnerRoot";
            nested.transform.SetParent(root.transform, false);

            var innerChild = FindChild(root.transform, "InnerChild");
            if (innerChild == null)
            {
                throw new InvalidOperationException("InnerChild missing while authoring Outer prefab.");
            }

            var probe = root.AddComponent(probeType);
            var meshFilter = innerChild.GetComponent<MeshFilter>();
            SetProbeRefs(
                probe,
                innerChild.gameObject,
                meshFilter != null ? (Component)meshFilter : innerChild);

            PrefabUtility.SaveAsPrefabAsset(root, path);
            UnityEngine.Object.DestroyImmediate(root);
            return AssetDatabase.LoadAssetAtPath<GameObject>(path);
        }

        private static void EnsureProofTempFolder()
        {
            if (!AssetDatabase.IsValidFolder("Assets/HertzStudio"))
            {
                AssetDatabase.CreateFolder("Assets", "HertzStudio");
            }

            if (!AssetDatabase.IsValidFolder(ProofTempFolder))
            {
                AssetDatabase.CreateFolder("Assets/HertzStudio", "ProofTemp");
            }
        }

        private static Transform FindChild(Transform root, string name)
        {
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                if (t.name == name)
                {
                    return t;
                }
            }

            return null;
        }

        private static GameObject FindNamedRoot(Scene scene, string name)
        {
            if (string.IsNullOrEmpty(name) || !scene.IsValid())
            {
                return null;
            }

            var roots = scene.GetRootGameObjects();
            for (var i = 0; i < roots.Length; i++)
            {
                var all = roots[i].GetComponentsInChildren<Transform>(true);
                for (var j = 0; j < all.Length; j++)
                {
                    if (all[j] != null && all[j].name == name)
                    {
                        return all[j].gameObject;
                    }
                }
            }

            return null;
        }

        private static void Track(List<GameObject> list, GameObject go)
        {
            if (go != null && !list.Contains(go))
            {
                list.Add(go);
            }
        }

        private static void CleanupTracked(List<GameObject> tracked)
        {
            for (var i = tracked.Count - 1; i >= 0; i--)
            {
                DestroyImmediateSafe(tracked[i]);
            }

            tracked.Clear();
        }

        private static void DestroyImmediateSafe(GameObject go)
        {
            if (go != null)
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        private static void DestroyProofPrefixed(Scene scene, string prefix)
        {
            var toDestroy = new List<GameObject>();
            var roots = scene.GetRootGameObjects();
            for (var i = 0; i < roots.Length; i++)
            {
                var all = roots[i].GetComponentsInChildren<Transform>(true);
                for (var j = 0; j < all.Length; j++)
                {
                    if (all[j] != null && all[j].name.StartsWith(prefix, StringComparison.Ordinal))
                    {
                        toDestroy.Add(all[j].gameObject);
                    }
                }
            }

            for (var i = 0; i < toDestroy.Count; i++)
            {
                DestroyImmediateSafe(toDestroy[i]);
            }
        }

        private static void DeleteProofAssets(List<string> paths)
        {
            for (var i = 0; i < paths.Count; i++)
            {
                if (!string.IsNullOrEmpty(paths[i]) &&
                    (File.Exists(paths[i]) || AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(paths[i]) != null))
                {
                    AssetDatabase.DeleteAsset(paths[i]);
                }
            }
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                return "null";
            }

            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static string VectorJson(Vector3 v)
        {
            return "{\"x\":" + v.x.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                   ",\"y\":" + v.y.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                   ",\"z\":" + v.z.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}";
        }
    }
}
