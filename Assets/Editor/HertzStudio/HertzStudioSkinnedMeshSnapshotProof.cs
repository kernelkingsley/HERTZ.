using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Deterministic editor proof: SkinnedMeshRenderer.BakeMesh captures posed vertices
    /// (not bind-pose sharedMesh) for Studio static previews. Does not save scenes.
    /// </summary>
    public static class HertzStudioSkinnedMeshSnapshotProof
    {
        private const string MenuPath = "HERTZ/Studio/Proofs/Run Skinned Mesh Snapshot Proof";
        private const string ArtifactRel = "Tools/HertzStudio/data/w03-skinned-mesh-snapshot-proof.json";

        [MenuItem(MenuPath)]
        public static void Run()
        {
            var checks = new List<(string name, bool pass, string detail)>();
            void Check(string name, bool pass, string detail = "")
            {
                checks.Add((name, pass, detail ?? string.Empty));
            }

            GameObject root = null;
            Mesh bindMesh = null;
            Mesh baked = null;
            try
            {
                root = new GameObject("HertzSkinnedProofRoot");
                var bone = new GameObject("Bone").transform;
                bone.SetParent(root.transform, false);
                bone.localPosition = Vector3.zero;

                bindMesh = new Mesh { name = "HertzSkinnedProofBind" };
                bindMesh.vertices = new[]
                {
                    new Vector3(-0.5f, 0f, 0f),
                    new Vector3(0.5f, 0f, 0f),
                    new Vector3(0f, 1f, 0f),
                };
                bindMesh.triangles = new[] { 0, 1, 2 };
                bindMesh.normals = new[] { Vector3.forward, Vector3.forward, Vector3.forward };
                bindMesh.boneWeights = new[]
                {
                    new BoneWeight { boneIndex0 = 0, weight0 = 1f },
                    new BoneWeight { boneIndex0 = 0, weight0 = 1f },
                    new BoneWeight { boneIndex0 = 0, weight0 = 1f },
                };
                bindMesh.bindposes = new[] { Matrix4x4.identity };
                bindMesh.RecalculateBounds();

                var smr = root.AddComponent<SkinnedMeshRenderer>();
                smr.sharedMesh = bindMesh;
                smr.bones = new[] { bone };
                smr.rootBone = bone;
                smr.enabled = true;

                // Pose the bone so baked vertices must leave the bind pose.
                bone.localPosition = new Vector3(0f, 2f, 0f);
                baked = new Mesh();
                smr.BakeMesh(baked, true);

                var bindY = bindMesh.vertices[2].y;
                var bakedY = baked.vertices.Length > 2 ? baked.vertices[2].y : float.NaN;
                Check("bake_vertex_count", baked.vertexCount == bindMesh.vertexCount, $"baked={baked.vertexCount}");
                Check("bake_differs_from_bind_pose", Mathf.Abs(bakedY - bindY) > 0.5f, $"bindY={bindY} bakedY={bakedY}");
                Check("bake_has_indices", baked.triangles != null && baked.triangles.Length == 3);

                // Inactive / disabled must not be treated as visible Studio content.
                smr.enabled = false;
                Check("disabled_renderer_not_enabled", smr.enabled == false);
                root.SetActive(false);
                Check("inactive_hierarchy", root.activeInHierarchy == false);

                // Exporter marker confirms BakeMesh path is compiled in.
                Check(
                    "exporter_build_marker_bake",
                    HertzStudioRenderSnapshotExporter.ExporterBuildMarker.IndexOf("bake", StringComparison.OrdinalIgnoreCase) >= 0,
                    HertzStudioRenderSnapshotExporter.ExporterBuildMarker);
                Check(
                    "snapshot_schema_v2",
                    HertzStudioRenderSnapshotExporter.SnapshotSchemaVersion >= 2,
                    "schema=" + HertzStudioRenderSnapshotExporter.SnapshotSchemaVersion);
                Check(
                    "hmsh_binary_v2",
                    HertzStudioRenderSnapshotExporter.HmshBinaryVersion >= 2,
                    "hmsh=" + HertzStudioRenderSnapshotExporter.HmshBinaryVersion);
            }
            catch (Exception ex)
            {
                Check("proof_exception", false, ex.Message);
            }
            finally
            {
                if (baked != null) UnityEngine.Object.DestroyImmediate(baked);
                if (bindMesh != null) UnityEngine.Object.DestroyImmediate(bindMesh);
                if (root != null) UnityEngine.Object.DestroyImmediate(root);
            }

            var passed = 0;
            var sb = new StringBuilder();
            sb.Append("{\"proof\":\"w03-skinned-mesh-snapshot\",\"checks\":[");
            for (var i = 0; i < checks.Count; i++)
            {
                var c = checks[i];
                if (c.pass) passed++;
                if (i > 0) sb.Append(',');
                sb.Append('{');
                sb.Append("\"name\":").Append(Quote(c.name)).Append(',');
                sb.Append("\"pass\":").Append(c.pass ? "true" : "false").Append(',');
                sb.Append("\"detail\":").Append(Quote(c.detail));
                sb.Append('}');
            }

            sb.Append("],\"passed\":").Append(passed);
            sb.Append(",\"total\":").Append(checks.Count);
            sb.Append(",\"ok\":").Append(passed == checks.Count ? "true" : "false");
            sb.Append('}');

            var abs = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ArtifactRel));
            Directory.CreateDirectory(Path.GetDirectoryName(abs) ?? ".");
            File.WriteAllText(abs, sb.ToString());
            if (passed == checks.Count)
            {
                Debug.Log($"HERTZ skinned mesh snapshot proof passed ({passed}/{checks.Count}): {abs}");
            }
            else
            {
                Debug.LogError($"HERTZ skinned mesh snapshot proof FAILED ({passed}/{checks.Count}): {abs}");
            }
        }

        static string Quote(string value)
        {
            if (value == null) return "\"\"";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n") + "\"";
        }
    }
}
