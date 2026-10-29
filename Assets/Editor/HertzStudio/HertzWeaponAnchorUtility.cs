using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Prefab-hierarchy anchor inspection and non-destructive wrapper authoring for W04 weapons.
    /// Never mutates the imported source prefab; never guesses final Grip/Muzzle placement silently.
    /// </summary>
    public static class HertzWeaponAnchorUtility
    {
        public const string WrappersFolder = "Assets/HertzStudio/Weapons/Wrappers";
        public const string DefaultGripName = "Grip";
        public const string DefaultMuzzleName = "Muzzle";

        public sealed class AnchorValidation
        {
            public bool Ok;
            public bool ModelPresent;
            public string PrefabPath;
            public string GripAnchor;
            public string MuzzleAnchor;
            public bool GripFound;
            public bool MuzzleFound;
            public string[] MissingAnchors = Array.Empty<string>();
            public string[] HierarchyNames = Array.Empty<string>();
            public string Error;
        }

        public sealed class WrapperResult
        {
            public bool Ok;
            public string Error;
            public string WrapperPrefabPath;
            public string SourcePrefabPath;
            public string SourcePrefabGuid;
            public string GripSourceNode;
            public string MuzzleSourceNode;
            public bool GripCreated;
            public bool MuzzleCreated;
            public bool GripFromSource;
            public bool MuzzleFromSource;
            public bool AnchorsProvisional;
            public bool AnchorsConfirmed;
            public bool NeedsConfirmation;
            public string RecoveryReason;
            public bool AlreadyExists;
            public bool IdempotentReuse;
            public bool CreatedNewVersion;
            public int WrapperVersion = 1;
            public string Note;
        }

        [Serializable]
        public sealed class WrapperAnchorMeta
        {
            public int version = 1;
            public string weaponId;
            public string wrapperPrefabPath;
            public string sourcePrefabPath;
            public string sourcePrefabGuid;
            public string gripSourceNode;
            public string muzzleSourceNode;
            public bool gripFromSource;
            public bool muzzleFromSource;
            public bool provisional;
            public bool confirmed;
            public bool needsConfirmation;
            public string recoveryReason;
            public string confirmedAt;
            public string modelAssetId;
            public int wrapperVersion = 1;
        }

        /// <summary>
        /// Normalize Assets/ paths: forward slashes, reject traversal, absolute, and non-Assets paths.
        /// </summary>
        public static string NormalizeAssetPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return null;
            var p = path.Trim().Replace('\\', '/');
            try
            {
                p = Uri.UnescapeDataString(p);
            }
            catch
            {
                // keep raw when not URI-encoded
            }

            p = p.Replace('\\', '/');
            while (p.Contains("//", StringComparison.Ordinal))
            {
                p = p.Replace("//", "/", StringComparison.Ordinal);
            }

            if (p.IndexOf("..", StringComparison.Ordinal) >= 0) return null;
            if (p.Length >= 2 && char.IsLetter(p[0]) && p[1] == ':') return null;
            if (p.StartsWith("/", StringComparison.Ordinal) || p.StartsWith("\\\\", StringComparison.Ordinal))
            {
                return null;
            }

            if (!p.StartsWith("Assets/", StringComparison.Ordinal)) return null;
            return p;
        }

        public static bool TryValidateManagedWrapperPath(
            string path,
            string weaponId,
            out string normalized,
            out string error)
        {
            normalized = null;
            error = null;
            var n = NormalizeAssetPath(path);
            if (n == null || !n.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                error = "Managed wrapper path must be an Assets/…/*.prefab path without traversal.";
                return false;
            }

            if (string.IsNullOrWhiteSpace(weaponId))
            {
                error = "weaponId required for managed wrapper path validation.";
                return false;
            }

            var prefix = $"{WrappersFolder}/{weaponId.Trim()}/";
            if (!n.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                error =
                    $"Managed wrapper must live under {prefix}. Cross-weapon and outside-folder paths are rejected.";
                return false;
            }

            var remainder = n.Substring(prefix.Length);
            // Direct child only — no nested folders that could obscure association.
            if (string.IsNullOrEmpty(remainder) || remainder.IndexOf('/') >= 0)
            {
                error = $"Managed wrapper must be a direct *.prefab child of {prefix}.";
                return false;
            }

            normalized = n;
            return true;
        }

        public static AnchorValidation ValidatePrefabAnchors(
            GameObject prefab,
            string gripAnchor,
            string muzzleAnchor)
        {
            var result = new AnchorValidation
            {
                GripAnchor = string.IsNullOrWhiteSpace(gripAnchor) ? DefaultGripName : gripAnchor.Trim(),
                MuzzleAnchor = string.IsNullOrWhiteSpace(muzzleAnchor) ? DefaultMuzzleName : muzzleAnchor.Trim(),
            };

            if (prefab == null)
            {
                result.ModelPresent = false;
                result.Error = "No model prefab assigned.";
                result.MissingAnchors = new[] { result.GripAnchor, result.MuzzleAnchor };
                return result;
            }

            result.ModelPresent = true;
            result.PrefabPath = AssetDatabase.GetAssetPath(prefab);
            result.HierarchyNames = ListHierarchyNames(prefab.transform);
            result.GripFound = FindNamed(prefab.transform, result.GripAnchor) != null;
            result.MuzzleFound = FindNamed(prefab.transform, result.MuzzleAnchor) != null;

            var missing = new List<string>(2);
            if (!result.GripFound) missing.Add(result.GripAnchor);
            if (!result.MuzzleFound) missing.Add(result.MuzzleAnchor);
            result.MissingAnchors = missing.ToArray();
            result.Ok = missing.Count == 0;
            if (!result.Ok)
            {
                result.Error = BuildMissingAnchorsError(result);
            }

            return result;
        }

        /// <summary>
        /// Runtime-ready check: named anchors must exist, and provisional wrappers must be confirmed.
        /// Direct GripAttach/MuzzlePoint mappings on imported models skip wrapper metadata.
        /// </summary>
        public static AnchorValidation ValidateRuntimeReady(
            GameObject prefab,
            string gripAnchor,
            string muzzleAnchor)
        {
            var result = ValidatePrefabAnchors(prefab, gripAnchor, muzzleAnchor);
            if (!result.Ok || string.IsNullOrEmpty(result.PrefabPath)) return result;

            var normalized = result.PrefabPath.Replace('\\', '/');
            if (!normalized.StartsWith(WrappersFolder + "/", StringComparison.OrdinalIgnoreCase))
            {
                return result;
            }

            var meta = LoadWrapperMeta(normalized);
            if (meta == null)
            {
                // Legacy wrapper without sidecar — not runtime-ready; Studio Confirm recovers metadata.
                result.Ok = false;
                result.Error =
                    "Managed wrapper is missing confirmation metadata (legacy). Confirm Grip/Muzzle in Studio " +
                    "to write .anchors.json without overwriting the prefab — Sync/Deploy rejected until then.";
                return result;
            }

            if (meta.needsConfirmation || (meta.provisional && !meta.confirmed) || !meta.confirmed)
            {
                result.Ok = false;
                result.Error =
                    "Managed Grip/Muzzle wrapper is unconfirmed. Position anchors in Prefab Mode if needed, " +
                    "then Confirm in Studio before claiming runtime-ready. Sync/deploy rejected.";
            }

            return result;
        }

        public static string WrapperMetaPath(string wrapperPrefabPath)
        {
            if (string.IsNullOrEmpty(wrapperPrefabPath)) return null;
            var normalized = wrapperPrefabPath.Replace('\\', '/');
            if (normalized.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                return normalized.Substring(0, normalized.Length - ".prefab".Length) + ".anchors.json";
            }

            return normalized + ".anchors.json";
        }

        private static string AbsoluteProjectPath(string assetsRelativePath)
        {
            var normalized = assetsRelativePath.Replace('\\', '/');
            if (normalized.StartsWith("Assets/", StringComparison.Ordinal))
            {
                normalized = normalized.Substring("Assets/".Length);
            }

            return Path.GetFullPath(Path.Combine(Application.dataPath, normalized));
        }

        public static WrapperAnchorMeta LoadWrapperMeta(string wrapperPrefabPath)
        {
            var metaPath = WrapperMetaPath(wrapperPrefabPath);
            if (string.IsNullOrEmpty(metaPath)) return null;
            var abs = AbsoluteProjectPath(metaPath);
            if (!File.Exists(abs)) return null;
            try
            {
                return JsonUtility.FromJson<WrapperAnchorMeta>(File.ReadAllText(abs));
            }
            catch
            {
                return null;
            }
        }

        public static void SaveWrapperMeta(string wrapperPrefabPath, WrapperAnchorMeta meta)
        {
            var metaPath = WrapperMetaPath(wrapperPrefabPath);
            var abs = AbsoluteProjectPath(metaPath);
            var dir = Path.GetDirectoryName(abs);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(abs, JsonUtility.ToJson(meta, true));
            AssetDatabase.ImportAsset(metaPath);
        }

        /// <summary>
        /// Best-effort nested/source prefab identity for a managed wrapper (PrefabUtility / variant parent).
        /// Name-only matching is never treated as proof.
        /// </summary>
        public static bool TryResolveWrapperSourceIdentity(
            GameObject wrapperPrefab,
            out string sourcePath,
            out string sourceGuid,
            out string error)
        {
            sourcePath = null;
            sourceGuid = null;
            error = null;
            if (wrapperPrefab == null)
            {
                error = "Wrapper prefab is null.";
                return false;
            }

            var corresponding = PrefabUtility.GetCorrespondingObjectFromOriginalSource(wrapperPrefab);
            if (corresponding != null && corresponding != (UnityEngine.Object)wrapperPrefab)
            {
                var path = AssetDatabase.GetAssetPath(corresponding);
                var n = NormalizeAssetPath(path);
                if (!string.IsNullOrEmpty(n) &&
                    n.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) &&
                    !n.StartsWith(WrappersFolder + "/", StringComparison.OrdinalIgnoreCase))
                {
                    sourcePath = n;
                    sourceGuid = AssetDatabase.AssetPathToGUID(n);
                    return !string.IsNullOrEmpty(sourceGuid);
                }
            }

            // Nested prefab instances inside the wrapper root.
            var transforms = wrapperPrefab.GetComponentsInChildren<Transform>(true);
            for (var i = 0; i < transforms.Length; i++)
            {
                var t = transforms[i];
                if (t == null || t.gameObject == wrapperPrefab) continue;
                if (!PrefabUtility.IsPartOfPrefabInstance(t.gameObject)) continue;
                var nearest = PrefabUtility.GetNearestPrefabInstanceRoot(t.gameObject);
                if (nearest == null) continue;
                var src = PrefabUtility.GetCorrespondingObjectFromSource(nearest);
                if (src == null) continue;
                var path = AssetDatabase.GetAssetPath(src);
                var n = NormalizeAssetPath(path);
                if (string.IsNullOrEmpty(n) ||
                    !n.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ||
                    n.StartsWith(WrappersFolder + "/", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                sourcePath = n;
                sourceGuid = AssetDatabase.AssetPathToGUID(n);
                if (!string.IsNullOrEmpty(sourceGuid)) return true;
            }

            error =
                "Could not reconstruct nested/source prefab identity for this managed wrapper. " +
                "Create a new versioned wrapper from the weapon's current imported source.";
            return false;
        }

        public static WrapperResult ConfirmWrapperAnchors(
            string wrapperPrefabPath,
            string weaponId = null,
            string expectedSourcePrefabPath = null,
            string expectedSourcePrefabGuid = null,
            string modelAssetId = null)
        {
            var result = new WrapperResult { WrapperPrefabPath = wrapperPrefabPath };
            if (string.IsNullOrEmpty(wrapperPrefabPath))
            {
                result.Error = "wrapperPrefabPath required.";
                return result;
            }

            if (!TryValidateManagedWrapperPath(wrapperPrefabPath, weaponId, out var normalized, out var pathError))
            {
                result.Error = pathError;
                return result;
            }

            result.WrapperPrefabPath = normalized;
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(normalized);
            if (prefab == null)
            {
                result.Error = $"Wrapper prefab not found at {normalized}.";
                return result;
            }

            var named = ValidatePrefabAnchors(prefab, DefaultGripName, DefaultMuzzleName);
            if (!named.Ok)
            {
                result.Error = named.Error;
                return result;
            }

            var expectedPath = NormalizeAssetPath(expectedSourcePrefabPath);
            var expectedGuid = string.IsNullOrWhiteSpace(expectedSourcePrefabGuid)
                ? null
                : expectedSourcePrefabGuid.Trim();

            var meta = LoadWrapperMeta(normalized);
            var wasLegacy = meta == null;
            if (meta == null)
            {
                if (!TryResolveWrapperSourceIdentity(prefab, out var provenPath, out var provenGuid, out var resolveError))
                {
                    result.Error = resolveError;
                    result.NeedsConfirmation = true;
                    result.RecoveryReason = "source_identity_unproven";
                    result.Note =
                        "Legacy wrapper cannot be confirmed without proven source identity. " +
                        "Pass replaceExisting=true to create a new versioned wrapper from the current imported model.";
                    return result;
                }

                if (!string.IsNullOrEmpty(expectedPath) &&
                    !string.Equals(provenPath, expectedPath, StringComparison.OrdinalIgnoreCase))
                {
                    result.Error =
                        $"Legacy wrapper source '{provenPath}' does not match expected '{expectedPath}'. Confirmation rejected.";
                    result.RecoveryReason = "wrapper_source_mismatch";
                    return result;
                }

                if (!string.IsNullOrEmpty(expectedGuid) &&
                    !string.Equals(provenGuid, expectedGuid, StringComparison.OrdinalIgnoreCase))
                {
                    result.Error =
                        $"Legacy wrapper source GUID '{provenGuid}' does not match expected '{expectedGuid}'. Confirmation rejected.";
                    result.RecoveryReason = "wrapper_source_mismatch";
                    return result;
                }

                meta = new WrapperAnchorMeta
                {
                    version = 1,
                    provisional = true,
                    confirmed = false,
                    needsConfirmation = true,
                    recoveryReason = "missing_metadata",
                    wrapperVersion = 1,
                    sourcePrefabPath = provenPath,
                    sourcePrefabGuid = provenGuid,
                };
                result.SourcePrefabPath = provenPath;
                result.SourcePrefabGuid = provenGuid;
            }

            if (!string.IsNullOrEmpty(meta.weaponId) &&
                !string.Equals(meta.weaponId, weaponId.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                result.Error =
                    $"Wrapper metadata is associated with weapon '{meta.weaponId}', not '{weaponId}'. Confirmation rejected.";
                return result;
            }

            if (!string.IsNullOrEmpty(meta.wrapperPrefabPath))
            {
                var metaPath = NormalizeAssetPath(meta.wrapperPrefabPath);
                if (metaPath != null &&
                    !string.Equals(metaPath, normalized, StringComparison.OrdinalIgnoreCase))
                {
                    result.Error =
                        "Sidecar wrapperPrefabPath does not match the confirmed prefab. Confirmation rejected.";
                    return result;
                }
            }

            var metaSourcePath = NormalizeAssetPath(meta.sourcePrefabPath);
            if (!string.IsNullOrEmpty(expectedPath))
            {
                if (string.IsNullOrEmpty(metaSourcePath) ||
                    !string.Equals(metaSourcePath, expectedPath, StringComparison.OrdinalIgnoreCase))
                {
                    result.Error =
                        "Wrapper sourcePrefabPath does not match the weapon's authoritative imported source. Confirmation rejected.";
                    result.RecoveryReason = "wrapper_source_mismatch";
                    return result;
                }
            }

            if (!string.IsNullOrEmpty(expectedGuid) &&
                !string.IsNullOrEmpty(meta.sourcePrefabGuid) &&
                !string.Equals(meta.sourcePrefabGuid, expectedGuid, StringComparison.OrdinalIgnoreCase))
            {
                result.Error =
                    "Wrapper sourcePrefabGuid does not match the weapon's authoritative imported source. Confirmation rejected.";
                result.RecoveryReason = "wrapper_source_mismatch";
                return result;
            }

            // Preserve existing transforms — write metadata only after Grip+Muzzle + source identity validation.
            meta.weaponId = weaponId.Trim();
            meta.wrapperPrefabPath = normalized;
            meta.modelAssetId = modelAssetId ?? meta.modelAssetId;
            if (!string.IsNullOrEmpty(expectedPath)) meta.sourcePrefabPath = expectedPath;
            if (!string.IsNullOrEmpty(expectedGuid)) meta.sourcePrefabGuid = expectedGuid;
            meta.confirmed = true;
            meta.confirmedAt = DateTime.UtcNow.ToString("o");
            meta.provisional = false;
            meta.needsConfirmation = false;
            meta.recoveryReason = null;
            if (meta.wrapperVersion < 1) meta.wrapperVersion = 1;
            SaveWrapperMeta(normalized, meta);

            result.Ok = true;
            result.AnchorsConfirmed = true;
            result.AnchorsProvisional = false;
            result.NeedsConfirmation = false;
            result.RecoveryReason = null;
            result.WrapperVersion = meta.wrapperVersion;
            result.SourcePrefabPath = meta.sourcePrefabPath;
            result.SourcePrefabGuid = meta.sourcePrefabGuid;
            result.Note = wasLegacy
                ? "Legacy wrapper recovered: source identity proven and .anchors.json written. Prefab transforms preserved. Re-sync before deploy."
                : "Anchors confirmed. Re-sync the weapon definition before deploy.";
            return result;
        }

        public static string BuildMissingAnchorsError(AnchorValidation v)
        {
            var sb = new StringBuilder();
            sb.Append("Required weapon anchors missing on Unity prefab");
            if (!string.IsNullOrEmpty(v.PrefabPath))
            {
                sb.Append(" '").Append(v.PrefabPath).Append("'");
            }

            sb.Append(": ");
            sb.Append(string.Join(", ", v.MissingAnchors));
            sb.Append(". Grip sets hand alignment; Muzzle sets flash/tracer origin and direction. ");
            sb.Append("Select existing hierarchy transforms in Studio, or create a managed Grip/Muzzle wrapper under ");
            sb.Append(WrappersFolder);
            sb.Append(" — do not claim runtime-ready until both resolve.");
            if (v.HierarchyNames != null && v.HierarchyNames.Length > 0)
            {
                var tipCount = Math.Min(12, v.HierarchyNames.Length);
                sb.Append(" Prefab nodes: ");
                for (var i = 0; i < tipCount; i++)
                {
                    if (i > 0) sb.Append(", ");
                    sb.Append(v.HierarchyNames[i]);
                }

                if (v.HierarchyNames.Length > tipCount) sb.Append(", …");
            }

            return sb.ToString();
        }

        public static string[] ListHierarchyNames(Transform root)
        {
            var names = new List<string>();
            if (root == null) return names.ToArray();
            CollectNames(root, names);
            return names.ToArray();
        }

        /// <summary>
        /// Creates a non-destructive prefab variant under WrappersFolder with explicit Grip and Muzzle
        /// empties. Optionally seeds their local pose from named source nodes on the imported prefab.
        /// Never renames or edits the source asset.
        /// </summary>
        public static WrapperResult CreateManagedAnchorWrapper(
            string sourcePrefabPath,
            string weaponId,
            string gripSourceNode,
            string muzzleSourceNode,
            bool replaceExisting = false,
            string expectedSourceGuid = null,
            string modelAssetId = null)
        {
            var result = new WrapperResult
            {
                SourcePrefabPath = sourcePrefabPath,
                GripSourceNode = gripSourceNode,
                MuzzleSourceNode = muzzleSourceNode,
            };

            var normalized = NormalizeAssetPath(sourcePrefabPath);
            if (normalized == null || !normalized.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            {
                result.Error = "sourcePrefabPath must be an Assets/…/*.prefab path without traversal.";
                return result;
            }

            var source = AssetDatabase.LoadAssetAtPath<GameObject>(normalized);
            if (source == null)
            {
                result.Error = $"Source prefab not found at {sourcePrefabPath}.";
                return result;
            }

            result.SourcePrefabPath = normalized;
            result.SourcePrefabGuid = AssetDatabase.AssetPathToGUID(normalized);
            if (!string.IsNullOrEmpty(expectedSourceGuid) &&
                !string.Equals(result.SourcePrefabGuid, expectedSourceGuid.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                result.Error =
                    $"Source prefab GUID '{result.SourcePrefabGuid}' does not match expected '{expectedSourceGuid}'.";
                result.RecoveryReason = "wrapper_source_mismatch";
                return result;
            }

            if (normalized.StartsWith(WrappersFolder + "/", StringComparison.OrdinalIgnoreCase))
            {
                result.Error = "Source is already under Weapons/Wrappers. Edit that wrapper or pick the imported model.";
                return result;
            }

            var folderKey = string.IsNullOrWhiteSpace(weaponId) ? "unassigned" : weaponId.Trim();
            var folder = $"{WrappersFolder}/{folderKey}";
            EnsureFolder(folder);

            var baseName = source.name + "_Anchored";
            var wrapperPath = $"{folder}/{baseName}.prefab";
            var existing = AssetDatabase.LoadAssetAtPath<GameObject>(wrapperPath);
            if (existing != null && !replaceExisting)
            {
                var existingMeta = LoadWrapperMeta(wrapperPath);
                result.AlreadyExists = true;
                result.WrapperPrefabPath = wrapperPath;
                result.WrapperVersion = existingMeta != null ? Math.Max(1, existingMeta.wrapperVersion) : 1;
                result.GripFromSource = existingMeta != null && existingMeta.gripFromSource;
                result.MuzzleFromSource = existingMeta != null && existingMeta.muzzleFromSource;

                if (existingMeta != null)
                {
                    if (!string.IsNullOrEmpty(existingMeta.weaponId) &&
                        !string.Equals(existingMeta.weaponId, folderKey, StringComparison.OrdinalIgnoreCase))
                    {
                        result.Error =
                            $"Existing wrapper metadata belongs to weapon '{existingMeta.weaponId}', not '{folderKey}'. " +
                            "Pass replaceExisting=true to create a new versioned wrapper.";
                        result.RecoveryReason = "wrapper_source_mismatch";
                        return result;
                    }

                    var metaWrapPath = NormalizeAssetPath(existingMeta.wrapperPrefabPath) ?? wrapperPath;
                    if (!string.Equals(metaWrapPath, wrapperPath, StringComparison.OrdinalIgnoreCase))
                    {
                        result.Error = "Existing wrapper sidecar path does not match the on-disk wrapper prefab.";
                        result.RecoveryReason = "wrapper_source_mismatch";
                        return result;
                    }

                    var metaSourcePath = NormalizeAssetPath(existingMeta.sourcePrefabPath);
                    if (!string.IsNullOrEmpty(metaSourcePath) &&
                        !string.Equals(metaSourcePath, normalized, StringComparison.OrdinalIgnoreCase))
                    {
                        result.Error =
                            $"Existing wrapper was built from '{metaSourcePath}', not current source '{normalized}'. " +
                            "Pass replaceExisting=true to create a new versioned wrapper. Existing file preserved.";
                        result.RecoveryReason = "wrapper_source_mismatch";
                        return result;
                    }

                    if (!string.IsNullOrEmpty(existingMeta.sourcePrefabGuid) &&
                        !string.Equals(existingMeta.sourcePrefabGuid, result.SourcePrefabGuid,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        result.Error =
                            $"Existing wrapper source GUID '{existingMeta.sourcePrefabGuid}' does not match " +
                            $"current source GUID '{result.SourcePrefabGuid}'. Pass replaceExisting=true for a new version.";
                        result.RecoveryReason = "wrapper_source_mismatch";
                        return result;
                    }
                }
                else
                {
                    // Legacy: require nested source identity to match current source before reuse is accepted.
                    if (!TryResolveWrapperSourceIdentity(existing, out var provenPath, out var provenGuid, out _))
                    {
                        result.Ok = true;
                        result.IdempotentReuse = true;
                        result.AnchorsProvisional = true;
                        result.AnchorsConfirmed = false;
                        result.NeedsConfirmation = true;
                        result.RecoveryReason = "source_identity_unproven";
                        result.Note =
                            "Existing legacy wrapper preserved but source identity could not be proven. " +
                            "Confirmation will require a proven match or create a new versioned wrapper (replaceExisting=true).";
                        return result;
                    }

                    if (!string.Equals(provenPath, normalized, StringComparison.OrdinalIgnoreCase) ||
                        (!string.IsNullOrEmpty(provenGuid) &&
                         !string.Equals(provenGuid, result.SourcePrefabGuid, StringComparison.OrdinalIgnoreCase)))
                    {
                        result.Error =
                            $"Legacy wrapper nested source '{provenPath}'/{provenGuid} does not match current " +
                            $"'{normalized}'/{result.SourcePrefabGuid}. Pass replaceExisting=true. Existing file preserved.";
                        result.RecoveryReason = "wrapper_source_mismatch";
                        return result;
                    }
                }

                result.Ok = true;
                result.IdempotentReuse = true;

                if (existingMeta == null)
                {
                    result.AnchorsProvisional = true;
                    result.AnchorsConfirmed = false;
                    result.NeedsConfirmation = true;
                    result.RecoveryReason = "missing_metadata";
                    result.Note =
                        "Existing managed wrapper preserved (legacy, missing .anchors.json; source identity matches). " +
                        "Confirmation required — Confirm writes metadata without overwriting Grip/Muzzle.";
                }
                else if (existingMeta.needsConfirmation ||
                         (existingMeta.provisional && !existingMeta.confirmed) ||
                         !existingMeta.confirmed)
                {
                    result.AnchorsProvisional = true;
                    result.AnchorsConfirmed = false;
                    result.NeedsConfirmation = true;
                    result.RecoveryReason = string.IsNullOrEmpty(existingMeta.recoveryReason)
                        ? "unconfirmed"
                        : existingMeta.recoveryReason;
                    result.Note =
                        "Existing managed wrapper preserved (unconfirmed, source identity matches). " +
                        "Confirm after positioning Grip/Muzzle. Pass replaceExisting=true for a new version.";
                }
                else
                {
                    result.AnchorsProvisional = false;
                    result.AnchorsConfirmed = true;
                    result.NeedsConfirmation = false;
                    result.RecoveryReason = null;
                    result.Note =
                        "Existing managed wrapper preserved (idempotent, confirmed, source identity matches). " +
                        "Pass replaceExisting=true to create a new versioned wrapper.";
                }

                return result;
            }

            if (existing != null && replaceExisting)
            {
                var version = 2;
                while (AssetDatabase.LoadAssetAtPath<GameObject>($"{folder}/{baseName}_v{version}.prefab") != null)
                {
                    version++;
                }

                wrapperPath = $"{folder}/{baseName}_v{version}.prefab";
                result.CreatedNewVersion = true;
                result.WrapperVersion = version;
            }

            var instance = (GameObject)PrefabUtility.InstantiatePrefab(source);
            if (instance == null)
            {
                result.Error = "Failed to instantiate source prefab for wrapper.";
                return result;
            }

            try
            {
                instance.name = Path.GetFileNameWithoutExtension(wrapperPath);

                var gripSrc = FindNamed(instance.transform, gripSourceNode);
                var muzzleSrc = FindNamed(instance.transform, muzzleSourceNode);

                DestroyChildNamed(instance.transform, DefaultGripName);
                DestroyChildNamed(instance.transform, DefaultMuzzleName);

                var grip = new GameObject(DefaultGripName);
                grip.transform.SetParent(instance.transform, false);
                if (gripSrc != null)
                {
                    CopyLocalPoseRelativeToRoot(gripSrc, instance.transform, grip.transform);
                    result.GripCreated = true;
                    result.GripFromSource = true;
                }
                else
                {
                    grip.transform.localPosition = Vector3.zero;
                    grip.transform.localRotation = Quaternion.identity;
                    result.GripCreated = true;
                    result.GripFromSource = false;
                    result.Note = AppendNote(result.Note,
                        $"Grip source '{gripSourceNode}' not found — created provisional {DefaultGripName} at root local identity.");
                }

                var muzzle = new GameObject(DefaultMuzzleName);
                muzzle.transform.SetParent(instance.transform, false);
                if (muzzleSrc != null)
                {
                    CopyLocalPoseRelativeToRoot(muzzleSrc, instance.transform, muzzle.transform);
                    result.MuzzleCreated = true;
                    result.MuzzleFromSource = true;
                }
                else
                {
                    muzzle.transform.localPosition = new Vector3(0f, 0.05f, 0.15f);
                    muzzle.transform.localRotation = Quaternion.identity;
                    result.MuzzleCreated = true;
                    result.MuzzleFromSource = false;
                    result.Note = AppendNote(result.Note,
                        $"Muzzle source '{muzzleSourceNode}' not found — created provisional {DefaultMuzzleName} at a placeholder offset.");
                }

                PrefabUtility.SaveAsPrefabAsset(instance, wrapperPath);
                AssetDatabase.ImportAsset(wrapperPath);

                var validation = ValidatePrefabAnchors(
                    AssetDatabase.LoadAssetAtPath<GameObject>(wrapperPath),
                    DefaultGripName,
                    DefaultMuzzleName);
                if (!validation.Ok)
                {
                    result.Error = validation.Error ?? "Wrapper saved but anchors still missing.";
                    return result;
                }

                var provisional = !result.GripFromSource || !result.MuzzleFromSource;
                if (result.WrapperVersion < 1) result.WrapperVersion = 1;
                var meta = new WrapperAnchorMeta
                {
                    version = 1,
                    weaponId = folderKey,
                    wrapperPrefabPath = wrapperPath,
                    sourcePrefabPath = normalized,
                    sourcePrefabGuid = result.SourcePrefabGuid,
                    modelAssetId = modelAssetId,
                    gripSourceNode = gripSourceNode,
                    muzzleSourceNode = muzzleSourceNode,
                    gripFromSource = result.GripFromSource,
                    muzzleFromSource = result.MuzzleFromSource,
                    provisional = provisional,
                    confirmed = !provisional,
                    needsConfirmation = provisional,
                    recoveryReason = provisional ? "provisional_anchors" : null,
                    confirmedAt = provisional ? null : DateTime.UtcNow.ToString("o"),
                    wrapperVersion = result.WrapperVersion,
                };
                SaveWrapperMeta(wrapperPath, meta);

                result.Ok = true;
                result.WrapperPrefabPath = wrapperPath;
                result.AnchorsProvisional = provisional;
                result.AnchorsConfirmed = !provisional;
                result.NeedsConfirmation = provisional;
                result.RecoveryReason = provisional ? "provisional_anchors" : null;
                result.Note = AppendNote(result.Note,
                    provisional
                        ? "Provisional anchors are NOT runtime-ready. Position Grip/Muzzle in Prefab Mode, then confirm before Sync/Deploy. Imported source GUID preserved."
                        : "Anchors copied from explicit source nodes. Wrapper preserves the imported source GUID. Point the weapon at this prefab with Grip/Muzzle names.");
                return result;
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(instance);
            }
        }

        public static Transform FindNamed(Transform root, string name)
        {
            if (root == null || string.IsNullOrEmpty(name)) return null;
            if (string.Equals(root.name, name, StringComparison.Ordinal)) return root;
            for (var i = 0; i < root.childCount; i++)
            {
                var found = FindNamed(root.GetChild(i), name);
                if (found != null) return found;
            }

            return null;
        }

        private static void CollectNames(Transform t, List<string> names)
        {
            names.Add(t.name);
            for (var i = 0; i < t.childCount; i++)
            {
                CollectNames(t.GetChild(i), names);
            }
        }

        private static void CopyLocalPoseRelativeToRoot(Transform source, Transform root, Transform target)
        {
            // Match source world pose while parenting under root (non-destructive duplicate marker).
            target.position = source.position;
            target.rotation = source.rotation;
            target.SetParent(root, true);
        }

        private static void DestroyChildNamed(Transform root, string name)
        {
            for (var i = root.childCount - 1; i >= 0; i--)
            {
                var child = root.GetChild(i);
                if (string.Equals(child.name, name, StringComparison.Ordinal))
                {
                    UnityEngine.Object.DestroyImmediate(child.gameObject);
                }
            }
        }

        private static string AppendNote(string existing, string next)
        {
            if (string.IsNullOrEmpty(existing)) return next;
            return existing + " " + next;
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parts = folder.Split('/');
            var current = parts[0];
            for (var i = 1; i < parts.Length; i++)
            {
                var next = current + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    AssetDatabase.CreateFolder(current, parts[i]);
                }

                current = next;
            }
        }
    }
}
