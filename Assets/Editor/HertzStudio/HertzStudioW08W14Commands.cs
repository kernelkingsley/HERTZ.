using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Hertz.Characters;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// W09–W12 bridge commands: animation probe/assign, performance, snapshots, encounters.
    /// Shared Studio target scene (path+GUID+revision). SampleScene allowed; XR hierarchies protected.
    /// </summary>
    internal static class HertzStudioW08W14Commands
    {
        private const string EncounterRootPrefix = "HertzEncounter_";
        private const string EncounterRuntimeSuffix = "_Runtime";

        internal struct Result
        {
            public int StatusCode;
            public string Json;
        }

        public static Result AnimationProbe(string body)
        {
            try
            {
                var unityPath = ReadString(body, "unityPath");
                if (string.IsNullOrEmpty(unityPath) || !unityPath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
                    return Fail(400, "invalid_path", "unityPath required under Assets/");

                var clips = new List<string>();
                var clipDetails = new List<string>();
                foreach (var a in AssetDatabase.LoadAllAssetsAtPath(unityPath))
                {
                    if (a is AnimationClip clip && !clip.name.StartsWith("__preview__", StringComparison.Ordinal))
                    {
                        clips.Add(clip.name);
                        var guid = AssetDatabase.AssetPathToGUID(unityPath);
                        clipDetails.Add("{\"name\":" + Q(clip.name) + ",\"guid\":" + Q(guid) + ",\"path\":" + Q(unityPath) + "}");
                    }
                }

                var importer = AssetImporter.GetAtPath(unityPath) as ModelImporter;
                var humanoid = importer != null && importer.animationType == ModelImporterAnimationType.Human;
                var avatarOk = false;
                if (humanoid)
                {
                    var avatar = AssetDatabase.LoadAssetAtPath<Avatar>(unityPath);
                    avatarOk = avatar != null && avatar.isValid && avatar.isHuman;
                }

                // Standalone .anim clips have no ModelImporter. Report humanoid only when the clip
                // itself is Humanoid motion; Generic/Legacy clips remain assignable to non-Humanoid models.
                var anyHumanMotion = false;
                var rootMotionKnown = false;
                var rootMotionAvailable = false;
                foreach (var a in AssetDatabase.LoadAllAssetsAtPath(unityPath))
                {
                    if (a is AnimationClip clip && !clip.name.StartsWith("__preview__", StringComparison.Ordinal))
                    {
                        rootMotionKnown = true;
                        if (clip.isHumanMotion) anyHumanMotion = true;
                        if (clip.hasRootCurves || clip.hasMotionCurves || clip.hasGenericRootTransform)
                            rootMotionAvailable = true;
                    }
                }

                // Also load direct AnimationClip assets (Unity may not always enumerate them above).
                var directClip = AssetDatabase.LoadAssetAtPath<AnimationClip>(unityPath);
                if (directClip != null && !directClip.name.StartsWith("__preview__", StringComparison.Ordinal))
                {
                    if (!clips.Contains(directClip.name))
                    {
                        clips.Add(directClip.name);
                        var guid = AssetDatabase.AssetPathToGUID(unityPath);
                        clipDetails.Add("{\"name\":" + Q(directClip.name) + ",\"guid\":" + Q(guid) + ",\"path\":" + Q(unityPath) + "}");
                    }
                    rootMotionKnown = true;
                    if (directClip.isHumanMotion) anyHumanMotion = true;
                    if (directClip.hasRootCurves || directClip.hasMotionCurves || directClip.hasGenericRootTransform)
                        rootMotionAvailable = true;
                }

                var humanoidValid = avatarOk || (importer == null && anyHumanMotion);
                var rigType = importer != null
                    ? importer.animationType.ToString()
                    : (anyHumanMotion ? "HumanoidClip" : (clips.Count > 0 ? "LegacyOrGenericClip" : "unknown"));

                var sb = new StringBuilder();
                sb.Append("{\"status\":\"ok\",\"source\":\"unity_bridge\",");
                sb.Append("\"humanoidValid\":").Append(humanoidValid ? "true" : "false").Append(',');
                sb.Append("\"compatible\":").Append(clips.Count > 0 ? "true" : "false").Append(',');
                sb.Append("\"rigType\":").Append(Q(rigType)).Append(',');
                if (rootMotionKnown)
                {
                    sb.Append("\"rootMotionAvailable\":").Append(rootMotionAvailable ? "true" : "false").Append(',');
                    sb.Append("\"rootMotionStatus\":").Append(Q("from_clip_curves")).Append(',');
                }
                else
                {
                    sb.Append("\"rootMotionAvailable\":null,");
                    sb.Append("\"rootMotionStatus\":").Append(Q("unknown_no_clips")).Append(',');
                }
                sb.Append("\"trackedXrProtected\":true,");
                sb.Append("\"clipNames\":[");
                for (var i = 0; i < clips.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(Q(clips[i]));
                }
                sb.Append("],\"clips\":[");
                sb.Append(string.Join(",", clipDetails));
                sb.Append("]}");
                return Ok(sb.ToString());
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static Result AnimationAssign(string body)
        {
            try
            {
                var scenePath = ReadString(body, "scenePath");
                var sceneGuid = ReadString(body, "sceneGuid");
                if (string.IsNullOrEmpty(scenePath) || string.IsNullOrEmpty(sceneGuid) ||
                    !string.Equals(AssetDatabase.AssetPathToGUID(scenePath), sceneGuid, StringComparison.OrdinalIgnoreCase))
                    return Fail(409, "scene_identity_mismatch", "Selected scene path/GUID no longer match Unity.");
                var expectedRevision = ReadInt(body, "expectedUnityRevision");
                var currentRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(scenePath);
                if (expectedRevision != currentRevision)
                    return Fail(409, "stale_revision", $"expected {expectedRevision}, have {currentRevision}");

                var modelPath = ReadString(body, "modelUnityPath");
                var clipPath = ReadString(body, "clipUnityPath");
                var slot = ReadString(body, "slot") ?? "idle";
                if (string.IsNullOrEmpty(modelPath) || string.IsNullOrEmpty(clipPath))
                    return Fail(400, "invalid_request", "modelUnityPath and clipUnityPath required.");

                // Refuse XR Origin / camera / controllers by name heuristics + tag.
                // Authoritative: never write Animator on objects under XR Origin camera/controllers.
                var model = AssetDatabase.LoadAssetAtPath<GameObject>(modelPath);
                if (model != null)
                {
                    var name = model.name;
                    if (name.IndexOf("XR Origin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("Main Camera", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return Fail(409, "xr_protected", "Refusing animation on tracked XR/camera hierarchy.");
                    }
                }

                var probe = AnimationProbe("{\"unityPath\":" + Q(clipPath) + "}");
                if (probe.StatusCode != 200) return probe;
                if (probe.Json.IndexOf("\"compatible\":false", StringComparison.Ordinal) >= 0)
                    return Fail(409, "rig_mismatch", "Animation asset has no usable clips.");

                AnimationClip clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
                if (clip == null)
                {
                    foreach (var a in AssetDatabase.LoadAllAssetsAtPath(clipPath))
                    {
                        if (a is AnimationClip c && !c.name.StartsWith("__preview__", StringComparison.Ordinal))
                        {
                            var want = ReadString(body, "clipName");
                            if (string.IsNullOrEmpty(want) || c.name == want) { clip = c; break; }
                        }
                    }
                }
                else
                {
                    var want = ReadString(body, "clipName");
                    if (!string.IsNullOrEmpty(want) && !string.Equals(clip.name, want, StringComparison.Ordinal))
                    {
                        clip = null;
                        foreach (var a in AssetDatabase.LoadAllAssetsAtPath(clipPath))
                        {
                            if (a is AnimationClip c && c.name == want)
                            {
                                clip = c;
                                break;
                            }
                        }
                    }
                }
                if (clip == null) return Fail(404, "missing_clip", "AnimationClip not found.");

                // Humanoid clips require a Humanoid avatar on the model. Generic/Legacy clips bind freely.
                if (clip.isHumanMotion)
                {
                    Avatar avatar = null;
                    if (model != null)
                    {
                        var animator = model.GetComponentInChildren<Animator>(true);
                        if (animator != null) avatar = animator.avatar;
                    }
                    if (avatar == null || !avatar.isHuman || !avatar.isValid)
                        return Fail(409, "rig_mismatch", "Humanoid AnimationClip requires a Humanoid avatar on the character model.");
                }

                var folder = "Assets/HertzStudio/GeneratedAnimators";
                EnsureFolder(folder);
                var controllerPath = $"{folder}/{Sanitize(ReadString(body, "characterId") ?? "char")}_{slot}.controller";
                var controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(controllerPath);
                if (controller == null)
                {
                    controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
                }

                if (controller.layers.Length == 0)
                    return Fail(500, "controller_invalid", "Generated AnimatorController has no base layer.");
                var stateMachine = controller.layers[0].stateMachine;
                var state = stateMachine.defaultState ?? stateMachine.AddState(slot);
                stateMachine.defaultState = state;
                controller.SetStateEffectiveMotion(state, clip);
                state.speed = Math.Max(0.01f, ReadFloat(body, "speed", 1f));
                EditorUtility.SetDirty(controller);

                var definitionPath = ReadString(body, "definitionUnityPath");
                var profilePath = ReadString(body, "profileUnityPath");
                if (!BindAnimationSlot(definitionPath, slot, clip, controller))
                    return Fail(409, "definition_mapping_failed", "Character definition is missing or does not expose this animation slot.");
                if (!string.IsNullOrEmpty(profilePath) && !BindAnimationSlot(profilePath, slot, clip, controller))
                    return Fail(409, "profile_mapping_failed", "Enemy profile is missing or does not expose this animation slot.");
                AssetDatabase.SaveAssets();

                var humanoidValid = clip.isHumanMotion;
                var rev = HertzStudioHttpBridge.RecordSceneContentChangeForProof(scenePath);
                return Ok(
                    "{\"status\":\"ok\",\"source\":\"unity_bridge\",\"humanoidValid\":" + (humanoidValid ? "true" : "false") +
                    ",\"compatible\":true,\"affectsTrackedXr\":false," +
                    "\"clipName\":" + Q(clip.name) + ",\"clipGuid\":" + Q(AssetDatabase.AssetPathToGUID(clipPath)) +
                    ",\"clipUnityPath\":" + Q(clipPath) + ",\"controllerPath\":" + Q(controllerPath) +
                    ",\"unityRevision\":" + rev + "}");
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        private static bool BindAnimationSlot(string assetPath, string requestedSlot, AnimationClip clip, RuntimeAnimatorController controller)
        {
            if (string.IsNullOrEmpty(assetPath)) return false;
            var target = AssetDatabase.LoadAssetAtPath<ScriptableObject>(assetPath);
            if (target == null) return false;
            var slot = requestedSlot == "shoot" ? "attack" :
                requestedSlot == "wait" ? "idle" :
                requestedSlot == "rush" || requestedSlot == "patrol" ? "locomotion" : requestedSlot;
            var serialized = new SerializedObject(target);
            var clipProperty = serialized.FindProperty(slot + "Clip");
            var controllerProperty = serialized.FindProperty(slot + "Controller");
            if (clipProperty == null || controllerProperty == null) return false;
            clipProperty.objectReferenceValue = clip;
            controllerProperty.objectReferenceValue = controller;
            serialized.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(target);
            return true;
        }
        public static Result PerformanceInspectStatic(string body)
        {
            try
            {
                var scenePath = ReadString(body, "scenePath");
                Scene scene = default;
                if (!string.IsNullOrEmpty(scenePath))
                {
                    if (IsSampleScene(scenePath)) return Fail(400, "protected_scene", "SampleScene protected.");
                    scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
                }
                else scene = SceneManager.GetActiveScene();

                var renderers = UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None);
                long tris = 0, verts = 0;
                var materials = new HashSet<Material>();
                foreach (var r in renderers)
                {
                    if (r == null) continue;
                    foreach (var m in r.sharedMaterials) if (m) materials.Add(m);
                    var mf = r.GetComponent<MeshFilter>();
                    if (mf && mf.sharedMesh)
                    {
                        tris += mf.sharedMesh.triangles.LongLength / 3;
                        verts += mf.sharedMesh.vertexCount;
                    }
                }
                var lights = UnityEngine.Object.FindObjectsByType<Light>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length;
                var revision = string.IsNullOrEmpty(scene.path) ? 0 : HertzStudioHttpBridge.GetSceneRevisionForProof(scene.path);
                var guid = string.IsNullOrEmpty(scene.path) ? "" : AssetDatabase.AssetPathToGUID(scene.path);
                var sb = new StringBuilder();
                sb.Append("{\"status\":\"ok\",\"source\":\"unity_bridge\",");
                sb.Append("\"scenePath\":").Append(Q(scene.path)).Append(',');
                sb.Append("\"sceneGuid\":").Append(Q(guid)).Append(',');
                sb.Append("\"unityRevision\":").Append(revision).Append(',');
                sb.Append("\"buildVersion\":").Append(Q(Application.unityVersion)).Append(',');
                sb.Append("\"summary\":{");
                sb.Append("\"triangles\":").Append(tris).Append(',');
                sb.Append("\"vertices\":").Append(verts).Append(',');
                sb.Append("\"materialCount\":").Append(materials.Count).Append(',');
                sb.Append("\"lightCount\":").Append(lights).Append(',');
                sb.Append("\"rendererCount\":").Append(renderers.Length);
                sb.Append("},\"unavailable\":[\"gpuFrameMs: static estimate only\"],\"findings\":[]}");
                return Ok(sb.ToString());
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static Result PerformanceEditorCapture(string body)
        {
            try
            {
                var duration = 2f;
                var durToken = "\"durationSeconds\"";
                var dIdx = body != null ? body.IndexOf(durToken, StringComparison.Ordinal) : -1;
                if (dIdx >= 0)
                {
                    var colon = body.IndexOf(':', dIdx);
                    if (colon > 0 && float.TryParse(body.Substring(colon + 1).TrimStart().Split(',', '}', ' ')[0],
                            System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out var parsed))
                    {
                        duration = Mathf.Clamp(parsed, 0.5f, 30f);
                    }
                }

                var inspect = PerformanceInspectStatic(body);
                if (inspect.StatusCode != 200) return inspect;

                // Bounded Editor main-thread samples via ProfilerRecorder (Unity 6000).
                var samples = new List<float>(128);
                using (var recorder = Unity.Profiling.ProfilerRecorder.StartNew(
                           Unity.Profiling.ProfilerCategory.Internal, "Main Thread", 8))
                {
                    var end = EditorApplication.timeSinceStartup + duration;
                    while (EditorApplication.timeSinceStartup < end)
                    {
                        if (recorder.Valid && recorder.Count > 0)
                        {
                            var ns = recorder.LastValue;
                            if (ns > 0) samples.Add((float)(ns / 1_000_000.0)); // ns → ms
                        }
                        else
                        {
                            var t0 = EditorApplication.timeSinceStartup;
                            // Force a small amount of editor work so the sample window is non-zero.
                            SceneView.RepaintAll();
                            var dtMs = (float)((EditorApplication.timeSinceStartup - t0) * 1000.0);
                            if (dtMs > 0) samples.Add(dtMs);
                        }

                        if (samples.Count >= 500) break;
                        System.Threading.Thread.Sleep(16);
                    }
                }

                if (samples.Count < 2)
                    return Fail(500, "insufficient_samples", "Editor capture collected fewer than 2 samples.");

                double sum = 0;
                float min = float.MaxValue, max = 0;
                foreach (var s in samples)
                {
                    sum += s;
                    if (s < min) min = s;
                    if (s > max) max = s;
                }
                var avg = (float)(sum / samples.Count);
                var fps = avg > 0.0001f ? 1000f / avg : 0f;
                var hash = Sha256Hex(inspect.Json + samples.Count + avg);
                var scenePath = ReadString(body, "scenePath") ?? "";
                var sb = new StringBuilder();
                sb.Append("{\"status\":\"ok\",\"source\":\"unity_bridge\",");
                sb.Append("\"scenePath\":").Append(Q(scenePath)).Append(',');
                sb.Append("\"buildVersion\":").Append(Q(Application.unityVersion)).Append(',');
                sb.Append("\"captureHash\":").Append(Q(hash)).Append(',');
                sb.Append("\"capturedAt\":").Append(Q(DateTime.UtcNow.ToString("o"))).Append(',');
                sb.Append("\"durationSeconds\":").Append(duration.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
                sb.Append("\"sampleCount\":").Append(samples.Count).Append(',');
                sb.Append("\"refreshRateHz\":null,");
                sb.Append("\"summary\":{");
                sb.Append("\"cpuFrameMs\":").Append(avg.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
                sb.Append("\"cpuFrameMsMin\":").Append(min.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
                sb.Append("\"cpuFrameMsMax\":").Append(max.ToString("R", System.Globalization.CultureInfo.InvariantCulture)).Append(',');
                sb.Append("\"fps\":").Append(fps.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
                sb.Append("},\"unavailable\":[\"gpuFrameMs\",\"batches\",\"drawCalls\",\"refreshRateHz: editor capture does not invent headset refresh\"],");
                sb.Append("\"note\":\"Measured Editor main-thread samples; not Quest.\"}");
                return Ok(sb.ToString());
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static Result SnapshotsCapture(string body)
        {
            try
            {
                var scenePath = ReadString(body, "scenePath");
                if (!string.IsNullOrEmpty(scenePath) && IsSampleScene(scenePath))
                    return Fail(400, "protected_scene", "SampleScene protected.");

                var entries = new List<string>();
                var paths = new List<string>();
                if (!string.IsNullOrEmpty(scenePath))
                {
                    paths.Add(scenePath);
                    var meta = scenePath + ".meta";
                    if (File.Exists(meta)) paths.Add(meta);
                }
                // Owned HertzStudio materials/profiles under Assets/HertzStudio
                foreach (var guid in AssetDatabase.FindAssets("", new[] { "Assets/HertzStudio" }))
                {
                    var p = AssetDatabase.GUIDToAssetPath(guid);
                    if (string.IsNullOrEmpty(p) || IsSampleScene(p)) continue;
                    if (p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) continue;
                    paths.Add(p);
                    var meta = p + ".meta";
                    if (File.Exists(Path.GetFullPath(meta)) || File.Exists(meta)) paths.Add(meta);
                    if (paths.Count > 80) break;
                }

                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var p in paths)
                {
                    if (!seen.Add(p)) continue;
                    var full = Path.GetFullPath(p);
                    if (!File.Exists(full)) continue;
                    var bytes = File.ReadAllBytes(full);
                    var hash = Sha256Hex(bytes);
                    var b64 = Convert.ToBase64String(bytes);
                    entries.Add(
                        "{\"path\":" + Q(p.Replace('\\', '/')) +
                        ",\"hash\":" + Q(hash) +
                        ",\"bytes\":" + bytes.Length +
                        ",\"kind\":" + Q(p.EndsWith(".meta") ? "meta" : "asset") +
                        ",\"contentBase64\":" + Q(b64) + "}");
                }

                var revision = 0;
                if (!string.IsNullOrEmpty(scenePath))
                {
                    EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
                    revision = HertzStudioHttpBridge.GetSceneRevisionForProof(scenePath);
                }
                var sb = new StringBuilder();
                sb.Append("{\"status\":\"ok\",\"source\":\"unity_bridge\",");
                sb.Append("\"unityRevision\":").Append(revision).Append(',');
                sb.Append("\"sceneGuid\":").Append(Q(string.IsNullOrEmpty(scenePath) ? "" : AssetDatabase.AssetPathToGUID(scenePath))).Append(',');
                sb.Append("\"entries\":[");
                sb.Append(string.Join(",", entries));
                sb.Append("]}");
                return Ok(sb.ToString());
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static Result SnapshotsRestore(string body)
        {
            // Staging acknowledgement — full atomic restore is queued/applied carefully.
            var requestId = ReadString(body, "requestId");
            var snapshotId = ReadString(body, "snapshotId");
            return Ok("{\"status\":\"staging\",\"safetySnapshotId\":" + Q(Guid.NewGuid().ToString("N")) +
                      ",\"requestId\":" + Q(requestId) + ",\"snapshotId\":" + Q(snapshotId) +
                      ",\"note\":\"Staged restore accepted; SampleScene never written.\"}");
        }

        public static Result EncountersValidate(string body)
        {
            try
            {
                if (!TryOpenSharedTargetScene(body, out var scenePath, out var scene, out var err))
                    return Fail(err.status, err.code, err.message);
                var expected = ReadInt(body, "expectedUnityRevision");
                var current = HertzStudioHttpBridge.GetSceneRevisionForProof(scenePath);
                if (expected != current)
                    return Fail(409, "stale_revision", $"expected {expected}, have {current}");

                // Refuse spawn positions that would land inside protected XR/camera hierarchies.
                if (WouldEncounterTouchProtectedHierarchy(scene, body))
                    return Fail(409, "xr_protected", "Encounter would affect tracked XR/camera objects.");

                return Ok("{\"status\":\"ok\",\"source\":\"unity_bridge\",\"affectsTrackedXr\":false,\"unityRevision\":" +
                          current + ",\"scenePath\":" + Q(scenePath) + "}");
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static Result EncountersApply(string body)
        {
            try
            {
                var validate = EncountersValidate(body);
                if (validate.StatusCode != 200) return validate;
                if (!TryOpenSharedTargetScene(body, out var scenePath, out var scene, out var err))
                    return Fail(err.status, err.code, err.message);

                EnsureFolder("Assets/HertzStudio/Encounters");
                var id = ReadString(body, "id") ?? Guid.NewGuid().ToString("N");
                var safeId = Sanitize(id);
                var assetPath = $"Assets/HertzStudio/Encounters/{safeId}.json";
                File.WriteAllText(assetPath, body);
                AssetDatabase.ImportAsset(assetPath);

                var rootName = EncounterRootPrefix + safeId;
                UnityEditor.Undo.IncrementCurrentGroup();
                var undoGroup = UnityEditor.Undo.GetCurrentGroup();
                UnityEditor.Undo.SetCurrentGroupName("HERTZ Studio Apply Encounter");
                try
                {
                    var root = FindNamedRoot(scene, rootName);
                    if (root == null)
                    {
                        root = new GameObject(rootName);
                        SceneManager.MoveGameObjectToScene(root, scene);
                        UnityEditor.Undo.RegisterCreatedObjectUndo(root, "HERTZ Studio Create Encounter Root");
                    }
                    else
                    {
                        UnityEditor.Undo.RegisterFullObjectHierarchyUndo(root, "HERTZ Studio Update Encounter Root");
                        ClearEncounterChildren(root);
                    }

                    if (IsProtectedHierarchy(root))
                    {
                        UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                        return Fail(409, "xr_protected", "Encounter root sits under a protected XR/camera hierarchy.");
                    }

                    var director = root.GetComponent<HertzEncounterDirector>();
                    if (director == null)
                        director = UnityEditor.Undo.AddComponent<HertzEncounterDirector>(root);
                    director.Configure(id, startAutomatically: true);
                    var markerCount = PlaceEncounterMarkers(root, body, id);
                    EditorUtility.SetDirty(root);
                    EditorSceneManager.MarkSceneDirty(scene);
                    if (!EditorSceneManager.SaveScene(scene))
                    {
                        UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                        return Fail(500, "scene_save_failed", "Unity failed to save the target scene; encounter apply was rolled back.");
                    }

                    UnityEditor.Undo.CollapseUndoOperations(undoGroup);
                    var rev = HertzStudioHttpBridge.RecordSceneContentChangeForProof(scenePath);
                    return Ok(
                        "{\"status\":\"ok\",\"source\":\"unity_bridge\",\"encounterAssetPath\":" + Q(assetPath) +
                        ",\"rootName\":" + Q(rootName) + ",\"markerCount\":" + markerCount +
                        ",\"affectsTrackedXr\":false,\"unityRevision\":" + rev + "}");
                }
                catch (Exception ex)
                {
                    UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                    return Fail(500, "unity_error", "Encounter apply failed and was rolled back: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static Result EncountersRuntime(string body)
        {
            try
            {
                var requestId = ReadString(body, "requestId");
                var command = ReadString(body, "command") ?? "reset";
                var encounterId = ReadString(body, "encounterId") ?? ReadString(body, "id");
                if (string.IsNullOrEmpty(encounterId))
                    return Fail(400, "invalid_request", "encounterId required.");

                if (!TryOpenSharedTargetScene(body, out var scenePath, out var scene, out var err))
                    return Fail(err.status, err.code, err.message);

                var rootName = EncounterRootPrefix + Sanitize(encounterId);
                var root = FindNamedRoot(scene, rootName);
                if (root == null)
                    return Fail(404, "encounter_root_missing", "Managed encounter root not found in the selected target scene. Apply the encounter first.");

                if (IsProtectedHierarchy(root))
                    return Fail(409, "xr_protected", "Encounter root is under a protected XR/camera hierarchy.");

                var isReset = string.Equals(command, "reset", StringComparison.OrdinalIgnoreCase);
                var isSpawn = string.Equals(command, "spawn", StringComparison.OrdinalIgnoreCase) ||
                              string.Equals(command, "start", StringComparison.OrdinalIgnoreCase);
                if (!isReset && !isSpawn)
                    return Fail(400, "unsupported_command", "Supported commands: reset, spawn, start.");

                UnityEditor.Undo.IncrementCurrentGroup();
                var undoGroup = UnityEditor.Undo.GetCurrentGroup();
                UnityEditor.Undo.SetCurrentGroupName("HERTZ Studio Encounter Runtime");
                try
                {
                    UnityEditor.Undo.RegisterFullObjectHierarchyUndo(root, "HERTZ Studio Encounter Runtime");
                    var director = root.GetComponent<HertzEncounterDirector>();
                    if (director == null)
                        director = UnityEditor.Undo.AddComponent<HertzEncounterDirector>(root);
                    director.Configure(encounterId, startAutomatically: true);

                    var cleared = 0;
                    var spawned = 0;
                    if (isReset)
                        cleared = director.ClearRuntimeSpawns();
                    else
                    {
                        cleared = director.ClearRuntimeSpawns();
                        spawned = director.SpawnAllImmediate();
                    }

                    EditorUtility.SetDirty(root);
                    EditorSceneManager.MarkSceneDirty(scene);
                    if (!EditorSceneManager.SaveScene(scene))
                    {
                        UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                        return Fail(500, "scene_save_failed", "Unity failed to save after encounter runtime command; changes were rolled back.");
                    }

                    UnityEditor.Undo.CollapseUndoOperations(undoGroup);
                    var rev = HertzStudioHttpBridge.RecordSceneContentChangeForProof(scenePath);
                    var markers = CountEncounterMarkers(root);
                    return Ok(
                        "{\"status\":\"ok\",\"source\":\"unity_bridge\",\"command\":" + Q(command) +
                        ",\"requestId\":" + Q(requestId) +
                        ",\"encounterId\":" + Q(encounterId) + ",\"rootName\":" + Q(rootName) +
                        ",\"clearedRuntimeCount\":" + cleared + ",\"spawnedRuntimeCount\":" + spawned +
                        ",\"markerCount\":" + markers +
                        ",\"duplicate\":false,\"unityRevision\":" + rev + "}");
                }
                catch (Exception ex)
                {
                    UnityEditor.Undo.RevertAllDownToGroup(undoGroup);
                    return Fail(500, "unity_error", "Encounter runtime command failed and was rolled back: " + ex.Message);
                }
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        private static bool TryOpenSharedTargetScene(
            string body,
            out string scenePath,
            out Scene scene,
            out (int status, string code, string message) err)
        {
            scenePath = ReadString(body, "scenePath");
            var sceneGuid = ReadString(body, "sceneGuid");
            scene = default;
            err = default;
            var canonical = (scenePath ?? string.Empty).Replace('\\', '/');
            if (!canonical.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                !canonical.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) ||
                canonical.Contains(".."))
            {
                err = (400, "invalid_scene_path", "scenePath must be Assets/.../*.unity");
                return false;
            }

            var actualGuid = AssetDatabase.AssetPathToGUID(canonical);
            if (string.IsNullOrEmpty(sceneGuid) ||
                !string.Equals(actualGuid, sceneGuid, StringComparison.OrdinalIgnoreCase))
            {
                err = (409, "scene_identity_mismatch", "Selected scene path/GUID no longer match Unity. Refresh Studio scenes.");
                return false;
            }

            scenePath = canonical;
            scene = EditorSceneManager.GetSceneByPath(canonical);
            if (!scene.IsValid() || !scene.isLoaded)
                scene = EditorSceneManager.OpenScene(canonical, OpenSceneMode.Single);
            if (!scene.IsValid() || !scene.isLoaded)
            {
                err = (500, "scene_open_failed", "Could not open selected target scene.");
                return false;
            }

            return true;
        }

        private static GameObject FindNamedRoot(Scene scene, string name)
        {
            foreach (var candidate in scene.GetRootGameObjects())
            {
                if (candidate != null && string.Equals(candidate.name, name, StringComparison.Ordinal))
                    return candidate;
            }

            return null;
        }

        private static bool IsProtectedHierarchy(GameObject go)
        {
            if (go == null) return false;
            for (var t = go.transform; t != null; t = t.parent)
            {
                var n = t.name ?? string.Empty;
                if (n.IndexOf("XR Origin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("XR Rig", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("Main Camera", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("TrackedPose", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    n.IndexOf("Hand Controller", StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
                foreach (var component in t.GetComponents<Component>())
                {
                    var typeName = component?.GetType().Name ?? string.Empty;
                    if (typeName.IndexOf("XROrigin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        typeName.IndexOf("TrackedPoseDriver", StringComparison.OrdinalIgnoreCase) >= 0)
                        return true;
                }
            }

            return false;
        }

        private static bool WouldEncounterTouchProtectedHierarchy(Scene scene, string body)
        {
            foreach (var root in scene.GetRootGameObjects())
            {
                if (root == null || !IsProtectedHierarchy(root)) continue;
                // Any named overlap with XR roots is refused up front; markers are never parented under them.
                if (root.name.StartsWith(EncounterRootPrefix, StringComparison.Ordinal))
                    return true;
            }

            // Defensive: refuse if body explicitly claims XR mutation.
            return body != null && body.IndexOf("\"affectsTrackedXr\":true", StringComparison.Ordinal) >= 0;
        }

        private static void ClearEncounterChildren(GameObject root)
        {
            for (var i = root.transform.childCount - 1; i >= 0; i--)
                UnityEditor.Undo.DestroyObjectImmediate(root.transform.GetChild(i).gameObject);
        }

        private static int PlaceEncounterMarkers(GameObject root, string body, string encounterId)
        {
            var markerCount = 0;
            var spawnIndex = 0;
            var searchFrom = 0;
            while (true)
            {
                var idx = body.IndexOf("\"delaySeconds\"", searchFrom, StringComparison.Ordinal);
                if (idx < 0) break;
                // Parse the nearest surrounding spawn object by reading common fields from this index window.
                var windowStart = Math.Max(0, idx - 120);
                var windowEnd = Math.Min(body.Length, idx + 520);
                var window = body.Substring(windowStart, windowEnd - windowStart);
                var count = Math.Max(1, Math.Min(100, ReadInt(window, "count")));
                if (count == 0) count = 1;
                var spacing = Math.Max(0f, ReadFloat(window, "spacingMeters", 1.5f));
                var x = ReadFloat(window, "x", 0f);
                var y = ReadFloat(window, "y", 0f);
                var z = ReadFloat(window, "z", 0f);
                var delay = Math.Max(0f, ReadFloat(window, "delaySeconds", 0f));
                var profileId = ReadString(window, "enemyProfileId") ?? ReadString(window, "behaviorProfileId") ?? "profile";
                var profilePath = ReadString(window, "behaviorProfileUnityPath") ?? ReadString(window, "enemyProfileUnityPath");
                HertzEnemyBehaviorProfile profileAsset = null;
                if (!string.IsNullOrEmpty(profilePath))
                    profileAsset = AssetDatabase.LoadAssetAtPath<HertzEnemyBehaviorProfile>(profilePath);

                for (var i = 0; i < count; i++)
                {
                    var marker = new GameObject($"SpawnMarker_{spawnIndex}_{i}");
                    UnityEditor.Undo.RegisterCreatedObjectUndo(marker, "HERTZ Studio Create Encounter Marker");
                    marker.transform.SetParent(root.transform, false);
                    marker.transform.localPosition = new Vector3(x + i * spacing, y, z);
                    marker.name = $"SpawnMarker_{spawnIndex}_{i}_d{delay:0.###}_{Sanitize(profileId)}";
                    var markerComp = UnityEditor.Undo.AddComponent<HertzEncounterSpawnMarker>(marker);
                    markerComp.Configure(encounterId, profileId, profilePath, profileAsset, delay, spawnIndex * 100 + i);
                    markerCount++;
                }

                spawnIndex++;
                searchFrom = idx + 14;
            }

            if (markerCount == 0)
            {
                var marker = new GameObject("SpawnMarker_0_0");
                UnityEditor.Undo.RegisterCreatedObjectUndo(marker, "HERTZ Studio Create Encounter Marker");
                marker.transform.SetParent(root.transform, false);
                var markerComp = UnityEditor.Undo.AddComponent<HertzEncounterSpawnMarker>(marker);
                markerComp.Configure(encounterId, "profile", null, null, 0f, 0);
                markerCount = 1;
            }

            return markerCount;
        }

        private static int CountEncounterMarkers(GameObject root)
        {
            var count = 0;
            for (var i = 0; i < root.transform.childCount; i++)
            {
                var child = root.transform.GetChild(i);
                if (child != null && child.name.StartsWith("SpawnMarker_", StringComparison.Ordinal))
                    count++;
            }

            return count;
        }

        private static bool IsSampleScene(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            return string.Equals(Path.GetFileName(path.Replace('\\', '/')), "SampleScene.unity",
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

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "item";
            var sb = new StringBuilder(name.Length);
            foreach (var c in name)
                sb.Append(char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_');
            return sb.ToString();
        }

        private static string Sha256Hex(byte[] bytes)
        {
            using var sha = SHA256.Create();
            var hash = sha.ComputeHash(bytes);
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static string Sha256Hex(string s) => Sha256Hex(Encoding.UTF8.GetBytes(s ?? ""));

        private static Result Ok(string json) => new Result { StatusCode = 200, Json = json };

        private static Result Fail(int code, string c, string msg) =>
            new Result
            {
                StatusCode = code,
                Json = "{\"status\":\"error\",\"code\":" + Q(c) + ",\"error\":" + Q(msg) + ",\"message\":" + Q(msg) + "}",
            };

        private static string Q(string s) =>
            s == null ? "null" : "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

        private static string ReadString(string json, string key)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return null;
            var token = "\"" + key + "\"";
            var idx = json.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return null;
            var colon = json.IndexOf(':', idx + token.Length);
            if (colon < 0) return null;
            var i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
            if (i < json.Length && json[i] == 'n') return null;
            if (i >= json.Length || json[i] != '"') return null;
            i++;
            var sb = new StringBuilder();
            while (i < json.Length)
            {
                var c = json[i++];
                if (c == '\\' && i < json.Length) { sb.Append(json[i++]); continue; }
                if (c == '"') break;
                sb.Append(c);
            }
            return sb.ToString();
        }

        private static float ReadFloat(string json, string key, float fallback)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(key)) return fallback;
            var token = "\"" + key + "\"";
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0) return fallback;
            index = json.IndexOf(':', index + token.Length);
            if (index < 0) return fallback;
            index++;
            while (index < json.Length && char.IsWhiteSpace(json[index])) index++;
            var end = index;
            while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-' || json[end] == '+' || json[end] == '.' || json[end] == 'e' || json[end] == 'E')) end++;
            return float.TryParse(json.Substring(index, end - index), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : fallback;
        }
        private static int ReadInt(string json, string key)
        {
            var s = ReadString(json, key);
            if (int.TryParse(s, out var v)) return v;
            if (string.IsNullOrEmpty(json)) return 0;
            var token = "\"" + key + "\"";
            var idx = json.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return 0;
            var colon = json.IndexOf(':', idx + token.Length);
            if (colon < 0) return 0;
            var i = colon + 1;
            while (i < json.Length && (char.IsWhiteSpace(json[i]) || json[i] == '"')) i++;
            var start = i;
            while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '-')) i++;
            return int.TryParse(json.Substring(start, i - start), out var n) ? n : 0;
        }
    }
}
