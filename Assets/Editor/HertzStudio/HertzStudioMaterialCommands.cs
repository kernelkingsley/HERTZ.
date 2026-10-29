using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// W08 Unity-authoritative material / Terrain / HDRI apply for dedicated Studio test scenes.
    /// </summary>
    internal static class HertzStudioMaterialCommands
    {
        private const string GeneratedMaterials = "Assets/HertzStudio/GeneratedMaterials";
        private const string GeneratedTerrainLayers = "Assets/HertzStudio/GeneratedTerrainLayers";
        private const string GeneratedLighting = "Assets/HertzStudio/GeneratedLighting";

        internal struct MaterialCommandResult
        {
            public int StatusCode;
            public string Json;
        }

        public static MaterialCommandResult ListTargets(string bodyJson)
        {
            try
            {
                var req = JsonUtility.FromJson<TargetListRequest>(bodyJson);
                if (req == null)
                    return Fail(400, "invalid_request", "scenePath and sceneGuid required.");
                if (!TryOpenTargetScene(req.scenePath, req.sceneGuid, out var scene, out var err))
                    return Fail(400, err.code, err.message);

                var seen = new HashSet<int>();
                var sb = new StringBuilder(4096);
                sb.Append("{\"status\":\"ok\",\"source\":\"unity_bridge\",\"unityRevision\":")
                    .Append(HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath)).Append(",\"targets\":[");
                var first = true;
                foreach (var root in scene.GetRootGameObjects())
                {
                    foreach (var component in root.GetComponentsInChildren<Component>(true))
                    {
                        var renderer = component as Renderer;
                        var terrain = component as Terrain;
                        if (renderer == null && terrain == null) continue;
                        var go = component.gameObject;
                        if (!seen.Add(go.GetInstanceID()) || IsProtectedHierarchy(go)) continue;
                        var globalId = GlobalObjectId.GetGlobalObjectIdSlow(go).ToString();
                        if (string.IsNullOrEmpty(globalId)) continue;
                        if (!first) sb.Append(',');
                        first = false;
                        sb.Append('{');
                        Append(sb, "objectId", globalId);
                        sb.Append(','); Append(sb, "name", go.name);
                        sb.Append(','); Append(sb, "hierarchyPath", HierarchyPath(go.transform));
                        sb.Append(','); Append(sb, "kind", terrain != null ? "terrain_layer" : "renderer_slot");
                        sb.Append(",\"materialSlotCount\":").Append(renderer?.sharedMaterials?.Length ?? terrain?.terrainData?.terrainLayers?.Length ?? 0);
                        sb.Append('}');
                    }
                }
                sb.Append("]}");
                return new MaterialCommandResult { StatusCode = 200, Json = sb.ToString() };
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }
        public static MaterialCommandResult Inspect(string bodyJson)
        {
            try
            {
                var req = JsonUtility.FromJson<InspectRequest>(bodyJson);
                if (req == null || string.IsNullOrEmpty(req.scenePath) || string.IsNullOrEmpty(req.targetObjectId))
                    return Fail(400, "invalid_request", "scenePath and targetObjectId required.");

                if (!TryOpenTargetScene(req.scenePath, req.sceneGuid, out var scene, out var err))
                    return Fail(400, err.code, err.message);

                var go = FindByObjectId(req.targetObjectId);
                if (go == null)
                    return Fail(404, "unknown_object", $"No object with id {req.targetObjectId}.");
                if (IsProtectedHierarchy(go))
                    return Fail(409, "xr_protected", "Materials cannot target tracked XR or camera hierarchies.");

                var terrain = go.GetComponent<Terrain>() ?? go.GetComponentInChildren<Terrain>(true);
                var isTerrain = terrain != null;
                var renderer = go.GetComponent<Renderer>() ?? go.GetComponentInChildren<Renderer>(true);
                var slotCount = renderer != null && renderer.sharedMaterials != null
                    ? renderer.sharedMaterials.Length
                    : (isTerrain ? (terrain.terrainData != null ? terrain.terrainData.terrainLayers.Length : 0) : 0);
                var slot = Mathf.Clamp(req.materialSlot, 0, Math.Max(0, slotCount - 1));

                string matPath = null;
                string matGuid = null;
                var shared = false;
                var depUsers = new List<string>();
                string depVersion = null;

                if (!isTerrain && renderer != null && slotCount > 0 && slot < slotCount)
                {
                    var mat = renderer.sharedMaterials[slot];
                    if (mat != null)
                    {
                        matPath = AssetDatabase.GetAssetPath(mat);
                        matGuid = string.IsNullOrEmpty(matPath) ? null : AssetDatabase.AssetPathToGUID(matPath);
                        shared = !string.IsNullOrEmpty(matPath) && CountMaterialUsers(mat) > 1;
                        depVersion = matGuid + ":" + (mat != null ? mat.GetInstanceID().ToString(CultureInfo.InvariantCulture) : "0");
                        if (shared)
                        {
                            foreach (var user in FindMaterialUsers(mat, 16))
                                depUsers.Add(user);
                        }
                    }
                }

                var revision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                var sb = new StringBuilder(512);
                sb.Append('{');
                sb.Append("\"status\":\"ok\",");
                sb.Append("\"source\":\"unity_bridge\",");
                Append(sb, "scenePath", req.scenePath);
                sb.Append(",\"unityRevision\":").Append(revision).Append(',');
                Append(sb, "targetObjectId", req.targetObjectId);
                sb.Append(",\"isActualTerrain\":").Append(isTerrain ? "true" : "false").Append(',');
                sb.Append("\"rendererPresent\":").Append(renderer != null ? "true" : "false").Append(',');
                sb.Append("\"materialSlotCount\":").Append(slotCount).Append(',');
                sb.Append("\"materialSlot\":").Append(slot).Append(',');
                sb.Append("\"sharedMaterial\":").Append(shared ? "true" : "false").Append(',');
                Append(sb, "dependencyVersion", depVersion);
                sb.Append(",\"dependencyUsers\":[");
                for (var i = 0; i < depUsers.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(Quote(depUsers[i]));
                }
                sb.Append("],");
                Append(sb, "currentMaterialPath", matPath);
                sb.Append(',');
                Append(sb, "currentMaterialGuid", matGuid);
                sb.Append('}');
                return new MaterialCommandResult { StatusCode = 200, Json = sb.ToString() };
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static MaterialCommandResult Apply(string bodyJson)
        {
            try
            {
                var req = JsonUtility.FromJson<ApplyRequest>(bodyJson);
                if (req == null || string.IsNullOrEmpty(req.scenePath) || string.IsNullOrEmpty(req.targetObjectId))
                    return Fail(400, "invalid_request", "scenePath and targetObjectId required.");

                if (!TryOpenTargetScene(req.scenePath, req.sceneGuid, out var scene, out var err))
                    return Fail(400, err.code, err.message);

                var currentRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                if (req.expectedUnityRevision != currentRevision)
                {
                    return Fail(409, "stale_revision",
                        $"Scene revision mismatch: expected {req.expectedUnityRevision}, have {currentRevision}.");
                }

                var go = FindByObjectId(req.targetObjectId);
                if (go == null)
                    return Fail(404, "unknown_object", $"No object with id {req.targetObjectId}.");
                if (IsProtectedHierarchy(go))
                    return Fail(409, "xr_protected", "Materials cannot target tracked XR or camera hierarchies.");

                var terrain = go.GetComponent<Terrain>() ?? go.GetComponentInChildren<Terrain>(true);
                var isTerrain = terrain != null;

                if (string.Equals(req.targetKind, "terrain_layer", StringComparison.OrdinalIgnoreCase) && !isTerrain)
                    return Fail(400, "not_terrain", "Target is not a Unity Terrain.");

                string materialPath = null;
                string materialGuid = null;
                string terrainLayerPath = null;
                string appliedKind = isTerrain ? "terrain_layer" : (req.targetKind ?? "renderer_slot");
                int slot = req.materialSlot;

                var undoOp = new UndoOp
                {
                    operationId = Guid.NewGuid().ToString("N"),
                    kind = appliedKind,
                    scenePath = req.scenePath,
                    targetObjectId = req.targetObjectId,
                    materialSlot = slot,
                };
                if (isTerrain && terrain.terrainData != null)
                {
                    var guids = new List<string>();
                    foreach (var layer in terrain.terrainData.terrainLayers ?? Array.Empty<TerrainLayer>())
                    {
                        if (layer == null) continue;
                        var p = AssetDatabase.GetAssetPath(layer);
                        if (!string.IsNullOrEmpty(p)) guids.Add(AssetDatabase.AssetPathToGUID(p));
                    }
                    undoOp.priorTerrainLayersJson = string.Join("|", guids);
                }
                else
                {
                    var renderer = go.GetComponent<Renderer>() ?? go.GetComponentInChildren<Renderer>(true);
                    if (renderer != null && renderer.sharedMaterials != null &&
                        slot >= 0 && slot < renderer.sharedMaterials.Length &&
                        renderer.sharedMaterials[slot] != null)
                    {
                        undoOp.priorMaterialPath = AssetDatabase.GetAssetPath(renderer.sharedMaterials[slot]);
                        if (!string.IsNullOrEmpty(undoOp.priorMaterialPath))
                            undoOp.priorMaterialGuid = AssetDatabase.AssetPathToGUID(undoOp.priorMaterialPath);
                    }
                }

                if (isTerrain)
                {
                    var layerResult = ApplyTerrainLayer(terrain, req, out terrainLayerPath, out materialPath, out materialGuid);
                    if (layerResult.HasValue) return layerResult.Value;
                }
                else
                {
                    var applyResult = ApplyRendererMaterial(go, req, out materialPath, out materialGuid, out slot);
                    if (applyResult.HasValue) return applyResult.Value;
                    undoOp.materialSlot = slot;
                }

                if (req.saveScene)
                {
                    EditorSceneManager.MarkSceneDirty(scene);
                    if (!EditorSceneManager.SaveScene(scene))
                    {
                        if (isTerrain) RestoreTerrainSnapshot(undoOp);
                        else RestoreRendererSnapshot(undoOp);
                        return Fail(500, "scene_save_failed", "Unity could not save the target scene; the material change was rolled back.");
                    }
                    HertzStudioHttpBridge.RecordSceneContentChangeForProof(req.scenePath);
                }
                RecordUndoOp(undoOp);

                var newRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                var sb = new StringBuilder(640);
                sb.Append('{');
                sb.Append("\"status\":\"ok\",");
                sb.Append("\"source\":\"unity_bridge\",");
                Append(sb, "scenePath", req.scenePath);
                sb.Append(",\"unityRevision\":").Append(newRevision).Append(',');
                Append(sb, "targetObjectId", req.targetObjectId);
                sb.Append(",\"isActualTerrain\":").Append(isTerrain ? "true" : "false").Append(',');
                Append(sb, "appliedKind", appliedKind);
                sb.Append(",\"materialSlot\":").Append(slot).Append(',');
                Append(sb, "operationId", undoOp.operationId);
                sb.Append(',');
                Append(sb, "materialPath", materialPath);
                sb.Append(',');
                Append(sb, "materialGuid", materialGuid);
                sb.Append(',');
                Append(sb, "terrainLayerPath", terrainLayerPath);
                sb.Append(",\"appliedValues\":{");
                sb.Append("\"tilingX\":").Append(F(req.tilingX)).Append(',');
                sb.Append("\"tilingY\":").Append(F(req.tilingY)).Append(',');
                sb.Append("\"smoothness\":").Append(F(req.smoothness)).Append(',');
                sb.Append("\"metallic\":").Append(F(req.metallic));
                sb.Append("}}");
                return new MaterialCommandResult { StatusCode = 200, Json = sb.ToString() };
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static MaterialCommandResult Undo(string bodyJson)
        {
            try
            {
                var req = string.IsNullOrEmpty(bodyJson) ? null : JsonUtility.FromJson<UndoRequest>(bodyJson);
                if (req == null || string.IsNullOrEmpty(req.operationId))
                    return Fail(400, "invalid_request", "operationId required for operation-scoped undo.");
                if (string.IsNullOrEmpty(req.scenePath))
                    return Fail(400, "invalid_request", "scenePath required.");

                if (!TryOpenTargetScene(req.scenePath, req.sceneGuid, out var scene, out var err))
                    return Fail(400, err.code, err.message);

                var currentRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                if (req.expectedUnityRevision != currentRevision)
                {
                    return Fail(409, "stale_revision",
                        $"Scene revision mismatch: expected {req.expectedUnityRevision}, have {currentRevision}.");
                }

                var journal = LoadUndoJournal();
                var op = journal.Find(o => o.operationId == req.operationId);
                if (op == null)
                    return Fail(404, "unknown_operation", "Studio operation not found in undo journal.");
                if (op.undone)
                {
                    // Idempotent: already undone.
                    return new MaterialCommandResult
                    {
                        StatusCode = 200,
                        Json = "{\"status\":\"ok\",\"source\":\"unity_bridge\",\"idempotent\":true,\"operationId\":" +
                               Quote(req.operationId) + ",\"unityRevision\":" + currentRevision + "}",
                    };
                }

                if (string.Equals(op.kind, "hdri", StringComparison.OrdinalIgnoreCase))
                {
                    RestoreHdriSnapshot(op);
                }
                else if (string.Equals(op.kind, "terrain_layer", StringComparison.OrdinalIgnoreCase))
                {
                    RestoreTerrainSnapshot(op);
                }
                else
                {
                    RestoreRendererSnapshot(op);
                }

                op.undone = true;
                SaveUndoJournal(journal);
                EditorSceneManager.MarkSceneDirty(scene);
                EditorSceneManager.SaveScene(scene);
                HertzStudioHttpBridge.RecordSceneContentChangeForProof(req.scenePath);
                var newRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                return new MaterialCommandResult
                {
                    StatusCode = 200,
                    Json = "{\"status\":\"ok\",\"source\":\"unity_bridge\",\"operationId\":" + Quote(req.operationId) +
                           ",\"unityRevision\":" + newRevision + "}",
                };
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        public static MaterialCommandResult ApplyHdri(string bodyJson)
        {
            try
            {
                var req = JsonUtility.FromJson<HdriRequest>(bodyJson);
                if (req == null || string.IsNullOrEmpty(req.scenePath))
                    return Fail(400, "invalid_request", "scenePath required.");
                if (!TryOpenTargetScene(req.scenePath, req.sceneGuid, out var scene, out var err))
                    return Fail(400, err.code, err.message);

                var currentRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                if (req.expectedUnityRevision != currentRevision)
                {
                    return Fail(409, "stale_revision",
                        $"Scene revision mismatch: expected {req.expectedUnityRevision}, have {currentRevision}.");
                }

                if (string.IsNullOrEmpty(req.unityHdriPath) || !req.unityHdriPath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
                    return Fail(400, "invalid_hdri", "unityHdriPath must be an Assets/ path.");

                EnsureFolder(GeneratedLighting);
                var tex = AssetDatabase.LoadAssetAtPath<Texture>(req.unityHdriPath);
                if (tex == null)
                    return Fail(404, "missing_hdri", "HDRI texture not found at path.");

                var priorSky = RenderSettings.skybox;
                var undoOp = new UndoOp
                {
                    operationId = Guid.NewGuid().ToString("N"),
                    kind = "hdri",
                    scenePath = req.scenePath,
                    priorSkyboxPath = priorSky != null ? AssetDatabase.GetAssetPath(priorSky) : null,
                    priorAmbientMode = RenderSettings.ambientMode.ToString(),
                    priorRealtimeGi = Lightmapping.realtimeGI,
                };

                // Configure as cubemap/latlong friendly when TextureImporter present.
                var importer = AssetImporter.GetAtPath(req.unityHdriPath) as TextureImporter;
                if (importer != null)
                {
                    importer.textureShape = TextureImporterShape.TextureCube;
                    importer.sRGBTexture = false;
                    importer.SaveAndReimport();
                    tex = AssetDatabase.LoadAssetAtPath<Texture>(req.unityHdriPath);
                }

                RenderSettings.ambientMode = AmbientMode.Skybox;
                var skyMatPath = $"{GeneratedLighting}/HertzStudio_HDRI_Sky_{undoOp.operationId.Substring(0, 8)}.mat";
                var sky = AssetDatabase.LoadAssetAtPath<Material>(skyMatPath);
                if (sky == null)
                {
                    var shader = Shader.Find("Skybox/Cubemap") ?? Shader.Find("Skybox/Panoramic");
                    sky = new Material(shader) { name = "HertzStudio_HDRI_Sky" };
                    AssetDatabase.CreateAsset(sky, skyMatPath);
                }
                if (sky.HasProperty("_Tex")) sky.SetTexture("_Tex", tex);
                else if (sky.HasProperty("_MainTex")) sky.SetTexture("_MainTex", tex);
                if (sky.HasProperty("_Exposure")) sky.SetFloat("_Exposure", req.intensity);
                if (sky.HasProperty("_Rotation")) sky.SetFloat("_Rotation", req.rotation);
                RenderSettings.skybox = sky;

                // Quest-friendly: do not enable expensive realtime GI unless explicitly requested.
                var giEnabled = false;
                if (req.enableRealtimeGi)
                {
                    Lightmapping.realtimeGI = true;
                    giEnabled = true;
                }
                else
                {
                    Lightmapping.realtimeGI = false;
                }

                if (req.saveScene)
                {
                    EditorSceneManager.MarkSceneDirty(scene);
                    if (!EditorSceneManager.SaveScene(scene))
                    {
                        RestoreHdriSnapshot(undoOp);
                        return Fail(500, "scene_save_failed", "Unity could not save the target scene; the HDRI change was rolled back.");
                    }
                    HertzStudioHttpBridge.RecordSceneContentChangeForProof(req.scenePath);
                }
                RecordUndoOp(undoOp);

                var newRevision = HertzStudioHttpBridge.GetSceneRevisionForProof(req.scenePath);
                var sb = new StringBuilder(320);
                sb.Append("{\"status\":\"ok\",\"source\":\"unity_bridge\",");
                Append(sb, "scenePath", req.scenePath);
                sb.Append(",\"unityRevision\":").Append(newRevision).Append(',');
                Append(sb, "operationId", undoOp.operationId);
                sb.Append(',');
                Append(sb, "unityHdriPath", req.unityHdriPath);
                sb.Append(",\"realtimeGiEnabled\":").Append(giEnabled ? "true" : "false").Append('}');
                return new MaterialCommandResult { StatusCode = 200, Json = sb.ToString() };
            }
            catch (Exception ex)
            {
                return Fail(500, "unity_error", ex.Message);
            }
        }

        private static MaterialCommandResult? ApplyRendererMaterial(
            GameObject go,
            ApplyRequest req,
            out string materialPath,
            out string materialGuid,
            out int slot)
        {
            materialPath = null;
            materialGuid = null;
            slot = req.materialSlot;
            var renderer = go.GetComponent<Renderer>() ?? go.GetComponentInChildren<Renderer>(true);
            if (renderer == null)
                return Fail(400, "no_renderer", "Target has no Renderer.");

            var mats = renderer.sharedMaterials;
            if (mats == null || mats.Length == 0)
                return Fail(400, "no_slots", "Renderer has no material slots.");
            if (slot < 0 || slot >= mats.Length)
                return Fail(400, "slot_oob", $"Material slot {slot} out of range (count {mats.Length}).");

            var existing = mats[slot];
            if (existing != null)
            {
                var existingPath = AssetDatabase.GetAssetPath(existing);
                var shared = !string.IsNullOrEmpty(existingPath) && CountMaterialUsers(existing) > 1;
                if (shared && !req.duplicateShared)
                {
                    if (!req.confirmSharedEdit)
                        return Fail(409, "shared_material_protected",
                            "Shared material edit requires confirmSharedEdit after inspecting dependencies.");
                    var depVersion = AssetDatabase.AssetPathToGUID(existingPath) + ":" + existing.GetInstanceID();
                    if (!string.IsNullOrEmpty(req.expectedDependencyVersion) &&
                        !string.Equals(req.expectedDependencyVersion, depVersion, StringComparison.Ordinal))
                    {
                        return Fail(409, "dependency_version_mismatch",
                            "Shared material dependency version changed; re-inspect before shared edit.");
                    }
                }
            }

            EnsureFolder(GeneratedMaterials);
            Material mat;
            if (!string.IsNullOrEmpty(req.unityMaterialPath) &&
                req.unityMaterialPath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
            {
                mat = AssetDatabase.LoadAssetAtPath<Material>(req.unityMaterialPath);
                if (mat == null)
                    return Fail(404, "missing_material", "Material not found.");
                if (req.duplicateShared || existing == null || CountMaterialUsers(existing) <= 1)
                {
                    // Use as-is or duplicate below.
                }
            }
            else
            {
                Texture2D albedo = null;
                if (!string.IsNullOrEmpty(req.unityTexturePath))
                {
                    ConfigureTextureImport(req.unityTexturePath, sRgb: true, normal: false);
                    albedo = AssetDatabase.LoadAssetAtPath<Texture2D>(req.unityTexturePath);
                }
                if (albedo == null)
                    return Fail(400, "missing_texture", "unityTexturePath or unityMaterialPath required.");

                var matFile =
                    $"{GeneratedMaterials}/{Sanitize(go.name)}_slot{slot}_{Path.GetFileNameWithoutExtension(req.unityTexturePath)}.mat";
                mat = AssetDatabase.LoadAssetAtPath<Material>(matFile);
                if (mat == null || req.duplicateShared)
                {
                    var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
                    mat = new Material(shader) { name = Path.GetFileNameWithoutExtension(matFile) };
                    if (req.duplicateShared && File.Exists(Path.GetFullPath(matFile)))
                        matFile = AssetDatabase.GenerateUniqueAssetPath(matFile);
                    AssetDatabase.CreateAsset(mat, matFile);
                }
                ApplyUrpLitParams(mat, albedo, req);
            }

            if (req.duplicateShared && existing != null && CountMaterialUsers(existing) > 1)
            {
                var dupPath =
                    $"{GeneratedMaterials}/{Sanitize(go.name)}_slot{slot}_dup_{Guid.NewGuid().ToString("N").Substring(0, 8)}.mat";
                mat = new Material(mat) { name = Path.GetFileNameWithoutExtension(dupPath) };
                AssetDatabase.CreateAsset(mat, dupPath);
            }

            UnityEditor.Undo.RecordObject(renderer, "HERTZ Studio Assign Material");
            var next = (Material[])mats.Clone();
            next[slot] = mat;
            renderer.sharedMaterials = next;
            EditorUtility.SetDirty(renderer);

            materialPath = AssetDatabase.GetAssetPath(mat);
            materialGuid = AssetDatabase.AssetPathToGUID(materialPath);
            return null;
        }

        private static MaterialCommandResult? ApplyTerrainLayer(
            Terrain terrain,
            ApplyRequest req,
            out string terrainLayerPath,
            out string materialPath,
            out string materialGuid)
        {
            terrainLayerPath = null;
            materialPath = null;
            materialGuid = null;
            if (terrain.terrainData == null)
                return Fail(400, "no_terrain_data", "Terrain has no TerrainData.");

            Texture2D albedo = null;
            if (!string.IsNullOrEmpty(req.unityTexturePath))
            {
                ConfigureTextureImport(req.unityTexturePath, sRgb: true, normal: false);
                albedo = AssetDatabase.LoadAssetAtPath<Texture2D>(req.unityTexturePath);
            }
            if (albedo == null)
                return Fail(400, "missing_texture", "TerrainLayer apply requires unityTexturePath.");

            EnsureFolder(GeneratedTerrainLayers);
            terrainLayerPath =
                $"{GeneratedTerrainLayers}/{Sanitize(terrain.name)}_{Path.GetFileNameWithoutExtension(req.unityTexturePath)}.terrainlayer";
            var layer = AssetDatabase.LoadAssetAtPath<TerrainLayer>(terrainLayerPath);
            if (layer == null)
            {
                layer = new TerrainLayer();
                AssetDatabase.CreateAsset(layer, terrainLayerPath);
            }
            UnityEditor.Undo.RecordObject(layer, "HERTZ Studio TerrainLayer");
            layer.diffuseTexture = albedo;
            layer.tileSize = new Vector2(Mathf.Max(0.01f, req.tilingX), Mathf.Max(0.01f, req.tilingY));
            layer.tileOffset = new Vector2(req.offsetX, req.offsetY);
            EditorUtility.SetDirty(layer);

            UnityEditor.Undo.RecordObject(terrain.terrainData, "HERTZ Studio Terrain Layers");
            var layers = terrain.terrainData.terrainLayers;
            var list = new List<TerrainLayer>(layers ?? Array.Empty<TerrainLayer>());
            var idx = Mathf.Clamp(req.materialSlot, 0, list.Count);
            if (idx < list.Count) list[idx] = layer;
            else list.Add(layer);
            terrain.terrainData.terrainLayers = list.ToArray();
            EditorUtility.SetDirty(terrain.terrainData);
            EditorUtility.SetDirty(terrain);

            materialPath = terrainLayerPath;
            materialGuid = AssetDatabase.AssetPathToGUID(terrainLayerPath);
            return null;
        }

        private static void ApplyUrpLitParams(Material mat, Texture2D albedo, ApplyRequest req)
        {
            if (mat.HasProperty("_BaseMap")) mat.SetTexture("_BaseMap", albedo);
            else if (mat.HasProperty("_MainTex")) mat.SetTexture("_MainTex", albedo);
            if (mat.HasProperty("_BaseColor") && ColorUtility.TryParseHtmlString(req.tint ?? "#FFFFFF", out var tint))
                mat.SetColor("_BaseColor", tint);
            if (mat.HasProperty("_Metallic")) mat.SetFloat("_Metallic", Mathf.Clamp01(req.metallic));
            // Provider roughness � 1 - smoothness when only smoothness is supplied.
            if (mat.HasProperty("_Smoothness")) mat.SetFloat("_Smoothness", Mathf.Clamp01(req.smoothness));
            if (mat.HasProperty("_BumpScale")) mat.SetFloat("_BumpScale", req.normalStrength);
            if (albedo != null)
            {
                mat.SetTextureScale(mat.HasProperty("_BaseMap") ? "_BaseMap" : "_MainTex",
                    new Vector2(req.tilingX, req.tilingY));
                mat.SetTextureOffset(mat.HasProperty("_BaseMap") ? "_BaseMap" : "_MainTex",
                    new Vector2(req.offsetX, req.offsetY));
            }
            EditorUtility.SetDirty(mat);
        }

        private static void ConfigureTextureImport(string assetPath, bool sRgb, bool normal)
        {
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null) return;
            var dirty = false;
            if (importer.sRGBTexture != sRgb) { importer.sRGBTexture = sRgb; dirty = true; }
            if (normal && importer.textureType != TextureImporterType.NormalMap)
            {
                importer.textureType = TextureImporterType.NormalMap;
                dirty = true;
            }
            if (dirty) importer.SaveAndReimport();
        }

        private static bool TryOpenTargetScene(string scenePath, string sceneGuid, out Scene scene, out (string code, string message) err)
        {
            scene = default;
            err = default;
            var canonical = (scenePath ?? string.Empty).Replace('\\', '/');
            if (!canonical.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                !canonical.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) || canonical.Contains(".."))
            {
                err = ("invalid_scene_path", "scenePath must be Assets/.../*.unity");
                return false;
            }
            var actualGuid = AssetDatabase.AssetPathToGUID(canonical);
            if (string.IsNullOrEmpty(sceneGuid) || !string.Equals(actualGuid, sceneGuid, StringComparison.OrdinalIgnoreCase))
            {
                err = ("scene_identity_mismatch", "Selected scene path/GUID no longer match Unity. Refresh Studio scenes.");
                return false;
            }
            scene = EditorSceneManager.GetSceneByPath(canonical);
            if (!scene.IsValid() || !scene.isLoaded)
                scene = EditorSceneManager.OpenScene(canonical, OpenSceneMode.Single);
            if (!scene.IsValid() || !scene.isLoaded)
            {
                err = ("scene_open_failed", "Could not open selected target scene.");
                return false;
            }
            return true;
        }

        private static bool IsProtectedHierarchy(GameObject go)
        {
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

        private static string HierarchyPath(Transform transform)
        {
            var names = new List<string>();
            for (var t = transform; t != null; t = t.parent) names.Add(t.name);
            names.Reverse();
            return string.Join("/", names);
        }
        private static GameObject FindByObjectId(string objectId)
        {
            if (GlobalObjectId.TryParse(objectId, out var globalId))
            {
                var obj = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalId) as GameObject;
                if (obj != null) return obj;
            }
            return GameObject.Find(objectId);
        }

        private static int CountMaterialUsers(Material mat)
        {
            var count = 0;
            foreach (var r in UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (r?.sharedMaterials == null) continue;
                foreach (var m in r.sharedMaterials)
                {
                    if (m == mat) count++;
                }
            }
            return count;
        }

        private static IEnumerable<string> FindMaterialUsers(Material mat, int max)
        {
            var n = 0;
            foreach (var r in UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (r?.sharedMaterials == null) continue;
                foreach (var m in r.sharedMaterials)
                {
                    if (m != mat) continue;
                    yield return r.gameObject.name;
                    n++;
                    if (n >= max) yield break;
                    break;
                }
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
                    AssetDatabase.CreateFolder(cur, parts[i]);
                cur = next;
            }
        }

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "object";
            var sb = new StringBuilder(name.Length);
            foreach (var c in name)
                sb.Append(char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_');
            return sb.ToString();
        }

        private static MaterialCommandResult Fail(int status, string code, string message)
        {
            return new MaterialCommandResult
            {
                StatusCode = status,
                Json = "{\"status\":\"error\",\"code\":" + Quote(code) + ",\"error\":" + Quote(message) +
                       ",\"message\":" + Quote(message) + "}",
            };
        }

        private static void Append(StringBuilder sb, string key, string value)
        {
            sb.Append(Quote(key)).Append(':').Append(value == null ? "null" : Quote(value));
        }

        private static string Quote(string s)
        {
            if (s == null) return "null";
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static string F(float v) => v.ToString("R", CultureInfo.InvariantCulture);

        [Serializable]
        private class TargetListRequest
        {
            public string scenePath;
            public string sceneGuid;
        }
        [Serializable]
        private class InspectRequest
        {
            public string scenePath;
            public string sceneGuid;
            public string targetObjectId;
            public int materialSlot;
        }

        [Serializable]
        private class ApplyRequest
        {
            public string scenePath;
            public string sceneGuid;
            public string targetObjectId;
            public string targetKind;
            public int materialSlot;
            public string assetId;
            public string unityTexturePath;
            public string unityMaterialPath;
            public int expectedUnityRevision;
            public float tilingX = 1;
            public float tilingY = 1;
            public float offsetX;
            public float offsetY;
            public float normalStrength = 1;
            public string tint = "#ffffff";
            public float metallic;
            public float smoothness = 0.5f;
            public bool duplicateShared = true;
            public bool confirmSharedEdit;
            public string expectedDependencyVersion;
            public string providerId;
            public bool saveScene = true;
        }

        [Serializable]
        private class UndoRequest
        {
            public string scenePath;
            public string sceneGuid;
            public string operationId;
            public int expectedUnityRevision;
        }

        [Serializable]
        private class UndoOp
        {
            public string operationId;
            public string kind;
            public string scenePath;
            public string targetObjectId;
            public int materialSlot;
            public string priorMaterialPath;
            public string priorMaterialGuid;
            public string priorTerrainLayersJson;
            public string priorSkyboxPath;
            public string priorAmbientMode;
            public bool priorRealtimeGi;
            public bool undone;
        }

        private const string UndoJournalPath = "Tools/HertzStudio/data/w08-material-undo-journal.json";

        private static List<UndoOp> LoadUndoJournal()
        {
            var path = Path.GetFullPath(UndoJournalPath);
            if (!File.Exists(path)) return new List<UndoOp>();
            try
            {
                var wrap = JsonUtility.FromJson<UndoJournalFile>(File.ReadAllText(path));
                return wrap?.operations != null ? new List<UndoOp>(wrap.operations) : new List<UndoOp>();
            }
            catch
            {
                return new List<UndoOp>();
            }
        }

        private static void SaveUndoJournal(List<UndoOp> ops)
        {
            while (ops.Count > 40) ops.RemoveAt(0);
            var path = Path.GetFullPath(UndoJournalPath);
            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? "Tools/HertzStudio/data");
            var wrap = new UndoJournalFile { operations = ops.ToArray() };
            File.WriteAllText(path, JsonUtility.ToJson(wrap, true), new UTF8Encoding(false));
        }

        private static string RecordUndoOp(UndoOp op)
        {
            if (op == null) return null;
            if (string.IsNullOrEmpty(op.operationId)) op.operationId = Guid.NewGuid().ToString("N");
            var journal = LoadUndoJournal();
            journal.Add(op);
            SaveUndoJournal(journal);
            return op.operationId;
        }

        private static void RestoreRendererSnapshot(UndoOp op)
        {
            var go = FindByObjectId(op.targetObjectId);
            if (go == null) throw new InvalidOperationException("Undo target missing.");
            var renderer = go.GetComponent<Renderer>() ?? go.GetComponentInChildren<Renderer>(true);
            if (renderer == null) throw new InvalidOperationException("Undo target has no Renderer.");
            var mats = renderer.sharedMaterials;
            if (mats == null || op.materialSlot < 0 || op.materialSlot >= mats.Length)
                throw new InvalidOperationException("Undo slot out of range.");
            Material prior = null;
            if (!string.IsNullOrEmpty(op.priorMaterialPath))
                prior = AssetDatabase.LoadAssetAtPath<Material>(op.priorMaterialPath);
            var next = (Material[])mats.Clone();
            next[op.materialSlot] = prior;
            renderer.sharedMaterials = next;
            EditorUtility.SetDirty(renderer);
        }

        private static void RestoreTerrainSnapshot(UndoOp op)
        {
            var go = FindByObjectId(op.targetObjectId);
            var terrain = go != null ? go.GetComponent<Terrain>() ?? go.GetComponentInChildren<Terrain>(true) : null;
            if (terrain == null || terrain.terrainData == null)
                throw new InvalidOperationException("Undo Terrain missing.");
            // priorTerrainLayersJson stores GUID list joined by |
            var guids = string.IsNullOrEmpty(op.priorTerrainLayersJson)
                ? Array.Empty<string>()
                : op.priorTerrainLayersJson.Split(new[] { '|' }, StringSplitOptions.RemoveEmptyEntries);
            var layers = new List<TerrainLayer>();
            foreach (var g in guids)
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                var layer = AssetDatabase.LoadAssetAtPath<TerrainLayer>(p);
                if (layer != null) layers.Add(layer);
            }
            terrain.terrainData.terrainLayers = layers.ToArray();
            EditorUtility.SetDirty(terrain.terrainData);
            EditorUtility.SetDirty(terrain);
        }

        private static void RestoreHdriSnapshot(UndoOp op)
        {
            if (!string.IsNullOrEmpty(op.priorSkyboxPath))
                RenderSettings.skybox = AssetDatabase.LoadAssetAtPath<Material>(op.priorSkyboxPath);
            else
                RenderSettings.skybox = null;
            if (Enum.TryParse(op.priorAmbientMode, out AmbientMode mode))
                RenderSettings.ambientMode = mode;
            Lightmapping.realtimeGI = op.priorRealtimeGi;
        }

        [Serializable]
        private class UndoJournalFile
        {
            public UndoOp[] operations;
        }

        [Serializable]
        private class HdriRequest
        {
            public string scenePath;
            public string sceneGuid;
            public int expectedUnityRevision;
            public string unityHdriPath;
            public string assetId;
            public string providerId;
            public float intensity = 1;
            public float rotation;
            public bool enableRealtimeGi;
            public bool saveScene = true;
        }
    }
}
