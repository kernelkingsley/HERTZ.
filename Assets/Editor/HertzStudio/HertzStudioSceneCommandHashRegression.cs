using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace HertzStudio.Editor
{
    /// <summary>Non-mutating field-by-field regression for canonical scene-operation hashing.</summary>
    [InitializeOnLoad]
    internal static class HertzStudioSceneCommandHashRegression
    {
        private static readonly string ReportPath = Path.Combine(
            Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath,
            "Tools", "HertzStudio", "data", "w03-hash-proof.json");

        static HertzStudioSceneCommandHashRegression()
        {
            EditorApplication.delayCall += Run;
        }

        [MenuItem("Tools/HERTZ Studio/Run W03 Hash Proof")]
        private static void Run()
        {
            var checks = 0;
            var baseline = NewOperation();
            var baselineHash = Hash("request-a", "Assets/Scenes/HertzStudioTest.unity", 7, baseline);

            CheckDifferent(baselineHash, Hash("request-b", "Assets/Scenes/HertzStudioTest.unity", 7, baseline), ref checks);
            CheckDifferent(baselineHash, Hash("request-a", "Assets/Scenes/BasicScene.unity", 7, baseline), ref checks);
            CheckDifferent(baselineHash, Hash("request-a", "Assets/Scenes/HertzStudioTest.unity", 8, baseline), ref checks);
            CheckStringField(baselineHash, op => op.Op = "remove", ref checks);
            CheckStringField(baselineHash, op => op.ObjectId = "object-b", ref checks);
            CheckStringField(baselineHash, op => op.DraftObjectId = "draft-b", ref checks);
            CheckStringField(baselineHash, op => op.AssetId = "asset-b", ref checks);
            CheckStringField(baselineHash, op => op.DisplayName = "Display B", ref checks);
            CheckStringField(baselineHash, op => op.PrefabPath = "Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs", ref checks);
            CheckStringField(baselineHash, op => op.ImportedPath = "Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs", ref checks);
            CheckStringField(baselineHash, op => op.TargetObjectId = "target-b", ref checks);
            CheckStringField(baselineHash, op => op.MaterialSlot = 3, ref checks);
            CheckStringField(baselineHash, op => op.Position = new Vector3(9, 2, 3), ref checks);
            CheckStringField(baselineHash, op => op.Rotation = new Vector3(10, 99, 30), ref checks);
            CheckStringField(baselineHash, op => op.Scale = new Vector3(1, 2, 4), ref checks);
            CheckStringField(baselineHash, op => op.HasPosition = false, ref checks);
            CheckStringField(baselineHash, op => op.HasRotation = false, ref checks);
            CheckStringField(baselineHash, op => op.HasScale = false, ref checks);

            var second = NewOperation();
            second.ObjectId = "second";
            var forward = HertzStudioSceneCommands.HashOperations("request-a", "Assets/Scenes/HertzStudioTest.unity", 7,
                new List<HertzStudioSceneCommands.SceneOperation> { baseline, second });
            var reversed = HertzStudioSceneCommands.HashOperations("request-a", "Assets/Scenes/HertzStudioTest.unity", 7,
                new List<HertzStudioSceneCommands.SceneOperation> { second, baseline });
            CheckDifferent(forward, reversed, ref checks);

            var priorCulture = CultureInfo.CurrentCulture;
            try
            {
                CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
                var french = Hash("request-a", "Assets/Scenes/HertzStudioTest.unity", 7, baseline);
                CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
                var english = Hash("request-a", "Assets/Scenes/HertzStudioTest.unity", 7, baseline);
                if (!string.Equals(french, english, StringComparison.Ordinal)) throw new InvalidOperationException("Hash changed with culture.");
                checks++;
            }
            finally
            {
                CultureInfo.CurrentCulture = priorCulture;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(ReportPath) ?? string.Empty);
            File.WriteAllText(ReportPath,
                "{\n  \"ok\": true,\n  \"checks\": " + checks.ToString(CultureInfo.InvariantCulture) +
                ",\n  \"baselineHash\": \"" + baselineHash + "\"\n}\n");
            Debug.Log($"HERTZ W03 hash regression passed ({checks} checks): {ReportPath}");
        }

        private static void CheckStringField(string baselineHash, Action<HertzStudioSceneCommands.SceneOperation> mutate, ref int checks)
        {
            var changed = NewOperation();
            mutate(changed);
            CheckDifferent(baselineHash, Hash("request-a", "Assets/Scenes/HertzStudioTest.unity", 7, changed), ref checks);
        }

        private static void CheckDifferent(string left, string right, ref int checks)
        {
            if (string.Equals(left, right, StringComparison.Ordinal)) throw new InvalidOperationException("Canonical hash ignored a changed field or operation order.");
            checks++;
        }

        private static string Hash(string requestId, string scenePath, int revision, HertzStudioSceneCommands.SceneOperation operation) =>
            HertzStudioSceneCommands.HashOperations(requestId, scenePath, revision,
                new List<HertzStudioSceneCommands.SceneOperation> { operation });

        private static HertzStudioSceneCommands.SceneOperation NewOperation() => new HertzStudioSceneCommands.SceneOperation
        {
            Op = "instantiate_model",
            ObjectId = "object-a",
            DraftObjectId = "draft-a",
            AssetId = "asset-a",
            DisplayName = "Display A",
            PrefabPath = "Assets/Editor/HertzStudio/HertzStudioSceneCommands.cs",
            ImportedPath = "Assets/Editor/HertzStudio/HertzStudioSceneCommands.cs",
            TargetObjectId = "target-a",
            MaterialSlot = 2,
            Position = new Vector3(1, 2, 3),
            Rotation = new Vector3(10, 20, 30),
            Scale = new Vector3(1, 2, 3),
            HasPosition = true,
            HasRotation = true,
            HasScale = true,
        };
    }
}
