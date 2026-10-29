using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Unity.Collections;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Read-only Unity mesh snapshot writer for Hertz Studio viewport.
    /// Writes under Tools/HertzStudio/data/render-snapshots/ — never into scene asset folders.
    /// Uses a synchronous compact binary mesh format (no async glTFast on the main thread).
    /// Non-readable meshes use Mesh.AcquireReadOnlyMeshData (editor-safe CPU path).
    /// </summary>
    public static class HertzStudioRenderSnapshotExporter
    {
        public const int SnapshotSchemaVersion = 2;
        public const string ExporterBuildMarker = "hmsh-submesh-v3-bake";
        public const long MaxTotalBytes = 128L * 1024L * 1024L;
        public const int MaxMeshExports = 200;
        public const string MeshExtension = ".hmsh";
        public const uint HmshBinaryVersion = 2;

        public sealed class SnapshotResult
        {
            public bool Ok;
            public string Error;
            public string SnapshotId;
            public string ManifestRelativePath;
            public int MeshCount;
            public int SkippedOwnedByCatalog;
            public int FailedMeshes;
            public string CreatedAt;
            public string Json;
        }

        public static string ResolveSnapshotsRoot()
        {
            var projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            return Path.Combine(projectRoot, "Tools", "HertzStudio", "data", "render-snapshots");
        }

        public static string BuildSnapshotId(string scenePath, string contentFingerprint, string forceExportRequestId)
        {
            var raw = $"{scenePath}|{contentFingerprint}|schema{SnapshotSchemaVersion}|{forceExportRequestId ?? ""}";
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
                var sb = new StringBuilder(32);
                for (var i = 0; i < 16; i++) sb.Append(bytes[i].ToString("x2"));
                return sb.ToString();
            }
        }

        public static SnapshotResult ExportActiveScene(string contentFingerprint, string forceExportRequestId, int unityRevision)
        {
            var scene = SceneManager.GetActiveScene();
            var snapshotId = BuildSnapshotId(scene.path, contentFingerprint ?? "", forceExportRequestId);
            var root = ResolveSnapshotsRoot();
            var dir = Path.Combine(root, snapshotId);
            Directory.CreateDirectory(dir);

            var manifestPath = Path.Combine(dir, "manifest.json");
            if (File.Exists(manifestPath) && Directory.Exists(Path.Combine(dir, "meshes")))
            {
                var cached = File.ReadAllText(manifestPath);
                return new SnapshotResult
                {
                    Ok = true,
                    SnapshotId = snapshotId,
                    ManifestRelativePath = $"{snapshotId}/manifest.json",
                    MeshCount = CountMeshesInManifest(cached),
                    CreatedAt = File.GetCreationTimeUtc(manifestPath).ToString("o"),
                    Json = ManifestSummaryJson(snapshotId, scene.path, contentFingerprint, forceExportRequestId, unityRevision, cached),
                };
            }

            Directory.CreateDirectory(Path.Combine(dir, "meshes"));
            var meshEntries = new List<string>();
            var meshKeyToFile = new Dictionary<string, string>();
            var skippedCatalog = 0;
            var failed = 0;
            long totalBytes = 0;
            var exported = 0;

            foreach (var rootGo in scene.GetRootGameObjects())
            {
                CollectNativeMeshes(
                    rootGo.transform,
                    meshEntries,
                    meshKeyToFile,
                    dir,
                    ref skippedCatalog,
                    ref failed,
                    ref totalBytes,
                    ref exported);
                if (exported >= MaxMeshExports || totalBytes >= MaxTotalBytes) break;
            }

            CleanupSupersededSnapshots(root, scene.path, snapshotId);

            var createdAt = DateTime.UtcNow.ToString("o");
            var manifest = new StringBuilder(2048);
            manifest.Append('{');
            manifest.Append($"\"snapshotId\":{Quote(snapshotId)},");
            manifest.Append($"\"snapshotSchemaVersion\":{SnapshotSchemaVersion},");
            manifest.Append($"\"scenePath\":{Quote(scene.path)},");
            manifest.Append($"\"sceneName\":{Quote(scene.name)},");
            manifest.Append($"\"unityRevision\":{unityRevision},");
            manifest.Append($"\"contentFingerprint\":{Quote(contentFingerprint ?? "")},");
            manifest.Append($"\"forceExportRequestId\":{(forceExportRequestId == null ? "null" : Quote(forceExportRequestId))},");
            manifest.Append($"\"createdAt\":{Quote(createdAt)},");
            manifest.Append("\"coordinateSpace\":\"unity_local\",");
            manifest.Append("\"meshFormat\":\"hmsh2\",");
            manifest.Append($"\"meshCount\":{meshEntries.Count},");
            manifest.Append($"\"skippedOwnedByCatalog\":{skippedCatalog},");
            manifest.Append($"\"failedMeshes\":{failed},");
            manifest.Append($"\"meshes\":[{string.Join(",", meshEntries)}]");
            manifest.Append('}');
            File.WriteAllText(manifestPath, manifest.ToString());

            return new SnapshotResult
            {
                Ok = true,
                SnapshotId = snapshotId,
                ManifestRelativePath = $"{snapshotId}/manifest.json",
                MeshCount = meshEntries.Count,
                SkippedOwnedByCatalog = skippedCatalog,
                FailedMeshes = failed,
                CreatedAt = createdAt,
                Json = ManifestSummaryJson(snapshotId, scene.path, contentFingerprint, forceExportRequestId, unityRevision, manifest.ToString()),
            };
        }

        static void CollectNativeMeshes(
            Transform transform,
            List<string> meshEntries,
            Dictionary<string, string> meshKeyToFile,
            string snapshotDir,
            ref int skippedCatalog,
            ref int failed,
            ref long totalBytes,
            ref int exported)
        {
            if (exported >= MaxMeshExports || totalBytes >= MaxTotalBytes) return;

            var go = transform.gameObject;
            var objectId = GlobalObjectId.GetGlobalObjectIdSlow(go).ToString();
            var assetId = HertzStudioAssetProvenance.FindAssetIdInHierarchy(go);

            var skinned = go.GetComponent<SkinnedMeshRenderer>();
            var meshFilter = go.GetComponent<MeshFilter>();
            var meshRenderer = go.GetComponent<MeshRenderer>();
            Mesh mesh = null;
            Mesh bakedOwned = null;
            Renderer renderer = null;
            var skinnedFlag = false;

            if (skinned != null && skinned.sharedMesh != null)
            {
                // Match Unity visibility: inactive/disabled skinned renderers must not appear in Studio.
                if (!skinned.enabled || !go.activeInHierarchy)
                {
                    // Skip export for this renderer; still walk children.
                }
                else
                {
                    // Bake current pose (not bind-pose sharedMesh) into a temporary mesh in renderer local space.
                    bakedOwned = new Mesh();
                    skinned.BakeMesh(bakedOwned, true);
                    mesh = bakedOwned;
                    renderer = skinned;
                    skinnedFlag = true;
                }
            }
            else if (meshFilter != null && meshFilter.sharedMesh != null && meshRenderer != null)
            {
                if (meshRenderer.enabled && go.activeInHierarchy)
                {
                    mesh = meshFilter.sharedMesh;
                    renderer = meshRenderer;
                }
            }

            if (mesh != null && renderer != null)
            {
                if (!string.IsNullOrEmpty(assetId))
                {
                    skippedCatalog++;
                }
                else
                {
                    try
                    {
                        // Skinned poses are instance-specific; never share bind-pose cache keys across objects.
                        var meshKey = skinnedFlag
                            ? ShortHash(
                                $"{objectId}|skinned|{mesh.vertexCount}|{mesh.subMeshCount}|{mesh.bounds.center}|{mesh.bounds.size}")
                            : MeshContentKey(mesh);
                        if (!meshKeyToFile.TryGetValue(meshKey, out var fileName))
                        {
                            fileName = $"m_{meshKey}{MeshExtension}";
                            var abs = Path.Combine(snapshotDir, "meshes", fileName);
                            if (!WriteMeshBinary(mesh, renderer.sharedMaterials, abs))
                            {
                                failed++;
                                fileName = null;
                            }
                            else
                            {
                                var len = new FileInfo(abs).Length;
                                totalBytes += len;
                                meshKeyToFile[meshKey] = fileName;
                                exported++;
                            }
                        }

                        if (!string.IsNullOrEmpty(fileName))
                        {
                            var category = skinnedFlag ? "skinned_mesh" : "native_mesh";
                            var materialsJson = ExtractMaterialsJson(renderer.sharedMaterials);
                            var baseColor = ExtractBaseColor(renderer.sharedMaterials);
                            meshEntries.Add(
                                "{" +
                                $"\"objectId\":{Quote(objectId)}," +
                                $"\"category\":{Quote(category)}," +
                                $"\"meshKey\":{Quote(meshKey)}," +
                                $"\"file\":\"meshes/{fileName}\"," +
                                $"\"meshFormat\":\"hmsh2\"," +
                                $"\"rendererEnabled\":{(renderer.enabled ? "true" : "false")}," +
                                $"\"activeInHierarchy\":{(go.activeInHierarchy ? "true" : "false")}," +
                                $"\"vertexCount\":{mesh.vertexCount}," +
                                $"\"subMeshCount\":{mesh.subMeshCount}," +
                                $"\"baseColor\":{baseColor}," +
                                $"\"materials\":{materialsJson}" +
                                "}");
                        }
                    }
                    catch (Exception ex)
                    {
                        failed++;
                        Debug.LogWarning($"[HertzStudio] mesh snapshot failed for {go.name}: {ex.Message}");
                    }
                }
            }

            if (bakedOwned != null)
            {
                UnityEngine.Object.DestroyImmediate(bakedOwned);
                bakedOwned = null;
            }

            for (var i = 0; i < transform.childCount; i++)
            {
                CollectNativeMeshes(
                    transform.GetChild(i),
                    meshEntries,
                    meshKeyToFile,
                    snapshotDir,
                    ref skippedCatalog,
                    ref failed,
                    ref totalBytes,
                    ref exported);
                if (exported >= MaxMeshExports || totalBytes >= MaxTotalBytes) return;
            }
        }

        /// <summary>
        /// Compact little-endian mesh (hmsh2):
        /// magic 'HMSH' + u32 version=2 + u32 vertexCount + u32 indexCount + u32 flags
        /// + u32 subMeshCount + u32 materialCount
        /// + positions(float3*v) + normals(float3*v) + uv0(float2*v) + indices(u32*i)
        /// + submeshes[subMeshCount]: u32 indexStart, u32 indexCount, u32 materialIndex
        /// + materials[materialCount]: float r,g,b,a
        /// Legacy hmsh1 (version=1, no submesh/material tables) remains readable by the browser.
        /// </summary>
        static bool WriteMeshBinary(Mesh mesh, Material[] materials, string absolutePath)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath) ?? ".");
            if (!TryReadMeshArrays(
                    mesh,
                    out var positions,
                    out var normals,
                    out var uvs,
                    out var triangles,
                    out var subMeshes))
            {
                return false;
            }

            if (positions == null || positions.Length == 0 || triangles == null || triangles.Length == 0)
            {
                return false;
            }

            var vCount = positions.Length;
            var iCount = triangles.Length;
            var version = HmshBinaryVersion;
            uint flags = 0;
            if (normals != null && normals.Length == vCount) flags |= 1;
            if (uvs != null && uvs.Length == vCount) flags |= 2;

            var mats = materials ?? Array.Empty<Material>();
            var matCount = Math.Max(1, mats.Length);
            var colors = new Color[matCount];
            for (var m = 0; m < matCount; m++)
            {
                colors[m] = Color.white;
                if (m < mats.Length && mats[m] != null)
                {
                    if (mats[m].HasProperty("_BaseColor")) colors[m] = mats[m].GetColor("_BaseColor");
                    else if (mats[m].HasProperty("_Color")) colors[m] = mats[m].GetColor("_Color");
                }
            }

            if (subMeshes == null || subMeshes.Length == 0)
            {
                subMeshes = new[] { new SubMeshRange { IndexStart = 0, IndexCount = iCount, MaterialIndex = 0 } };
            }

            using (var fs = new FileStream(absolutePath, FileMode.Create, FileAccess.Write, FileShare.Read))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write((byte)'H');
                bw.Write((byte)'M');
                bw.Write((byte)'S');
                bw.Write((byte)'H');
                bw.Write(version);
                bw.Write((uint)vCount);
                bw.Write((uint)iCount);
                bw.Write(flags);
                bw.Write((uint)subMeshes.Length);
                bw.Write((uint)matCount);
                for (var i = 0; i < vCount; i++)
                {
                    var p = positions[i];
                    bw.Write(p.x);
                    bw.Write(p.y);
                    bw.Write(p.z);
                }

                if ((flags & 1) != 0)
                {
                    for (var i = 0; i < vCount; i++)
                    {
                        var n = normals[i];
                        bw.Write(n.x);
                        bw.Write(n.y);
                        bw.Write(n.z);
                    }
                }

                if ((flags & 2) != 0)
                {
                    for (var i = 0; i < vCount; i++)
                    {
                        var uv = uvs[i];
                        bw.Write(uv.x);
                        bw.Write(uv.y);
                    }
                }

                for (var i = 0; i < iCount; i++)
                {
                    bw.Write((uint)triangles[i]);
                }

                for (var s = 0; s < subMeshes.Length; s++)
                {
                    var sm = subMeshes[s];
                    bw.Write((uint)sm.IndexStart);
                    bw.Write((uint)sm.IndexCount);
                    var matIndex = sm.MaterialIndex;
                    if (matIndex < 0 || matIndex >= matCount) matIndex = Math.Min(s, matCount - 1);
                    bw.Write((uint)matIndex);
                }

                for (var m = 0; m < matCount; m++)
                {
                    var c = colors[m];
                    bw.Write(c.r);
                    bw.Write(c.g);
                    bw.Write(c.b);
                    bw.Write(c.a);
                }
            }

            try
            {
                var matPath = absolutePath + ".mat.json";
                File.WriteAllText(matPath, ExtractMaterialsJson(materials));
            }
            catch
            {
                // Non-fatal.
            }

            return true;
        }

        struct SubMeshRange
        {
            public int IndexStart;
            public int IndexCount;
            public int MaterialIndex;
        }

        static bool TryReadMeshArrays(
            Mesh mesh,
            out Vector3[] positions,
            out Vector3[] normals,
            out Vector2[] uvs,
            out int[] triangles,
            out SubMeshRange[] subMeshes)
        {
            positions = null;
            normals = null;
            uvs = null;
            triangles = null;
            subMeshes = null;

            if (mesh.isReadable)
            {
                try
                {
                    positions = mesh.vertices;
                    normals = mesh.normals;
                    uvs = mesh.uv;
                    var smCount = Math.Max(1, mesh.subMeshCount);
                    subMeshes = new SubMeshRange[smCount];
                    var total = 0;
                    for (var s = 0; s < smCount; s++)
                    {
                        var indices = mesh.GetIndices(s);
                        subMeshes[s] = new SubMeshRange
                        {
                            IndexStart = total,
                            IndexCount = indices?.Length ?? 0,
                            MaterialIndex = s,
                        };
                        total += indices?.Length ?? 0;
                    }

                    triangles = new int[total];
                    var write = 0;
                    for (var s = 0; s < smCount; s++)
                    {
                        var indices = mesh.GetIndices(s);
                        if (indices == null) continue;
                        for (var i = 0; i < indices.Length; i++)
                        {
                            triangles[write++] = indices[i];
                        }
                    }

                    if (positions != null && positions.Length > 0 && triangles != null && triangles.Length > 0)
                    {
                        return true;
                    }
                }
                catch
                {
                    // Fall through to AcquireReadOnlyMeshData.
                }
            }

            // Unity 6000 Mesh.MeshData getters require NativeArray (not List<>).
            try
            {
                var dataArray = Mesh.AcquireReadOnlyMeshData(mesh);
                try
                {
                    if (dataArray.Length < 1) return false;
                    var data = dataArray[0];
                    var vCount = data.vertexCount;
                    if (vCount <= 0) return false;

                    using (var pos = new NativeArray<Vector3>(vCount, Allocator.Temp))
                    {
                        data.GetVertices(pos);
                        positions = pos.ToArray();
                    }

                    if (data.HasVertexAttribute(VertexAttribute.Normal))
                    {
                        using (var n = new NativeArray<Vector3>(vCount, Allocator.Temp))
                        {
                            data.GetNormals(n);
                            normals = n.ToArray();
                        }
                    }

                    if (data.HasVertexAttribute(VertexAttribute.TexCoord0))
                    {
                        using (var uv = new NativeArray<Vector2>(vCount, Allocator.Temp))
                        {
                            data.GetUVs(0, uv);
                            uvs = uv.ToArray();
                        }
                    }

                    var smCount = Math.Max(1, data.subMeshCount);
                    subMeshes = new SubMeshRange[smCount];
                    var indexCount = 0;
                    for (var s = 0; s < data.subMeshCount; s++)
                    {
                        var count = data.GetSubMesh(s).indexCount;
                        subMeshes[s] = new SubMeshRange
                        {
                            IndexStart = indexCount,
                            IndexCount = count,
                            MaterialIndex = s,
                        };
                        indexCount += count;
                    }

                    triangles = new int[indexCount];
                    var write = 0;
                    var useU16 = data.indexFormat == IndexFormat.UInt16;
                    for (var s = 0; s < data.subMeshCount; s++)
                    {
                        var count = data.GetSubMesh(s).indexCount;
                        if (count <= 0) continue;
                        if (useU16)
                        {
                            using (var slice = new NativeArray<ushort>(count, Allocator.Temp))
                            {
                                data.GetIndices(slice, s);
                                for (var i = 0; i < count; i++)
                                {
                                    triangles[write++] = slice[i];
                                }
                            }
                        }
                        else
                        {
                            using (var slice = new NativeArray<int>(count, Allocator.Temp))
                            {
                                data.GetIndices(slice, s);
                                for (var i = 0; i < count; i++)
                                {
                                    triangles[write++] = slice[i];
                                }
                            }
                        }
                    }

                    if (write != indexCount)
                    {
                        Array.Resize(ref triangles, write);
                    }

                    return positions != null && positions.Length > 0 && triangles != null && triangles.Length > 0;
                }
                finally
                {
                    dataArray.Dispose();
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[HertzStudio] AcquireReadOnlyMeshData failed for '{mesh.name}': {ex.Message}");
                return false;
            }
        }

        static string ExtractBaseColor(Material[] materials)
        {
            Color c = Color.white;
            if (materials != null)
            {
                for (var i = 0; i < materials.Length; i++)
                {
                    var m = materials[i];
                    if (m == null) continue;
                    if (m.HasProperty("_BaseColor")) c = m.GetColor("_BaseColor");
                    else if (m.HasProperty("_Color")) c = m.GetColor("_Color");
                    break;
                }
            }

            return $"{{\"r\":{F(c.r)},\"g\":{F(c.g)},\"b\":{F(c.b)},\"a\":{F(c.a)}}}";
        }

        static string ExtractMaterialsJson(Material[] materials)
        {
            var mats = materials ?? Array.Empty<Material>();
            if (mats.Length == 0)
            {
                return "[{\"r\":1,\"g\":1,\"b\":1,\"a\":1}]";
            }

            var parts = new string[mats.Length];
            for (var i = 0; i < mats.Length; i++)
            {
                Color c = Color.white;
                var m = mats[i];
                if (m != null)
                {
                    if (m.HasProperty("_BaseColor")) c = m.GetColor("_BaseColor");
                    else if (m.HasProperty("_Color")) c = m.GetColor("_Color");
                }

                parts[i] = $"{{\"r\":{F(c.r)},\"g\":{F(c.g)},\"b\":{F(c.b)},\"a\":{F(c.a)}}}";
            }

            return "[" + string.Join(",", parts) + "]";
        }

        static string F(float v) => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);

        static string MeshContentKey(Mesh mesh)
        {
            var path = AssetDatabase.GetAssetPath(mesh);
            var vCount = mesh.vertexCount;
            var subCount = mesh.subMeshCount;
            var indexEstimate = 0;
            try
            {
                for (var s = 0; s < subCount; s++)
                {
                    indexEstimate += (int)mesh.GetIndexCount(s);
                }
            }
            catch
            {
                indexEstimate = vCount;
            }

            if (!string.IsNullOrEmpty(path))
            {
                var guid = AssetDatabase.AssetPathToGUID(path);
                if (!string.IsNullOrEmpty(guid))
                {
                    AssetDatabase.TryGetGUIDAndLocalFileIdentifier(mesh, out _, out long localId);
                    return ShortHash($"{guid}:{localId}:{vCount}:{indexEstimate}");
                }
            }

            return ShortHash($"{mesh.name}:{vCount}:{indexEstimate}:{subCount}:{mesh.GetInstanceID()}");
        }

        static string ShortHash(string raw)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
                var sb = new StringBuilder(16);
                for (var i = 0; i < 8; i++) sb.Append(bytes[i].ToString("x2"));
                return sb.ToString();
            }
        }

        static void CleanupSupersededSnapshots(string root, string scenePath, string keepId)
        {
            if (!Directory.Exists(root)) return;
            foreach (var dir in Directory.GetDirectories(root))
            {
                var id = Path.GetFileName(dir);
                if (string.Equals(id, keepId, StringComparison.OrdinalIgnoreCase)) continue;
                var manifest = Path.Combine(dir, "manifest.json");
                if (!File.Exists(manifest)) continue;
                try
                {
                    var text = File.ReadAllText(manifest);
                    if (text.IndexOf(scenePath, StringComparison.Ordinal) < 0) continue;
                    var age = DateTime.UtcNow - File.GetLastWriteTimeUtc(manifest);
                    if (age.TotalDays > 2) Directory.Delete(dir, true);
                }
                catch
                {
                    // Ignore cleanup failures.
                }
            }
        }

        static int CountMeshesInManifest(string json)
        {
            if (string.IsNullOrEmpty(json)) return 0;
            const string key = "\"meshCount\":";
            var idx = json.IndexOf(key, StringComparison.Ordinal);
            if (idx < 0) return 0;
            idx += key.Length;
            var end = idx;
            while (end < json.Length && char.IsDigit(json[end])) end++;
            return int.TryParse(json.Substring(idx, end - idx), out var n) ? n : 0;
        }

        static string ManifestSummaryJson(
            string snapshotId,
            string scenePath,
            string contentFingerprint,
            string forceExportRequestId,
            int unityRevision,
            string fullManifest)
        {
            var meshCount = CountMeshesInManifest(fullManifest);
            return "{" +
                   $"\"snapshotId\":{Quote(snapshotId)}," +
                   $"\"snapshotSchemaVersion\":{SnapshotSchemaVersion}," +
                   $"\"scenePath\":{Quote(scenePath)}," +
                   $"\"unityRevision\":{unityRevision}," +
                   $"\"contentFingerprint\":{Quote(contentFingerprint ?? "")}," +
                   $"\"forceExportRequestId\":{(forceExportRequestId == null ? "null" : Quote(forceExportRequestId))}," +
                   $"\"meshCount\":{meshCount}," +
                   $"\"meshFormat\":\"hmsh2\"," +
                   $"\"manifestUrl\":{Quote($"/api/render-snapshots/{snapshotId}/manifest.json")}" +
                   "}";
        }

        static string Quote(string value)
        {
            if (value == null) return "\"\"";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r") + "\"";
        }
    }
}
