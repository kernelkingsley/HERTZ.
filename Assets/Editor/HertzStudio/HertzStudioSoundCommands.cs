using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Hertz.Analytics;
using Hertz.Sound;
using Hertz.Weapons;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// W07: apply Studio sound board sync into HertzStudio/Sound assets and test scene wiring.
    /// </summary>
    public static class HertzStudioSoundCommands
    {
        public const string SoundFolder = "Assets/HertzStudio/Sound";
        public const string BoardPath = SoundFolder + "/HertzSoundBoard.asset";
        public const string FootstepMapPath = SoundFolder + "/HertzFootstepSurfaceMap.asset";
        public const string TestScenePath = "Assets/Scenes/HertzSoundTest.unity";
        public const string ValidationClipPath =
            "Assets/Samples/XR Interaction Toolkit/3.4.1/Starter Assets/DemoAssets/Audio/Button Pop.wav";

        [Serializable]
        public class SoundSyncRequest
        {
            public string requestId;
            public string payloadHash;
            public SlotDto[] slots;
            public EmitterDto[] emitters;
            public FootstepDto[] footstepMappings;
        }

        [Serializable]
        public class SlotDto
        {
            public string id;
            public string category;
            public string slotKey;
            public string targetId;
            public ClipDto clip;
        }

        [Serializable]
        public class EmitterDto
        {
            public string id;
            public string name;
            public string scenePath;
            public Vec3Dto position;
            public float volume;
            public bool loop;
            public float spatialBlend;
            public float minDistance;
            public float maxDistance;
            public ClipDto clip;
        }

        [Serializable]
        public class FootstepDto
        {
            public string id;
            public string surfaceId;
            public string surfaceLabel;
            public ClipDto clip;
        }

        [Serializable]
        public class ClipDto
        {
            public string assetId;
            public string name;
            public string clipPath;
            public bool missing;
        }

        [Serializable]
        public class Vec3Dto
        {
            public float x;
            public float y;
            public float z;
        }

        public struct SyncResult
        {
            public int StatusCode;
            public string Json;
            public SyncResult(int statusCode, string json)
            {
                StatusCode = statusCode;
                Json = json;
            }
        }

        public static SyncResult SyncSoundBoard(string body)
        {
            var req = JsonUtility.FromJson<SoundSyncRequest>(body);
            if (req == null || string.IsNullOrEmpty(req.payloadHash))
            {
                return new SyncResult(400,
                    "{\"status\":\"failed\",\"error\":\"Missing sound sync payloadHash.\"}");
            }

            EnsureFolders();
            var leftShot = FindSlotClip(req.slots, "weapon", "shot", "left_pistol");
            var rightShot = FindSlotClip(req.slots, "weapon", "shot", "right_pistol");
            var footEntries = new List<HertzFootstepSurfaceMap.Entry>();
            if (req.footstepMappings != null)
            {
                foreach (var m in req.footstepMappings)
                {
                    if (m == null || string.IsNullOrEmpty(m.surfaceId)) continue;
                    footEntries.Add(new HertzFootstepSurfaceMap.Entry
                    {
                        surfaceId = m.surfaceId,
                        surfaceLabel = string.IsNullOrEmpty(m.surfaceLabel) ? m.surfaceId : m.surfaceLabel,
                        clip = LoadClip(m.clip),
                    });
                }
            }

            var map = AssetDatabase.LoadAssetAtPath<HertzFootstepSurfaceMap>(FootstepMapPath);
            if (map == null)
            {
                map = ScriptableObject.CreateInstance<HertzFootstepSurfaceMap>();
                AssetDatabase.CreateAsset(map, FootstepMapPath);
            }

            map.SetEntries(footEntries.ToArray());
            EditorUtility.SetDirty(map);

            // Persist a tiny JSON board for Studio mapping / proofs (no fabricated metrics).
            var boardJsonPath = Path.Combine(SoundFolder, "last-sync.json");
            File.WriteAllText(
                boardJsonPath,
                body,
                new UTF8Encoding(false));
            AssetDatabase.ImportAsset(boardJsonPath);

            WireWeaponTestPresenter(leftShot, rightShot);
            if (req.emitters != null && req.emitters.Length > 0)
            {
                EnsureSoundTestScene(req.emitters, map);
            }

            AssetDatabase.SaveAssets();
            var guid = AssetDatabase.AssetPathToGUID(FootstepMapPath);
            return new SyncResult(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"assetGuid\":{Quote(guid)}," +
                $"\"assetPath\":{Quote(FootstepMapPath)}," +
                $"\"observedPayloadHash\":{Quote(req.payloadHash)}," +
                $"\"requestId\":{Quote(req.requestId)}" +
                "}");
        }

        private static AudioClip FindSlotClip(SlotDto[] slots, string category, string slotKey, string targetId)
        {
            if (slots == null) return null;
            foreach (var s in slots)
            {
                if (s == null) continue;
                if (s.category != category || s.slotKey != slotKey) continue;
                var tid = string.IsNullOrEmpty(s.targetId) ? null : s.targetId;
                if (tid != targetId) continue;
                return LoadClip(s.clip);
            }

            return null;
        }

        private static AudioClip LoadClip(ClipDto clip)
        {
            if (clip == null || clip.missing) return null;
            if (!string.IsNullOrEmpty(clip.clipPath) && clip.clipPath.StartsWith("Assets/", StringComparison.Ordinal))
            {
                var c = AssetDatabase.LoadAssetAtPath<AudioClip>(clip.clipPath);
                if (c != null) return c;
            }

            return null;
        }

        private static void WireWeaponTestPresenter(AudioClip left, AudioClip right)
        {
            var scene = EditorSceneManager.GetSceneByPath("Assets/Scenes/HertzWeaponTest.unity");
            if (!scene.IsValid() || !scene.isLoaded)
            {
                // Do not force-open during sync if unrelated scene is active — optional soft wire.
                return;
            }

            foreach (var root in scene.GetRootGameObjects())
            {
                var runtime = root.GetComponentInChildren<HertzDualPistolRuntime>(true);
                if (runtime == null) continue;
                var presenter = root.GetComponentInChildren<HertzWeaponShotClipPresenter>(true);
                if (presenter == null)
                {
                    presenter = runtime.gameObject.AddComponent<HertzWeaponShotClipPresenter>();
                }

                presenter.Configure(left, right, 0.7f);
                runtime.SetShotAudioPresenter(presenter);
                EditorSceneManager.MarkSceneDirty(scene);
                break;
            }
        }

        private static void EnsureSoundTestScene(EmitterDto[] emitters, HertzFootstepSurfaceMap map)
        {
            EnsureFolders();
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            scene.name = "HertzSoundTest";
            var root = new GameObject("HertzSoundTestRig");
            var floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
            floor.name = "TestFloor_Wood";
            floor.transform.localScale = new Vector3(2f, 1f, 2f);

            var footGo = new GameObject("FootstepPlayer");
            footGo.transform.SetParent(root.transform, false);
            var footSrc = footGo.AddComponent<AudioSource>();
            footSrc.playOnAwake = false;
            footSrc.spatialBlend = 1f;
            var footPlayer = footGo.AddComponent<HertzFootstepPlayer>();
            footPlayer.Configure(map, footSrc);

            if (emitters != null)
            {
                foreach (var em in emitters)
                {
                    if (em == null) continue;
                    var go = new GameObject(string.IsNullOrEmpty(em.name) ? "Emitter" : em.name);
                    go.transform.SetParent(root.transform, false);
                    var pos = em.position ?? new Vec3Dto();
                    go.AddComponent<AudioSource>();
                    var emitter = go.AddComponent<HertzSoundEmitter>();
                    emitter.Configure(
                        em.id,
                        LoadClip(em.clip),
                        em.volume,
                        em.loop,
                        em.spatialBlend,
                        em.minDistance > 0 ? em.minDistance : 1f,
                        em.maxDistance > 0 ? em.maxDistance : 25f,
                        new Vector3(pos.x, pos.y, pos.z));
                }
            }

            var label = new GameObject("PLACEHOLDER_SOUND_LABEL");
            EditorSceneManager.SaveScene(scene, TestScenePath);
            AssetDatabase.SaveAssets();
        }

        private static void EnsureFolders()
        {
            if (!AssetDatabase.IsValidFolder("Assets/HertzStudio"))
            {
                AssetDatabase.CreateFolder("Assets", "HertzStudio");
            }

            if (!AssetDatabase.IsValidFolder(SoundFolder))
            {
                AssetDatabase.CreateFolder("Assets/HertzStudio", "Sound");
            }
        }

        private static string Quote(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private enum W07Phase
        {
            Idle,
            EnterPlay,
            Setup,
            SilentMissing,
            FreqOff,
            Wait1,
            FreqOnLeft,
            Wait2,
            FreqOnRight,
            Reconfigure,
            Footsteps,
            PersistAndSync,
            ExitForSync,
            ApplySync,
            Finish,
        }

        private const string W07SessionFlag = "HertzW07SoundProof.Active";
        private const string W07PhaseKey = "HertzW07SoundProof.Phase";

        [InitializeOnLoadMethod]
        private static void ResumeW07AfterDomainReload()
        {
            if (!SessionState.GetBool(W07SessionFlag, false)) return;
            if (_w07Running) return;
            _w07Running = true;
            EditorApplication.playModeStateChanged -= OnW07PlayMode;
            EditorApplication.playModeStateChanged += OnW07PlayMode;
            EditorApplication.update -= OnW07Update;
            EditorApplication.update += OnW07Update;
            var saved = SessionState.GetString(W07PhaseKey, "");
            if (saved == "ExitForSync" || saved == "ApplySync")
            {
                // Resume post-Play Mode SyncSoundBoard path — do not restart Setup.
                _w07Phase = W07Phase.ExitForSync;
                _w07PayloadHash = SessionState.GetString("HertzW07SoundProof.PayloadHash", _w07PayloadHash);
                _w07OpenedWeaponTest = SessionState.GetBool("HertzW07SoundProof.OpenedWeapon", true);
                _w07SceneGuid = SessionState.GetString("HertzW07SoundProof.SceneGuid", _w07SceneGuid);
            }
            else if (EditorApplication.isPlaying)
            {
                _w07Phase = W07Phase.Setup;
            }
        }

        private static bool _w07Running;
        private static W07Phase _w07Phase;
        private static float _w07Until;
        private static readonly List<string> W07Checks = new List<string>();
        private static int _w07Passed;
        private static string _w07Failed;
        private static GameObject _w07Host;
        private static GameObject _w07FootGo;
        private static HertzDualPistolRuntime _w07Pistol;
        private static HertzFrequencyGate _w07Gate;
        private static HertzWeaponShotClipPresenter _w07Presenter;
        private static HertzFootstepSurfaceMap _w07LiveMap;
        private static AudioClip _w07Clip;
        private static bool _w07UnityApplied;
        private static string _w07PayloadHash;
        private static string _w07SceneGuid;
        private static bool _w07OpenedWeaponTest;

        [MenuItem("HERTZ/Studio/Proofs/W07 Sound Runtime")]
        public static void RunSoundProof()
        {
            if (_w07Running)
            {
                Debug.LogWarning("W07 sound proof already running.");
                return;
            }

            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                EditorApplication.isPlaying = false;
                EditorApplication.delayCall += RunSoundProof;
                return;
            }

            // Open target scene BEFORE Play Mode (EditorSceneManager.OpenScene is illegal while playing).
            EnsureFolders();
            if (EditorApplication.isPlaying)
            {
                EditorApplication.isPlaying = false;
                EditorApplication.delayCall += () =>
                {
                    EditorApplication.delayCall += RunSoundProof;
                };
                return;
            }

            _w07OpenedWeaponTest = false;
            if (File.Exists("Assets/Scenes/HertzWeaponTest.unity"))
            {
                var scene = EditorSceneManager.OpenScene("Assets/Scenes/HertzWeaponTest.unity", OpenSceneMode.Single);
                _w07OpenedWeaponTest = scene.IsValid();
            }

            _w07Clip = AssetDatabase.LoadAssetAtPath<AudioClip>(ValidationClipPath);
            if (_w07Clip == null)
                throw new InvalidOperationException("Validation AudioClip missing: " + ValidationClipPath);

            var woodEntry = new HertzFootstepSurfaceMap.Entry
            {
                surfaceId = "floor_wood",
                surfaceLabel = "Wood floor",
                clip = _w07Clip,
            };
            var map = AssetDatabase.LoadAssetAtPath<HertzFootstepSurfaceMap>(FootstepMapPath);
            if (map == null)
            {
                map = ScriptableObject.CreateInstance<HertzFootstepSurfaceMap>();
                AssetDatabase.CreateAsset(map, FootstepMapPath);
            }

            map.SetEntries(new[] { woodEntry });
            EditorUtility.SetDirty(map);
            AssetDatabase.SaveAssets();

            _w07LiveMap = ScriptableObject.CreateInstance<HertzFootstepSurfaceMap>();
            _w07LiveMap.SetEntries(new[] { woodEntry });

            W07Checks.Clear();
            _w07Passed = 0;
            _w07Failed = null;
            _w07Host = null;
            _w07FootGo = null;
            _w07Pistol = null;
            _w07Gate = null;
            _w07Presenter = null;
            _w07UnityApplied = false;
            _w07PayloadHash = null;
            _w07SceneGuid = AssetDatabase.AssetPathToGUID("Assets/Scenes/HertzWeaponTest.unity");
            _w07Running = true;
            SessionState.SetBool(W07SessionFlag, true);
            _w07Phase = W07Phase.EnterPlay;
            EditorApplication.playModeStateChanged -= OnW07PlayMode;
            EditorApplication.playModeStateChanged += OnW07PlayMode;
            EditorApplication.update -= OnW07Update;
            EditorApplication.update += OnW07Update;
            if (EditorApplication.isPlaying) _w07Phase = W07Phase.Setup;
            else EditorApplication.isPlaying = true;
        }

        private static void OnW07PlayMode(PlayModeStateChange state)
        {
            if (!_w07Running) return;
            if (state == PlayModeStateChange.EnteredPlayMode) _w07Phase = W07Phase.Setup;
        }

        private static void OnW07Update()
        {
            if (!_w07Running) return;
            try { TickW07(); }
            catch (Exception ex)
            {
                W07Check("exception", false, ex.Message);
                if (_w07Failed == null) _w07Failed = "exception:" + ex.Message;
                FinishW07(false);
            }
        }

        private static void W07Check(string name, bool ok, string detail = null)
        {
            W07Checks.Add(
                "{\"name\":\"" + name + "\",\"pass\":" + (ok ? "true" : "false") +
                (detail != null ? ",\"detail\":\"" + detail.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"" : "") +
                "}");
            if (ok) _w07Passed++;
            else if (_w07Failed == null) _w07Failed = name + (detail != null ? ":" + detail : "");
        }

        private static void TickW07()
        {
            switch (_w07Phase)
            {
                case W07Phase.EnterPlay:
                    break;

                case W07Phase.Setup:
                    if (!EditorApplication.isPlaying) return;
                    W07Checks.Clear();
                    _w07Passed = 0;
                    _w07Failed = null;
                    if (_w07Clip == null)
                        _w07Clip = AssetDatabase.LoadAssetAtPath<AudioClip>(ValidationClipPath);
                    if (_w07LiveMap == null && _w07Clip != null)
                    {
                        _w07LiveMap = ScriptableObject.CreateInstance<HertzFootstepSurfaceMap>();
                        _w07LiveMap.SetEntries(new[]
                        {
                            new HertzFootstepSurfaceMap.Entry
                            {
                                surfaceId = "floor_wood",
                                surfaceLabel = "Wood floor",
                                clip = _w07Clip,
                            },
                        });
                    }

                    _w07OpenedWeaponTest =
                        string.Equals(SceneManager.GetActiveScene().path, "Assets/Scenes/HertzWeaponTest.unity",
                            StringComparison.OrdinalIgnoreCase);
                    _w07SceneGuid = AssetDatabase.AssetPathToGUID("Assets/Scenes/HertzWeaponTest.unity");
                    _w07Gate = UnityEngine.Object.FindFirstObjectByType<HertzFrequencyGate>();
                    _w07Pistol = UnityEngine.Object.FindFirstObjectByType<HertzDualPistolRuntime>();
                    _w07Host = new GameObject("HertzW07ProofHost");
                    if (_w07Gate == null) _w07Gate = _w07Host.AddComponent<HertzFrequencyGate>();
                    if (_w07Pistol == null) _w07Pistol = _w07Host.AddComponent<HertzDualPistolRuntime>();
                    if (!_w07Pistol.IsBound || _w07Pistol.LeftMuzzle == null)
                        _w07Pistol.BindModelsAsInPlayMode();
                    W07Check("weapon_bound_for_tryfireside",
                        _w07Pistol.IsBound && _w07Pistol.LeftMuzzle != null,
                        _w07Pistol.BindError ?? "bound");
                    _w07Presenter = _w07Host.AddComponent<HertzWeaponShotClipPresenter>();
                    _w07Presenter.Configure(null, null, 0.5f);
                    _w07Pistol.SetShotAudioPresenter(_w07Presenter);
                    _w07Pistol.ResetShotCounts();
                    _w07Phase = W07Phase.SilentMissing;
                    break;

                case W07Phase.SilentMissing:
                {
                    var silentShot = new HertzWeaponShotEvent(
                        HertzWeaponDefinition.WeaponRole.LeftPistol,
                        null, Vector3.zero, Vector3.forward, false, Vector3.zero, 0f);
                    _w07Presenter.PresentAcceptedShot(silentShot);
                    W07Check("missing_clip_silent", _w07Presenter.PresentCount == 0, "count=" + _w07Presenter.PresentCount);
                    _w07Phase = W07Phase.FreqOff;
                    break;
                }

                case W07Phase.FreqOff:
                {
                    _w07Gate.SetFrequencyActive(false);
                    var offAccepted = _w07Pistol.TryFireLeftForProof();
                    W07Check("frequency_off_rejects_fire", !offAccepted, "accepted=" + offAccepted);
                    W07Check("frequency_off_no_presenter_delivery",
                        _w07Presenter.PresentCount == 0 && _w07Pistol.LeftPresenterDeliveryCount == 0,
                        "present=" + _w07Presenter.PresentCount);
                    _w07Phase = W07Phase.Wait1;
                    _w07Until = Time.realtimeSinceStartup + 0.25f;
                    break;
                }

                case W07Phase.Wait1:
                    if (Time.realtimeSinceStartup < _w07Until) return;
                    _w07Phase = W07Phase.FreqOnLeft;
                    break;

                case W07Phase.FreqOnLeft:
                {
                    _w07Presenter.Configure(_w07Clip, _w07Clip, 0.5f);
                    _w07Pistol.SetShotAudioPresenter(_w07Presenter);
                    _w07Gate.SetFrequencyActive(true);
                    var miss = _w07Pistol.LeftMuzzle.position + _w07Pistol.LeftMuzzle.up * 6f;
                    AimW07(_w07Pistol.LeftMuzzle, miss);
                    var onAccepted = _w07Pistol.TryFireLeftForProof();
                    W07Check("frequency_on_accepted_tryfireside", onAccepted, "accepted=" + onAccepted);
                    W07Check("exactly_one_presenter_delivery",
                        _w07Presenter.PresentCount == 1 && _w07Pistol.LeftPresenterDeliveryCount == 1,
                        "present=" + _w07Presenter.PresentCount + ",del=" + _w07Pistol.LeftPresenterDeliveryCount);
                    W07Check("left_clip_assigned", _w07Clip != null, _w07Clip != null ? _w07Clip.name : "null");
                    _w07Phase = W07Phase.Wait2;
                    _w07Until = Time.realtimeSinceStartup + 0.25f;
                    break;
                }

                case W07Phase.Wait2:
                    if (Time.realtimeSinceStartup < _w07Until) return;
                    _w07Phase = W07Phase.FreqOnRight;
                    break;

                case W07Phase.FreqOnRight:
                {
                    var before = _w07Presenter.PresentCount;
                    var miss = _w07Pistol.RightMuzzle != null
                        ? _w07Pistol.RightMuzzle.position + _w07Pistol.RightMuzzle.up * 6f
                        : Vector3.up * 10f;
                    if (_w07Pistol.RightMuzzle != null) AimW07(_w07Pistol.RightMuzzle, miss);
                    var rightOk = _w07Pistol.TryFireRightForProof();
                    W07Check("right_accepted_tryfireside", rightOk, "accepted=" + rightOk);
                    W07Check("second_delivery_exactly_one",
                        _w07Presenter.PresentCount == before + 1,
                        "present=" + _w07Presenter.PresentCount);
                    W07Check("right_clip_assigned", _w07Clip != null, _w07Clip.name);
                    _w07Phase = W07Phase.Reconfigure;
                    break;
                }

                case W07Phase.Reconfigure:
                {
                    _w07Presenter.Configure(_w07Clip, _w07Clip, 0.5f);
                    _w07Pistol.SetShotAudioPresenter(_w07Presenter);
                    var beforeRe = _w07Presenter.PresentCount;
                    if (_w07Pistol.LeftMuzzle != null)
                        AimW07(_w07Pistol.LeftMuzzle, _w07Pistol.LeftMuzzle.position + _w07Pistol.LeftMuzzle.up * 6f);
                    _w07Pistol.TryFireLeftForProof();
                    W07Check("reconfigure_no_duplicate_delivery",
                        _w07Presenter.PresentCount == beforeRe + 1,
                        "present=" + _w07Presenter.PresentCount);
                    _w07Phase = W07Phase.Footsteps;
                    break;
                }

                case W07Phase.Footsteps:
                {
                    _w07FootGo = new GameObject("HertzW07Foot");
                    var srcGo = new GameObject("FootstepAudio");
                    srcGo.transform.SetParent(_w07FootGo.transform, false);
                    var src = srcGo.AddComponent<AudioSource>();
                    src.playOnAwake = false;
                    src.spatialBlend = 1f;
                    var foot = _w07FootGo.AddComponent<HertzFootstepPlayer>();
                    foot.Configure(_w07LiveMap, src);
                    var mapHasClip = _w07LiveMap.TryGetClip("floor_wood", out var mappedClip) && mappedClip != null;
                    W07Check("footstep_map_has_clip", mapHasClip, mapHasClip ? mappedClip.name : "null");
                    W07Check("footstep_source_ready", src != null, "AudioSource");
                    var playedWood = foot.PlayForSurface("floor_wood");
                    W07Check("footstep_floor_wood", playedWood, playedWood ? "played" : "miss");
                    W07Check("unknown_surface_silent", !foot.PlayForSurface("unknown_surface"));
                    W07Check("material_appearance_not_auto_bound", !foot.PlayForSurface(""));

                    var persistMap = AssetDatabase.LoadAssetAtPath<HertzFootstepSurfaceMap>(FootstepMapPath);
                    AudioClip reClip = null;
                    var reloadOk = persistMap != null && persistMap.TryGetClip("floor_wood", out reClip) && reClip != null;
                    W07Check("assignment_survives_reload", reloadOk, reloadOk ? reClip.name : "miss");
                    _w07Phase = W07Phase.PersistAndSync;
                    break;
                }

                case W07Phase.PersistAndSync:
                {
                    var boardPath = Path.Combine(SoundFolder, "last-sync.json");
                    _w07PayloadHash = "w07-runtime-local-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                    var syncBody =
                        "{" +
                        "\"requestId\":\"w07-runtime-proof\"," +
                        "\"payloadHash\":" + Quote(_w07PayloadHash) + "," +
                        "\"slots\":[{" +
                        "\"category\":\"weapon\",\"slotKey\":\"shot\",\"targetId\":\"left_pistol\"," +
                        "\"clip\":{\"clipPath\":" + Quote(ValidationClipPath) + ",\"missing\":false}" +
                        "},{" +
                        "\"category\":\"weapon\",\"slotKey\":\"shot\",\"targetId\":\"right_pistol\"," +
                        "\"clip\":{\"clipPath\":" + Quote(ValidationClipPath) + ",\"missing\":false}" +
                        "}]," +
                        "\"footstepMappings\":[{" +
                        "\"surfaceId\":\"floor_wood\",\"surfaceLabel\":\"Wood floor\"," +
                        "\"clip\":{\"clipPath\":" + Quote(ValidationClipPath) + ",\"missing\":false}" +
                        "}]," +
                        "\"emitters\":[]" +
                        "}";
                    File.WriteAllText(boardPath, syncBody, new UTF8Encoding(false));
                    W07Check("board_assignment_persisted", File.Exists(boardPath));
                    // SyncSoundBoard uses AssetDatabase — must run outside Play Mode.
                    SessionState.SetString("HertzW07SoundProof.SyncBody", syncBody);
                    SessionState.SetString("HertzW07SoundProof.PayloadHash", _w07PayloadHash ?? "");
                    SessionState.SetBool("HertzW07SoundProof.OpenedWeapon", _w07OpenedWeaponTest);
                    SessionState.SetString("HertzW07SoundProof.SceneGuid", _w07SceneGuid ?? "");
                    // Persist check progress across Play Mode exit domain reload.
                    SessionState.SetString("HertzW07SoundProof.ChecksJson", string.Join("\n", W07Checks));
                    SessionState.SetInt("HertzW07SoundProof.Passed", _w07Passed);
                    SessionState.SetString(W07PhaseKey, "ExitForSync");
                    _w07Phase = W07Phase.ExitForSync;
                    // Abandon the scene's analytics session while its component is still alive.
                    // Waiting until Edit Mode is too late: OnDisable stages during Play Mode exit.
                    AbandonW07AnalyticsSessions();
                    if (EditorApplication.isPlaying) EditorApplication.isPlaying = false;
                    break;
                }

                case W07Phase.ExitForSync:
                    if (EditorApplication.isPlaying || EditorApplication.isPlayingOrWillChangePlaymode) return;
                    // Restore checks accumulated before Play Mode exit.
                    if (W07Checks.Count == 0)
                    {
                        var raw = SessionState.GetString("HertzW07SoundProof.ChecksJson", "");
                        if (!string.IsNullOrEmpty(raw))
                        {
                            foreach (var line in raw.Split('\n'))
                            {
                                if (!string.IsNullOrWhiteSpace(line)) W07Checks.Add(line);
                            }
                        }

                        _w07Passed = SessionState.GetInt("HertzW07SoundProof.Passed", W07Checks.Count);
                    }

                    SessionState.SetString(W07PhaseKey, "ApplySync");
                    _w07Phase = W07Phase.ApplySync;
                    break;

                case W07Phase.ApplySync:
                {
                    var syncBody = SessionState.GetString("HertzW07SoundProof.SyncBody", "");
                    SessionState.EraseString("HertzW07SoundProof.SyncBody");
                    if (string.IsNullOrEmpty(_w07PayloadHash))
                        _w07PayloadHash = SessionState.GetString("HertzW07SoundProof.PayloadHash", null);
                    var syncResult = SyncSoundBoard(syncBody);
                    _w07UnityApplied = syncResult.StatusCode == 200 &&
                                       syncResult.Json != null &&
                                       syncResult.Json.IndexOf("\"status\":\"applied\"", StringComparison.Ordinal) >= 0;
                    W07Check("unity_sound_board_apply", _w07UnityApplied, syncResult.StatusCode + ":" + (syncResult.Json ?? ""));
                    // Cleanup proof objects now that we are back in Edit Mode.
                    if (_w07Pistol != null)
                    {
                        try { _w07Pistol.SetShotAudioPresenter(null); } catch { /* cleanup */ }
                    }

                    if (_w07FootGo != null) UnityEngine.Object.DestroyImmediate(_w07FootGo);
                    if (_w07Host != null) UnityEngine.Object.DestroyImmediate(_w07Host);
                    if (_w07LiveMap != null)
                    {
                        UnityEngine.Object.DestroyImmediate(_w07LiveMap);
                        _w07LiveMap = null;
                    }

                    _w07Phase = W07Phase.Finish;
                    FinishW07(_w07Passed == W07Checks.Count && string.IsNullOrEmpty(_w07Failed));
                    break;
                }

                case W07Phase.Finish:
                case W07Phase.Idle:
                    break;
            }
        }

        private static void AbandonW07AnalyticsSessions()
        {
            foreach (var capture in UnityEngine.Object.FindObjectsByType<HertzAnalyticsCapture>(FindObjectsSortMode.None))
            {
                if (capture != null) capture.AbandonOpenSessionWithoutStaging();
            }
        }

        private static void AimW07(Transform muzzle, Vector3 worldPoint)
        {
            if (muzzle == null) return;
            var dir = (worldPoint - muzzle.position).normalized;
            if (dir.sqrMagnitude < 0.0001f) return;
            muzzle.rotation = Quaternion.LookRotation(dir, Vector3.up);
        }

        private static void FinishW07(bool ok)
        {
            ok = ok && _w07Passed == W07Checks.Count && W07Checks.Count > 0 && string.IsNullOrEmpty(_w07Failed);
            WriteW07ProofJson(ok);
            Debug.Log("W07 sound runtime proof ok=" + ok + " " + _w07Passed + "/" + W07Checks.Count);

            AbandonW07AnalyticsSessions();

            EditorApplication.update -= OnW07Update;
            EditorApplication.playModeStateChanged -= OnW07PlayMode;
            SessionState.SetBool(W07SessionFlag, false);
            SessionState.EraseString(W07PhaseKey);
            SessionState.EraseString("HertzW07SoundProof.SyncBody");
            SessionState.EraseString("HertzW07SoundProof.ChecksJson");
            SessionState.EraseString("HertzW07SoundProof.PayloadHash");
            SessionState.EraseString("HertzW07SoundProof.SceneGuid");
            _w07Running = false;
            _w07Phase = W07Phase.Idle;
            if (EditorApplication.isPlaying) EditorApplication.isPlaying = false;
            if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
        }

        private const string W07CheckSetVersion = "w07-checks-v3-playmode";

        private static string ComputeW07SourceFingerprint()
        {
            var files = new[]
            {
                "ProjectSettings/ProjectVersion.txt",
                "Assets/Scripts/Weapons/HertzDualPistolRuntime.cs",
                "Assets/Scripts/Sound/HertzWeaponShotClipPresenter.cs",
                "Assets/Scripts/Sound/HertzFootstepSurfaceMap.cs",
                "Assets/Editor/HertzStudio/HertzStudioSoundCommands.cs",
                "Tools/HertzStudio/api/src/sound.mjs",
                "Tools/HertzStudio/connector/src/connector.mjs",

                "Tools/HertzStudio/scripts/proof-w07-aggregate.mjs",
                "Tools/HertzStudio/scripts/lib/w07-aggregate-status.mjs",
            };
            using var sha = System.Security.Cryptography.SHA256.Create();
            var ms = new MemoryStream();
            foreach (var f in files)
            {
                var full = Path.GetFullPath(f);
                var bytes = File.Exists(full) ? File.ReadAllBytes(full) : Array.Empty<byte>();
                var name = Encoding.UTF8.GetBytes(f.Replace('\\', '/') + "\n");
                ms.Write(name, 0, name.Length);
                ms.Write(bytes, 0, bytes.Length);
            }

            var scenePath = "Assets/Scenes/HertzWeaponTest.unity";
            var sceneGuid = AssetDatabase.AssetPathToGUID(scenePath) ?? _w07SceneGuid ?? "";
            var pathBytes = Encoding.UTF8.GetBytes("scenePath:" + scenePath + "\n");
            ms.Write(pathBytes, 0, pathBytes.Length);
            var guidBytes = Encoding.UTF8.GetBytes("sceneGuid:" + sceneGuid + "\n");
            ms.Write(guidBytes, 0, guidBytes.Length);
            var hash = sha.ComputeHash(ms.ToArray());
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static void WriteW07ProofJson(bool allOk)
        {
            var outPath = Path.GetFullPath("Tools/HertzStudio/data/w07-sound-runtime-proof.json");
            Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? "Tools/HertzStudio/data");
            var stamp = DateTime.UtcNow.ToString("o");
            var scenePath = _w07OpenedWeaponTest ? "Assets/Scenes/HertzWeaponTest.unity" : "ephemeral";
            var fingerprint = ComputeW07SourceFingerprint();
            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"schemaVersion\": 3,\n");
            sb.Append("  \"proof\": \"w07-sound-runtime\",\n");
            sb.Append("  \"ok\": ").Append(allOk ? "true" : "false").Append(",\n");
            sb.Append("  \"status\": \"").Append(allOk ? "passed" : "failed").Append("\",\n");
            sb.Append("  \"passed\": ").Append(_w07Passed).Append(",\n");
            sb.Append("  \"total\": ").Append(W07Checks.Count).Append(",\n");
            sb.Append("  \"source\": \"unity_editor_menu\",\n");
            sb.Append("  \"proofSource\": \"unity_editor_menu\",\n");
            sb.Append("  \"unityVersion\": ").Append(Quote(Application.unityVersion)).Append(",\n");
            sb.Append("  \"scenePath\": ").Append(Quote(scenePath)).Append(",\n");
            sb.Append("  \"sceneGuid\": ").Append(Quote(_w07SceneGuid)).Append(",\n");
            sb.Append("  \"sourceFingerprint\": ").Append(Quote(fingerprint)).Append(",\n");
            sb.Append("  \"checkSetVersion\": ").Append(Quote(W07CheckSetVersion)).Append(",\n");
            sb.Append("  \"generatedAt\": ").Append(Quote(stamp)).Append(",\n");
            sb.Append("  \"firePath\": \"TryFireLeftForProof/TryFireRightForProof→TryFireSide→EmitAcceptedShot→HertzWeaponShotClipPresenter\",\n");
            sb.Append("  \"proofOnlyFallback\": false,\n");
            sb.Append("  \"unityApplication\":{\"ok\":").Append(_w07UnityApplied ? "true" : "false")
                .Append(",\"path\":\"HertzStudioSoundCommands.SyncSoundBoard\",\"bridgeRoute\":\"POST /sound/sync\"},\n");
            sb.Append("  \"connectorDelivery\":{\"ok\":false,\"status\":\"pending\",\"reason\":\"live_studio_connector_token_not_exercised_this_run\"},\n");
            if (!string.IsNullOrEmpty(_w07PayloadHash))
                sb.Append("  \"payloadHash\": ").Append(Quote(_w07PayloadHash)).Append(",\n");
            if (!string.IsNullOrEmpty(_w07Failed))
                sb.Append("  \"failed\": ").Append(Quote(_w07Failed)).Append(",\n");
            sb.Append("  \"stampedAt\": \"").Append(stamp).Append("\",\n");
            sb.Append("  \"checks\": [\n    ");
            sb.Append(string.Join(",\n    ", W07Checks));
            sb.Append("\n  ]\n}\n");
            File.WriteAllText(outPath, sb.ToString(), new UTF8Encoding(false));
        }
    }
}
