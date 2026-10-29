using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Hertz.Characters;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Fail-closed W05 Unity proofs: hold wait→fire, rush→stop→attack, frequency targeting, sync safety.
    /// </summary>
    public static class HertzStudioCharacterProof
    {
        private const string ProofScenePath = "Assets/Scenes/HertzCharacterTest.unity";
        private const string GeneratedFolder = "Assets/HertzStudio/GeneratedProof/W05";
        private const string SampleScenePath = "Assets/Scenes/SampleScene.unity";

        [MenuItem("HERTZ/Studio/Proofs/W05 Character Behavior")]
        public static void RunBehaviorProof()
        {
            var checks = new List<Check>();
            try
            {
                HertzStudioCharacterTestSceneBuilder.BuildPlayableScene();
                checks.Add(new Check(
                    "persistent_scene_exists",
                    File.Exists(Path.GetFullPath(ProofScenePath)),
                    ProofScenePath,
                    ProofScenePath));

                var scene = EditorSceneManager.OpenScene(ProofScenePath, OpenSceneMode.Single);
                HertzEnemyAgent hold = null;
                HertzEnemyAgent rush = null;
                HertzFrequencyGate gate = null;
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (gate == null) gate = root.GetComponentInChildren<HertzFrequencyGate>(true);
                    foreach (var agent in root.GetComponentsInChildren<HertzEnemyAgent>(true))
                    {
                        if (agent.name == "Enemy_Hold") hold = agent;
                        if (agent.name == "Enemy_Rush") rush = agent;
                    }
                }

                checks.Add(new Check("hold_agent_present", hold != null, hold != null, true));
                checks.Add(new Check("rush_agent_present", rush != null, rush != null, true));
                checks.Add(new Check("frequency_gate_present", gate != null, gate != null, true));

                if (hold != null && rush != null && gate != null)
                {
                    ProveHoldWaitFire(hold, gate, checks);
                    ProveRushStopAttack(rush, gate, checks);
                    ProveFrequencyTargeting(hold, gate, checks);
                }

                checks.Add(new Check(
                    "sample_scene_untouched",
                    SampleSceneHashUnchanged(),
                    "unchanged",
                    "unchanged"));

                WriteProof("w05-character-behavior-proof.json", "w05-character-behavior", checks, ProofScenePath);
            }
            finally
            {
                if (File.Exists(Path.GetFullPath(ProofScenePath)))
                {
                    EditorSceneManager.OpenScene(ProofScenePath, OpenSceneMode.Single);
                }
            }
        }

        [MenuItem("HERTZ/Studio/Proofs/W05 Character Sync")]
        public static void RunSyncProof()
        {
            var checks = new List<Check>();
            var modelId = "w05-proof-model-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            var profileId = "w05-proof-profile-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            try
            {
                EnsureFolder(GeneratedFolder);

                var blocked = HertzStudioCharacterCommands.SyncCharacterModel(new HertzStudioCharacterCommands.CharacterModelRequest
                {
                    CharacterId = modelId + "-xr",
                    DisplayName = "Blocked XR",
                    Kind = "enemy_visual",
                    Enabled = true,
                    Scale = 1f,
                    ReplaceTrackedXrRig = true,
                    Version = 1,
                    PayloadHash = "hash-blocked",
                });
                checks.Add(new Check(
                    "reject_replace_tracked_xr_rig",
                    !blocked.Ok && !string.IsNullOrEmpty(blocked.Error),
                    blocked.Error,
                    "forbidden"));

                var model = HertzStudioCharacterCommands.SyncCharacterModel(new HertzStudioCharacterCommands.CharacterModelRequest
                {
                    CharacterId = modelId,
                    DisplayName = "W05 Proof Model",
                    Kind = "enemy_visual",
                    Enabled = true,
                    Scale = 1f,
                    ReplaceTrackedXrRig = false,
                    Version = 1,
                    PayloadHash = "hash-model-1",
                });
                checks.Add(new Check("sync_model_create", model.Ok, model.Error, null));
                checks.Add(new Check(
                    "sync_model_guid_path",
                    model.Ok && !string.IsNullOrEmpty(model.AssetGuid) && !string.IsNullOrEmpty(model.AssetPath),
                    model.AssetGuid + "|" + model.AssetPath,
                    "guid|path"));

                var modelAgain = HertzStudioCharacterCommands.SyncCharacterModel(new HertzStudioCharacterCommands.CharacterModelRequest
                {
                    CharacterId = modelId,
                    DisplayName = "W05 Proof Model v2",
                    Kind = "enemy_visual",
                    Enabled = true,
                    Scale = 1.1f,
                    Version = 2,
                    PayloadHash = "hash-model-2",
                    ExpectedAssetGuid = model.AssetGuid,
                    AssetPath = model.AssetPath,
                });
                checks.Add(new Check(
                    "sync_model_update_preserves_guid",
                    modelAgain.Ok && modelAgain.AssetGuid == model.AssetGuid,
                    modelAgain.AssetGuid,
                    model.AssetGuid));

                var profile = HertzStudioCharacterCommands.SyncEnemyProfile(new HertzStudioCharacterCommands.EnemyProfileRequest
                {
                    ProfileId = profileId,
                    DisplayName = "W05 Proof Profile",
                    Enabled = true,
                    Version = 1,
                    PayloadHash = "hash-profile-1",
                    ModelAssetGuid = model.AssetGuid,
                    MoveSpeed = 3f,
                    DetectionRangeMeters = 10f,
                    AttackRangeMeters = 6f,
                    WaitReactionDelaySeconds = 0.25f,
                    ShotBurstIntervalSeconds = 0.4f,
                    ApproachDistanceMeters = 2f,
                    Mode = "hold_position",
                });
                checks.Add(new Check("sync_profile_create", profile.Ok, profile.Error, null));
                checks.Add(new Check(
                    "sync_profile_guid_path",
                    profile.Ok && !string.IsNullOrEmpty(profile.AssetGuid) && !string.IsNullOrEmpty(profile.AssetPath),
                    profile.AssetGuid + "|" + profile.AssetPath,
                    "guid|path"));

                var profileAgain = HertzStudioCharacterCommands.SyncEnemyProfile(new HertzStudioCharacterCommands.EnemyProfileRequest
                {
                    ProfileId = profileId,
                    DisplayName = "W05 Proof Profile v2",
                    Enabled = true,
                    Version = 2,
                    PayloadHash = "hash-profile-2",
                    ExpectedAssetGuid = profile.AssetGuid,
                    AssetPath = profile.AssetPath,
                    ModelAssetGuid = model.AssetGuid,
                    MoveSpeed = 3.5f,
                    DetectionRangeMeters = 11f,
                    AttackRangeMeters = 7f,
                    WaitReactionDelaySeconds = 0.3f,
                    ShotBurstIntervalSeconds = 0.5f,
                    ApproachDistanceMeters = 2.2f,
                    Mode = "rush",
                });
                checks.Add(new Check(
                    "sync_profile_update_preserves_guid",
                    profileAgain.Ok && profileAgain.AssetGuid == profile.AssetGuid,
                    profileAgain.AssetGuid,
                    profile.AssetGuid));

                var deleted = HertzStudioCharacterCommands.DeleteDefinition(
                    "enemy_profile", profileId, profile.AssetGuid, profile.AssetPath);
                checks.Add(new Check("delete_profile_ok", deleted.Ok, deleted.Error, null));
                var deletedModel = HertzStudioCharacterCommands.DeleteDefinition(
                    "character_model", modelId, model.AssetGuid, model.AssetPath);
                checks.Add(new Check("delete_model_ok", deletedModel.Ok, deletedModel.Error, null));

                checks.Add(new Check(
                    "sample_scene_untouched",
                    SampleSceneHashUnchanged(),
                    "unchanged",
                    "unchanged"));

                WriteProof("w05-character-sync-proof.json", "w05-character-sync", checks, ProofScenePath);
            }
            finally
            {
                CleanupProofAssets(modelId, profileId);
            }
        }

        private static void ProveHoldWaitFire(HertzEnemyAgent hold, HertzFrequencyGate gate, List<Check> checks)
        {
            hold.ResetRuntimeCounters();
            var start = hold.transform.position;
            gate.SetFrequencyActive(false);
            for (var i = 0; i < 30; i++) hold.Tick(0.05f);
            checks.Add(new Check("hold_freq_off_no_shots", hold.ShotsFired == 0, hold.ShotsFired, 0));
            checks.Add(new Check("hold_freq_off_not_detected", !hold.HasDetectedPlayer, hold.HasDetectedPlayer, false));

            gate.SetFrequencyActive(true);
            hold.ResetRuntimeCounters();
            var wait = hold.Profile != null ? hold.Profile.WaitReactionDelaySeconds : 0.35f;
            var halfWait = Mathf.Max(0.05f, wait * 0.5f);
            hold.Tick(halfWait);
            checks.Add(new Check("hold_waiting_no_shots", hold.ShotsFired == 0 && hold.IsWaiting, hold.ShotsFired, 0));

            var remaining = wait - halfWait + 0.05f;
            hold.Tick(remaining);
            hold.Tick(0.1f);
            checks.Add(new Check("hold_after_wait_fires", hold.ShotsFired >= 1, hold.ShotsFired, ">=1"));
            var moved = Vector3.Distance(hold.transform.position, start);
            checks.Add(new Check("hold_stays_in_place", moved < 0.05f, moved, "<0.05"));
        }

        private static void ProveRushStopAttack(HertzEnemyAgent rush, HertzFrequencyGate gate, List<Check> checks)
        {
            rush.ResetRuntimeCounters();
            gate.SetFrequencyActive(true);
            var start = rush.transform.position;
            var approach = rush.Profile != null ? rush.Profile.ApproachDistanceMeters : 2.5f;
            var wait = rush.Profile != null ? rush.Profile.WaitReactionDelaySeconds : 0.2f;

            rush.Tick(wait + 0.05f);
            var distBefore = rush.DistanceToPlayer;
            for (var i = 0; i < 40; i++)
            {
                if (rush.DistanceToPlayer <= approach + 0.05f) break;
                rush.Tick(0.05f);
            }

            var movedCloser = rush.DistanceToPlayer < distBefore - 0.2f ||
                              Vector3.Distance(rush.transform.position, start) > 0.2f;
            checks.Add(new Check("rush_moves_toward_player", movedCloser, rush.DistanceToPlayer, "<start"));

            // Drive into approach range if still outside.
            var safety = 0;
            while (rush.DistanceToPlayer > approach && safety++ < 200)
            {
                rush.Tick(0.05f);
            }

            var posAtApproach = rush.transform.position;
            var shotsAtApproach = rush.ShotsFired;
            for (var i = 0; i < 20; i++) rush.Tick(0.1f);
            var drift = Vector3.Distance(rush.transform.position, posAtApproach);
            checks.Add(new Check(
                "rush_stops_within_approach",
                rush.DistanceToPlayer <= approach + 0.15f && drift < 0.35f,
                $"dist={rush.DistanceToPlayer:F2},drift={drift:F2}",
                $"dist<={approach}+0.15"));
            checks.Add(new Check(
                "rush_fires_after_stop",
                rush.ShotsFired > shotsAtApproach,
                rush.ShotsFired,
                $">{shotsAtApproach}"));
        }

        private static void ProveFrequencyTargeting(HertzEnemyAgent hold, HertzFrequencyGate gate, List<Check> checks)
        {
            var spirit = hold.GetComponent<HertzSpiritTarget>();
            checks.Add(new Check("spirit_target_present", spirit != null, spirit != null, true));
            if (spirit == null) return;

            spirit.ResetHealth();
            gate.SetFrequencyActive(false);
            checks.Add(new Check("spirit_not_targetable_freq_off", !spirit.IsTargetable, spirit.IsTargetable, false));
            checks.Add(new Check(
                "spirit_damage_blocked_freq_off",
                !spirit.TryApplyDamage(5f) && Mathf.Approximately(spirit.CurrentHealth, spirit.MaxHealth),
                spirit.CurrentHealth,
                spirit.MaxHealth));

            gate.SetFrequencyActive(true);
            checks.Add(new Check("spirit_targetable_freq_on", spirit.IsTargetable, spirit.IsTargetable, true));
            checks.Add(new Check(
                "spirit_damage_applies_freq_on",
                spirit.TryApplyDamage(5f) && spirit.CurrentHealth < spirit.MaxHealth,
                spirit.CurrentHealth,
                "<max"));
        }

        private static void CleanupProofAssets(string modelId, string profileId)
        {
            DeleteIfExists($"Assets/HertzStudio/Characters/Models/{modelId}.asset");
            DeleteIfExists($"Assets/HertzStudio/Characters/Models/{modelId}-xr.asset");
            DeleteIfExists($"Assets/HertzStudio/Characters/Profiles/{profileId}.asset");
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
        }

        private static void DeleteIfExists(string path)
        {
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path) != null)
            {
                AssetDatabase.DeleteAsset(path);
            }
        }

        private static bool SampleSceneHashUnchanged()
        {
            var path = Path.GetFullPath(SampleScenePath);
            if (!File.Exists(path)) return false;
            using var sha = SHA256.Create();
            using var stream = File.OpenRead(path);
            var hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
            return string.Equals(
                hash,
                "9FB1EFEAC51BD4AEE87A5DD23CD3613DB054EA41BC82977F0ADAF27CA5E5F4D9",
                StringComparison.OrdinalIgnoreCase);
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

        private static void WriteProof(string fileName, string proofName, List<Check> checks, string scenePath)
        {
            var passed = 0;
            foreach (var c in checks)
            {
                if (c.Pass) passed++;
            }

            var ok = checks.Count > 0 && passed == checks.Count;
            var sceneGuid = AssetDatabase.AssetPathToGUID(scenePath) ?? "";
            var sceneRevision = 0;
            try
            {
                sceneRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(scenePath);
            }
            catch
            {
                // Scene may not be loaded yet; revision stays 0 and validators treat missing live revision carefully.
            }

            var sourceFingerprint = ComputeW05SourceFingerprint();
            var stamped = DateTime.UtcNow.ToString("o");
            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("  \"schemaVersion\": 3,");
            sb.AppendLine($"  \"proof\": \"{proofName}\",");
            sb.AppendLine($"  \"ok\": {(ok ? "true" : "false")},");
            sb.AppendLine($"  \"passed\": {passed},");
            sb.AppendLine($"  \"total\": {checks.Count},");
            sb.AppendLine($"  \"unityVersion\": {Json(Application.unityVersion)},");
            sb.AppendLine($"  \"projectIdentity\": {Json(Path.GetFileName(Path.GetFullPath(".")))},");
            sb.AppendLine($"  \"sourceFingerprint\": {Json(sourceFingerprint)},");
            sb.AppendLine($"  \"buildIdentity\": {Json(Application.unityVersion + "/" + sourceFingerprint.Substring(0, Math.Min(12, sourceFingerprint.Length)))},");
            sb.AppendLine($"  \"scenePath\": {Json(scenePath)},");
            sb.AppendLine($"  \"sceneGuid\": {Json(sceneGuid)},");
            sb.AppendLine($"  \"sceneRevision\": {sceneRevision},");
            sb.AppendLine($"  \"unityRevision\": {sceneRevision},");
            sb.AppendLine("  \"proofSource\": \"unity_executeMethod\",");
            sb.AppendLine($"  \"generatedAt\": {Json(stamped)},");
            sb.AppendLine($"  \"stampedAt\": {Json(stamped)},");
            sb.AppendLine($"  \"executedAt\": {Json(stamped)},");
            sb.AppendLine("  \"checks\": [");
            for (var i = 0; i < checks.Count; i++)
            {
                var c = checks[i];
                sb.Append("    {");
                sb.Append($"\"name\":{Json(c.Name)},\"pass\":{(c.Pass ? "true" : "false")},");
                sb.Append($"\"actual\":{Json(c.Actual)},\"expected\":{Json(c.Expected)}");
                sb.Append("}");
                sb.AppendLine(i < checks.Count - 1 ? "," : "");
            }

            sb.AppendLine("  ]");
            sb.AppendLine("}");
            var outPath = Path.GetFullPath(Path.Combine("Tools/HertzStudio/data", fileName));
            Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? "Tools/HertzStudio/data");
            File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            Debug.Log($"W05 proof wrote {outPath} ok={ok} ({passed}/{checks.Count}) schema=3 fp={sourceFingerprint.Substring(0, 12)}");
            if (!ok) throw new InvalidOperationException($"W05 proof failed: {proofName}");
        }

        /// <summary>Stable fingerprint of W05 character proof surface (must match Node proof-identity.mjs).</summary>
        private static string ComputeW05SourceFingerprint()
        {
            var files = new[]
            {
                "Assets/Scripts/Characters/HertzEnemyAgent.cs",
                "Assets/Scripts/Characters/HertzSpiritTarget.cs",
                "Assets/Scripts/Weapons/HertzFrequencyGate.cs",
                "Assets/Editor/HertzStudio/HertzStudioCharacterProof.cs",
                "Assets/Editor/HertzStudio/HertzStudioCharacterCommands.cs",
            };
            using var sha = System.Security.Cryptography.SHA256.Create();
            foreach (var rel in files)
            {
                var bytes = Encoding.UTF8.GetBytes(rel.Replace('\\', '/'));
                sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
                sha.TransformBlock(new byte[] { 0 }, 0, 1, null, 0);
                var full = Path.GetFullPath(rel);
                if (File.Exists(full))
                {
                    var content = File.ReadAllBytes(full);
                    sha.TransformBlock(content, 0, content.Length, null, 0);
                }
                else
                {
                    var missing = Encoding.UTF8.GetBytes("MISSING");
                    sha.TransformBlock(missing, 0, missing.Length, null, 0);
                }

                sha.TransformBlock(new byte[] { 0 }, 0, 1, null, 0);
            }

            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            var hash = sha.Hash ?? Array.Empty<byte>();
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static string Json(object value)
        {
            if (value == null) return "null";
            if (value is bool b) return b ? "true" : "false";
            if (value is int or long or float or double)
            {
                return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
            }

            return "\"" + value.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private sealed class Check
        {
            public string Name;
            public bool Pass;
            public object Actual;
            public object Expected;

            public Check(string name, bool pass, object actual, object expected)
            {
                Name = name;
                Pass = pass;
                Actual = actual;
                Expected = expected;
            }
        }
    }
}
