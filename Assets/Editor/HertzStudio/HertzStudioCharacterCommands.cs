using System;
using System.IO;
using Hertz.Characters;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Create/update W05 character model and enemy profile ScriptableObjects.
    /// </summary>
    internal static class HertzStudioCharacterCommands
    {
        private const string ModelsFolder = "Assets/HertzStudio/Characters/Models";
        private const string ProfilesFolder = "Assets/HertzStudio/Characters/Profiles";

        internal sealed class SyncResult
        {
            public bool Ok;
            public bool Conflict;
            public string Error;
            public string AssetGuid;
            public string AssetPath;
            public string ObservedPayloadHash;
            public int ObservedVersion;
            public string EntityId;
            public string AssetType;
        }

        internal sealed class DeployResult
        {
            public bool Ok;
            public bool Conflict;
            public string Error;
            public string ScenePath;
            public string SceneGuid;
            public int UnityRevision;
            public string[] ManagedObjectIds = Array.Empty<string>();
        }

        internal sealed class CharacterModelRequest
        {
            public string CharacterId;
            public string DisplayName;
            public string Kind;
            public bool Enabled = true;
            public float Scale = 1f;
            public bool ReplaceTrackedXrRig;
            public int Version = 1;
            public string PayloadHash;
            public string ModelPrefabPath;
            public string ExpectedAssetGuid;
            public string AssetPath;
            public string IdleAnimPath;
            public string AttackAnimPath;
            public string LocomotionAnimPath;
        }

        internal sealed class EnemyProfileRequest
        {
            public string ProfileId;
            public string DisplayName;
            public bool Enabled = true;
            public int Version = 1;
            public string PayloadHash;
            public string ExpectedAssetGuid;
            public string AssetPath;
            public string ModelAssetGuid;
            public float MoveSpeed = 2.5f;
            public float DetectionRangeMeters = 12f;
            public float AttackRangeMeters = 8f;
            public float WaitReactionDelaySeconds = 0.4f;
            public float ShotBurstIntervalSeconds = 0.75f;
            public float ApproachDistanceMeters = 3f;
            public string Mode = "hold_position";
            public string IdleAnimPath;
            public string AttackAnimPath;
            public string LocomotionAnimPath;
        }

        internal static SyncResult SyncCharacterModel(CharacterModelRequest req)
        {
            var result = new SyncResult { EntityId = req?.CharacterId, AssetType = nameof(HertzCharacterDefinition) };
            if (req == null || string.IsNullOrWhiteSpace(req.CharacterId) || string.IsNullOrWhiteSpace(req.PayloadHash))
            {
                result.Error = "characterId and payloadHash required.";
                return result;
            }

            if (req.ReplaceTrackedXrRig)
            {
                result.Error = "replaceTrackedXrRig is forbidden.";
                return result;
            }

            EnsureFolder(ModelsFolder);
            var assetPath = string.IsNullOrWhiteSpace(req.AssetPath)
                ? $"{ModelsFolder}/{req.CharacterId}.asset"
                : req.AssetPath.Replace('\\', '/');
            if (!assetPath.StartsWith(ModelsFolder + "/", StringComparison.Ordinal))
            {
                assetPath = $"{ModelsFolder}/{req.CharacterId}.asset";
            }

            var def = AssetDatabase.LoadAssetAtPath<HertzCharacterDefinition>(assetPath);
            if (def == null && !string.IsNullOrEmpty(req.ExpectedAssetGuid))
            {
                var mapped = AssetDatabase.GUIDToAssetPath(req.ExpectedAssetGuid);
                if (!string.IsNullOrEmpty(mapped))
                {
                    def = AssetDatabase.LoadAssetAtPath<HertzCharacterDefinition>(mapped);
                    if (def != null) assetPath = mapped;
                }
            }

            if (def == null)
            {
                def = ScriptableObject.CreateInstance<HertzCharacterDefinition>();
                AssetDatabase.CreateAsset(def, assetPath);
            }

            GameObject prefab = null;
            if (!string.IsNullOrEmpty(req.ModelPrefabPath) && req.ModelPrefabPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                prefab = AssetDatabase.LoadAssetAtPath<GameObject>(req.ModelPrefabPath);
            }

            var kind = string.Equals(req.Kind, "player_character", StringComparison.OrdinalIgnoreCase)
                ? HertzCharacterDefinition.CharacterKind.PlayerCharacter
                : HertzCharacterDefinition.CharacterKind.EnemyVisual;

            ResolveAnimation(req.IdleAnimPath, out var idleClip, out var idleCtrl);
            ResolveAnimation(req.AttackAnimPath, out var attackClip, out var attackCtrl);
            ResolveAnimation(req.LocomotionAnimPath, out var locoClip, out var locoCtrl);

            if (!def.TryApplyStudioFields(
                    req.CharacterId,
                    req.DisplayName,
                    kind,
                    req.Enabled,
                    prefab,
                    req.Scale,
                    false,
                    idleClip,
                    attackClip,
                    locoClip,
                    idleCtrl,
                    attackCtrl,
                    locoCtrl,
                    req.Version,
                    req.PayloadHash,
                    out var error))
            {
                result.Error = error;
                return result;
            }

            EditorUtility.SetDirty(def);
            AssetDatabase.SaveAssets();
            result.Ok = true;
            result.AssetPath = assetPath;
            result.AssetGuid = AssetDatabase.AssetPathToGUID(assetPath);
            result.ObservedPayloadHash = req.PayloadHash;
            result.ObservedVersion = req.Version;
            return result;
        }

        internal static SyncResult SyncEnemyProfile(EnemyProfileRequest req)
        {
            var result = new SyncResult { EntityId = req?.ProfileId, AssetType = nameof(HertzEnemyBehaviorProfile) };
            if (req == null || string.IsNullOrWhiteSpace(req.ProfileId) || string.IsNullOrWhiteSpace(req.PayloadHash))
            {
                result.Error = "profileId and payloadHash required.";
                return result;
            }

            EnsureFolder(ProfilesFolder);
            var assetPath = string.IsNullOrWhiteSpace(req.AssetPath)
                ? $"{ProfilesFolder}/{req.ProfileId}.asset"
                : req.AssetPath.Replace('\\', '/');
            if (!assetPath.StartsWith(ProfilesFolder + "/", StringComparison.Ordinal))
            {
                assetPath = $"{ProfilesFolder}/{req.ProfileId}.asset";
            }

            var def = AssetDatabase.LoadAssetAtPath<HertzEnemyBehaviorProfile>(assetPath);
            if (def == null && !string.IsNullOrEmpty(req.ExpectedAssetGuid))
            {
                var mapped = AssetDatabase.GUIDToAssetPath(req.ExpectedAssetGuid);
                if (!string.IsNullOrEmpty(mapped))
                {
                    def = AssetDatabase.LoadAssetAtPath<HertzEnemyBehaviorProfile>(mapped);
                    if (def != null) assetPath = mapped;
                }
            }

            if (def == null)
            {
                def = ScriptableObject.CreateInstance<HertzEnemyBehaviorProfile>();
                AssetDatabase.CreateAsset(def, assetPath);
            }

            HertzCharacterDefinition model = null;
            if (!string.IsNullOrEmpty(req.ModelAssetGuid))
            {
                var modelPath = AssetDatabase.GUIDToAssetPath(req.ModelAssetGuid);
                if (!string.IsNullOrEmpty(modelPath))
                {
                    model = AssetDatabase.LoadAssetAtPath<HertzCharacterDefinition>(modelPath);
                }
            }

            var mode = ParseMode(req.Mode);
            ResolveAnimation(req.IdleAnimPath, out var idleClip, out var idleCtrl);
            ResolveAnimation(req.AttackAnimPath, out var attackClip, out var attackCtrl);
            ResolveAnimation(req.LocomotionAnimPath, out var locoClip, out var locoCtrl);
            if (!def.TryApplyStudioFields(
                    req.ProfileId,
                    req.DisplayName,
                    req.Enabled,
                    model,
                    req.MoveSpeed,
                    req.DetectionRangeMeters,
                    req.AttackRangeMeters,
                    req.WaitReactionDelaySeconds,
                    req.ShotBurstIntervalSeconds,
                    req.ApproachDistanceMeters,
                    mode,
                    idleClip,
                    attackClip,
                    locoClip,
                    idleCtrl,
                    attackCtrl,
                    locoCtrl,
                    req.Version,
                    req.PayloadHash,
                    out var error))
            {
                result.Error = error;
                return result;
            }

            EditorUtility.SetDirty(def);
            AssetDatabase.SaveAssets();
            result.Ok = true;
            result.AssetPath = assetPath;
            result.AssetGuid = AssetDatabase.AssetPathToGUID(assetPath);
            result.ObservedPayloadHash = req.PayloadHash;
            result.ObservedVersion = req.Version;
            return result;
        }

        internal static DeployResult DeployToScene(
            string characterId,
            string characterKind,
            string characterAssetGuid,
            string characterAssetPath,
            string profileId,
            string profileAssetGuid,
            string profileAssetPath,
            string scenePath,
            string sceneGuid,
            int expectedUnityRevision,
            bool confirmSave,
            int quantity,
            Vector3 position,
            Quaternion rotation,
            Vector3 scale,
            string managedObjectId)
        {
            var result = new DeployResult { ScenePath = scenePath, SceneGuid = sceneGuid };
            if (string.IsNullOrWhiteSpace(characterId))
            {
                result.Error = "characterId required.";
                return result;
            }
            if (!confirmSave || expectedUnityRevision < 0 || quantity < 1 || quantity > 8)
            {
                result.Error = "Explicit save confirmation, a current revision, and quantity 1-8 are required.";
                return result;
            }
            var modelPath = ResolveAssetPath(characterAssetGuid, characterAssetPath);
            var definition = AssetDatabase.LoadAssetAtPath<HertzCharacterDefinition>(modelPath);
            if (definition == null || !string.Equals(definition.CharacterId, characterId, StringComparison.Ordinal))
            {
                result.Error = "Synced HertzCharacterDefinition not found or characterId mismatch.";
                return result;
            }
            if (!definition.Enabled || definition.ModelPrefab == null || definition.ReplaceTrackedXrRig)
            {
                result.Error = "Character definition is disabled, missing its model prefab, or violates XR safety.";
                return result;
            }

            HertzEnemyBehaviorProfile profile = null;
            if (!string.IsNullOrWhiteSpace(profileId))
            {
                var resolvedProfilePath = ResolveAssetPath(profileAssetGuid, profileAssetPath);
                profile = AssetDatabase.LoadAssetAtPath<HertzEnemyBehaviorProfile>(resolvedProfilePath);
                if (profile == null || !string.Equals(profile.ProfileId, profileId, StringComparison.Ordinal))
                {
                    result.Error = "Synced HertzEnemyBehaviorProfile not found or profileId mismatch.";
                    return result;
                }
                if (definition.Kind != HertzCharacterDefinition.CharacterKind.EnemyVisual || profile.VisualModel != definition)
                {
                    result.Error = "Enemy profile is not linked to the selected enemy visual definition.";
                    return result;
                }
            }

            var target = FindLoadedScene(scenePath);
            if (!target.IsValid() || !target.isLoaded)
            {
                var mode = SceneManager.sceneCount > 1 ? OpenSceneMode.Additive : OpenSceneMode.Single;
                target = EditorSceneManager.OpenScene(scenePath, mode);
            }
            if (!target.IsValid() || !target.isLoaded)
            {
                result.Error = "Failed to open the selected target scene.";
                return result;
            }

            HertzFrequencyGate gate = null;
            Transform playerTarget = null;
            if (profile != null)
            {
                foreach (var sceneRoot in target.GetRootGameObjects())
                {
                    if (gate == null) gate = sceneRoot.GetComponentInChildren<HertzFrequencyGate>(true);
                    if (playerTarget == null)
                    {
                        var camera = sceneRoot.GetComponentInChildren<Camera>(true);
                        if (camera != null) playerTarget = camera.transform;
                        else if (string.Equals(sceneRoot.name, "PlayerProxy", StringComparison.OrdinalIgnoreCase)) playerTarget = sceneRoot.transform;
                    }
                }
                if (gate == null || playerTarget == null)
                {
                    result.Error = "Enemy deployment needs an existing HertzFrequencyGate and player/head target in the selected scene.";
                    return result;
                }
            }

            var baseName = string.IsNullOrWhiteSpace(managedObjectId)
                ? $"HertzStudioManagedCharacter_{characterId}"
                : managedObjectId;
            var roots = target.GetRootGameObjects();
            foreach (var candidate in roots)
            {
                if (TryGetManagedRootIndex(candidate.name, baseName, out _) &&
                    HertzStudioSceneCommands.IsProtectedHierarchy(candidate))
                {
                    result.Error = "Refusing to mutate a managed character under a protected XR/camera hierarchy.";
                    return result;
                }
            }

            var managed = new GameObject[quantity];
            UnityEditor.Undo.IncrementCurrentGroup();
            var undoGroup = UnityEditor.Undo.GetCurrentGroup();
            UnityEditor.Undo.SetCurrentGroupName("HERTZ Studio Deploy Character");
            try
            {
                for (var index = 0; index < quantity; index++)
                {
                    // Index zero keeps one identity regardless of quantity so switching between
                    // one and many instances does not create a second managed root.
                    var expectedName = index == 0 ? baseName : $"{baseName}_{index}";
                    GameObject root = null;
                    var migrateLegacyName = false;
                    foreach (var candidate in roots)
                    {
                        if (string.Equals(candidate.name, expectedName, StringComparison.Ordinal))
                        {
                            root = candidate;
                            break;
                        }
                    }

                    // Migrate the original multi-instance _0 name without losing its
                    // GlobalObjectId. Any duplicate legacy root is removed below.
                    if (root == null && index == 0)
                    {
                        foreach (var candidate in roots)
                        {
                            if (string.Equals(candidate.name, $"{baseName}_0", StringComparison.Ordinal))
                            {
                                root = candidate;
                                migrateLegacyName = true;
                                break;
                            }
                        }
                    }

                    if (root == null)
                    {
                        root = new GameObject(expectedName);
                        SceneManager.MoveGameObjectToScene(root, target);
                        UnityEditor.Undo.RegisterCreatedObjectUndo(root, "HERTZ Studio Create Managed Character");
                    }
                    else
                    {
                        UnityEditor.Undo.RegisterFullObjectHierarchyUndo(root, "HERTZ Studio Update Managed Character");
                        if (migrateLegacyName) root.name = expectedName;
                    }

                    root.transform.position = position + new Vector3(index * 1.5f, 0f, 0f);
                    root.transform.rotation = rotation;
                    root.transform.localScale = scale;
                    ClearManagedRuntime(root);

                    if (profile != null)
                    {
                        var spirit = UnityEditor.Undo.AddComponent<HertzSpiritTarget>(root);
                        spirit.Configure(gate, 30f);
                        var agent = UnityEditor.Undo.AddComponent<HertzEnemyAgent>(root);
                        agent.Configure(profile, gate, playerTarget, Array.Empty<Transform>(), spirit);
                    }
                    else
                    {
                        var visual = PrefabUtility.InstantiatePrefab(definition.ModelPrefab, root.transform) as GameObject;
                        if (visual == null) visual = UnityEngine.Object.Instantiate(definition.ModelPrefab, root.transform);
                        if (visual == null) throw new InvalidOperationException("Unity could not instantiate the selected character prefab.");
                        UnityEditor.Undo.RegisterCreatedObjectUndo(visual, "HERTZ Studio Create Character Visual");
                        visual.name = definition.DisplayName + "_Runtime";
                        visual.transform.localPosition = Vector3.zero;
                        visual.transform.localRotation = Quaternion.identity;
                        visual.transform.localScale = Vector3.one * definition.Scale;
                    }

                    managed[index] = root;
                    EditorUtility.SetDirty(root);
                }

                // Quantity reductions and the old single/multiple naming scheme can leave
                // surplus managed roots. Remove only roots owned by this exact character ID.
                foreach (var candidate in roots)
                {
                    if (Array.IndexOf(managed, candidate) < 0 &&
                        TryGetManagedRootIndex(candidate.name, baseName, out _))
                    {
                        UnityEditor.Undo.DestroyObjectImmediate(candidate);
                    }
                }

                EditorSceneManager.MarkSceneDirty(target);
                if (!EditorSceneManager.SaveScene(target))
                {
                    UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                    result.Error = "Unity failed to save the selected target scene; managed character changes were rolled back.";
                    return result;
                }

                UnityEditor.Undo.CollapseUndoOperations(undoGroup);
            }
            catch (Exception ex)
            {
                UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                result.Error = $"Character deployment failed and was rolled back: {ex.Message}";
                return result;
            }
            result.UnityRevision = HertzStudioHttpBridge.RecordSceneContentChangeForProof(scenePath);
            result.ManagedObjectIds = new string[managed.Length];
            for (var i = 0; i < managed.Length; i++)
            {
                result.ManagedObjectIds[i] = GlobalObjectId.GetGlobalObjectIdSlow(managed[i]).ToString();
            }
            result.Ok = true;
            return result;
        }

        private static string ResolveAssetPath(string guid, string assetPath)
        {
            if (!string.IsNullOrWhiteSpace(guid))
            {
                var mapped = AssetDatabase.GUIDToAssetPath(guid);
                if (!string.IsNullOrWhiteSpace(mapped)) return mapped;
            }
            return (assetPath ?? string.Empty).Replace('\\', '/');
        }

        private static Scene FindLoadedScene(string scenePath)
        {
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (string.Equals(scene.path, scenePath, StringComparison.OrdinalIgnoreCase)) return scene;
            }
            return default;
        }

        private static bool TryGetManagedRootIndex(string objectName, string baseName, out int index)
        {
            index = -1;
            if (string.Equals(objectName, baseName, StringComparison.Ordinal))
            {
                index = 0;
                return true;
            }

            var prefix = baseName + "_";
            if (string.IsNullOrEmpty(objectName) ||
                !objectName.StartsWith(prefix, StringComparison.Ordinal))
            {
                return false;
            }

            return int.TryParse(objectName.Substring(prefix.Length), out index) && index >= 0;
        }

        private static void ClearManagedRuntime(GameObject root)
        {
            foreach (var agent in root.GetComponents<HertzEnemyAgent>()) UnityEditor.Undo.DestroyObjectImmediate(agent);
            foreach (var spirit in root.GetComponents<HertzSpiritTarget>()) UnityEditor.Undo.DestroyObjectImmediate(spirit);
            for (var i = root.transform.childCount - 1; i >= 0; i--)
            {
                UnityEditor.Undo.DestroyObjectImmediate(root.transform.GetChild(i).gameObject);
            }
        }

        internal static SyncResult DeleteDefinition(string entityKind, string entityId, string expectedGuid, string assetPath)
        {
            var result = new SyncResult { EntityId = entityId };
            var path = assetPath;
            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(expectedGuid))
            {
                path = AssetDatabase.GUIDToAssetPath(expectedGuid);
            }

            if (string.IsNullOrEmpty(path) || !File.Exists(path))
            {
                result.Ok = true;
                result.Error = null;
                return result;
            }

            if (!string.IsNullOrEmpty(expectedGuid))
            {
                var guid = AssetDatabase.AssetPathToGUID(path);
                if (!string.Equals(guid, expectedGuid, StringComparison.OrdinalIgnoreCase))
                {
                    result.Conflict = true;
                    result.Error = "GUID mismatch on delete.";
                    return result;
                }
            }

            if (!AssetDatabase.DeleteAsset(path))
            {
                result.Error = "AssetDatabase.DeleteAsset failed.";
                return result;
            }

            result.Ok = true;
            result.AssetPath = path;
            result.AssetGuid = expectedGuid;
            return result;
        }

        private static HertzEnemyBehaviorProfile.BehaviorMode ParseMode(string mode)
        {
            var normalized = (mode ?? string.Empty).Trim().ToLowerInvariant();
            switch (normalized)
            {
                case "idle": return HertzEnemyBehaviorProfile.BehaviorMode.Idle;
                case "patrol": return HertzEnemyBehaviorProfile.BehaviorMode.Patrol;
                case "rush": return HertzEnemyBehaviorProfile.BehaviorMode.Rush;
                default: return HertzEnemyBehaviorProfile.BehaviorMode.HoldPosition;
            }
        }

        /// <summary>
        /// Authoritative W05 animation/rig probe. Paths must be under Assets/. Never exposes filesystem escape.
        /// Does not mutate XR rig, camera, or scene objects.
        /// </summary>
        internal static AnimationValidationResult ValidateAnimationBinding(
            string modelUnityPath,
            string animationUnityPath,
            string slot,
            string modelAssetId,
            string animationAssetId)
        {
            if (string.IsNullOrWhiteSpace(modelUnityPath) ||
                !modelUnityPath.StartsWith("Assets/", StringComparison.Ordinal) ||
                modelUnityPath.Contains(".."))
            {
                return AnimationValidationResult.Fail("modelUnityPath must be an Assets/ path without '..'.");
            }

            if (string.IsNullOrWhiteSpace(animationUnityPath) ||
                !animationUnityPath.StartsWith("Assets/", StringComparison.Ordinal) ||
                animationUnityPath.Contains(".."))
            {
                return AnimationValidationResult.Fail("animationUnityPath must be an Assets/ path without '..'.");
            }

            ResolveAnimation(animationUnityPath, out var clip, out var controller);
            if (clip == null && controller == null)
            {
                return AnimationValidationResult.Fail(
                    "Animation asset not found at path (AnimationClip / RuntimeAnimatorController required).",
                    modelAssetId,
                    animationAssetId,
                    slot);
            }

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(modelUnityPath);
            Animator animator = null;
            Avatar avatar = null;
            if (prefab != null)
            {
                animator = prefab.GetComponentInChildren<Animator>(true);
                if (animator != null) avatar = animator.avatar;
            }

            if (prefab == null)
            {
                // Model may be a mesh FBX without a prefab wrapper — still accept anim load as pending bind.
                return new AnimationValidationResult
                {
                    Ok = true,
                    Compatible = false,
                    Source = "unity_editor",
                    Reason =
                        "Animation asset loads in Unity, but model prefab/GameObject was not found for avatar bind check.",
                    ModelAssetId = modelAssetId,
                    AnimationAssetId = animationAssetId,
                    Slot = slot,
                    AnimationKind = controller != null ? "controller" : "clip",
                    HasAvatar = false,
                };
            }

            if (animator == null)
            {
                return new AnimationValidationResult
                {
                    Ok = true,
                    Compatible = false,
                    Source = "unity_editor",
                    Reason = "Model has no Animator — cannot confirm rig compatibility.",
                    ModelAssetId = modelAssetId,
                    AnimationAssetId = animationAssetId,
                    Slot = slot,
                    AnimationKind = controller != null ? "controller" : "clip",
                    HasAvatar = false,
                };
            }

            // Humanoid clips require a humanoid avatar; generic clips are accepted when Animator exists.
            var humanoidClip = clip != null && clip.isHumanMotion;
            if (humanoidClip && (avatar == null || !avatar.isHuman))
            {
                return new AnimationValidationResult
                {
                    Ok = true,
                    Compatible = false,
                    Source = "unity_editor",
                    Reason = "Humanoid AnimationClip assigned to a non-humanoid (or missing) avatar.",
                    ModelAssetId = modelAssetId,
                    AnimationAssetId = animationAssetId,
                    Slot = slot,
                    AnimationKind = "clip",
                    HasAvatar = avatar != null,
                };
            }

            return new AnimationValidationResult
            {
                Ok = true,
                Compatible = true,
                Source = "unity_editor",
                Reason = controller != null
                    ? "RuntimeAnimatorController loads with model Animator present."
                    : "AnimationClip loads with model Animator present.",
                ModelAssetId = modelAssetId,
                AnimationAssetId = animationAssetId,
                Slot = slot,
                AnimationKind = controller != null ? "controller" : "clip",
                HasAvatar = avatar != null,
            };
        }

        internal sealed class AnimationValidationResult
        {
            public bool Ok;
            public bool Compatible;
            public string Source;
            public string Reason;
            public string ModelAssetId;
            public string AnimationAssetId;
            public string Slot;
            public string AnimationKind;
            public bool HasAvatar;

            public static AnimationValidationResult Fail(
                string reason,
                string modelAssetId = null,
                string animationAssetId = null,
                string slot = null)
            {
                return new AnimationValidationResult
                {
                    Ok = false,
                    Compatible = false,
                    Source = "unity_editor",
                    Reason = reason,
                    ModelAssetId = modelAssetId,
                    AnimationAssetId = animationAssetId,
                    Slot = slot,
                };
            }

            public string ToJson()
            {
                return "{" +
                       $"\"ok\":{(Ok ? "true" : "false")}," +
                       $"\"compatible\":{(Compatible ? "true" : "false")}," +
                       $"\"source\":{Quote(Source)}," +
                       $"\"reason\":{Quote(Reason)}," +
                       $"\"modelAssetId\":{Quote(ModelAssetId)}," +
                       $"\"animationAssetId\":{Quote(AnimationAssetId)}," +
                       $"\"slot\":{Quote(Slot)}," +
                       $"\"animationKind\":{Quote(AnimationKind)}," +
                       $"\"hasAvatar\":{(HasAvatar ? "true" : "false")}" +
                       "}";
            }

            private static string Quote(string value)
            {
                if (value == null) return "null";
                return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            }
        }

        /// <summary>
        /// Loads RuntimeAnimatorController preferred, else AnimationClip, from an Assets/ path.
        /// </summary>
        private static void ResolveAnimation(
            string assetPath,
            out AnimationClip clip,
            out RuntimeAnimatorController controller)
        {
            clip = null;
            controller = null;
            if (string.IsNullOrWhiteSpace(assetPath) || !assetPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                return;
            }

            controller = AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>(assetPath);
            if (controller != null) return;

            clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(assetPath);
            if (clip != null) return;

            var all = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            if (all == null) return;
            foreach (var obj in all)
            {
                if (controller == null && obj is RuntimeAnimatorController c) controller = c;
                if (clip == null && obj is AnimationClip a) clip = a;
            }
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parts = folder.Split('/');
            var cur = parts[0];
            for (var i = 1; i < parts.Length; i++)
            {
                var next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    AssetDatabase.CreateFolder(cur, parts[i]);
                }
                cur = next;
            }
        }
    }
}
