using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Prefab-aware GameObject duplication with PropertyModification remapping.
    /// Override targets/objectReferences must point at the duplicate instance, never the source.
    /// </summary>
    public static class HertzStudioPrefabDuplication
    {
        /// <summary>
        /// Create a duplicate of <paramref name="source"/> in <paramref name="scene"/> without
        /// parenting or renaming. Prefab instances keep linkage and remapped property overrides.
        /// Non-prefab objects use a plain instantiate. Caller owns Undo / parent / transform.
        /// </summary>
        public static GameObject Duplicate(GameObject source, Scene scene)
        {
            if (source == null)
            {
                throw new System.ArgumentNullException(nameof(source));
            }

            if (!scene.IsValid() || !scene.isLoaded)
            {
                throw new System.ArgumentException("Scene must be loaded.", nameof(scene));
            }

            var sourceRoot = PrefabUtility.GetNearestPrefabInstanceRoot(source) ?? source;
            GameObject copy = null;

            if (PrefabUtility.IsPartOfPrefabInstance(sourceRoot))
            {
                // In the Editor, Instantiate of a prefab instance creates another linked instance
                // with overrides remapped onto the duplicate. Re-apply remapped modifications so
                // nested-instance overrides are preserved even when Instantiate alone is incomplete.
                copy = Object.Instantiate(sourceRoot);
                SceneManager.MoveGameObjectToScene(copy, scene);
                if (PrefabUtility.IsPartOfPrefabInstance(copy))
                {
                    ApplyRemappedModifications(sourceRoot, copy);
                }
                else
                {
                    Object.DestroyImmediate(copy);
                    copy = null;
                }
            }

            if (copy == null && PrefabUtility.IsPartOfPrefabInstance(sourceRoot))
            {
                // Fallback: fresh asset instance + explicit PropertyModification remapping.
                var prefabAsset = PrefabUtility.GetCorrespondingObjectFromSource(sourceRoot);
                if (prefabAsset != null)
                {
                    copy = PrefabUtility.InstantiatePrefab(prefabAsset, scene) as GameObject;
                    if (copy != null)
                    {
                        ApplyRemappedModifications(sourceRoot, copy);
                    }
                }
            }

            if (copy == null)
            {
                copy = Object.Instantiate(sourceRoot);
                SceneManager.MoveGameObjectToScene(copy, scene);
            }

            return copy;
        }

        /// <summary>
        /// Copy property modifications from source instance onto copy, remapping targets, including
        /// nested prefab instance roots inside the hierarchy.
        /// </summary>
        public static void ApplyRemappedModifications(GameObject sourceRoot, GameObject copyRoot)
        {
            if (sourceRoot == null || copyRoot == null)
            {
                return;
            }

            ApplyRemappedModificationsOnRoot(sourceRoot, copyRoot);

            var sourceTransforms = sourceRoot.GetComponentsInChildren<Transform>(true);
            var copyByPath = new Dictionary<string, Transform>();
            CollectByPath(copyRoot.transform, copyRoot.transform, copyByPath);

            for (var i = 0; i < sourceTransforms.Length; i++)
            {
                var srcT = sourceTransforms[i];
                if (srcT == null || srcT.gameObject == sourceRoot)
                {
                    continue;
                }

                if (!PrefabUtility.IsAnyPrefabInstanceRoot(srcT.gameObject))
                {
                    continue;
                }

                var path = RelativePath(sourceRoot.transform, srcT);
                if (!copyByPath.TryGetValue(path, out var dstT) || dstT == null)
                {
                    continue;
                }

                ApplyRemappedModificationsOnRoot(srcT.gameObject, dstT.gameObject);
            }

            // Nested transform overrides sometimes remain only as instance state; sync overridden
            // transform properties by hierarchy path so the duplicate matches the source.
            SyncOverriddenTransforms(sourceRoot.transform, copyRoot.transform, copyByPath);

            // Remap serialized ObjectReference fields (GameObject/Component) that still point into
            // the source hierarchy so duplicates never keep cross-links to the original instance.
            SyncSerializedObjectReferences(sourceRoot, copyRoot);
        }

        private static void SyncSerializedObjectReferences(GameObject sourceRoot, GameObject copyRoot)
        {
            if (sourceRoot == null || copyRoot == null)
            {
                return;
            }

            var map = BuildSourceToCopyMap(sourceRoot, copyRoot);
            var sourceSet = CollectHierarchyObjects(sourceRoot);
            var copyByPath = new Dictionary<string, Transform>();
            CollectByPath(copyRoot.transform, copyRoot.transform, copyByPath);

            var sourceTransforms = sourceRoot.GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < sourceTransforms.Length; i++)
            {
                var srcT = sourceTransforms[i];
                if (srcT == null)
                {
                    continue;
                }

                var path = RelativePath(sourceRoot.transform, srcT);
                if (!copyByPath.TryGetValue(path, out var dstT) || dstT == null)
                {
                    continue;
                }

                var srcComps = srcT.GetComponents<Component>();
                var dstComps = dstT.GetComponents<Component>();
                for (var c = 0; c < srcComps.Length; c++)
                {
                    var srcComp = srcComps[c];
                    if (srcComp == null || srcComp is Transform)
                    {
                        continue;
                    }

                    if (!map.TryGetValue(srcComp, out var dstObj) || !(dstObj is Component dstComp))
                    {
                        continue;
                    }

                    RemapObjectReferenceProperties(srcComp, dstComp, map, sourceSet);
                }
            }
        }

        private static void RemapObjectReferenceProperties(
            Component srcComp,
            Component dstComp,
            Dictionary<Object, Object> map,
            HashSet<Object> sourceSet)
        {
            var srcSo = new SerializedObject(srcComp);
            var dstSo = new SerializedObject(dstComp);
            var srcProp = srcSo.GetIterator();
            while (srcProp.NextVisible(true))
            {
                if (srcProp.propertyType != SerializedPropertyType.ObjectReference)
                {
                    continue;
                }

                var srcRef = srcProp.objectReferenceValue;
                if (srcRef == null || !sourceSet.Contains(srcRef))
                {
                    continue;
                }

                var dstProp = dstSo.FindProperty(srcProp.propertyPath);
                if (dstProp == null || dstProp.propertyType != SerializedPropertyType.ObjectReference)
                {
                    continue;
                }

                dstProp.objectReferenceValue = RemapObject(map, srcRef);
            }

            dstSo.ApplyModifiedPropertiesWithoutUndo();
        }

        private static void SyncOverriddenTransforms(
            Transform sourceRoot,
            Transform copyRoot,
            Dictionary<string, Transform> copyByPath)
        {
            var sourceTransforms = sourceRoot.GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < sourceTransforms.Length; i++)
            {
                var srcT = sourceTransforms[i];
                if (srcT == null)
                {
                    continue;
                }

                var path = RelativePath(sourceRoot, srcT);
                if (!copyByPath.TryGetValue(path, out var dstT) || dstT == null)
                {
                    continue;
                }

                var so = new SerializedObject(srcT);
                var pos = so.FindProperty("m_LocalPosition");
                if (pos != null && pos.prefabOverride)
                {
                    dstT.localPosition = srcT.localPosition;
                }

                var rot = so.FindProperty("m_LocalRotation");
                if (rot != null && rot.prefabOverride)
                {
                    dstT.localRotation = srcT.localRotation;
                }

                var scale = so.FindProperty("m_LocalScale");
                if (scale != null && scale.prefabOverride)
                {
                    dstT.localScale = srcT.localScale;
                }
            }
        }

        private static void ApplyRemappedModificationsOnRoot(GameObject sourceRoot, GameObject copyRoot)
        {
            var mods = PrefabUtility.GetPropertyModifications(sourceRoot);
            if (mods == null || mods.Length == 0)
            {
                return;
            }

            var remapped = RemapPropertyModifications(sourceRoot, copyRoot, mods);
            PrefabUtility.SetPropertyModifications(copyRoot, remapped);
        }

        /// <summary>
        /// Remap modification targets and objectReferences from the source instance hierarchy
        /// onto the duplicate instance hierarchy. Asset-level targets are left unchanged.
        /// </summary>
        public static PropertyModification[] RemapPropertyModifications(
            GameObject sourceRoot,
            GameObject copyRoot,
            PropertyModification[] mods)
        {
            if (mods == null || mods.Length == 0)
            {
                return mods ?? System.Array.Empty<PropertyModification>();
            }

            var map = BuildSourceToCopyMap(sourceRoot, copyRoot);
            var remapped = new PropertyModification[mods.Length];
            for (var i = 0; i < mods.Length; i++)
            {
                var src = mods[i];
                remapped[i] = new PropertyModification
                {
                    propertyPath = src.propertyPath,
                    value = src.value,
                    target = RemapObject(map, src.target),
                    objectReference = RemapObject(map, src.objectReference),
                };
            }

            return remapped;
        }

        /// <summary>
        /// True when every modification target/objectReference that belonged to the source
        /// instance now references an object inside the copy instance (or remains an asset ref).
        /// </summary>
        public static bool OverridesPointOnlyAtCopy(
            GameObject sourceRoot,
            GameObject copyRoot,
            PropertyModification[] mods)
        {
            if (mods == null || mods.Length == 0)
            {
                return true;
            }

            var sourceSet = CollectHierarchyObjects(sourceRoot);
            var copySet = CollectHierarchyObjects(copyRoot);
            for (var i = 0; i < mods.Length; i++)
            {
                var mod = mods[i];
                if (PointsAtSourceNotCopy(mod.target, sourceSet, copySet))
                {
                    return false;
                }

                if (PointsAtSourceNotCopy(mod.objectReference, sourceSet, copySet))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool PointsAtSourceNotCopy(
            Object obj,
            HashSet<Object> sourceSet,
            HashSet<Object> copySet)
        {
            if (obj == null)
            {
                return false;
            }

            if (sourceSet.Contains(obj) && !copySet.Contains(obj))
            {
                return true;
            }

            return false;
        }

        private static Object RemapObject(Dictionary<Object, Object> map, Object obj)
        {
            if (obj == null)
            {
                return null;
            }

            if (map.TryGetValue(obj, out var mapped) && mapped != null)
            {
                return mapped;
            }

            return obj;
        }

        private static Dictionary<Object, Object> BuildSourceToCopyMap(GameObject sourceRoot, GameObject copyRoot)
        {
            var map = new Dictionary<Object, Object>();
            var copyByPath = new Dictionary<string, Transform>();
            CollectByPath(copyRoot.transform, copyRoot.transform, copyByPath);

            var sourceTransforms = sourceRoot.GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < sourceTransforms.Length; i++)
            {
                var srcT = sourceTransforms[i];
                var path = RelativePath(sourceRoot.transform, srcT);
                if (!copyByPath.TryGetValue(path, out var dstT) || dstT == null)
                {
                    continue;
                }

                map[srcT] = dstT;
                map[srcT.gameObject] = dstT.gameObject;

                var srcComps = srcT.GetComponents<Component>();
                var dstComps = dstT.GetComponents<Component>();
                MapComponentsByTypeOrder(srcComps, dstComps, map);

                // Also key by corresponding prefab-asset object when present so asset-tied
                // lookups can resolve if a modification unexpectedly holds an instance target
                // that still shares a corresponding source with the copy.
                var srcAssetGo = PrefabUtility.GetCorrespondingObjectFromSource(srcT.gameObject);
                if (srcAssetGo != null && !map.ContainsKey(srcAssetGo))
                {
                    // Do not map asset → instance; callers keep asset targets as-is.
                }
            }

            return map;
        }

        private static void MapComponentsByTypeOrder(
            Component[] srcComps,
            Component[] dstComps,
            Dictionary<Object, Object> map)
        {
            var dstIndexByType = new Dictionary<System.Type, int>();
            for (var i = 0; i < srcComps.Length; i++)
            {
                var src = srcComps[i];
                if (src == null)
                {
                    continue;
                }

                var type = src.GetType();
                dstIndexByType.TryGetValue(type, out var start);
                Component match = null;
                for (var j = start; j < dstComps.Length; j++)
                {
                    var dst = dstComps[j];
                    if (dst != null && dst.GetType() == type)
                    {
                        match = dst;
                        dstIndexByType[type] = j + 1;
                        break;
                    }
                }

                if (match != null)
                {
                    map[src] = match;
                }
            }
        }

        private static void CollectByPath(Transform root, Transform current, Dictionary<string, Transform> into)
        {
            into[RelativePath(root, current)] = current;
            for (var i = 0; i < current.childCount; i++)
            {
                CollectByPath(root, current.GetChild(i), into);
            }
        }

        private static string RelativePath(Transform root, Transform node)
        {
            if (node == root)
            {
                return string.Empty;
            }

            var parts = new List<string>(8);
            var t = node;
            while (t != null && t != root)
            {
                parts.Add(t.GetSiblingIndex().ToString() + ":" + t.name);
                t = t.parent;
            }

            parts.Reverse();
            return string.Join("/", parts);
        }

        private static HashSet<Object> CollectHierarchyObjects(GameObject root)
        {
            var set = new HashSet<Object>();
            if (root == null)
            {
                return set;
            }

            var transforms = root.GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < transforms.Length; i++)
            {
                var tr = transforms[i];
                set.Add(tr);
                set.Add(tr.gameObject);
                var comps = tr.GetComponents<Component>();
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
    }
}
