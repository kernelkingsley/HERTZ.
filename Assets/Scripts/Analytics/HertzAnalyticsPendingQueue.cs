using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using UnityEngine;

namespace Hertz.Analytics
{
    /// <summary>
    /// Crash-safe durable analytics capture queue.
    /// Immutable payload files + structured manifest with atomic replace.
    /// Proofs use explicit StageAt/ListPendingAt/AckAt APIs; production uses the default root.
    /// </summary>
    public static class HertzAnalyticsPendingQueue
    {
        public const int ManifestVersion = 2;
        public const string UnrecoverableCode = "manifest_unrecoverable";

        private static readonly object Gate = new object();

        [Serializable]
        public class ManifestDocument
        {
            public int version = ManifestVersion;
            public long nextSequence = 1;
            public ManifestEntry[] entries = Array.Empty<ManifestEntry>();
        }

        [Serializable]
        public class ManifestEntry
        {
            public string captureId;
            public string file;
            public string status;
            public string createdAt;
            public string payloadSha256;
            public long sequence;
            public long bytes;
            public string lastError;
        }

        public struct StageResult
        {
            public bool Ok;
            public string CaptureId;
            public string FilePath;
            public string Code;
            public string Message;
            public bool Deduplicated;
        }

        public struct AckResult
        {
            public bool Ok;
            public bool Deduplicated;
            public string Code;
            public string Message;
            public string Status;
        }

        public struct LoadResult
        {
            public bool Ok;
            public ManifestDocument Document;
            public string Code;
            public string Message;
            public string RecoveredFrom;
        }

        public static string ResolveQueueRoot()
        {
            try
            {
                var fromAssets = Path.GetFullPath(Path.Combine(
                    Application.dataPath, "..", "Tools", "HertzStudio", "data", "w06-pending-queue"));
                Directory.CreateDirectory(fromAssets);
                var probe = Path.Combine(fromAssets, ".write_probe");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return fromAssets;
            }
            catch
            {
                // Built player / Quest: local durable queue only. Studio must import via an
                // explicit transfer path — the Editor bridge cannot read Quest persistentDataPath.
            }

            var fallback = Path.Combine(Application.persistentDataPath, "HertzAnalytics", "pending-queue");
            Directory.CreateDirectory(fallback);
            return fallback;
        }

        public static StageResult Stage(string sourcePath, string captureId) =>
            StageAt(ResolveQueueRoot(), sourcePath, captureId);

        public static StageResult StageAt(string root, string sourcePath, string captureId)
        {
            if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
                return FailStage("missing_source", "Analytics capture source missing.");

            var id = string.IsNullOrWhiteSpace(captureId) ? Guid.NewGuid().ToString("N") : captureId.Trim();
            lock (Gate)
            {
                Directory.CreateDirectory(root);
                var capturesDir = Path.Combine(root, "captures");
                Directory.CreateDirectory(capturesDir);

                byte[] bytes;
                try { bytes = File.ReadAllBytes(sourcePath); }
                catch (Exception ex) { return FailStage("read_failed", ex.Message); }

                var hash = Sha256Hex(bytes);
                var dest = Path.Combine(capturesDir, id + ".json");
                var relative = ("captures/" + id + ".json").Replace('\\', '/');

                var load = LoadManifestAt(root);
                if (!load.Ok || load.Document == null)
                    return FailStage(load.Code ?? UnrecoverableCode, load.Message ?? "manifest unreadable");

                var doc = load.Document;
                NormalizeSequences(doc);

                var existing = FindEntry(doc, id);
                if (existing != null)
                {
                    if (!string.Equals(existing.payloadSha256, hash, StringComparison.OrdinalIgnoreCase) ||
                        existing.bytes != bytes.LongLength)
                    {
                        return new StageResult
                        {
                            Ok = false,
                            CaptureId = id,
                            Code = "capture_id_content_conflict",
                            Message = "captureId already exists with a different payload hash.",
                        };
                    }

                    if (!File.Exists(dest))
                    {
                        return new StageResult
                        {
                            Ok = false,
                            CaptureId = id,
                            Code = "identical_retry_missing_payload",
                            Message = "manifest entry exists but payload file is missing.",
                        };
                    }

                    var diskHash = Sha256Hex(File.ReadAllBytes(dest));
                    if (!string.Equals(diskHash, hash, StringComparison.OrdinalIgnoreCase))
                    {
                        return new StageResult
                        {
                            Ok = false,
                            CaptureId = id,
                            Code = "identical_retry_payload_tampered",
                            Message = "payload file hash no longer matches manifest.",
                        };
                    }

                    return new StageResult
                    {
                        Ok = true,
                        CaptureId = id,
                        FilePath = dest,
                        Deduplicated = true,
                        Code = "deduplicated",
                    };
                }

                if (File.Exists(dest))
                {
                    var diskHash = Sha256Hex(File.ReadAllBytes(dest));
                    if (!string.Equals(diskHash, hash, StringComparison.OrdinalIgnoreCase))
                    {
                        return new StageResult
                        {
                            Ok = false,
                            CaptureId = id,
                            Code = "capture_id_content_conflict",
                            Message = "payload file exists with different content.",
                        };
                    }
                }
                else
                {
                    File.WriteAllBytes(dest, bytes);
                }

                var entry = new ManifestEntry
                {
                    captureId = id,
                    file = relative,
                    status = "pending",
                    createdAt = DateTime.UtcNow.ToString("o"),
                    payloadSha256 = hash,
                    sequence = doc.nextSequence++,
                    bytes = bytes.LongLength,
                };
                var list = new List<ManifestEntry>(doc.entries ?? Array.Empty<ManifestEntry>()) { entry };
                doc.entries = list.ToArray();
                if (!SaveManifestAtomic(root, doc, out var saveErr))
                    return FailStage("manifest_write_failed", saveErr);

                // Legacy single-slot pointer only for the actual production queue root (best-effort).
                var isProductionRoot = string.Equals(
                    Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                    Path.GetFullPath(ResolveQueueRoot()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                    StringComparison.OrdinalIgnoreCase);
                if (isProductionRoot)
                {
                    try
                    {
                        var legacy = Path.GetFullPath(Path.Combine(root, "..", "w06-pending-capture.json"));
                        Directory.CreateDirectory(Path.GetDirectoryName(legacy) ?? ".");
                        File.Copy(dest, legacy, overwrite: true);
                    }
                    catch { /* non-authoritative */ }
                }

                return new StageResult { Ok = true, CaptureId = id, FilePath = dest };
            }
        }

        public static IReadOnlyList<HertzAnalyticsCapture.PendingCaptureInfo> ListPending() =>
            ListPendingAt(ResolveQueueRoot());

        public static IReadOnlyList<HertzAnalyticsCapture.PendingCaptureInfo> ListPendingAt(string root)
        {
            lock (Gate)
            {
                var result = new List<HertzAnalyticsCapture.PendingCaptureInfo>();
                var load = LoadManifestAt(root);
                if (!load.Ok || load.Document?.entries == null)
                {
                    if (!string.IsNullOrEmpty(load.Message))
                        Debug.LogWarning("HertzAnalyticsPendingQueue: " + load.Message);
                    return result;
                }

                var doc = load.Document;
                var pending = new List<ManifestEntry>();
                foreach (var e in doc.entries)
                {
                    if (e == null || string.IsNullOrEmpty(e.captureId)) continue;
                    if (!string.Equals(e.status, "pending", StringComparison.OrdinalIgnoreCase)) continue;
                    pending.Add(e);
                }

                pending.Sort((a, b) =>
                {
                    var c = a.sequence.CompareTo(b.sequence);
                    return c != 0 ? c : string.CompareOrdinal(a.captureId, b.captureId);
                });

                var dirty = false;
                foreach (var e in pending)
                {
                    var full = Path.IsPathRooted(e.file) ? e.file : Path.Combine(root, e.file);
                    if (!ValidatePayload(e, full, out var err))
                    {
                        e.status = "corrupt";
                        e.lastError = err;
                        dirty = true;
                        continue;
                    }

                    result.Add(new HertzAnalyticsCapture.PendingCaptureInfo
                    {
                        CaptureId = e.captureId,
                        FilePath = full,
                        Status = e.status,
                    });
                }

                if (dirty)
                    SaveManifestAtomic(root, doc, out _);
                return result;
            }
        }

        public static AckResult Ack(string captureId) => AckAt(ResolveQueueRoot(), captureId);

        public static AckResult AckAt(string root, string captureId)
        {
            if (string.IsNullOrWhiteSpace(captureId))
                return new AckResult { Ok = false, Code = "missing_id", Message = "captureId required" };

            lock (Gate)
            {
                var load = LoadManifestAt(root);
                if (!load.Ok || load.Document?.entries == null)
                    return new AckResult { Ok = false, Code = load.Code ?? "manifest_unreadable", Message = load.Message };

                var doc = load.Document;
                var entry = FindEntry(doc, captureId);
                if (entry == null)
                    return new AckResult { Ok = false, Code = "unknown_id", Message = "capture not found" };

                if (string.Equals(entry.status, "delivered", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(entry.status, "acked", StringComparison.OrdinalIgnoreCase))
                {
                    return new AckResult
                    {
                        Ok = true,
                        Deduplicated = true,
                        Code = "already_acked",
                        Status = entry.status,
                    };
                }

                if (string.Equals(entry.status, "corrupt", StringComparison.OrdinalIgnoreCase))
                {
                    return new AckResult
                    {
                        Ok = false,
                        Code = "corrupt_entry",
                        Message = string.IsNullOrEmpty(entry.lastError) ? "entry corrupt" : entry.lastError,
                        Status = entry.status,
                    };
                }

                var full = Path.IsPathRooted(entry.file) ? entry.file : Path.Combine(root, entry.file);
                if (!ValidatePayload(entry, full, out var payloadErr))
                {
                    entry.status = "corrupt";
                    entry.lastError = payloadErr;
                    SaveManifestAtomic(root, doc, out _);
                    return new AckResult { Ok = false, Code = "corrupt_entry", Message = payloadErr, Status = "corrupt" };
                }

                entry.status = "delivered";
                entry.lastError = null;
                if (!SaveManifestAtomic(root, doc, out var saveErr))
                    return new AckResult { Ok = false, Code = "manifest_write_failed", Message = saveErr };

                return new AckResult { Ok = true, Status = "delivered" };
            }
        }

        public static ManifestDocument LoadManifest(string root, out string error)
        {
            var load = LoadManifestAt(root);
            error = load.Ok ? null : (load.Message ?? load.Code);
            return load.Document;
        }

        public static LoadResult LoadManifestAt(string root)
        {
            Directory.CreateDirectory(root);
            var path = Path.Combine(root, "manifest.json");
            var bak = path + ".bak";
            var tmp = path + ".tmp";

            var primary = TryParseCandidate(path);
            var tmpCand = TryParseCandidate(tmp);
            var bakCand = TryParseCandidate(bak);

            var anyFile =
                File.Exists(path) || File.Exists(tmp) || File.Exists(bak);

            if (!anyFile)
            {
                return new LoadResult
                {
                    Ok = true,
                    Document = new ManifestDocument(),
                    RecoveredFrom = "empty",
                };
            }

            // Prefer newest valid complete state by nextSequence, then entry count, then mtime.
            var best = PickBest(primary, tmpCand, bakCand);
            if (best.Doc == null)
            {
                return new LoadResult
                {
                    Ok = false,
                    Document = null,
                    Code = UnrecoverableCode,
                    Message = "all manifest candidates corrupt; refusing empty overwrite",
                };
            }

            NormalizeSequences(best.Doc);

            // If primary is missing/corrupt and we recovered from tmp/bak, restore primary without
            // overwriting a valid bak with an invalid primary.
            if (best.Source != "primary")
            {
                try
                {
                    if (primary.Doc == null && File.Exists(path) == false)
                    {
                        // Promote recovery candidate to primary via temp write (do not touch bak if it is the source).
                        SaveManifestAtomic(root, best.Doc, out _);
                    }
                    else if (primary.Doc == null && File.Exists(path))
                    {
                        // Corrupt primary present: leave bak intact; write recovered state to primary via temp.
                        // SaveManifestAtomic validates/preserves bak only when primary parses — override carefully.
                        PromoteWithoutClobberingGoodBak(root, best.Doc, bakCand.Doc != null);
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("HertzAnalyticsPendingQueue: recovery promote failed: " + ex.Message);
                }
            }

            return new LoadResult
            {
                Ok = true,
                Document = best.Doc,
                RecoveredFrom = best.Source,
            };
        }

        public static bool SaveManifestAtomic(string root, ManifestDocument doc, out string error)
        {
            error = null;
            Directory.CreateDirectory(root);
            var path = Path.Combine(root, "manifest.json");
            var tmp = path + ".tmp";
            var bak = path + ".bak";
            try
            {
                if (doc.entries == null) doc.entries = Array.Empty<ManifestEntry>();
                NormalizeSequences(doc);
                var json = JsonUtility.ToJson(doc, true);
                using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
                using (var sw = new StreamWriter(fs, new UTF8Encoding(false)))
                {
                    sw.Write(json);
                    sw.Flush();
                    fs.Flush(true);
                }

                // Only overwrite .bak when current primary is a valid complete manifest.
                if (File.Exists(path))
                {
                    var primaryOk = TryParseCandidate(path);
                    if (primaryOk.Doc != null)
                    {
                        File.Copy(path, bak, overwrite: true);
                    }
                    // else: keep existing last-known-good bak

                    var replaceBak = path + ".replace_bak";
                    File.Replace(tmp, path, replaceBak);
                    try { if (File.Exists(replaceBak)) File.Delete(replaceBak); } catch { /* ok */ }
                }
                else
                {
                    File.Move(tmp, path);
                }

                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ok */ }
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ok */ }
                return false;
            }
        }

        private static void PromoteWithoutClobberingGoodBak(string root, ManifestDocument recovered, bool bakIsGood)
        {
            var path = Path.Combine(root, "manifest.json");
            var tmp = path + ".tmp";
            var json = JsonUtility.ToJson(recovered, true);
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (bakIsGood)
            {
                // Replace primary only; do not copy corrupt primary over bak.
                if (File.Exists(path)) File.Delete(path);
                File.Move(tmp, path);
            }
            else
            {
                SaveManifestAtomic(root, recovered, out _);
            }
        }

        private struct Candidate
        {
            public ManifestDocument Doc;
            public string Source;
            public long NextSequence;
            public int EntryCount;
            public DateTime MtimeUtc;
        }

        private static Candidate TryParseCandidate(string path)
        {
            var c = new Candidate { Source = Path.GetFileName(path) };
            if (!File.Exists(path)) return c;
            try
            {
                c.MtimeUtc = File.GetLastWriteTimeUtc(path);
                var text = File.ReadAllText(path, Encoding.UTF8);
                var doc = JsonUtility.FromJson<ManifestDocument>(text);
                if (doc == null || doc.version < 1) return c;
                if (doc.entries == null) doc.entries = Array.Empty<ManifestEntry>();
                if (doc.nextSequence < 1) doc.nextSequence = 1;
                c.Doc = doc;
                c.NextSequence = doc.nextSequence;
                c.EntryCount = doc.entries.Length;
                if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) c.Source = "tmp";
                else if (path.EndsWith(".bak", StringComparison.OrdinalIgnoreCase)) c.Source = "bak";
                else c.Source = "primary";
                return c;
            }
            catch
            {
                return new Candidate { Source = Path.GetFileName(path) };
            }
        }

        private static Candidate PickBest(Candidate primary, Candidate tmp, Candidate bak)
        {
            Candidate best = default;
            void Consider(Candidate c)
            {
                if (c.Doc == null) return;
                if (best.Doc == null)
                {
                    best = c;
                    return;
                }

                if (c.NextSequence != best.NextSequence)
                {
                    if (c.NextSequence > best.NextSequence) best = c;
                    return;
                }

                if (c.EntryCount != best.EntryCount)
                {
                    if (c.EntryCount > best.EntryCount) best = c;
                    return;
                }

                if (c.MtimeUtc > best.MtimeUtc) best = c;
            }

            Consider(primary);
            Consider(tmp);
            Consider(bak);
            return best;
        }

        private static void NormalizeSequences(ManifestDocument doc)
        {
            if (doc.entries == null) doc.entries = Array.Empty<ManifestEntry>();
            long max = 0;
            var seen = new HashSet<long>();
            foreach (var e in doc.entries)
            {
                if (e == null) continue;
                if (e.sequence < 1 || !seen.Add(e.sequence))
                {
                    // Assign later in second pass
                }
                else if (e.sequence > max) max = e.sequence;
            }

            long next = max + 1;
            seen.Clear();
            foreach (var e in doc.entries)
            {
                if (e == null) continue;
                if (e.sequence >= 1 && seen.Add(e.sequence))
                {
                    if (e.sequence > max) max = e.sequence;
                    continue;
                }

                e.sequence = next++;
                seen.Add(e.sequence);
                max = e.sequence;
            }

            if (doc.nextSequence <= max) doc.nextSequence = max + 1;
            if (doc.nextSequence < 1) doc.nextSequence = 1;
        }

        private static bool ValidatePayload(ManifestEntry e, string fullPath, out string error)
        {
            error = null;
            if (!File.Exists(fullPath))
            {
                error = "missing_payload";
                return false;
            }

            try
            {
                var bytes = File.ReadAllBytes(fullPath);
                if (e.bytes > 0 && bytes.LongLength != e.bytes)
                {
                    error = "payload_byte_length_mismatch";
                    return false;
                }

                var diskHash = Sha256Hex(bytes);
                if (!string.IsNullOrEmpty(e.payloadSha256) &&
                    !string.Equals(diskHash, e.payloadSha256, StringComparison.OrdinalIgnoreCase))
                {
                    error = "payload_hash_mismatch";
                    return false;
                }

                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static ManifestEntry FindEntry(ManifestDocument doc, string id)
        {
            if (doc?.entries == null) return null;
            foreach (var e in doc.entries)
            {
                if (e != null && string.Equals(e.captureId, id, StringComparison.Ordinal))
                    return e;
            }

            return null;
        }

        private static StageResult FailStage(string code, string message) =>
            new StageResult { Ok = false, Code = code, Message = message };

        public static string Sha256Hex(byte[] bytes)
        {
            using var sha = SHA256.Create();
            var hash = sha.ComputeHash(bytes);
            var sb = new StringBuilder(hash.Length * 2);
            foreach (var b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        public static string Sha256File(string path)
        {
            if (!File.Exists(path)) return null;
            return Sha256Hex(File.ReadAllBytes(path));
        }
    }
}
