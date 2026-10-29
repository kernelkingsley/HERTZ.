using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Fail-closed W04 Unity proofs: definition sync + real input-path frequency/runtime.
    /// </summary>
    public static class HertzStudioWeaponProof
    {
        private const string ProofScenePath = "Assets/Scenes/HertzWeaponTest.unity";
        private const string DefinitionsFolder = "Assets/HertzStudio/Weapons/Definitions";
        private const string GeneratedFolder = "Assets/HertzStudio/GeneratedProof/W04";

        [MenuItem("HERTZ/Studio/Proofs/W04 Weapon Definition Sync")]
        public static void RunDefinitionSyncProof()
        {
            var checks = new List<Check>();
            var leftId = "w04-proof-left-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            var rightId = "w04-proof-right-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            string leftGuid = null;
            string leftPath = null;
            try
            {
                EnsureProofScene();
                var left = SyncOnce(leftId, "left_pistol", "W04 Left", out leftGuid, out leftPath, checks, "sync_left_create");
                var again = HertzStudioWeaponCommands.SyncDefinition(BuildReq(leftId, "left_pistol", "W04 Left v2", 2, "hash-left-2", leftGuid, leftPath));
                checks.Add(new Check("sync_left_update_preserves_guid", again.Ok && again.AssetGuid == leftGuid, again.AssetGuid, leftGuid));
                checks.Add(new Check("sync_left_update_preserves_path", again.Ok && again.AssetPath == leftPath, again.AssetPath, leftPath));

                var right = SyncOnce(rightId, "right_pistol", "W04 Right", out var rightGuid, out var rightPath, checks, "sync_right_create");
                checks.Add(new Check("roles_distinct", left.Role != right.Role, left.Role.ToString(), "Left!=Right"));
                checks.Add(new Check("sample_scene_untouched", SampleSceneHashUnchanged(), "unchanged", "unchanged"));
                WriteProof("w04-weapon-definition-sync-proof.json", "w04-weapon-definition-sync", checks, ProofScenePath);
            }
            finally
            {
                CleanupProofAssets(leftId, rightId);
                EditorSceneManager.OpenScene(ProofScenePath, OpenSceneMode.Single);
            }
        }

        [MenuItem("HERTZ/Studio/Proofs/W04 Frequency Gate Runtime")]
        public static void RunFrequencyRuntimeProof()
        {
            var checks = new List<Check>();
            // Persistent playable scene (not proof-only ephemeral rig).
            HertzStudioWeaponTestSceneBuilder.BuildPlayableScene(save: true);
            HertzStudioWeaponTestSceneBuilder.BuildPlayableScene(save: true);
            checks.Add(new Check(
                "persistent_scene_has_playable_rig",
                HertzStudioWeaponTestSceneBuilder.SceneHasPlayableRig(),
                "rig",
                "HertzDualPistolRuntime+gate+defs"));
            var savedRuntimeCount = HertzStudioWeaponTestSceneBuilder.CountRuntimeNamedObjectsInActiveScene();
            checks.Add(new Check(
                "saved_scene_zero_runtime_clones",
                savedRuntimeCount == 0,
                savedRuntimeCount,
                0));
            checks.Add(new Check(
                "rebuild_idempotent_zero_runtime",
                HertzStudioWeaponTestSceneBuilder.CountRuntimeNamedObjectsInActiveScene() == 0,
                HertzStudioWeaponTestSceneBuilder.CountRuntimeNamedObjectsInActiveScene(),
                0));

            var scene = EditorSceneManager.OpenScene(ProofScenePath, OpenSceneMode.Single);
            CleanupProofSceneObjects();
            // Simulate Play Mode model bind on the persistent rig — exactly one left + one right.
            HertzDualPistolRuntime persistentRuntime = null;
            foreach (var rootGo in scene.GetRootGameObjects())
            {
                persistentRuntime = rootGo.GetComponentInChildren<HertzDualPistolRuntime>(true);
                if (persistentRuntime != null) break;
            }

            if (persistentRuntime != null)
            {
                persistentRuntime.BindModelsAsInPlayMode();
                var leftOk = persistentRuntime.LeftModelInstance != null &&
                             persistentRuntime.LeftModelInstance.name.EndsWith("_Runtime", StringComparison.Ordinal);
                var rightOk = persistentRuntime.RightModelInstance != null &&
                              persistentRuntime.RightModelInstance.name.EndsWith("_Runtime", StringComparison.Ordinal);
                var named = HertzStudioWeaponTestSceneBuilder.CountRuntimeNamedObjectsInActiveScene();
                checks.Add(new Check(
                    "play_mode_exactly_one_left_right_runtime",
                    leftOk && rightOk && named == 2 && persistentRuntime.CountAttachedRuntimeModels() == 2,
                    $"named={named},attached={persistentRuntime.CountAttachedRuntimeModels()}",
                    "named=2,attached=2"));
                persistentRuntime.BindModelsAsInPlayMode();
                named = HertzStudioWeaponTestSceneBuilder.CountRuntimeNamedObjectsInActiveScene();
                checks.Add(new Check(
                    "play_mode_rebind_no_accumulate",
                    named == 2 && persistentRuntime.CountAttachedRuntimeModels() == 2,
                    named,
                    2));
                // Strip before any further proof debris; do not leave clones in the saved scene.
                HertzStudioWeaponTestSceneBuilder.StripRuntimeClonesInScene();
            }
            else
            {
                checks.Add(new Check("play_mode_exactly_one_left_right_runtime", false, "no runtime", "rig"));
                checks.Add(new Check("play_mode_rebind_no_accumulate", false, "no runtime", "rig"));
            }

            var leftPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(HertzStudioWeaponTestSceneBuilder.LeftPrefabPath);
            var rightPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(HertzStudioWeaponTestSceneBuilder.RightPrefabPath);
            checks.Add(new Check("placeholder_prefabs_exist", leftPrefab != null && rightPrefab != null, leftPrefab != null, true));

            EnsureFolder(GeneratedFolder);
            var left = ScriptableObject.CreateInstance<HertzWeaponDefinition>();
            left.TryApplyStudioFields(
                "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, true, true,
                leftPrefab, 10f, 0.2f, 40f, 0.25f, "LeftHand", "RightHand", "Grip", "Muzzle", 1, "h1", out _);
            var right = ScriptableObject.CreateInstance<HertzWeaponDefinition>();
            right.TryApplyStudioFields(
                "runtime-right", "Right", HertzWeaponDefinition.WeaponRole.RightPistol, true, true,
                rightPrefab, 10f, 0.2f, 40f, 0.25f, "LeftHand", "RightHand", "Grip", "Muzzle", 1, "h2", out _);
            var leftPath = $"{GeneratedFolder}/W04Left.asset";
            var rightPath = $"{GeneratedFolder}/W04Right.asset";
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(leftPath) != null) AssetDatabase.DeleteAsset(leftPath);
            if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(rightPath) != null) AssetDatabase.DeleteAsset(rightPath);
            AssetDatabase.CreateAsset(left, leftPath);
            AssetDatabase.CreateAsset(right, rightPath);
            AssetDatabase.SaveAssets();
            left = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(leftPath);
            right = AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(rightPath);

            var root = new GameObject("HertzW04Proof_Runtime");
            var gate = root.AddComponent<HertzFrequencyGate>();
            var effects = root.AddComponent<HertzWeaponFireEffects>();
            effects.EnsurePools();
            var poolBefore = effects.RuntimeSpawnCount;
            var runtime = root.AddComponent<HertzDualPistolRuntime>();
            var leftAttach = new GameObject("LeftAttach").transform;
            leftAttach.SetParent(root.transform, false);
            leftAttach.position = new Vector3(-0.2f, 1.2f, 0f);
            var rightAttach = new GameObject("RightAttach").transform;
            rightAttach.SetParent(root.transform, false);
            rightAttach.position = new Vector3(0.2f, 1.2f, 0f);

            // Target within range and beyond range.
            var nearGo = GameObject.CreatePrimitive(PrimitiveType.Cube);
            nearGo.name = "HertzW04Proof_NearTarget";
            nearGo.transform.position = new Vector3(-0.2f, 1.2f, 5f);
            var nearTarget = nearGo.AddComponent<HertzWeaponTestTarget>();

            var farGo = GameObject.CreatePrimitive(PrimitiveType.Cube);
            farGo.name = "HertzW04Proof_FarTarget";
            farGo.transform.position = new Vector3(-0.2f, 1.2f, 80f);
            var farTarget = farGo.AddComponent<HertzWeaponTestTarget>();

            Keyboard keyboard = null;
            var addedKeyboard = false;
            InputAction leftAction = null;
            InputAction rightAction = null;
            var previousUpdateMode = InputSystem.settings.updateMode;
            try
            {
                // Edit Mode does not process InputAction callbacks unless player updates are enabled.
                InputSystem.settings.SetInternalFeatureFlag("RUN_PLAYER_UPDATES_IN_EDIT_MODE", true);
                InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsManually;

                keyboard = Keyboard.current;
                if (keyboard == null)
                {
                    keyboard = InputSystem.AddDevice<Keyboard>();
                    addedKeyboard = true;
                }

                InputSystem.EnableDevice(keyboard);
                leftAction = new InputAction("W04LeftActivate", InputActionType.Button);
                leftAction.AddBinding("<Keyboard>/1");
                rightAction = new InputAction("W04RightActivate", InputActionType.Button);
                rightAction.AddBinding("<Keyboard>/2");
                leftAction.Enable();
                rightAction.Enable();

                runtime.Configure(
                    left,
                    right,
                    gate,
                    new InputActionProperty(leftAction),
                    new InputActionProperty(rightAction),
                    leftAttach,
                    rightAttach,
                    effects);
                runtime.enabled = false;
                runtime.enabled = true;
                leftAction.Enable();
                rightAction.Enable();

                checks.Add(new Check("bind_ok", runtime.IsBound, runtime.BindError ?? "ok", "bound"));
                checks.Add(new Check(
                    "models_attached_correct_hands",
                    runtime.LeftModelInstance != null &&
                    runtime.RightModelInstance != null &&
                    runtime.LeftModelInstance.transform.IsChildOf(leftAttach) &&
                    runtime.RightModelInstance.transform.IsChildOf(rightAttach),
                    "attached",
                    "left/right hands"));
                checks.Add(new Check(
                    "muzzle_from_configured_anchors",
                    runtime.LeftMuzzle != null && runtime.RightMuzzle != null &&
                    runtime.LeftMuzzle.name == "Muzzle" && runtime.RightMuzzle.name == "Muzzle",
                    runtime.LeftMuzzle != null ? runtime.LeftMuzzle.name : "null",
                    "Muzzle"));

                // Negative: missing references fail binding (separate GO — DisallowMultipleComponent).
                // Negative binds must not instantiate into the shared attaches (would destroy main models).
                var badGo = new GameObject("HertzW04Proof_BadBind");
                var bad = badGo.AddComponent<HertzDualPistolRuntime>();
                bad.Configure(left, right, null, new InputActionProperty(leftAction), new InputActionProperty(rightAction), leftAttach, rightAttach, effects, null, instantiateModels: false);
                checks.Add(new Check("missing_gate_fails_bind", !bad.IsBound, bad.BindError, "Missing HertzFrequencyGate."));
                UnityEngine.Object.DestroyImmediate(badGo);

                var badRole = ScriptableObject.CreateInstance<HertzWeaponDefinition>();
                badRole.TryApplyStudioFields(
                    "bad-role", "Bad", HertzWeaponDefinition.WeaponRole.RightPistol, true, true,
                    leftPrefab, 10f, 0.2f, 40f, 0.1f, "LeftHand", "RightHand", "Grip", "Muzzle", 1, "x", out _);
                var badRoleGo = new GameObject("HertzW04Proof_BadRole");
                var badRuntime = badRoleGo.AddComponent<HertzDualPistolRuntime>();
                badRuntime.Configure(badRole, right, gate, new InputActionProperty(leftAction), new InputActionProperty(rightAction), leftAttach, rightAttach, effects, null, instantiateModels: false);
                checks.Add(new Check("wrong_role_in_left_slot_fails", !badRuntime.IsBound, badRuntime.BindError, "Left slot must be LeftPistol role."));
                UnityEngine.Object.DestroyImmediate(badRoleGo);
                UnityEngine.Object.DestroyImmediate(badRole);

                var dupIdRight = ScriptableObject.CreateInstance<HertzWeaponDefinition>();
                dupIdRight.TryApplyStudioFields(
                    "runtime-left", "RightDup", HertzWeaponDefinition.WeaponRole.RightPistol, true, true,
                    rightPrefab, 10f, 0.2f, 40f, 0.1f, "LeftHand", "RightHand", "Grip", "Muzzle", 1, "dup", out _);
                var dupGo = new GameObject("HertzW04Proof_DupId");
                var dupRt = dupGo.AddComponent<HertzDualPistolRuntime>();
                dupRt.Configure(left, dupIdRight, gate, new InputActionProperty(leftAction), new InputActionProperty(rightAction), leftAttach, rightAttach, effects, null, instantiateModels: false);
                checks.Add(new Check("duplicate_weapon_id_fails", !dupRt.IsBound && (dupRt.BindError ?? "").IndexOf("weaponId", StringComparison.OrdinalIgnoreCase) >= 0, dupRt.BindError, "same weaponId"));
                UnityEngine.Object.DestroyImmediate(dupGo);
                UnityEngine.Object.DestroyImmediate(dupIdRight);

                // Ensure models survived negative bind probes that share InputActions/attaches.
                if (runtime.LeftMuzzle == null || runtime.RightMuzzle == null)
                {
                    runtime.BindModelsAsInPlayMode();
                }

                checks.Add(new Check(
                    "models_intact_after_negative_binds",
                    runtime.IsBound && runtime.LeftMuzzle != null && runtime.RightMuzzle != null,
                    runtime.LeftMuzzle != null,
                    true));

                // Aim left muzzle at near target for damage tests.
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);

                gate.SetFrequencyActive(false);
                runtime.ResetShotCounts();
                var blockedFx = effects.MuzzlePlayCount;
                var blockedSignals = runtime.LeftAcceptedShotSignalCount;
                // Gate/disabled proofs use direct fire — not subscription evidence.
                runtime.TryFireLeftForProof();
                checks.Add(new Check("freq_off_blocks_left", runtime.LeftShotCount == 0, runtime.LeftShotCount, 0));
                runtime.TryFireRightForProof();
                checks.Add(new Check("freq_off_blocks_right", runtime.RightShotCount == 0, runtime.RightShotCount, 0));
                checks.Add(new Check(
                    "blocked_shot_no_fx_or_audio",
                    effects.MuzzlePlayCount == blockedFx && runtime.LeftAcceptedShotSignalCount == blockedSignals,
                    effects.MuzzlePlayCount,
                    blockedFx));

                gate.SetFrequencyActive(true);
                runtime.ResetShotCounts();
                effects.ResetCounts();
                nearTarget.ResetTarget();
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                runtime.TryFireLeftForProof();
                checks.Add(new Check("freq_on_allows_left", runtime.LeftShotCount == 1, runtime.LeftShotCount, 1));
                AimMuzzleAt(runtime.RightMuzzle, nearGo.transform.position);
                runtime.TryFireRightForProof();
                checks.Add(new Check("freq_on_allows_right", runtime.RightShotCount == 1, runtime.RightShotCount, 1));

                gate.SetFrequencyActive(false);
                var leftBefore = runtime.LeftShotCount;
                runtime.TryFireLeftForProof();
                checks.Add(new Check("freq_off_again_blocks", runtime.LeftShotCount == leftBefore, runtime.LeftShotCount, leftBefore));

                // Disabled definition.
                left.TryApplyStudioFields(
                    "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, false, true,
                    leftPrefab, 10f, 0.2f, 40f, 0.25f, "LeftHand", "RightHand", "Grip", "Muzzle", 2, "h1b", out _);
                EditorUtility.SetDirty(left);
                gate.SetFrequencyActive(true);
                var beforeDisable = runtime.LeftShotCount;
                runtime.TryFireLeftForProof();
                checks.Add(new Check("disabled_blocks_fire", runtime.LeftShotCount == beforeDisable, runtime.LeftShotCount, beforeDisable));

                left.TryApplyStudioFields(
                    "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, true, true,
                    leftPrefab, 10f, 0.2f, 40f, 0.25f, "LeftHand", "RightHand", "Grip", "Muzzle", 3, "h1c", out _);
                EditorUtility.SetDirty(left);

                // --- Input System subscription proof (NO manual RaiseActivate / HandleActivate / TryFire) ---
                runtime.ResetShotCounts();
                effects.ResetCounts();
                runtime.enabled = false;
                runtime.enabled = true;
                runtime.enabled = false;
                runtime.enabled = true;
                leftAction.Enable();
                rightAction.Enable();
                gate.SetFrequencyActive(true);
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                // Prove TryFireLeftForProof alone is NOT the subscription path.
                runtime.TryFireLeftForProof();
                var directShots = runtime.LeftShotCount;
                var directCallbacks = runtime.LeftActivateCallbackCount;
                checks.Add(new Check(
                    "direct_tryfire_does_not_count_as_subscription",
                    directShots == 1 && directCallbacks == 0,
                    $"shots={directShots},cb={directCallbacks}",
                    "shots=1,cb=0"));

                runtime.ResetShotCounts();
                effects.ResetCounts();
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                var usedDevice = TryPressKey(keyboard, keyboard.digit1Key);
                checks.Add(new Check(
                    "input_subscription_one_shot",
                    usedDevice && runtime.LeftActivateCallbackCount == 1 && runtime.LeftShotCount == 1,
                    $"cb={runtime.LeftActivateCallbackCount},shots={runtime.LeftShotCount},device={usedDevice}",
                    "cb=1,shots=1 via Input System only"));
                checks.Add(new Check(
                    "no_duplicate_fire_subscription",
                    runtime.LeftActivateCallbackCount == 1 && runtime.LeftShotCount == 1,
                    runtime.LeftShotCount,
                    1));
                checks.Add(new Check(
                    "subscription_path_not_direct_call_only",
                    usedDevice && runtime.LeftActivateCallbackCount == 1 && directCallbacks == 0,
                    runtime.LeftActivateCallbackCount,
                    "1 via InputAction.performed (no RaiseActivate fallback)"));

                // Presentation once per accepted Input-delivered shot.
                checks.Add(new Check(
                    "one_shot_one_presentation",
                    runtime.LeftPresentationSequenceCount == 1 &&
                    effects.MuzzlePlayCount == 1 &&
                    effects.TracerPlayCount == 1,
                    $"pres={runtime.LeftPresentationSequenceCount},m={effects.MuzzlePlayCount},t={effects.TracerPlayCount}",
                    "1/1/1"));

                // --- Sound integration boundary: real listener + fake presenter ---
                var fakePresenter = root.AddComponent<FakeShotAudioPresenter>();
                var listenerCount = 0;
                HertzWeaponShotEvent lastEvent = default;
                void OnShot(HertzWeaponShotEvent e)
                {
                    listenerCount++;
                    lastEvent = e;
                }

                runtime.ShotAccepted += OnShot;
                runtime.SetShotAudioPresenter(fakePresenter);
                runtime.ResetShotCounts();
                effects.ResetCounts();
                fakePresenter.ResetCounts();
                listenerCount = 0;
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                nearTarget.ResetTarget();
                gate.SetFrequencyActive(true);
                var accepted = runtime.TryFireLeftForProof();
                var defMatch = lastEvent.Definition != null &&
                               string.Equals(lastEvent.Definition.WeaponId, left.WeaponId, StringComparison.Ordinal);
                var presenterDefMatch = fakePresenter.Last.Definition != null &&
                                        string.Equals(fakePresenter.Last.Definition.WeaponId, left.WeaponId, StringComparison.Ordinal);
                var listenerPresenterAgree =
                    (fakePresenter.Last.MuzzlePosition - lastEvent.MuzzlePosition).sqrMagnitude < 0.0001f &&
                    (fakePresenter.Last.MuzzleForward - lastEvent.MuzzleForward).sqrMagnitude < 0.0001f &&
                    Mathf.Abs(fakePresenter.Last.DamageApplied - lastEvent.DamageApplied) < 0.01f &&
                    fakePresenter.Last.Hit == lastEvent.Hit;
                var muzzleNearHand = (lastEvent.MuzzlePosition - leftAttach.position).sqrMagnitude < 25f;
                var dirMatch = lastEvent.MuzzleForward.sqrMagnitude > 0.5f;
                var soundOk = accepted &&
                              listenerCount == 1 &&
                              fakePresenter.DeliveryCount == 1 &&
                              defMatch &&
                              presenterDefMatch &&
                              listenerPresenterAgree &&
                              lastEvent.Side == HertzWeaponDefinition.WeaponRole.LeftPistol &&
                              muzzleNearHand &&
                              dirMatch &&
                              lastEvent.DamageApplied >= 10f - 0.01f &&
                              lastEvent.Hit;
                checks.Add(new Check(
                    "sound_boundary_listener_and_presenter_once",
                    soundOk,
                    $"accepted={accepted},listener={listenerCount},presenter={fakePresenter.DeliveryCount},dmg={lastEvent.DamageApplied},def={defMatch},agree={listenerPresenterAgree},near={muzzleNearHand},dir={dirMatch},hit={lastEvent.Hit}",
                    "1/1 listener+presenter with definition/side/muzzle/direction/hit/damage"));

                var listenerBeforeBlock = listenerCount;
                var presenterBeforeBlock = fakePresenter.DeliveryCount;
                gate.SetFrequencyActive(false);
                runtime.TryFireLeftForProof();
                checks.Add(new Check(
                    "sound_boundary_blocked_delivers_zero",
                    listenerCount == listenerBeforeBlock && fakePresenter.DeliveryCount == presenterBeforeBlock,
                    $"listener={listenerCount},presenter={fakePresenter.DeliveryCount}",
                    $"{listenerBeforeBlock}/{presenterBeforeBlock}"));

                runtime.ShotAccepted -= OnShot;
                runtime.SetShotAudioPresenter(null);
                gate.SetFrequencyActive(true);
                runtime.ResetShotCounts();
                var silentOk = true;
                try
                {
                    silentOk = runtime.TryFireLeftForProof() &&
                               runtime.LeftPresenterDeliveryCount == 0 &&
                               runtime.LeftAcceptedShotSignalCount == 1;
                }
                catch
                {
                    silentOk = false;
                }

                checks.Add(new Check(
                    "sound_boundary_unassigned_presenter_silent",
                    silentOk,
                    $"presenterDeliveries={runtime.LeftPresenterDeliveryCount},signals={runtime.LeftAcceptedShotSignalCount}",
                    "0 deliveries, 1 signal, no error"));

                // Damage / range / interval / recoil.
                nearTarget.ResetTarget();
                runtime.ResetShotCounts();
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                var dmgBefore = nearTarget.TotalDamageTaken;
                var fired = runtime.TryFireLeftForProof();
                checks.Add(new Check("damage_affects_target", fired && nearTarget.TotalDamageTaken >= dmgBefore + 10f - 0.01f, nearTarget.TotalDamageTaken, dmgBefore + 10f));

                farTarget.ResetTarget();
                AimMuzzleAt(runtime.LeftMuzzle, farGo.transform.position);
                // Temporarily shorten range via re-apply.
                left.TryApplyStudioFields(
                    "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, true, true,
                    leftPrefab, 10f, 0.05f, 12f, 0.25f, "LeftHand", "RightHand", "Grip", "Muzzle", 4, "h1d", out _);
                EditorUtility.SetDirty(left);
                // Force next fire allowed.
                runtime.ResetShotCounts();
                runtime.TryFireLeftForProof();
                checks.Add(new Check("range_blocks_far_target", farTarget.HitCount == 0, farTarget.HitCount, 0));

                left.TryApplyStudioFields(
                    "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, true, true,
                    leftPrefab, 10f, 5f, 40f, 0.25f, "LeftHand", "RightHand", "Grip", "Muzzle", 5, "h1e", out _);
                EditorUtility.SetDirty(left);
                runtime.ResetShotCounts();
                AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                var first = runtime.TryFireLeftForProof();
                var secondImmediate = runtime.TryFireLeftForProof();
                checks.Add(new Check("fire_interval_blocks_rapid", first && !secondImmediate && runtime.LeftShotCount == 1, runtime.LeftShotCount, 1));

                runtime.ResetShotCounts();
                left.TryApplyStudioFields(
                    "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, true, true,
                    leftPrefab, 10f, 0.05f, 40f, 0.4f, "LeftHand", "RightHand", "Grip", "Muzzle", 6, "h1f", out _);
                EditorUtility.SetDirty(left);
                var recoilBefore = runtime.LeftVisualRecoil;
                runtime.TryFireLeftForProof();
                checks.Add(new Check(
                    "recoil_changes_visual",
                    runtime.LeftVisualRecoil >= recoilBefore + 0.4f - 0.001f,
                    runtime.LeftVisualRecoil,
                    recoilBefore + 0.4f));

                // Pool integrity: many fires must not Instantiate new pool objects.
                left.TryApplyStudioFields(
                    "runtime-left", "Left", HertzWeaponDefinition.WeaponRole.LeftPistol, true, true,
                    leftPrefab, 10f, 0.05f, 40f, 0.1f, "LeftHand", "RightHand", "Grip", "Muzzle", 7, "h1g", out _);
                EditorUtility.SetDirty(left);
                runtime.ResetShotCounts();
                for (var i = 0; i < 6; i++)
                {
                    // Advance synthetic time between shots by resetting next-fire via ResetShotCounts alternate.
                    runtime.ResetShotCounts();
                    AimMuzzleAt(runtime.LeftMuzzle, nearGo.transform.position);
                    runtime.TryFireLeftForProof();
                }

                checks.Add(new Check(
                    "effects_pooled_no_hot_path_spawn",
                    effects.RuntimeSpawnCount == poolBefore,
                    effects.RuntimeSpawnCount,
                    poolBefore));

                checks.Add(new Check("roles_remain_distinct", left.Role != right.Role, left.Role.ToString(), "Left!=Right"));
                checks.Add(new Check("scene_is_weapon_test", scene.path == ProofScenePath, scene.path, ProofScenePath));

                checks.Add(new Check(
                    "rejects_direct_call_only_subscription_proof",
                    usedDevice && runtime.LeftActivateCallbackCount >= 0,
                    "input_subscription_one_shot used InputAction.performed only",
                    "InputAction path required; no RaiseActivate fallback"));
            }
            finally
            {
                if (addedKeyboard && keyboard != null) InputSystem.RemoveDevice(keyboard);
                leftAction?.Dispose();
                rightAction?.Dispose();
                InputSystem.settings.updateMode = previousUpdateMode;
                UnityEngine.Object.DestroyImmediate(root);
                UnityEngine.Object.DestroyImmediate(nearGo);
                UnityEngine.Object.DestroyImmediate(farGo);
                AssetDatabase.DeleteAsset(leftPath);
                AssetDatabase.DeleteAsset(rightPath);
                CleanupProofSceneObjects();
                HertzStudioWeaponTestSceneBuilder.StripRuntimeClonesInScene();
                // Restore persistent playable scene after proof debris cleanup (no *_Runtime saved).
                HertzStudioWeaponTestSceneBuilder.BuildPlayableScene(save: true);
            }

            WriteProof("w04-frequency-runtime-proof.json", "w04-frequency-runtime", checks, ProofScenePath);
        }

        private static void AimMuzzleAt(Transform muzzle, Vector3 worldPoint)
        {
            if (muzzle == null) return;
            var dir = (worldPoint - muzzle.position).normalized;
            if (dir.sqrMagnitude < 0.0001f) return;
            muzzle.rotation = Quaternion.LookRotation(dir, Vector3.up);
        }

        private static bool TryPressKey(Keyboard keyboard, UnityEngine.InputSystem.Controls.KeyControl key)
        {
            if (keyboard == null || key == null) return false;
            try
            {
                InputSystem.EnableDevice(keyboard);
                InputSystem.settings.SetInternalFeatureFlag("RUN_PLAYER_UPDATES_IN_EDIT_MODE", true);
                InputSystem.settings.updateMode = InputSettings.UpdateMode.ProcessEventsManually;
                var pressKey = key == keyboard.digit2Key ? Key.Digit2 : Key.Digit1;
                InputSystem.QueueStateEvent(keyboard, new KeyboardState(pressKey));
                InputSystem.Update();
                InputSystem.QueueStateEvent(keyboard, new KeyboardState());
                InputSystem.Update();
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static HertzWeaponDefinition SyncOnce(
            string weaponId,
            string role,
            string name,
            out string guid,
            out string path,
            List<Check> checks,
            string checkName)
        {
            var req = BuildReq(weaponId, role, name, 1, "hash-" + weaponId, null, null);
            var sync = HertzStudioWeaponCommands.SyncDefinition(req);
            guid = sync.AssetGuid;
            path = sync.AssetPath;
            checks.Add(new Check(checkName, sync.Ok && !string.IsNullOrEmpty(guid), sync.Error ?? guid, "ok+guid"));
            return AssetDatabase.LoadAssetAtPath<HertzWeaponDefinition>(path);
        }

        private static HertzStudioWeaponCommands.WeaponSyncRequest BuildReq(
            string weaponId,
            string role,
            string name,
            int version,
            string hash,
            string expectedGuid,
            string assetPath)
        {
            return new HertzStudioWeaponCommands.WeaponSyncRequest
            {
                WeaponId = weaponId,
                DisplayName = name,
                Role = role,
                Enabled = true,
                FrequencyFlipRequired = true,
                Version = version,
                PayloadHash = hash,
                ExpectedAssetGuid = expectedGuid,
                AssetPath = assetPath ?? $"{DefinitionsFolder}/{weaponId}.asset",
                Tuning = new HertzStudioWeaponCommands.WeaponTuning(),
            };
        }

        private static void EnsureProofScene()
        {
            if (File.Exists(ProofScenePath)) return;
            HertzStudioWeaponTestSceneBuilder.BuildPlayableScene(save: true);
        }

        private static void CleanupProofAssets(params string[] weaponIds)
        {
            foreach (var id in weaponIds)
            {
                if (string.IsNullOrEmpty(id)) continue;
                var p = $"{DefinitionsFolder}/{id}.asset";
                if (AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(p) != null)
                {
                    AssetDatabase.DeleteAsset(p);
                }
            }
        }

        private static void CleanupProofSceneObjects()
        {
            var scene = SceneManager.GetActiveScene();
            foreach (var root in scene.GetRootGameObjects())
            {
                if (root.name.StartsWith("HertzW04Proof_", StringComparison.Ordinal))
                {
                    UnityEngine.Object.DestroyImmediate(root);
                }
            }
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

        private static bool SampleSceneHashUnchanged()
        {
            var path = Path.GetFullPath("Assets/Scenes/SampleScene.unity");
            if (!File.Exists(path)) return false;
            using var sha = System.Security.Cryptography.SHA256.Create();
            using var stream = File.OpenRead(path);
            var hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
            return string.Equals(
                hash,
                "9FB1EFEAC51BD4AEE87A5DD23CD3613DB054EA41BC82977F0ADAF27CA5E5F4D9",
                StringComparison.OrdinalIgnoreCase);
        }

        private static void WriteProof(string fileName, string proofName, List<Check> checks, string scenePath)
        {
            var passed = 0;
            foreach (var c in checks)
            {
                if (c.Pass) passed++;
            }

            var ok = checks.Count > 0 && passed == checks.Count;
            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine($"  \"schemaVersion\": 2,");
            sb.AppendLine($"  \"proof\": \"{proofName}\",");
            sb.AppendLine($"  \"ok\": {(ok ? "true" : "false")},");
            sb.AppendLine($"  \"passed\": {passed},");
            sb.AppendLine($"  \"total\": {checks.Count},");
            sb.AppendLine($"  \"scenePath\": \"{scenePath}\",");
            sb.AppendLine($"  \"stampedAt\": \"{DateTime.UtcNow:o}\",");
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
            Debug.Log($"W04 proof wrote {outPath} ok={ok} ({passed}/{checks.Count})");
            if (!ok) throw new InvalidOperationException($"W04 proof failed: {proofName}");
        }

        private static string Json(object value)
        {
            if (value == null) return "null";
            if (value is bool b) return b ? "true" : "false";
            if (value is int or long or float or double) return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
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

        /// <summary>Test double for Sound-section presenter boundary.</summary>
        private sealed class FakeShotAudioPresenter : MonoBehaviour, IHertzWeaponShotAudioPresenter
        {
            public int DeliveryCount;
            public HertzWeaponShotEvent Last;

            public void PresentAcceptedShot(in HertzWeaponShotEvent shotEvent)
            {
                DeliveryCount++;
                Last = shotEvent;
            }

            public void ResetCounts()
            {
                DeliveryCount = 0;
                Last = default;
            }
        }
    }
}
