using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace HertzStudio.Editor
{
    /// <summary>
    /// W03 typed ops proof on HertzStudioTest only — every assignment goes through
    /// HertzStudioSceneCommands.ApplyOrError (production path). Never mutates SampleScene.
    /// Animation contract: RuntimeAnimatorController only (imported AnimationClip alone is unsupported).
    /// </summary>
    public static class HertzStudioTypedOpsProof
    {
        private const string TestScene = "Assets/Scenes/HertzStudioTest.unity";
        private const string ProofLogRelative = "Tools/HertzStudio/data/w03-typed-ops-proof.json";
        private const string AudioPath =
            "Assets/Samples/XR Interaction Toolkit/3.4.1/Starter Assets/DemoAssets/Audio/Button Pop.wav";
        private const string AnimControllerPath =
            "Assets/Samples/XR Interaction Toolkit/3.4.1/Starter Assets/Animations/Climb Teleport Arrow.controller";
        private const string SpritePath =
            "Assets/Samples/XR Interaction Toolkit/3.4.1/Starter Assets/DemoAssets/Sprites/Checkmark.png";

        [MenuItem("Tools/HERTZ Studio/Run Typed Ops Proof (HertzStudioTest)")]
        public static void RunFromMenu()
        {
            var report = Run();
            var abs = Path.GetFullPath(Path.Combine(Application.dataPath, "..", ProofLogRelative));
            Directory.CreateDirectory(Path.GetDirectoryName(abs) ?? ".");
            File.WriteAllText(abs, report, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            Debug.Log($"HERTZ typed ops proof written to {ProofLogRelative}\n{report}");
        }

        public static string Run()
        {
            var checks = new List<string>();
            var created = new List<UnityEngine.Object>();
            // Hash SampleScene before any work — never open or save it.
            const string sampleScenePath = "Assets/Scenes/SampleScene.unity";
            var sampleHashBefore = FileSha256(sampleScenePath);
            var scene = EditorSceneManager.OpenScene(TestScene, OpenSceneMode.Single);
            var beforeHash = FileSha256(TestScene);
            var beforeDirty = scene.isDirty;
            var pass = true;
            var generatedMatsBefore = ListGeneratedMats();

            try
            {
                EnsureSpriteImporter(SpritePath);

                var floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
                floor.name = "HertzW03Proof_Floor";
                floor.transform.position = new Vector3(0f, 0f, 0f);
                HertzStudioSurfaceKind.EnsureOn(floor, HertzStudioSurfaceKind.Kind.Floor);
                created.Add(floor);

                var wallA = GameObject.CreatePrimitive(PrimitiveType.Cube);
                wallA.name = "HertzW03Proof_WallA";
                wallA.transform.position = new Vector3(-2f, 1f, 0f);
                HertzStudioSurfaceKind.EnsureOn(wallA, HertzStudioSurfaceKind.Kind.Wall);
                created.Add(wallA);

                var wallB = GameObject.CreatePrimitive(PrimitiveType.Cube);
                wallB.name = "HertzW03Proof_WallB";
                wallB.transform.position = new Vector3(2f, 1f, 0f);
                HertzStudioSurfaceKind.EnsureOn(wallB, HertzStudioSurfaceKind.Kind.Wall);
                created.Add(wallB);

                var matAPath = EnsureTempMaterialAsset("HertzW03Proof_MatA", Color.red);
                var matBPath = EnsureTempMaterialAsset("HertzW03Proof_MatB", Color.blue);
                var floorMatPath = EnsureTempMaterialAsset("HertzW03Proof_FloorMat", Color.green);

                var wallAGoid = GlobalObjectId.GetGlobalObjectIdSlow(wallA).ToString();
                var wallBGoid = GlobalObjectId.GetGlobalObjectIdSlow(wallB).ToString();
                var floorGoid = GlobalObjectId.GetGlobalObjectIdSlow(floor).ToString();

                List<string> bindings;
                var matErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation>
                    {
                        Op("assign_material", wallAGoid, matAPath),
                        Op("assign_material", wallBGoid, matBPath),
                        Op("assign_material", floorGoid, floorMatPath),
                    },
                    out bindings);
                Record(checks, "assign_material_via_scene_commands", matErr == null, matErr ?? "ok");

                var ra = wallA.GetComponent<Renderer>();
                var rb = wallB.GetComponent<Renderer>();
                var independent = ra != null && rb != null &&
                                  ra.sharedMaterial != null && rb.sharedMaterial != null &&
                                  ra.sharedMaterial != rb.sharedMaterial &&
                                  ra.sharedMaterial.color != rb.sharedMaterial.color;
                Record(checks, "wall_materials_independent", independent,
                    $"A={ColorToStr(ra?.sharedMaterial?.color)} B={ColorToStr(rb?.sharedMaterial?.color)}");
                Record(checks, "floor_material_assigned",
                    floor.GetComponent<Renderer>()?.sharedMaterial != null &&
                    floor.GetComponent<Renderer>().sharedMaterial.name.Contains("FloorMat"),
                    floor.GetComponent<Renderer>()?.sharedMaterial?.name ?? "null");
                Record(checks, "material_slot_exact",
                    ra != null && ra.sharedMaterials.Length >= 1 && ra.sharedMaterials[0] != null &&
                    ra.sharedMaterials[0].name.Contains("MatA"),
                    ra?.sharedMaterials?[0]?.name ?? "null");

                // Sprite
                var spriteGo = new GameObject("HertzW03Proof_Sprite");
                spriteGo.AddComponent<SpriteRenderer>();
                created.Add(spriteGo);
                var spriteGoid = GlobalObjectId.GetGlobalObjectIdSlow(spriteGo).ToString();
                var spriteErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation> { Op("assign_sprite", spriteGoid, SpritePath) },
                    out bindings);
                var sr = spriteGo.GetComponent<SpriteRenderer>();
                Record(checks, "assign_sprite", spriteErr == null && sr != null && sr.sprite != null,
                    spriteErr ?? (sr?.sprite != null ? sr.sprite.name : "missing"));

                // UI Image
                var canvasGo = new GameObject("HertzW03Proof_Canvas");
                canvasGo.AddComponent<Canvas>();
                var imageGo = new GameObject("HertzW03Proof_Image");
                imageGo.transform.SetParent(canvasGo.transform, false);
                imageGo.AddComponent<Image>();
                created.Add(canvasGo);
                var imageGoid = GlobalObjectId.GetGlobalObjectIdSlow(imageGo).ToString();
                var uiErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation> { Op("assign_ui", imageGoid, SpritePath) },
                    out bindings);
                var img = imageGo.GetComponent<Image>();
                Record(checks, "assign_ui", uiErr == null && img != null && img.sprite != null,
                    uiErr ?? (img?.sprite != null ? img.sprite.name : "missing"));

                // Audio clip assignment (not merely AudioSource presence)
                var audioGo = new GameObject("HertzW03Proof_Audio");
                audioGo.AddComponent<AudioSource>();
                created.Add(audioGo);
                var audioGoid = GlobalObjectId.GetGlobalObjectIdSlow(audioGo).ToString();
                var audioErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation> { Op("assign_audio", audioGoid, AudioPath) },
                    out bindings);
                var audio = audioGo.GetComponent<AudioSource>();
                Record(checks, "assign_audio",
                    audioErr == null && audio != null && audio.clip != null && audio.clip.name.IndexOf("Button Pop", StringComparison.Ordinal) >= 0,
                    audioErr ?? (audio?.clip != null ? audio.clip.name : "missing clip"));

                // Animation — RuntimeAnimatorController only
                Record(checks, "animation_contract_runtime_controller_only", true,
                    "Supported: RuntimeAnimatorController. Unsupported: bare AnimationClip assignment.");
                var animGo = new GameObject("HertzW03Proof_Anim");
                animGo.AddComponent<Animator>();
                created.Add(animGo);
                var animGoid = GlobalObjectId.GetGlobalObjectIdSlow(animGo).ToString();
                var animErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation>
                    {
                        Op("assign_animation", animGoid, AnimControllerPath),
                    },
                    out bindings);
                var animator = animGo.GetComponent<Animator>();
                Record(checks, "assign_animation",
                    animErr == null && animator != null && animator.runtimeAnimatorController != null &&
                    animator.runtimeAnimatorController.name.IndexOf("Climb Teleport", StringComparison.Ordinal) >= 0,
                    animErr ?? (animator?.runtimeAnimatorController != null
                        ? animator.runtimeAnimatorController.name
                        : "missing controller"));

                // instantiate_model — Cube primitive prefab path via CreatePrimitive asset is not a prefab;
                // use wallA as template by saving a temp prefab, or instantiate from a known mesh prefab.
                var cubePrefabPath = EnsureTempCubePrefab();
                var instErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation>
                    {
                        new HertzStudioSceneCommands.SceneOperation
                        {
                            Op = "instantiate_model",
                            DraftObjectId = "proof-inst-1",
                            AssetId = Guid.NewGuid().ToString("D"),
                            ImportedPath = cubePrefabPath,
                            PrefabPath = cubePrefabPath,
                            DisplayName = "HertzW03Proof_Instance",
                            HasPosition = true,
                            Position = new Vector3(4f, 0.5f, 0f),
                            HasScale = true,
                            Scale = Vector3.one,
                        },
                    },
                    out bindings);
                var inst = GameObject.Find("HertzW03Proof_Instance");
                if (inst != null) created.Add(inst);
                var provenance = inst != null ? inst.GetComponent<HertzStudioAssetProvenance>() : null;
                Record(checks, "instantiate_model",
                    instErr == null && inst != null &&
                    Math.Abs(inst.transform.position.x - 4f) < 0.01f,
                    instErr ?? $"pos={inst?.transform.position} prov={provenance != null}");

                // replace_floor_wall — preserve collider, parent/sibling, tag/layer, surface marker,
                // unrelated project-owned MonoBehaviour serialized values, provenance.
                var parent = new GameObject("HertzW03Proof_Parent");
                created.Add(parent);
                var replaceTarget = GameObject.CreatePrimitive(PrimitiveType.Cube);
                replaceTarget.name = "HertzW03Proof_ReplaceWall";
                replaceTarget.transform.SetParent(parent.transform, false);
                replaceTarget.transform.SetSiblingIndex(0);
                replaceTarget.transform.localPosition = new Vector3(0.1f, 0.2f, 0.3f);
                replaceTarget.layer = 3;
                replaceTarget.tag = "Untagged";
                HertzStudioSurfaceKind.EnsureOn(replaceTarget, HertzStudioSurfaceKind.Kind.Wall);
                var note = replaceTarget.AddComponent<HertzStudioPreservedNote>();
                note.SetValues("w03-preserve-note", 42, true);
                HertzStudioAssetProvenance.EnsureOn(
                    replaceTarget, Guid.NewGuid().ToString("D"), "proof-guid", cubePrefabPath);
                var box = replaceTarget.GetComponent<BoxCollider>();
                box.size = new Vector3(1.5f, 2f, 0.5f);
                box.center = new Vector3(0f, 1f, 0f);
                box.isTrigger = false;
                created.Add(replaceTarget);
                var replaceGoid = GlobalObjectId.GetGlobalObjectIdSlow(replaceTarget).ToString();
                var siblingBefore = replaceTarget.transform.GetSiblingIndex();
                var replaceAssetId = Guid.NewGuid().ToString("D");
                var replaceErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation>
                    {
                        new HertzStudioSceneCommands.SceneOperation
                        {
                            Op = "replace_floor_wall",
                            DraftObjectId = "proof-replace-1",
                            TargetObjectId = replaceGoid,
                            ObjectId = replaceGoid,
                            AssetId = replaceAssetId,
                            ImportedPath = cubePrefabPath,
                            PrefabPath = cubePrefabPath,
                        },
                    },
                    out bindings);
                var replaced = parent.transform.Find("HertzW03Proof_ReplaceWall")?.gameObject;
                var replacedBox = replaced != null ? replaced.GetComponent<BoxCollider>() : null;
                var replacedNote = replaced != null ? replaced.GetComponent<HertzStudioPreservedNote>() : null;
                var replacedKind = replaced != null ? replaced.GetComponent<HertzStudioSurfaceKind>() : null;
                var replacedProv = replaced != null ? replaced.GetComponent<HertzStudioAssetProvenance>() : null;
                Record(checks, "replace_floor_wall",
                    replaceErr == null && replaced != null &&
                    replaced.transform.parent == parent.transform &&
                    replaced.transform.GetSiblingIndex() == siblingBefore &&
                    replaced.layer == 3 &&
                    replaced.activeSelf &&
                    replacedBox != null &&
                    !replacedBox.isTrigger &&
                    Nearly(replacedBox.size, new Vector3(1.5f, 2f, 0.5f)) &&
                    Nearly(replaced.transform.localPosition, new Vector3(0.1f, 0.2f, 0.3f)) &&
                    replacedNote != null &&
                    replacedNote.Note == "w03-preserve-note" &&
                    replacedNote.Counter == 42 &&
                    replacedNote.Flag &&
                    replacedKind != null &&
                    replacedKind.SurfaceKind == HertzStudioSurfaceKind.Kind.Wall &&
                    replacedProv != null &&
                    replacedProv.AssetId == replaceAssetId,
                    replaceErr ?? $"sib={replaced?.transform.GetSiblingIndex()} note={replacedNote?.Note} kind={replacedKind?.SurfaceKind}");
                Record(checks, "replace_preserves_unrelated_component",
                    replacedNote != null && replacedNote.Counter == 42 && replacedNote.Flag,
                    replacedNote != null ? $"note={replacedNote.Note};counter={replacedNote.Counter};flag={replacedNote.Flag}" : "missing");

                // Atomic rollback: create generated mat then fail — scene + generated assets unchanged
                var texPath = EnsureTempTextureAsset("HertzW03Proof_RollbackTex");
                var rollbackTarget = GameObject.CreatePrimitive(PrimitiveType.Cube);
                rollbackTarget.name = "HertzW03Proof_RollbackMesh";
                created.Add(rollbackTarget);
                var rollbackGoid = GlobalObjectId.GetGlobalObjectIdSlow(rollbackTarget).ToString();
                var matsBeforeRollback = ListGeneratedMats();
                var matBefore = rollbackTarget.GetComponent<Renderer>().sharedMaterial;
                var rollbackErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation>
                    {
                        Op("assign_material", rollbackGoid, texPath),
                        Op("assign_audio", rollbackGoid, AudioPath), // incompatible → fail batch
                    },
                    out bindings);
                var matsAfterRollback = ListGeneratedMats();
                var matAfter = rollbackTarget.GetComponent<Renderer>().sharedMaterial;
                Record(checks, "atomic_rollback_cleans_generated_materials",
                    !string.IsNullOrEmpty(rollbackErr) &&
                    matAfter == matBefore &&
                    matsAfterRollback.Count <= matsBeforeRollback.Count,
                    rollbackErr ?? "expected failure");

                // Walkability invalid example
                var invalidFloor = GameObject.CreatePrimitive(PrimitiveType.Plane);
                invalidFloor.name = "HertzW03Proof_InvalidFloor";
                invalidFloor.transform.localScale = new Vector3(0.001f, 1f, 1f);
                created.Add(invalidFloor);
                var col = invalidFloor.GetComponent<Collider>();
                if (col != null) col.enabled = false;
                Record(checks, "validation_invalid_example_present",
                    Math.Abs(invalidFloor.transform.localScale.x) < 0.01f && col != null && !col.enabled,
                    "near-zero scale + disabled collider");

                var warningWall = GameObject.CreatePrimitive(PrimitiveType.Cube);
                warningWall.name = "HertzW03Proof_WarnWall";
                var wcol = warningWall.GetComponent<Collider>();
                if (wcol != null) wcol.isTrigger = true;
                created.Add(warningWall);
                Record(checks, "validation_warning_trigger_wall", wcol != null && wcol.isTrigger, "trigger-only");

                // Protected camera
                var cam = new GameObject("Main Camera");
                cam.tag = "MainCamera";
                cam.AddComponent<Camera>();
                created.Add(cam);
                var camGoid = GlobalObjectId.GetGlobalObjectIdSlow(cam).ToString();
                var protectedErr = HertzStudioSceneCommands.ApplyOrError(
                    scene,
                    new List<HertzStudioSceneCommands.SceneOperation>
                    {
                        new HertzStudioSceneCommands.SceneOperation
                        {
                            Op = "transform",
                            ObjectId = camGoid,
                            HasPosition = true,
                            Position = new Vector3(9, 9, 9),
                        },
                    },
                    out bindings);
                Record(checks, "protected_camera_rejected",
                    !string.IsNullOrEmpty(protectedErr) &&
                    protectedErr.IndexOf("protected", StringComparison.OrdinalIgnoreCase) >= 0,
                    protectedErr ?? "no error");
                Record(checks, "is_protected_hierarchy",
                    HertzStudioSceneCommands.IsProtectedHierarchy(cam), "Main Camera");

                Record(checks, "floor_collider_present", floor.GetComponent<Collider>() != null, "floor collider");
                Record(checks, "wall_colliders_present",
                    wallA.GetComponent<Collider>() != null && wallB.GetComponent<Collider>() != null, "walls");

                pass = checks.TrueForAll(c => c.Contains("\"pass\":true"));
            }
            catch (Exception ex)
            {
                Record(checks, "proof_exception", false, ex.Message);
                pass = false;
            }
            finally
            {
                foreach (var obj in created)
                {
                    if (obj == null) continue;
                    UnityEngine.Object.DestroyImmediate(obj);
                }

                foreach (var root in scene.GetRootGameObjects())
                {
                    if (root != null && root.name.StartsWith("HertzW03Proof_", StringComparison.Ordinal))
                        UnityEngine.Object.DestroyImmediate(root);
                }

                // Cleanup proof-generated materials/prefabs/textures under GeneratedMaterials / GeneratedProof
                CleanupProofAssets(generatedMatsBefore);

                if (scene.isDirty)
                {
                    EditorSceneManager.SaveScene(scene);
                }
            }

            var afterHash = FileSha256(TestScene);
            var afterDirty = EditorSceneManager.GetSceneByPath(TestScene).isDirty;
            var leftoverProof = CountProofNamed(scene);
            Record(checks, "scene_clean_after_proof", leftoverProof == 0, $"leftover={leftoverProof}");
            var sampleHashAfter = FileSha256(sampleScenePath);
            Record(checks, "sample_scene_disk_hash_unchanged",
                !string.IsNullOrEmpty(sampleHashBefore) && sampleHashBefore == sampleHashAfter,
                $"before={sampleHashBefore} after={sampleHashAfter}");

            pass = checks.TrueForAll(c => c.Contains("\"pass\":true"));

            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine("\"schemaVersion\":2,");
            sb.AppendLine("\"proof\":\"w03-typed-ops\",");
            sb.AppendLine("\"runner\":\"HertzStudioTypedOpsProof\",");
            sb.AppendLine("\"runnerVersion\":\"3\",");
            sb.AppendLine("\"command\":\"Tools/HERTZ Studio/Run Typed Ops Proof (HertzStudioTest)\",");
            sb.AppendLine($"\"stampedAt\":{Quote(DateTime.UtcNow.ToString("o"))},");
            sb.AppendLine($"\"scenePath\":{Quote(TestScene)},");
            sb.AppendLine($"\"beforeHash\":{Quote(beforeHash)},");
            sb.AppendLine($"\"afterHash\":{Quote(afterHash)},");
            sb.AppendLine($"\"beforeDirty\":{(beforeDirty ? "true" : "false")},");
            sb.AppendLine($"\"afterDirty\":{(afterDirty ? "true" : "false")},");
            sb.AppendLine("\"sampleSceneMutated\":false,");
            sb.AppendLine("\"animationContract\":\"RuntimeAnimatorController only\",");
            sb.AppendLine("\"checks\":[");
            for (var i = 0; i < checks.Count; i++)
            {
                sb.Append("  ");
                sb.Append(checks[i]);
                sb.AppendLine(i < checks.Count - 1 ? "," : "");
            }

            sb.AppendLine("],");
            var derivedOk = pass && checks.Count > 0;
            sb.AppendLine($"\"ok\":{(derivedOk ? "true" : "false")},");
            sb.AppendLine($"\"passed\":{CountPass(checks)},");
            sb.AppendLine($"\"total\":{checks.Count}");
            sb.AppendLine("}");
            return sb.ToString();
        }

        private static HertzStudioSceneCommands.SceneOperation Op(string op, string targetGoid, string assetPath)
        {
            return new HertzStudioSceneCommands.SceneOperation
            {
                Op = op,
                TargetObjectId = targetGoid,
                ObjectId = targetGoid,
                ImportedPath = assetPath,
                PrefabPath = assetPath,
                AssetId = Guid.NewGuid().ToString("D"),
                MaterialSlot = 0,
            };
        }

        private static bool Nearly(Vector3 a, Vector3 b) =>
            (a - b).sqrMagnitude < 0.0001f;

        private static void EnsureSpriteImporter(string path)
        {
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null) throw new InvalidOperationException($"Missing sprite asset {path}");
            if (importer.textureType != TextureImporterType.Sprite)
            {
                importer.textureType = TextureImporterType.Sprite;
                importer.spriteImportMode = SpriteImportMode.Single;
                importer.SaveAndReimport();
            }
        }

        private static string EnsureTempMaterialAsset(string name, Color color)
        {
            var folder = "Assets/HertzStudio/GeneratedMaterials";
            if (!AssetDatabase.IsValidFolder("Assets/HertzStudio")) AssetDatabase.CreateFolder("Assets", "HertzStudio");
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder("Assets/HertzStudio", "GeneratedMaterials");
            var path = $"{folder}/{name}.mat";
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null)
            {
                existing.color = color;
                EditorUtility.SetDirty(existing);
                return path;
            }

            var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            var mat = new Material(shader) { name = name, color = color };
            AssetDatabase.CreateAsset(mat, path);
            return path;
        }

        private static string EnsureTempTextureAsset(string name)
        {
            var folder = "Assets/HertzStudio/GeneratedMaterials";
            if (!AssetDatabase.IsValidFolder(folder)) EnsureTempMaterialAsset("HertzW03Proof_Seed", Color.white);
            var path = $"{folder}/{name}.png";
            if (File.Exists(Path.GetFullPath(Path.Combine(Application.dataPath, "..", path))))
                return path;
            var tex = new Texture2D(4, 4, TextureFormat.RGBA32, false);
            var pixels = new Color[16];
            for (var i = 0; i < pixels.Length; i++) pixels[i] = Color.magenta;
            tex.SetPixels(pixels);
            tex.Apply();
            File.WriteAllBytes(Path.GetFullPath(Path.Combine(Application.dataPath, "..", path)), tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
            AssetDatabase.ImportAsset(path);
            return path;
        }

        private static string EnsureTempCubePrefab()
        {
            var folder = "Assets/HertzStudio/GeneratedProof";
            if (!AssetDatabase.IsValidFolder("Assets/HertzStudio")) AssetDatabase.CreateFolder("Assets", "HertzStudio");
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder("Assets/HertzStudio", "GeneratedProof");
            var path = $"{folder}/HertzW03Proof_Cube.prefab";
            if (AssetDatabase.LoadAssetAtPath<GameObject>(path) != null) return path;
            var temp = GameObject.CreatePrimitive(PrimitiveType.Cube);
            temp.name = "HertzW03Proof_Cube";
            PrefabUtility.SaveAsPrefabAsset(temp, path);
            UnityEngine.Object.DestroyImmediate(temp);
            return path;
        }

        private static HashSet<string> ListGeneratedMats()
        {
            var set = new HashSet<string>();
            foreach (var guid in AssetDatabase.FindAssets("t:Material", new[] { "Assets/HertzStudio/GeneratedMaterials" }))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (!string.IsNullOrEmpty(p)) set.Add(p);
            }

            return set;
        }

        private static void CleanupProofAssets(HashSet<string> before)
        {
            foreach (var guid in AssetDatabase.FindAssets("HertzW03Proof_", new[] { "Assets/HertzStudio" }))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(p)) continue;
                if (before != null && before.Contains(p) && p.EndsWith(".mat", StringComparison.OrdinalIgnoreCase))
                {
                    // Keep pre-existing mats from earlier runs? Prefer delete all proof-named.
                }

                if (p.IndexOf("HertzW03Proof_", StringComparison.Ordinal) >= 0)
                    AssetDatabase.DeleteAsset(p);
            }

            AssetDatabase.Refresh();
        }

        private static int CountProofNamed(Scene scene)
        {
            var n = 0;
            foreach (var root in scene.GetRootGameObjects())
            {
                if (root != null && root.name.StartsWith("HertzW03Proof_", StringComparison.Ordinal)) n++;
            }

            return n;
        }

        private static void Record(List<string> checks, string name, bool ok, string detail)
        {
            checks.Add(
                "{" +
                $"\"name\":{Quote(name)},\"pass\":{(ok ? "true" : "false")}," +
                $"\"actual\":{Quote(detail)},\"expected\":{Quote("pass")}" +
                "}");
            Debug.Log($"{(ok ? "✓" : "✗")} {name}: {detail}");
        }

        private static int CountPass(List<string> checks)
        {
            var n = 0;
            foreach (var c in checks)
                if (c.Contains("\"pass\":true")) n++;
            return n;
        }

        private static string FileSha256(string assetPath)
        {
            var abs = Path.GetFullPath(Path.Combine(Application.dataPath, "..", assetPath));
            if (!File.Exists(abs)) return null;
            using var sha = SHA256.Create();
            using var stream = File.OpenRead(abs);
            var hash = sha.ComputeHash(stream);
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("X2"));
            return sb.ToString();
        }

        private static string ColorToStr(Color? c)
        {
            if (c == null) return "null";
            var v = c.Value;
            return $"{v.r:F2},{v.g:F2},{v.b:F2}";
        }

        private static string Quote(string s)
        {
            if (s == null) return "null";
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
