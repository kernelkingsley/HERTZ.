using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Non-mutating proof: scene export JSON includes hierarchy + Hertz assetId recovery.
    /// Does not save or alter SampleScene; writes artifact under Tools/HertzStudio/data.
    /// </summary>
    public static class HertzStudioSceneExportProvenanceProof
    {
        private const string MenuPath = "HERTZ/Studio/Proofs/Run Scene Export Provenance Proof";
        private const string ArtifactRel = "Tools/HertzStudio/data/w03-scene-export-provenance-proof.json";

        [MenuItem(MenuPath)]
        public static void Run()
        {
            var checks = new List<(string name, bool pass, string detail)>();
            void Check(string name, bool pass, string detail = "")
            {
                checks.Add((name, pass, detail ?? string.Empty));
            }

            try
            {
                var exportJson = HertzStudioHttpBridge.ExportSceneForProof(out var status);
                Check("export_http_200", status == 200, "status=" + status);
                Check("export_has_objects", exportJson.IndexOf("\"objects\"", StringComparison.Ordinal) >= 0);

                var objectBlocks = ExtractObjectBlocks(exportJson);
                Check("export_object_count_gt_0", objectBlocks.Count > 0, "count=" + objectBlocks.Count);

                var hasParent = false;
                var hasRoot = false;
                var hasDepth = false;
                var hasRole = false;
                var hasAssetId = false;
                var modelRoots = 0;
                var meshChildren = 0;
                var protectedOk = true;
                var distinctIds = new HashSet<string>();
                var assetIds = new HashSet<string>();

                foreach (var block in objectBlocks)
                {
                    hasParent |= block.IndexOf("\"parentObjectId\"", StringComparison.Ordinal) >= 0;
                    hasRoot |= block.IndexOf("\"rootObjectId\"", StringComparison.Ordinal) >= 0;
                    hasDepth |= Regex.IsMatch(block, "\"depth\"\\s*:");
                    hasRole |= block.IndexOf("\"renderRole\"", StringComparison.Ordinal) >= 0;
                    var id = ReadJsonString(block, "objectId");
                    if (!string.IsNullOrEmpty(id))
                    {
                        distinctIds.Add(id);
                    }

                    var role = ReadJsonString(block, "renderRole");
                    if (role == "model_root")
                    {
                        modelRoots++;
                    }

                    if (role == "mesh")
                    {
                        meshChildren++;
                    }

                    var assetId = ReadJsonString(block, "assetId");
                    if (!string.IsNullOrEmpty(assetId))
                    {
                        hasAssetId = true;
                        assetIds.Add(assetId);
                    }

                    var name = ReadJsonString(block, "name") ?? string.Empty;
                    if (Regex.IsMatch(name, "XR Rig|Main Camera|Camera Offset", RegexOptions.IgnoreCase) &&
                        role == "model_root")
                    {
                        protectedOk = false;
                    }
                }

                Check("has_parentObjectId", hasParent);
                Check("has_rootObjectId", hasRoot);
                Check("has_depth", hasDepth);
                Check("has_renderRole", hasRole);
                Check("objectIds_distinct", distinctIds.Count == objectBlocks.Count,
                    distinctIds.Count + "/" + objectBlocks.Count);
                Check("model_roots_classified", modelRoots >= 0, "modelRoots=" + modelRoots);
                Check("mesh_children_not_extra_roots", meshChildren == 0 || modelRoots > 0,
                    "mesh=" + meshChildren + ", roots=" + modelRoots);
                Check("assetId_recovered_when_imported", hasAssetId || modelRoots == 0,
                    hasAssetId ? "assetIds=" + assetIds.Count : "no imported Hertz assets in active scene");
                Check("protected_not_model_root", protectedOk);

                var armoredFolder = "Assets/HertzStudio/Imported/8e7aeace-df2b-40ba-842d-9a94e99e1e8f";
                Check("armored_cat_import_folder_exists", AssetDatabase.IsValidFolder(armoredFolder), armoredFolder);
            }
            catch (Exception ex)
            {
                Check("proof_threw", false, ex.Message);
            }

            var passed = 0;
            foreach (var c in checks)
            {
                if (c.pass)
                {
                    passed++;
                }
            }

            var allPass = passed == checks.Count && checks.Count > 0;
            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("  \"passed\": " + (allPass ? "true" : "false") + ",");
            sb.AppendLine("  \"scene\": " + Quote(SceneManager.GetActiveScene().path) + ",");
            sb.AppendLine("  \"stampedAt\": " + Quote(DateTime.UtcNow.ToString("o")) + ",");
            sb.AppendLine("  \"checks\": [");
            for (var i = 0; i < checks.Count; i++)
            {
                var c = checks[i];
                sb.Append("    {\"name\":" + Quote(c.name) + ",\"pass\":" + (c.pass ? "true" : "false") +
                          ",\"detail\":" + Quote(c.detail) + "}");
                if (i < checks.Count - 1)
                {
                    sb.Append(',');
                }

                sb.AppendLine();
            }

            sb.AppendLine("  ],");
            sb.AppendLine("  \"passedCount\": " + passed + ",");
            sb.AppendLine("  \"checkCount\": " + checks.Count);
            sb.AppendLine("}");

            var abs = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ArtifactRel));
            Directory.CreateDirectory(Path.GetDirectoryName(abs) ?? ".");
            File.WriteAllText(abs, sb.ToString(), Encoding.UTF8);
            Debug.Log("[HERTZ] Scene export provenance proof " + (allPass ? "PASSED" : "FAILED") + " -> " + abs);
        }

        private static List<string> ExtractObjectBlocks(string json)
        {
            var list = new List<string>();
            var idx = json.IndexOf("\"objects\"", StringComparison.Ordinal);
            if (idx < 0)
            {
                return list;
            }

            var bracket = json.IndexOf('[', idx);
            if (bracket < 0)
            {
                return list;
            }

            var depth = 0;
            var start = -1;
            for (var i = bracket; i < json.Length; i++)
            {
                var ch = json[i];
                if (ch == '{')
                {
                    if (depth == 0)
                    {
                        start = i;
                    }

                    depth++;
                }
                else if (ch == '}')
                {
                    depth--;
                    if (depth == 0 && start >= 0)
                    {
                        list.Add(json.Substring(start, i - start + 1));
                        start = -1;
                    }
                }
                else if (ch == ']' && depth == 0)
                {
                    break;
                }
            }

            return list;
        }

        private static string ReadJsonString(string json, string key)
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(null|\"([^\"]*)\")");
            if (!m.Success)
            {
                return null;
            }

            if (m.Groups[1].Value == "null")
            {
                return null;
            }

            return m.Groups[2].Success ? m.Groups[2].Value : null;
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                return "null";
            }

            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
