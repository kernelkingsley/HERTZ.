using System.Linq;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Visible Editor workflow for weapon Grip/Muzzle authoring and HertzWeaponTest visualization.
    /// Does not mutate tracked XR Origin / camera transforms or SampleScene.
    /// </summary>
    public static class HertzStudioWeaponAnchorCommands
    {
        private const string WeaponTestScene = "Assets/Scenes/HertzWeaponTest.unity";

        [MenuItem("HERTZ/Studio/Weapons/Inspect Selected Prefab Anchors")]
        public static void InspectSelectedPrefabAnchors()
        {
            var prefab = Selection.activeObject as GameObject;
            if (prefab == null)
            {
                EditorUtility.DisplayDialog(
                    "HERTZ Anchors",
                    "Select an imported weapon prefab (or a managed wrapper) in the Project window.",
                    "OK");
                return;
            }

            var path = AssetDatabase.GetAssetPath(prefab);
            var validation = HertzWeaponAnchorUtility.ValidatePrefabAnchors(prefab, "Grip", "Muzzle");
            var hierarchy = string.Join("\n", validation.HierarchyNames.Take(40));
            EditorUtility.DisplayDialog(
                "HERTZ Prefab Anchors",
                $"Path: {path}\n" +
                $"Grip found: {validation.GripFound}\n" +
                $"Muzzle found: {validation.MuzzleFound}\n" +
                $"Missing: {(validation.MissingAnchors.Length == 0 ? "(none)" : string.Join(", ", validation.MissingAnchors))}\n\n" +
                "Grip = hand alignment. Muzzle = flash/tracer origin + direction.\n" +
                "Select existing nodes in Studio or create a managed wrapper — never silent-guess.\n\n" +
                $"Nodes:\n{hierarchy}",
                "OK");
            Debug.Log(validation.Ok
                ? $"[HERTZ] Anchors valid on {path}"
                : $"[HERTZ] {validation.Error}");
        }

        [MenuItem("HERTZ/Studio/Weapons/Create Managed Grip+Muzzle Wrapper From Selection")]
        public static void CreateWrapperFromSelection()
        {
            var prefab = Selection.activeObject as GameObject;
            if (prefab == null)
            {
                EditorUtility.DisplayDialog("HERTZ Anchors", "Select the imported source prefab first.", "OK");
                return;
            }

            var path = AssetDatabase.GetAssetPath(prefab);
            // Prefer common authoring names on this pistol; still creates empties if absent.
            var result = HertzWeaponAnchorUtility.CreateManagedAnchorWrapper(
                path,
                "manual",
                "GripAttach",
                "MuzzlePoint");
            if (!result.Ok)
            {
                EditorUtility.DisplayDialog("HERTZ Anchors", result.Error ?? "Wrapper failed.", "OK");
                return;
            }

            var wrapper = AssetDatabase.LoadAssetAtPath<GameObject>(result.WrapperPrefabPath);
            Selection.activeObject = wrapper;
            EditorGUIUtility.PingObject(wrapper);
            EditorUtility.DisplayDialog(
                "HERTZ Anchors",
                $"Created wrapper:\n{result.WrapperPrefabPath}\n\n{result.Note}\n\n" +
                "Open Prefab Mode to fine-tune Grip/Muzzle. Point the weapon definition at this prefab, keep names Grip and Muzzle, then Sync.",
                "OK");
        }

        [MenuItem("HERTZ/Studio/Weapons/Open HertzWeaponTest And Frame Bound Guns")]
        public static void OpenWeaponTestAndFrameGuns()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                FrameBoundGunsInOpenScenes();
                return;
            }

            var scene = EditorSceneManager.OpenScene(WeaponTestScene, OpenSceneMode.Single);
            if (!scene.IsValid())
            {
                EditorUtility.DisplayDialog("HERTZ", $"Failed to open {WeaponTestScene}", "OK");
                return;
            }

            FrameBoundGunsInOpenScenes();
            Debug.Log(
                "[HERTZ] HertzWeaponTest opened. Enter Play Mode to instantiate runtime guns under LeftHandAttach/RightHandAttach. " +
                "Binding errors are logged by HertzDualPistolRuntime — missing Grip/Muzzle will refuse the model.");
        }

        [MenuItem("HERTZ/Studio/Weapons/Enter Play Mode For HertzWeaponTest")]
        public static void EnterPlayModeForWeaponTest()
        {
            if (EditorApplication.isPlaying)
            {
                FrameBoundGunsInOpenScenes();
                return;
            }

            var active = SceneManager.GetActiveScene();
            if (!string.Equals(active.path, WeaponTestScene, System.StringComparison.OrdinalIgnoreCase))
            {
                EditorSceneManager.OpenScene(WeaponTestScene, OpenSceneMode.Single);
            }

            EditorApplication.playModeStateChanged -= OnPlayModeFrameGuns;
            EditorApplication.playModeStateChanged += OnPlayModeFrameGuns;
            EditorApplication.isPlaying = true;
        }

        private static void OnPlayModeFrameGuns(PlayModeStateChange state)
        {
            if (state != PlayModeStateChange.EnteredPlayMode) return;
            EditorApplication.playModeStateChanged -= OnPlayModeFrameGuns;
            EditorApplication.delayCall += () =>
            {
                FrameBoundGunsInOpenScenes();
                LogRuntimeBindState();
            };
        }

        private static void FrameBoundGunsInOpenScenes()
        {
            HertzDualPistolRuntime runtime = null;
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.IsValid() || !scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (HertzStudioSceneCommands.IsProtectedHierarchy(root)) continue;
                    runtime = root.GetComponentInChildren<HertzDualPistolRuntime>(true);
                    if (runtime != null) break;
                }

                if (runtime != null) break;
            }

            if (runtime == null)
            {
                Debug.LogWarning("[HERTZ] No HertzDualPistolRuntime in open scenes.");
                return;
            }

            if (!string.IsNullOrEmpty(runtime.BindError))
            {
                Debug.LogError("[HERTZ] DualPistolRuntime bind error: " + runtime.BindError);
            }

            Transform focus = null;
            if (runtime.LeftModelInstance != null) focus = runtime.LeftModelInstance.transform;
            else if (runtime.RightModelInstance != null) focus = runtime.RightModelInstance.transform;
            else
            {
                // Fall back to hand attachments — never select protected XR camera/rig.
                var so = new SerializedObject(runtime);
                focus = so.FindProperty("leftAttach")?.objectReferenceValue as Transform
                        ?? so.FindProperty("rightAttach")?.objectReferenceValue as Transform;
            }

            if (focus == null)
            {
                Debug.LogWarning("[HERTZ] No gun instance or hand attach to frame. Fix anchors and redeploy.");
                return;
            }

            Selection.activeTransform = focus;
            if (SceneView.lastActiveSceneView != null)
            {
                SceneView.lastActiveSceneView.FrameSelected();
            }

            Debug.Log($"[HERTZ] Framed '{focus.name}' under DualPistolRuntime (protected XR/camera untouched).");
        }

        private static void LogRuntimeBindState()
        {
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.IsValid() || !scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (HertzStudioSceneCommands.IsProtectedHierarchy(root)) continue;
                    var runtime = root.GetComponentInChildren<HertzDualPistolRuntime>(true);
                    if (runtime == null) continue;
                    Debug.Log(
                        $"[HERTZ] Runtime bound={runtime.IsBound} leftModel={(runtime.LeftModelInstance != null)} " +
                        $"rightModel={(runtime.RightModelInstance != null)} error={runtime.BindError ?? "(none)"}");
                }
            }
        }
    }
}
