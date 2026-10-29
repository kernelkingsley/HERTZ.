using System;
using System.IO;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Create/update <see cref="HertzWeaponDefinition"/> assets for Studio sync.
    /// Unity is the only authority for GUID/path acknowledgement.
    /// </summary>
    public static class HertzStudioWeaponCommands
    {
        private const string DefinitionsFolder = "Assets/HertzStudio/Weapons/Definitions";

        public sealed class SyncResult
        {
            public bool Ok;
            public bool Conflict;
            public string Error;
            public string AssetGuid;
            public string AssetPath;
            public string ObservedPayloadHash;
            public int ObservedVersion;
            public string WeaponId;
            public bool ModelImported;
            public bool DefinitionSynced;
            public bool AnchorsValid;
            public bool RuntimePlayable;
            public string[] MissingAnchors = Array.Empty<string>();
            public string[] HierarchyNames = Array.Empty<string>();
            public string PrefabPath;
        }

        public static SyncResult SyncDefinition(WeaponSyncRequest req)
        {
            var result = new SyncResult { WeaponId = req?.WeaponId };
            if (req == null || string.IsNullOrWhiteSpace(req.WeaponId))
            {
                result.Error = "weaponId required.";
                return result;
            }

            if (string.IsNullOrWhiteSpace(req.PayloadHash))
            {
                result.Error = "payloadHash required.";
                return result;
            }

            EnsureFolder(DefinitionsFolder);
            var assetPath = string.IsNullOrWhiteSpace(req.AssetPath)
                ? $"{DefinitionsFolder}/{req.WeaponId}.asset"
                : req.AssetPath.Replace('\\', '/');

            if (!assetPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                result.Error = "assetPath must be under Assets/.";
                return result;
            }

            if (!assetPath.StartsWith(DefinitionsFolder + "/", StringComparison.Ordinal) &&
                assetPath != DefinitionsFolder + "/" + req.WeaponId + ".asset")
            {
                // Enforce dedicated folder for Studio-managed definitions.
                assetPath = $"{DefinitionsFolder}/{req.WeaponId}.asset";
            }

            HertzWeaponDefinition def = null;
            var existingGuid = AssetDatabase.AssetPathToGUID(assetPath);
            if (!string.IsNullOrEmpty(existingGuid))
            {
                def = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(assetPath);
            }

            if (def == null && !string.IsNullOrEmpty(req.ExpectedAssetGuid))
            {
                var mappedPath = AssetDatabase.GUIDToAssetPath(req.ExpectedAssetGuid);
                if (!string.IsNullOrEmpty(mappedPath))
                {
                    def = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(mappedPath);
                    if (def != null) assetPath = mappedPath;
                }
            }

            var created = false;
            if (def == null)
            {
                def = ScriptableObject.CreateInstance<HertzWeaponDefinition>();
                AssetDatabase.CreateAsset(def, assetPath);
                created = true;
            }
            else if (!string.IsNullOrEmpty(req.ExpectedAssetGuid))
            {
                var currentGuid = AssetDatabase.AssetPathToGUID(assetPath);
                if (!string.Equals(currentGuid, req.ExpectedAssetGuid, StringComparison.OrdinalIgnoreCase))
                {
                    result.Conflict = true;
                    result.Error = "Existing definition GUID does not match expectedAssetGuid.";
                    return result;
                }
            }

            GameObject prefab = null;
            // Ignore non-path leftovers from JSON null mis-parses (e.g. literal "expectedAssetGuid").
            var modelPath = req.ModelPrefabPath;
            if (!string.IsNullOrEmpty(modelPath) &&
                (modelPath.IndexOf('/') < 0 ||
                 string.Equals(modelPath, "expectedAssetGuid", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(modelPath, "null", StringComparison.OrdinalIgnoreCase)))
            {
                modelPath = null;
            }

            if (!string.IsNullOrEmpty(modelPath))
            {
                prefab = AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
                if (prefab == null)
                {
                    result.Error = $"Model prefab not found at {modelPath}. Import the model first.";
                    result.ModelImported = false;
                    result.AnchorsValid = false;
                    result.RuntimePlayable = false;
                    if (created)
                    {
                        AssetDatabase.DeleteAsset(assetPath);
                    }

                    return result;
                }

                result.ModelImported = true;
                result.PrefabPath = modelPath;
            }

            var t = req.Tuning ?? new WeaponTuning();
            // Prefab-hierarchy validation is authoritative — browser GLB names alone are not enough.
            // Invalid sync must not overwrite a prior valid definition.
            if (prefab != null)
            {
                var anchors = HertzWeaponAnchorUtility.ValidateRuntimeReady(
                    prefab,
                    t.GripAnchor,
                    t.MuzzleAnchor);
                result.AnchorsValid = anchors.Ok;
                result.MissingAnchors = anchors.MissingAnchors;
                result.HierarchyNames = anchors.HierarchyNames;
                result.PrefabPath = anchors.PrefabPath ?? modelPath;
                if (!anchors.Ok)
                {
                    result.Error = anchors.Error;
                    result.DefinitionSynced = false;
                    result.RuntimePlayable = false;
                    if (created)
                    {
                        AssetDatabase.DeleteAsset(assetPath);
                    }

                    return result;
                }
            }
            else
            {
                result.ModelImported = false;
                result.AnchorsValid = false;
                result.RuntimePlayable = false;
            }

            var role = string.Equals(req.Role, "right_pistol", StringComparison.OrdinalIgnoreCase)
                ? HertzWeaponDefinition.WeaponRole.RightPistol
                : HertzWeaponDefinition.WeaponRole.LeftPistol;

            if (!def.TryApplyStudioFields(
                    req.WeaponId,
                    req.DisplayName,
                    role,
                    req.Enabled,
                    req.FrequencyFlipRequired,
                    prefab,
                    t.Damage,
                    t.FireIntervalSeconds,
                    t.RangeMeters,
                    t.Recoil,
                    t.LeftHandAnchor,
                    t.RightHandAnchor,
                    t.GripAnchor,
                    t.MuzzleAnchor,
                    req.Version,
                    req.PayloadHash,
                    out var applyError))
            {
                result.Error = applyError;
                result.DefinitionSynced = false;
                result.RuntimePlayable = false;
                if (created)
                {
                    AssetDatabase.DeleteAsset(assetPath);
                }

                return result;
            }

            EditorUtility.SetDirty(def);
            AssetDatabase.SaveAssets();
            AssetDatabase.ImportAsset(assetPath);

            var guid = AssetDatabase.AssetPathToGUID(assetPath);
            if (string.IsNullOrEmpty(guid))
            {
                result.Error = "Unity failed to assign asset GUID.";
                return result;
            }

            // Preserve GUID across updates — CreateAsset path reuses same file.
            result.Ok = true;
            result.AssetGuid = guid;
            result.AssetPath = assetPath;
            result.ObservedPayloadHash = req.PayloadHash;
            result.ObservedVersion = req.Version;
            result.WeaponId = req.WeaponId;
            result.DefinitionSynced = true;
            // Synced + model + valid Grip/Muzzle on the assigned prefab. Deploy is a separate stage.
            result.RuntimePlayable = prefab != null && result.AnchorsValid;
            if (prefab == null)
            {
                result.AnchorsValid = false;
            }

            return result;
        }

        internal sealed class DeleteResult
        {
            public bool Ok;
            public string Error;
            public string AssetGuid;
            public string AssetPath;
            public string WeaponId;
            public bool Deleted;
            public bool AlreadyAbsent;
        }

        /// <summary>
        /// Unity-acknowledged removal of a Studio-managed weapon definition asset.
        /// Does not delete imported model prefabs.
        /// </summary>
        internal static DeleteResult DeleteDefinition(string weaponId, string expectedGuid, string assetPath)
        {
            var result = new DeleteResult { WeaponId = weaponId };
            if (string.IsNullOrWhiteSpace(weaponId))
            {
                result.Error = "weaponId required.";
                return result;
            }

            var path = string.IsNullOrWhiteSpace(assetPath)
                ? $"{DefinitionsFolder}/{weaponId}.asset"
                : assetPath.Replace('\\', '/');

            if (!string.IsNullOrEmpty(expectedGuid))
            {
                var mapped = AssetDatabase.GUIDToAssetPath(expectedGuid);
                if (!string.IsNullOrEmpty(mapped)) path = mapped;
            }

            if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(path)))
            {
                result.Ok = true;
                result.AlreadyAbsent = true;
                result.Deleted = false;
                result.AssetPath = path;
                result.AssetGuid = expectedGuid ?? "";
                return result;
            }

            var guid = AssetDatabase.AssetPathToGUID(path);
            if (!string.IsNullOrEmpty(expectedGuid) &&
                !string.Equals(guid, expectedGuid, StringComparison.OrdinalIgnoreCase))
            {
                result.Error = "Definition GUID does not match expectedAssetGuid.";
                return result;
            }

            if (!AssetDatabase.DeleteAsset(path))
            {
                result.Error = "Unity failed to delete definition asset.";
                return result;
            }

            AssetDatabase.SaveAssets();
            result.Ok = true;
            result.Deleted = true;
            result.AssetGuid = guid;
            result.AssetPath = path;
            return result;
        }

        internal sealed class ResolveResult
        {
            public bool Ok;
            public string Error;
            public string AssetGuid;
            public string AssetPath;
            public string AssetType;
            public string WeaponId;
            public int StudioVersion;
            public string StudioPayloadHash;
            public bool Exists;
        }

        /// <summary>
        /// Authoritative Unity resolve of a Studio-mapped definition GUID/path.
        /// </summary>
        internal static ResolveResult ResolveDefinition(string assetGuid, string assetPath, string expectedWeaponId = null)
        {
            var result = new ResolveResult();
            var path = string.IsNullOrWhiteSpace(assetPath) ? null : assetPath.Replace('\\', '/');
            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(assetGuid))
            {
                path = AssetDatabase.GUIDToAssetPath(assetGuid);
            }

            if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/", StringComparison.Ordinal))
            {
                result.Error = "Missing or invalid Assets/ path.";
                return result;
            }

            var guid = AssetDatabase.AssetPathToGUID(path);
            if (string.IsNullOrEmpty(guid))
            {
                result.Error = "Asset does not exist at path.";
                result.AssetPath = path;
                return result;
            }

            if (!string.IsNullOrEmpty(assetGuid) &&
                !string.Equals(guid, assetGuid, StringComparison.OrdinalIgnoreCase))
            {
                result.Error = "GUID does not match path.";
                result.AssetGuid = guid;
                result.AssetPath = path;
                return result;
            }

            var def = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(path);
            if (def == null)
            {
                var other = AssetDatabase.LoadMainAssetAtPath(path);
                result.Error = "Asset is not HertzWeaponDefinition.";
                result.Exists = other != null;
                result.AssetGuid = guid;
                result.AssetPath = path;
                result.AssetType = other != null ? other.GetType().Name : "missing";
                return result;
            }

            if (!string.IsNullOrEmpty(expectedWeaponId) &&
                !string.Equals(def.WeaponId, expectedWeaponId, StringComparison.Ordinal))
            {
                result.Error = "WeaponId mismatch.";
                result.Exists = true;
                result.AssetGuid = guid;
                result.AssetPath = path;
                result.AssetType = nameof(HertzWeaponDefinition);
                result.WeaponId = def.WeaponId;
                result.StudioVersion = def.StudioVersion;
                result.StudioPayloadHash = def.StudioPayloadHash;
                return result;
            }

            result.Ok = true;
            result.Exists = true;
            result.AssetGuid = guid;
            result.AssetPath = path;
            result.AssetType = nameof(HertzWeaponDefinition);
            result.WeaponId = def.WeaponId;
            result.StudioVersion = def.StudioVersion;
            result.StudioPayloadHash = def.StudioPayloadHash;
            return result;
        }

        internal sealed class DeployResult
        {
            public bool Ok;
            public bool Conflict;
            public string Error;
            public string ManagedObjectId;
            public string ScenePath;
            public int UnityRevision;
            public string WeaponId;
            public string AssetGuid;
            public string AssetPath;
            public bool UpdatedExisting;
            public string Role;
            public bool ModelImported;
            public bool DefinitionSynced;
            public bool AnchorsValid;
            public bool RuntimeDeployApplied;
            public bool RuntimePlayable;
            public string[] MissingAnchors = Array.Empty<string>();
        }

        /// <summary>
        /// Bind a synced <see cref="HertzWeaponDefinition"/> into the scene DualPistolRuntime.
        /// Updates the same managed object on repeat. Never places a raw mesh or mutates XR Origin/camera.
        /// </summary>
        internal static DeployResult DeployToScene(
            string weaponId,
            string role,
            string assetGuid,
            string assetPath,
            string scenePath,
            int expectedUnityRevision,
            bool confirmSave,
            string managedObjectId)
        {
            var result = new DeployResult
            {
                WeaponId = weaponId,
                Role = role,
                ScenePath = scenePath,
                ManagedObjectId = string.IsNullOrWhiteSpace(managedObjectId)
                    ? $"HertzStudioManagedWeapon_{weaponId}"
                    : managedObjectId,
            };

            if (string.IsNullOrWhiteSpace(weaponId))
            {
                result.Error = "weaponId required.";
                return result;
            }

            if (string.IsNullOrWhiteSpace(scenePath) ||
                !scenePath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                !scenePath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) ||
                scenePath.IndexOf("..", StringComparison.Ordinal) >= 0)
            {
                result.Error = "scenePath must be an Assets/…/*.unity path.";
                return result;
            }

            if (!confirmSave)
            {
                result.Error = "confirmSave must be true after explicit Studio confirmation.";
                return result;
            }

            if (expectedUnityRevision < 0)
            {
                result.Error = "expectedUnityRevision must be non-negative.";
                return result;
            }

            var path = string.IsNullOrWhiteSpace(assetPath)
                ? $"{DefinitionsFolder}/{weaponId}.asset"
                : assetPath.Replace('\\', '/');
            if (!string.IsNullOrEmpty(assetGuid))
            {
                var mapped = AssetDatabase.GUIDToAssetPath(assetGuid);
                if (!string.IsNullOrEmpty(mapped)) path = mapped;
            }

            var def = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(path);
            if (def == null)
            {
                result.Error = $"HertzWeaponDefinition not found at {path}. Sync the definition first.";
                return result;
            }

            if (!string.Equals(def.WeaponId, weaponId, StringComparison.Ordinal))
            {
                result.Conflict = true;
                result.Error = "Definition WeaponId does not match deploy weaponId.";
                return result;
            }

            result.DefinitionSynced = true;
            result.ModelImported = def.ModelPrefab != null;
            var anchorCheck = HertzWeaponAnchorUtility.ValidateRuntimeReady(
                def.ModelPrefab,
                def.GripAnchor,
                def.MuzzleAnchor);
            result.AnchorsValid = anchorCheck.Ok;
            result.MissingAnchors = anchorCheck.MissingAnchors;
            if (!anchorCheck.Ok)
            {
                // Leave prior DualPistolRuntime binding intact — do not report applied/playable.
                result.Error = anchorCheck.Error;
                result.RuntimeDeployApplied = false;
                result.RuntimePlayable = false;
                result.AssetGuid = AssetDatabase.AssetPathToGUID(path);
                result.AssetPath = path;
                return result;
            }

            var target = default(Scene);
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var s = SceneManager.GetSceneAt(i);
                if (string.Equals(s.path, scenePath, StringComparison.OrdinalIgnoreCase))
                {
                    target = s;
                    break;
                }
            }

            if (!target.IsValid() || !target.isLoaded)
            {
                var mode = SceneManager.sceneCount > 1 ? OpenSceneMode.Additive : OpenSceneMode.Single;
                target = EditorSceneManager.OpenScene(scenePath, mode);
            }

            if (!target.IsValid() || !target.isLoaded)
            {
                result.Error = "Failed to open the target scene.";
                return result;
            }

            HertzDualPistolRuntime runtime = null;
            GameObject managedRoot = null;
            foreach (var root in target.GetRootGameObjects())
            {
                if (HertzStudioSceneCommands.IsProtectedHierarchy(root)) continue;
                if (root.name == result.ManagedObjectId ||
                    root.name == "HertzStudioManagedWeapons" ||
                    root.name == "HertzWeaponTestRig")
                {
                    var found = root.GetComponentInChildren<HertzDualPistolRuntime>(true);
                    if (found != null)
                    {
                        runtime = found;
                        managedRoot = root.name == result.ManagedObjectId ? root : found.gameObject;
                        break;
                    }
                }
            }

            if (runtime == null)
            {
                foreach (var root in target.GetRootGameObjects())
                {
                    if (HertzStudioSceneCommands.IsProtectedHierarchy(root)) continue;
                    runtime = root.GetComponentInChildren<HertzDualPistolRuntime>(true);
                    if (runtime != null)
                    {
                        managedRoot = runtime.gameObject;
                        break;
                    }
                }
            }

            if (runtime == null)
            {
                result.Error =
                    "No HertzDualPistolRuntime found in the selected target scene. Add or configure the runtime in " +
                    "that scene before deploying. Deploy binds definitions — it does not place raw meshes.";
                return result;
            }

            if (HertzStudioSceneCommands.IsProtectedHierarchy(runtime.gameObject))
            {
                result.Error = "Refusing to mutate protected XR/camera hierarchy.";
                return result;
            }

            managedRoot = runtime.gameObject;
            var isRight = string.Equals(role, "right_pistol", StringComparison.OrdinalIgnoreCase);
            var left = isRight ? runtime.LeftDefinition : def;
            var right = isRight ? def : runtime.RightDefinition;
            if (left == null || right == null)
            {
                result.Error =
                    "Dual-pistol runtime needs both left and right definitions. Sync and deploy the other pistol role as well, or use HertzWeaponTest which already has placeholders.";
                return result;
            }

            // Also validate the opposite slot already bound — a missing-anchor partner must not
            // silently leave DualPistolRuntime empty after this deploy overwrites one side.
            var partner = isRight ? left : right;
            if (partner != null && partner != def)
            {
                var partnerCheck = HertzWeaponAnchorUtility.ValidateRuntimeReady(
                    partner.ModelPrefab,
                    partner.GripAnchor,
                    partner.MuzzleAnchor);
                if (!partnerCheck.Ok)
                {
                    result.Error =
                        $"Partner pistol '{partner.WeaponId}' is not runtime-ready: {partnerCheck.Error}";
                    result.MissingAnchors = partnerCheck.MissingAnchors;
                    result.AnchorsValid = false;
                    result.RuntimeDeployApplied = false;
                    result.RuntimePlayable = false;
                    result.AssetGuid = AssetDatabase.AssetPathToGUID(path);
                    result.AssetPath = path;
                    return result;
                }
            }

            // Update definition slots only — preserve gate, input, and attach transforms.
            var so = new SerializedObject(runtime);
            so.FindProperty("leftDefinition").objectReferenceValue = left;
            so.FindProperty("rightDefinition").objectReferenceValue = right;
            so.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(runtime);
            result.UpdatedExisting = true;

            EditorSceneManager.MarkSceneDirty(target);
            if (!EditorSceneManager.SaveScene(target))
            {
                result.Error = "Unity failed to save the target scene.";
                return result;
            }

            result.Ok = true;
            result.AssetGuid = AssetDatabase.AssetPathToGUID(path);
            result.AssetPath = path;
            result.UnityRevision = expectedUnityRevision;
            result.RuntimeDeployApplied = true;
            result.RuntimePlayable = result.AnchorsValid && result.ModelImported && result.DefinitionSynced;
            // Return Unity's persistent scene-object identity. GetInstanceID is only valid for
            // the current Editor process, and appending it to the prior acknowledgement makes
            // the identifier grow on every redeploy.
            result.ManagedObjectId = managedRoot != null
                ? GlobalObjectId.GetGlobalObjectIdSlow(managedRoot).ToString()
                : result.ManagedObjectId;
            return result;
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parts = folder.Split('/');
            var current = parts[0];
            for (var i = 1; i < parts.Length; i++)
            {
                var next = current + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    AssetDatabase.CreateFolder(current, parts[i]);
                }

                current = next;
            }
        }

        [Serializable]
        public sealed class WeaponSyncRequest
        {
            public string WeaponId;
            public string DisplayName;
            public string Role;
            public bool Enabled = true;
            public bool FrequencyFlipRequired = true;
            public int Version = 1;
            public string PayloadHash;
            public string ModelPrefabPath;
            public string ExpectedAssetGuid;
            public string AssetPath;
            public WeaponTuning Tuning;
        }

        [Serializable]
        public sealed class WeaponTuning
        {
            public float Damage = 10f;
            public float FireIntervalSeconds = 0.2f;
            public float RangeMeters = 40f;
            public float Recoil = 0.15f;
            public string LeftHandAnchor = "LeftHand";
            public string RightHandAnchor = "RightHand";
            public string GripAnchor = "Grip";
            public string MuzzleAnchor = "Muzzle";
        }
    }
}
