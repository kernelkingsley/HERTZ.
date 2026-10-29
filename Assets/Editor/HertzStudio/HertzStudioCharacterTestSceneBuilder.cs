using Hertz.Analytics;
using Hertz.Characters;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Isolated W05 playable scene — SampleScene untouched. No invented species encounters.
    /// </summary>
    public static class HertzStudioCharacterTestSceneBuilder
    {
        public const string ScenePath = "Assets/Scenes/HertzCharacterTest.unity";
        private const string ProfilesFolder = "Assets/HertzStudio/Characters/Profiles";
        private const string ModelsFolder = "Assets/HertzStudio/Characters/Models";
        private const string TestAssets = "Assets/HertzStudio/Characters/TestAssets";

        [MenuItem("HERTZ/Studio/Build Character Test Scene")]
        public static void BuildPlayableScene()
        {
            EnsureFolders();
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            scene.name = "HertzCharacterTest";

            var root = new GameObject("HertzCharacterTestRig");
            var gate = root.AddComponent<HertzFrequencyGate>();
            gate.SetFrequencyActive(false);

            var player = new GameObject("PlayerProxy");
            player.transform.position = new Vector3(0f, 0f, 0f);
            var playerCapsule = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            playerCapsule.name = "PLACEHOLDER_PlayerProxy";
            playerCapsule.transform.SetParent(player.transform, false);

            var holdProfile = EnsureProfile("W05_Test_Hold", HertzEnemyBehaviorProfile.BehaviorMode.HoldPosition, 0.35f);
            var rushProfile = EnsureProfile("W05_Test_Rush", HertzEnemyBehaviorProfile.BehaviorMode.Rush, 0.2f);

            var holdGo = CreateEnemy("Enemy_Hold", new Vector3(0f, 0f, 8f), holdProfile, gate, player.transform);
            var rushGo = CreateEnemy("Enemy_Rush", new Vector3(4f, 0f, 10f), rushProfile, gate, player.transform);

            var floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
            floor.name = "TestFloor";
            floor.transform.localScale = new Vector3(2f, 1f, 2f);

            var label = new GameObject("PLACEHOLDER_CONTENT_LABEL");
            var hud = root.AddComponent<Hertz.Characters.HertzCharacterTestHud>();
            hud.Configure(gate, holdGo.GetComponent<HertzEnemyAgent>(), rushGo.GetComponent<HertzEnemyAgent>());
            var analytics = root.AddComponent<HertzAnalyticsCapture>();
            analytics.Configure("editor-dev", "HertzCharacterTest", gate, null);

            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            Debug.Log($"[HERTZ] Built {ScenePath}");
        }

        private static GameObject CreateEnemy(
            string name,
            Vector3 position,
            HertzEnemyBehaviorProfile profile,
            HertzFrequencyGate gate,
            Transform player)
        {
            var go = new GameObject(name);
            go.transform.position = position;
            var spirit = go.AddComponent<HertzSpiritTarget>();
            spirit.Configure(gate, 30f);
            var agent = go.AddComponent<HertzEnemyAgent>();
            var patrolA = new GameObject(name + "_PatrolA");
            patrolA.transform.position = position + new Vector3(-2f, 0f, 0f);
            var patrolB = new GameObject(name + "_PatrolB");
            patrolB.transform.position = position + new Vector3(2f, 0f, 0f);
            agent.Configure(profile, gate, player, new[] { patrolA.transform, patrolB.transform }, spirit);
            var marker = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            marker.name = "PLACEHOLDER_" + name;
            marker.transform.SetParent(go.transform, false);
            Object.DestroyImmediate(marker.GetComponent<Collider>());
            return go;
        }

        private static HertzEnemyBehaviorProfile EnsureProfile(
            string name,
            HertzEnemyBehaviorProfile.BehaviorMode mode,
            float wait)
        {
            EnsureFolders();
            var modelPath = $"{ModelsFolder}/{name}_Visual.asset";
            var model = AssetDatabase.LoadAssetAtPath<HertzCharacterDefinition>(modelPath);
            if (model == null)
            {
                model = ScriptableObject.CreateInstance<HertzCharacterDefinition>();
                AssetDatabase.CreateAsset(model, modelPath);
            }

            var idleClip = EnsurePlaceholderClip($"{TestAssets}/PLACEHOLDER_Idle.anim", "PLACEHOLDER_Idle");
            var attackClip = EnsurePlaceholderClip($"{TestAssets}/PLACEHOLDER_Attack.anim", "PLACEHOLDER_Attack");
            var locoClip = EnsurePlaceholderClip($"{TestAssets}/PLACEHOLDER_Locomotion.anim", "PLACEHOLDER_Locomotion");

            model.TryApplyStudioFields(
                name + "_visual",
                name + " Visual",
                HertzCharacterDefinition.CharacterKind.EnemyVisual,
                true,
                null,
                1f,
                false,
                idleClip,
                attackClip,
                locoClip,
                null,
                null,
                null,
                1,
                "test",
                out _);
            EditorUtility.SetDirty(model);

            var path = $"{ProfilesFolder}/{name}.asset";
            var profile = AssetDatabase.LoadAssetAtPath<HertzEnemyBehaviorProfile>(path);
            if (profile == null)
            {
                profile = ScriptableObject.CreateInstance<HertzEnemyBehaviorProfile>();
                AssetDatabase.CreateAsset(profile, path);
            }

            profile.TryApplyStudioFields(
                name,
                name,
                true,
                model,
                2.5f,
                12f,
                8f,
                wait,
                0.5f,
                2.5f,
                mode,
                idleClip,
                attackClip,
                locoClip,
                null,
                null,
                null,
                1,
                "test",
                out _);
            EditorUtility.SetDirty(profile);
            AssetDatabase.SaveAssets();
            return profile;
        }

        private static AnimationClip EnsurePlaceholderClip(string assetPath, string clipName)
        {
            var existing = AssetDatabase.LoadAssetAtPath<AnimationClip>(assetPath);
            if (existing != null) return existing;
            EnsureFolder(TestAssets);
            var clip = new AnimationClip { name = clipName };
            // Tiny Y bob so Play Mode / Animation component has a visible curve.
            var curve = AnimationCurve.EaseInOut(0f, 0f, 1f, 0.05f);
            clip.SetCurve("", typeof(Transform), "localPosition.y", curve);
            AssetDatabase.CreateAsset(clip, assetPath);
            return clip;
        }

        private static void EnsureFolders()
        {
            EnsureFolder(ModelsFolder);
            EnsureFolder(ProfilesFolder);
            EnsureFolder(TestAssets);
            EnsureFolder("Assets/Scenes");
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parts = folder.Split('/');
            var cur = parts[0];
            for (var i = 1; i < parts.Length; i++)
            {
                var next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(cur, parts[i]);
                cur = next;
            }
        }
    }

}
