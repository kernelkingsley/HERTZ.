using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Manual/Editor proof for place-in-scene safety (HertzStudioTest only).
    /// Invoked via menu; never mutates SampleScene.
    /// Interruption-safe: try/finally cleans only objects created by the current run.
    /// </summary>
    public static class HertzStudioPlaceSafetyProof
    {
        private const string TestScene = "Assets/Scenes/HertzStudioTest.unity";
        private const string AssetId = "44921c6c-07fc-47ae-9bd0-40fbb54d9a36";
        private const string ProofLogRelative = "Tools/HertzStudio/data/w03-place-safety-proof.json";
        private const float TransformTolerance = 0.001f;
        private static readonly Vector3 ProofPosition = new Vector3(1.25f, 0.5f, -2.75f);
        private static readonly Vector3 ProofRotation = new Vector3(10f, 37f, 5f);
        private static readonly Vector3 ProofScale = new Vector3(1.25f, 0.75f, 1.5f);

        [MenuItem("Tools/HERTZ Studio/Run Place Safety Proof (HertzStudioTest)")]
        public static void RunFromMenu()
        {
            var report = Run();
            var abs = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ProofLogRelative));
            Directory.CreateDirectory(Path.GetDirectoryName(abs) ?? ".");
            File.WriteAllText(abs, report, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            Debug.Log($"HERTZ place safety proof written to {ProofLogRelative}\n{report}");
        }

        public static string Run()
        {
            var runId = Guid.NewGuid().ToString("N").Substring(0, 8);
            var createdRoots = new List<GameObject>();
            var additiveScene = default(Scene);
            var hasAdditiveScene = false;
            var testSceneLoaded = false;
            string proofName = null;
            var sb = new StringBuilder();

            try
            {
                var scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                testSceneLoaded = true;
                var startingRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(TestScene);
                // Unique per invocation — never collide with a stale prior proof object.
                proofName = $"HertzW03TransformProof_{startingRevision}_{runId}";

                sb.AppendLine("{");
                sb.AppendLine($"\"ranAt\":{Quote(DateTime.UtcNow.ToString("o"))},");
                sb.AppendLine($"\"runId\":{Quote(runId)},");
                sb.AppendLine($"\"scene\":{Quote(TestScene)},");
                sb.AppendLine($"\"startingUnityRevision\":{startingRevision},");
                sb.AppendLine($"\"proofObjectName\":{Quote(proofName)},");

                // --- Revision is mandatory and must match the target scene ---
                var missingRevisionBody =
                    "{" +
                    $"\"requestId\":{Quote(Guid.NewGuid().ToString("D"))}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    "\"confirmSave\":true," +
                    "\"displayName\":\"RevisionRequiredProof\"" +
                    "}";
                var revisionRequired = InvokePlace(missingRevisionBody);
                sb.AppendLine("\"revisionRequired\":{" +
                              $"\"statusCode\":{revisionRequired.statusCode}," +
                              $"\"json\":{Quote(revisionRequired.json)}" +
                              "},");

                var staleRevisionBody =
                    "{" +
                    $"\"requestId\":{Quote(Guid.NewGuid().ToString("D"))}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    $"\"expectedUnityRevision\":{startingRevision + 1}," +
                    "\"confirmSave\":true," +
                    "\"displayName\":\"StaleRevisionProof\"" +
                    "}";
                var staleRevision = InvokePlace(staleRevisionBody);
                sb.AppendLine("\"staleRevision\":{" +
                              $"\"statusCode\":{staleRevision.statusCode}," +
                              $"\"json\":{Quote(staleRevision.json)}" +
                              "},");

                // --- Dirty refuse ---
                var probe = new GameObject($"HertzDirtyProbe_{runId}");
                Track(createdRoots, probe);
                EditorSceneManager.MarkSceneDirty(scene);
                var dirtyReq = Guid.NewGuid().ToString("D");
                var dirtyRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(TestScene);
                var dirtyBody =
                    "{" +
                    $"\"requestId\":{Quote(dirtyReq)}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    $"\"expectedUnityRevision\":{dirtyRevision}," +
                    "\"confirmSave\":true," +
                    "\"displayName\":\"PlaceProof\"" +
                    "}";
                var dirty = InvokePlace(dirtyBody);
                sb.AppendLine("\"dirtyRefuse\":{" +
                              $"\"statusCode\":{dirty.statusCode}," +
                              $"\"json\":{Quote(dirty.json)}" +
                              "},");
                DestroyTracked(createdRoots, probe);
                // Discard dirty without saving probe
                scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);

                // --- Idempotent transformed place ---
                var placementRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(TestScene);
                var req = Guid.NewGuid().ToString("D");
                var body =
                    "{" +
                    $"\"requestId\":{Quote(req)}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    $"\"expectedUnityRevision\":{placementRevision}," +
                    "\"confirmSave\":true," +
                    $"\"displayName\":{Quote(proofName)}," +
                    $"\"position\":{VectorJson(ProofPosition)}," +
                    $"\"rotation\":{VectorJson(ProofRotation)}," +
                    $"\"scale\":{VectorJson(ProofScale)}" +
                    "}";
                var first = InvokePlace(body);
                var placed = FindNamed(proofName);
                if (placed != null)
                {
                    Track(createdRoots, placed);
                }

                var placedFound = placed != null;
                var response = first.statusCode == 200
                    ? JsonUtility.FromJson<PlaceResponse>(first.json)
                    : null;
                var actualPosition = placedFound ? placed.transform.position : Vector3.zero;
                var actualRotation = placedFound ? placed.transform.rotation : Quaternion.identity;
                var actualScale = placedFound ? placed.transform.localScale : Vector3.zero;
                var actualGlobalId = placedFound
                    ? GlobalObjectId.GetGlobalObjectIdSlow(placed).ToString()
                    : string.Empty;
                var countBefore = CountNamed(proofName);
                var second = InvokePlace(body);
                var countAfter = CountNamed(proofName);
                sb.AppendLine("\"idempotent\":{" +
                              $"\"firstStatus\":{first.statusCode}," +
                              $"\"secondStatus\":{second.statusCode}," +
                              $"\"countBeforeSecond\":{countBefore}," +
                              $"\"countAfterSecond\":{countAfter}," +
                              $"\"firstJson\":{Quote(first.json)}," +
                              $"\"secondJson\":{Quote(second.json)}" +
                              "},");
                sb.AppendLine("\"transform\":{" +
                              $"\"expectedPosition\":{VectorJson(ProofPosition)}," +
                              $"\"actualPosition\":{VectorJson(actualPosition)}," +
                              $"\"expectedRotationEuler\":{VectorJson(ProofRotation)}," +
                              $"\"actualRotationEuler\":{VectorJson(actualRotation.eulerAngles)}," +
                              $"\"expectedScale\":{VectorJson(ProofScale)}," +
                              $"\"actualScale\":{VectorJson(actualScale)}," +
                              $"\"returnedGlobalObjectId\":{Quote(response?.globalObjectId)}," +
                              $"\"actualGlobalObjectId\":{Quote(actualGlobalId)}," +
                              $"\"unityRevision\":{(response != null ? response.unityRevision : -1)}" +
                              "},");

                // --- Conflict same requestId different payload ---
                var conflictBody =
                    "{" +
                    $"\"requestId\":{Quote(req)}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    $"\"expectedUnityRevision\":{placementRevision}," +
                    "\"confirmSave\":true," +
                    $"\"displayName\":{Quote(proofName)}," +
                    "\"position\":{\"x\":9,\"y\":0,\"z\":9}" +
                    "}";
                var conflict = InvokePlace(conflictBody);
                sb.AppendLine("\"payloadConflict\":{" +
                              $"\"statusCode\":{conflict.statusCode}," +
                              $"\"json\":{Quote(conflict.json)}" +
                              "},");

                // --- Source confinement ---
                var badReq = Guid.NewGuid().ToString("D");
                var currentRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(TestScene);
                var badBody =
                    "{" +
                    $"\"requestId\":{Quote(badReq)}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    $"\"expectedUnityRevision\":{currentRevision}," +
                    "\"confirmSave\":true," +
                    "\"prefabPath\":\"Assets/XR/XRGeneralSettingsPerBuildTarget.asset\"" +
                    "}";
                var confine = InvokePlace(badBody);
                sb.AppendLine("\"sourceConfine\":{" +
                              $"\"statusCode\":{confine.statusCode}," +
                              $"\"json\":{Quote(confine.json)}" +
                              "},");

                // --- Multi-scene dirty block (additive untitled dirty + target) ---
                EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                var extra = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
                additiveScene = extra;
                hasAdditiveScene = true;
                var extraProbe = new GameObject($"ExtraDirty_{runId}");
                Track(createdRoots, extraProbe);
                EditorSceneManager.MarkSceneDirty(extra);
                var multiReq = Guid.NewGuid().ToString("D");
                var multiRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(TestScene);
                var multiBody =
                    "{" +
                    $"\"requestId\":{Quote(multiReq)}," +
                    $"\"assetId\":{Quote(AssetId)}," +
                    $"\"scenePath\":{Quote(TestScene)}," +
                    $"\"expectedUnityRevision\":{multiRevision}," +
                    "\"confirmSave\":true," +
                    "\"displayName\":\"MultiBlock\"" +
                    "}";
                var multi = InvokePlace(multiBody);
                sb.AppendLine("\"multiSceneDirty\":{" +
                              $"\"statusCode\":{multi.statusCode}," +
                              $"\"json\":{Quote(multi.json)}" +
                              "},");
                DestroyTracked(createdRoots, extraProbe);
                EditorSceneManager.CloseScene(extra, true);
                hasAdditiveScene = false;
                scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);

                // --- Saved cleanup of every object matching this run's unique proof name ---
                var cleanupMatches = FindAllNamed(proofName);
                var cleanupFound = cleanupMatches.Count > 0;
                var cleanupGlobalId = cleanupFound
                    ? GlobalObjectId.GetGlobalObjectIdSlow(cleanupMatches[0]).ToString()
                    : string.Empty;
                var cleanupSaved = false;
                if (cleanupFound)
                {
                    for (var i = 0; i < cleanupMatches.Count; i++)
                    {
                        DestroyTracked(createdRoots, cleanupMatches[i]);
                    }

                    EditorSceneManager.MarkSceneDirty(scene);
                    cleanupSaved = EditorSceneManager.SaveScene(scene);
                }

                var cleanupRevision = cleanupSaved
                    ? HertzStudioHttpBridge.RecordSceneContentChangeForProof(TestScene)
                    : HertzStudioHttpBridge.GetSceneRevisionForProof(TestScene);
                var cleanupCount = CountNamed(proofName);
                var cleanupDirty = scene.isDirty;
                sb.AppendLine("\"cleanup\":{" +
                              $"\"objectFound\":{Bool(cleanupFound)}," +
                              $"\"globalObjectId\":{Quote(cleanupGlobalId)}," +
                              $"\"saved\":{Bool(cleanupSaved)}," +
                              $"\"countAfter\":{cleanupCount}," +
                              $"\"sceneDirty\":{Bool(cleanupDirty)}," +
                              $"\"unityRevision\":{cleanupRevision}" +
                              "},");

                var revisionRequiredOk = revisionRequired.statusCode == 400 &&
                                         revisionRequired.json.IndexOf("expectedUnityRevision is required", StringComparison.Ordinal) >= 0;
                var staleRevisionOk = staleRevision.statusCode == 409 &&
                                      staleRevision.json.IndexOf("revision mismatch", StringComparison.OrdinalIgnoreCase) >= 0;
                var dirtyOk = dirty.statusCode == 409 && dirty.json.IndexOf("unsaved_unity_changes", StringComparison.Ordinal) >= 0;
                var idemOk = first.statusCode == 200 && second.statusCode == 200 && countBefore == 1 && countAfter == 1;
                var transformOk = placedFound &&
                                  Vector3.Distance(actualPosition, ProofPosition) <= TransformTolerance &&
                                  Quaternion.Angle(actualRotation, Quaternion.Euler(ProofRotation)) <= TransformTolerance &&
                                  Vector3.Distance(actualScale, ProofScale) <= TransformTolerance;
                var globalIdOk = response != null &&
                                 !string.IsNullOrEmpty(response.globalObjectId) &&
                                 string.Equals(response.globalObjectId, actualGlobalId, StringComparison.Ordinal) &&
                                 string.Equals(cleanupGlobalId, actualGlobalId, StringComparison.Ordinal);
                var conflictOk = conflict.statusCode == 409;
                var confineOk = confine.statusCode == 400 || confine.statusCode == 404;
                var multiOk = multi.statusCode == 409;
                var cleanupOk = cleanupFound && cleanupSaved && cleanupCount == 0 && !cleanupDirty &&
                                response != null && cleanupRevision == response.unityRevision + 1;

                var passed = revisionRequiredOk && staleRevisionOk && dirtyOk && idemOk && transformOk && globalIdOk &&
                             conflictOk && confineOk && multiOk && cleanupOk;
                sb.AppendLine($"\"passed\":{Bool(passed)},");
                sb.AppendLine("\"checks\":{" +
                              $"\"revisionRequired\":{Bool(revisionRequiredOk)}," +
                              $"\"staleRevision\":{Bool(staleRevisionOk)}," +
                              $"\"dirtyRefuse\":{Bool(dirtyOk)}," +
                              $"\"idempotent\":{Bool(idemOk)}," +
                              $"\"transformPersisted\":{Bool(transformOk)}," +
                              $"\"globalObjectIdMatched\":{Bool(globalIdOk)}," +
                              $"\"payloadConflict\":{Bool(conflictOk)}," +
                              $"\"sourceConfine\":{Bool(confineOk)}," +
                              $"\"multiSceneDirty\":{Bool(multiOk)}," +
                              $"\"savedCleanup\":{Bool(cleanupOk)}" +
                              "}");
                sb.AppendLine("}");
                return sb.ToString();
            }
            catch (Exception ex)
            {
                sb.Clear();
                sb.AppendLine("{");
                sb.AppendLine($"\"ranAt\":{Quote(DateTime.UtcNow.ToString("o"))},");
                sb.AppendLine($"\"runId\":{Quote(runId)},");
                sb.AppendLine($"\"proofObjectName\":{Quote(proofName)},");
                sb.AppendLine($"\"passed\":false,");
                sb.AppendLine($"\"error\":{Quote(ex.Message)}");
                sb.AppendLine("}");
                return sb.ToString();
            }
            finally
            {
                // Only destroy objects tracked for this run — never unrelated scene content.
                for (var i = createdRoots.Count - 1; i >= 0; i--)
                {
                    var go = createdRoots[i];
                    if (go != null)
                    {
                        UnityEngine.Object.DestroyImmediate(go);
                    }
                }

                createdRoots.Clear();

                if (hasAdditiveScene && additiveScene.IsValid())
                {
                    try
                    {
                        EditorSceneManager.CloseScene(additiveScene, true);
                    }
                    catch
                    {
                        // Best-effort during interruption.
                    }

                    hasAdditiveScene = false;
                }

                if (testSceneLoaded)
                {
                    try
                    {
                        var scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                        // Exceptional path: remove every leftover with this run's unique proof name, then save.
                        if (!string.IsNullOrEmpty(proofName))
                        {
                            var leftovers = FindAllNamed(proofName);
                            if (leftovers.Count > 0)
                            {
                                for (var i = 0; i < leftovers.Count; i++)
                                {
                                    if (leftovers[i] != null)
                                    {
                                        UnityEngine.Object.DestroyImmediate(leftovers[i]);
                                    }
                                }

                                EditorSceneManager.MarkSceneDirty(scene);
                                EditorSceneManager.SaveScene(scene);
                            }
                        }

                        scene = EditorSceneManager.GetActiveScene();
                        if (scene.isDirty)
                        {
                            // Prefer discarding unexpected dirt from probes rather than saving unrelated edits.
                            EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
                        }
                    }
                    catch
                    {
                        // Best-effort restore of HertzStudioTest.
                    }
                }
            }
        }

        private static void Track(List<GameObject> created, GameObject go)
        {
            if (go != null && !created.Contains(go))
            {
                created.Add(go);
            }
        }

        private static void DestroyTracked(List<GameObject> created, GameObject go)
        {
            if (go == null)
            {
                return;
            }

            created.Remove(go);
            UnityEngine.Object.DestroyImmediate(go);
        }

        private static string Bool(bool v) => v ? "true" : "false";

        private static GameObject FindNamed(string name)
        {
            var all = FindAllNamed(name);
            return all.Count > 0 ? all[0] : null;
        }

        /// <summary>
        /// Every GameObject in the active scene whose name equals <paramref name="name"/>.
        /// Used so exceptional cleanup cannot leave a duplicate proof instance behind.
        /// </summary>
        private static List<GameObject> FindAllNamed(string name)
        {
            var found = new List<GameObject>();
            if (string.IsNullOrEmpty(name))
            {
                return found;
            }

            var scene = SceneManager.GetActiveScene();
            foreach (var root in scene.GetRootGameObjects())
            {
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                {
                    if (t.name == name)
                    {
                        found.Add(t.gameObject);
                    }
                }
            }

            return found;
        }

        private static int CountNamed(string name)
        {
            return FindAllNamed(name).Count;
        }

        private static (int statusCode, string json) InvokePlace(string body)
        {
            var json = HertzStudioHttpBridge.PlaceAssetInSceneForProof(body, out var statusCode);
            return (statusCode, json ?? "{}");
        }

        private static string VectorJson(Vector3 value)
        {
            return "{" +
                   $"\"x\":{value.x.ToString("R", CultureInfo.InvariantCulture)}," +
                   $"\"y\":{value.y.ToString("R", CultureInfo.InvariantCulture)}," +
                   $"\"z\":{value.z.ToString("R", CultureInfo.InvariantCulture)}" +
                   "}";
        }

        private static string Quote(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r") + "\"";
        }

        [Serializable]
        private sealed class PlaceResponse
        {
            public string globalObjectId;
            public int unityRevision;
        }
    }
}
