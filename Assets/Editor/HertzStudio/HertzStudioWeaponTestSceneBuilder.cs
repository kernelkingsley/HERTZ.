using System.IO;
using Hertz.Analytics;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Builds the persistent playable HertzWeaponTest scene with labelled placeholder pistols.
    /// Placeholders live under Assets/HertzStudio/Weapons/TestAssets/ — not final art.
    /// </summary>
    public static class HertzStudioWeaponTestSceneBuilder
    {
        public const string ScenePath = "Assets/Scenes/HertzWeaponTest.unity";
        public const string TestAssetsFolder = "Assets/HertzStudio/Weapons/TestAssets";
        public const string DefinitionsFolder = "Assets/HertzStudio/Weapons/Definitions";
        public const string LeftPrefabPath = TestAssetsFolder + "/PLACEHOLDER_Pistol_Left.prefab";
        public const string RightPrefabPath = TestAssetsFolder + "/PLACEHOLDER_Pistol_Right.prefab";
        public const string LeftDefPath = DefinitionsFolder + "/W04_Test_LeftPistol.asset";
        public const string RightDefPath = DefinitionsFolder + "/W04_Test_RightPistol.asset";

        [MenuItem("HERTZ/Studio/Build HertzWeaponTest Playable Scene")]
        public static void BuildPlayableSceneMenu()
        {
            BuildPlayableScene(save: true);
            Debug.Log("HertzWeaponTest playable scene saved: " + ScenePath);
        }

        public static void BuildPlayableScene(bool save)
        {
            EnsureFolders();
            var leftPrefab = EnsurePlaceholderPrefab(LeftPrefabPath, "PLACEHOLDER_Pistol_Left", new Color(0.25f, 0.55f, 0.95f));
            var rightPrefab = EnsurePlaceholderPrefab(RightPrefabPath, "PLACEHOLDER_Pistol_Right", new Color(0.95f, 0.45f, 0.25f));
            var leftDef = EnsureDefinition(
                LeftDefPath,
                "w04-test-left",
                "PLACEHOLDER Left Pistol",
                HertzWeaponDefinition.WeaponRole.LeftPistol,
                leftPrefab);
            var rightDef = EnsureDefinition(
                RightDefPath,
                "w04-test-right",
                "PLACEHOLDER Right Pistol",
                HertzWeaponDefinition.WeaponRole.RightPistol,
                rightPrefab);

            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

            var rig = new GameObject("HertzWeaponTestRig");
            var gate = rig.AddComponent<HertzFrequencyGate>();
            gate.SetFrequencyActive(false);

            var leftAttach = new GameObject("LeftHandAttach").transform;
            leftAttach.SetParent(rig.transform, false);
            leftAttach.localPosition = new Vector3(-0.25f, 1.2f, 0.35f);

            var rightAttach = new GameObject("RightHandAttach").transform;
            rightAttach.SetParent(rig.transform, false);
            rightAttach.localPosition = new Vector3(0.25f, 1.2f, 0.35f);

            var effects = rig.AddComponent<HertzWeaponFireEffects>();
            var runtime = rig.AddComponent<HertzDualPistolRuntime>();

            var leftAction = new InputAction("WeaponTestLeftFire", InputActionType.Button);
            leftAction.AddBinding("<Mouse>/leftButton");
            leftAction.AddBinding("<Keyboard>/1");
            var rightAction = new InputAction("WeaponTestRightFire", InputActionType.Button);
            rightAction.AddBinding("<Mouse>/rightButton");
            rightAction.AddBinding("<Keyboard>/2");

            // Serialize references only — do not spawn *_Runtime clones into the saved scene.
            runtime.Configure(
                leftDef,
                rightDef,
                gate,
                new InputActionProperty(leftAction),
                new InputActionProperty(rightAction),
                leftAttach,
                rightAttach,
                effects,
                audioPresenter: null,
                instantiateModels: false);
            StripRuntimeClonesInScene();

            var hud = rig.AddComponent<HertzWeaponTestHud>();
            var analytics = rig.AddComponent<HertzAnalyticsCapture>();
            analytics.Configure("editor-dev", "HertzWeaponTest", gate, runtime);
            var near = CreateTarget("TestTarget_Near", new Vector3(0f, 1.2f, 6f), new Color(0.3f, 0.8f, 0.4f));
            var mid = CreateTarget("TestTarget_Mid", new Vector3(1.5f, 1.2f, 15f), new Color(0.8f, 0.7f, 0.2f));
            var far = CreateTarget("TestTarget_BeyondTypicalRange", new Vector3(-1.5f, 1.2f, 55f), new Color(0.7f, 0.3f, 0.3f));
            CreateFloor();

            var soHud = new SerializedObject(hud);
            soHud.FindProperty("frequencyGate").objectReferenceValue = gate;
            soHud.FindProperty("dualPistols").objectReferenceValue = runtime;
            var targetsProp = soHud.FindProperty("targets");
            targetsProp.arraySize = 3;
            targetsProp.GetArrayElementAtIndex(0).objectReferenceValue = near;
            targetsProp.GetArrayElementAtIndex(1).objectReferenceValue = mid;
            targetsProp.GetArrayElementAtIndex(2).objectReferenceValue = far;
            soHud.ApplyModifiedPropertiesWithoutUndo();

            var label = new GameObject("PLACEHOLDER_CONTENT_LABEL");
            label.transform.position = new Vector3(0f, 2.2f, 4f);
            var tmp = label.AddComponent<TextMesh>();
            tmp.text = "PLACEHOLDER PISTOLS — replace via HertzWeaponDefinition";
            tmp.characterSize = 0.08f;
            tmp.anchor = TextAnchor.MiddleCenter;
            tmp.color = Color.yellow;

            StripRuntimeClonesInScene();
            EditorSceneManager.MarkSceneDirty(scene);
            if (save)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(ScenePath) ?? "Assets/Scenes");
                EditorSceneManager.SaveScene(scene, ScenePath);
                AssetDatabase.SaveAssets();
            }
        }

        /// <summary>
        /// True when the saved scene already contains the playable rig (not proof-only objects).
        /// </summary>
        public static bool SceneHasPlayableRig()
        {
            if (!File.Exists(ScenePath)) return false;
            var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            HertzDualPistolRuntime runtime = null;
            HertzFrequencyGate gate = null;
            foreach (var root in scene.GetRootGameObjects())
            {
                if (runtime == null) runtime = root.GetComponentInChildren<HertzDualPistolRuntime>(true);
                if (gate == null) gate = root.GetComponentInChildren<HertzFrequencyGate>(true);
            }

            return runtime != null && gate != null && runtime.LeftDefinition != null && runtime.RightDefinition != null;
        }

        public static int CountRuntimeNamedObjectsInActiveScene()
        {
            var count = 0;
            var scene = SceneManager.GetActiveScene();
            foreach (var root in scene.GetRootGameObjects())
            {
                count += CountRuntimeNamed(root.transform);
            }

            return count;
        }

        public static void StripRuntimeClonesInScene()
        {
            var scene = SceneManager.GetActiveScene();
            foreach (var root in scene.GetRootGameObjects())
            {
                StripRuntimeNamed(root.transform);
            }
        }

        private static int CountRuntimeNamed(Transform t)
        {
            var n = t.name.EndsWith("_Runtime", System.StringComparison.Ordinal) ? 1 : 0;
            for (var i = 0; i < t.childCount; i++) n += CountRuntimeNamed(t.GetChild(i));
            return n;
        }

        private static void StripRuntimeNamed(Transform t)
        {
            for (var i = t.childCount - 1; i >= 0; i--)
            {
                StripRuntimeNamed(t.GetChild(i));
            }

            if (t.name.EndsWith("_Runtime", System.StringComparison.Ordinal))
            {
                Object.DestroyImmediate(t.gameObject);
            }
        }

        private static HertzWeaponTestTarget CreateTarget(string name, Vector3 pos, Color color)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            go.transform.position = pos;
            go.transform.localScale = new Vector3(0.8f, 1.2f, 0.4f);
            var r = go.GetComponent<Renderer>();
            if (r != null)
            {
                var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
                var mat = new Material(shader);
                if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", color);
                if (mat.HasProperty("_Color")) mat.SetColor("_Color", color);
                r.sharedMaterial = mat;
            }

            var target = go.AddComponent<HertzWeaponTestTarget>();
            var so = new SerializedObject(target);
            so.FindProperty("feedbackRenderer").objectReferenceValue = r;
            so.ApplyModifiedPropertiesWithoutUndo();
            return target;
        }

        private static void CreateFloor()
        {
            var floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
            floor.name = "TestFloor";
            floor.transform.position = Vector3.zero;
            floor.transform.localScale = new Vector3(3f, 1f, 8f);
        }

        private static GameObject EnsurePlaceholderPrefab(string path, string rootName, Color color)
        {
            EnsureFolders();
            var existing = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (existing != null) return existing;

            var root = new GameObject(rootName);
            var recoil = new GameObject("RecoilPivot");
            recoil.transform.SetParent(root.transform, false);

            var grip = new GameObject("Grip");
            grip.transform.SetParent(recoil.transform, false);

            var body = GameObject.CreatePrimitive(PrimitiveType.Cube);
            body.name = "Body";
            body.transform.SetParent(recoil.transform, false);
            body.transform.localPosition = new Vector3(0f, 0.02f, 0.08f);
            body.transform.localScale = new Vector3(0.06f, 0.1f, 0.18f);
            Object.DestroyImmediate(body.GetComponent<Collider>());

            var barrel = GameObject.CreatePrimitive(PrimitiveType.Cube);
            barrel.name = "Barrel";
            barrel.transform.SetParent(recoil.transform, false);
            barrel.transform.localPosition = new Vector3(0f, 0.04f, 0.2f);
            barrel.transform.localScale = new Vector3(0.03f, 0.03f, 0.16f);
            Object.DestroyImmediate(barrel.GetComponent<Collider>());

            var muzzle = new GameObject("Muzzle");
            muzzle.transform.SetParent(recoil.transform, false);
            muzzle.transform.localPosition = new Vector3(0f, 0.04f, 0.3f);

            foreach (var r in root.GetComponentsInChildren<Renderer>())
            {
                var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
                var mat = new Material(shader);
                if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", color);
                if (mat.HasProperty("_Color")) mat.SetColor("_Color", color);
                r.sharedMaterial = mat;
            }

            var prefab = PrefabUtility.SaveAsPrefabAsset(root, path);
            Object.DestroyImmediate(root);
            return prefab;
        }

        private static HertzWeaponDefinition EnsureDefinition(
            string path,
            string weaponId,
            string displayName,
            HertzWeaponDefinition.WeaponRole role,
            GameObject prefab)
        {
            EnsureFolders();
            var def = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(path);
            if (def == null)
            {
                def = ScriptableObject.CreateInstance<HertzWeaponDefinition>();
                AssetDatabase.CreateAsset(def, path);
            }

            def.TryApplyStudioFields(
                weaponId,
                displayName,
                role,
                true,
                true,
                prefab,
                12f,
                0.18f,
                40f,
                0.2f,
                "LeftHand",
                "RightHand",
                "Grip",
                "Muzzle",
                1,
                "placeholder-test",
                out _);
            EditorUtility.SetDirty(def);
            AssetDatabase.SaveAssets();
            return def;
        }

        private static void EnsureFolders()
        {
            EnsureFolder("Assets/HertzStudio");
            EnsureFolder("Assets/HertzStudio/Weapons");
            EnsureFolder(TestAssetsFolder);
            EnsureFolder(DefinitionsFolder);
            EnsureFolder("Assets/Scenes");
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parts = folder.Split('/');
            var current = parts[0];
            for (var i = 1; i < parts.Length; i++)
            {
                var next = current + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(current, parts[i]);
                current = next;
            }
        }
    }
}
