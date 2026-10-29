using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using UnityEngine.XR;
using Debug = UnityEngine.Debug;

namespace HertzStudio.Editor
{
    /// <summary>
    /// Loopback-only HTTP bridge for the outbound HERTZ Studio connector.
    /// Mutating routes require the paired bridge token. Editor assembly Ã¢â€ â€™ excluded from player builds.
    /// </summary>
    [InitializeOnLoad]
    public static class HertzStudioHttpBridge
    {
        private const string PrefRevisionPrefix = "HertzStudio.UnityRevision.";
        private const string PrefFingerprintPrefix = "HertzStudio.ContentFingerprint.";
        private const int DefaultBridgePort = 8791;
        private const int MaxStartRetries = 40;
        private const double StartRetryDelaySeconds = 0.75d;
        /// <summary>Delay after domain reload so the prior TcpListener Accept unbinds and releases 8791.</summary>
        private const double PostDomainReloadDelaySeconds = 5.0d;
        private const double BusyEditorRetryDelaySeconds = 2.0d;
        // Bumped to force a real script recompile / domain reload for lifecycle proofs.
        private const string CompileStamp = "bridge-target-review-20261028T0001Z";
        private const float PlaceScaleMin = 0.001f;
        private const float PlaceScaleMax = 1000f;
        private const string IncomingStagingRelative = "Library/HertzStudioIncoming";

        private static int CurrentProcessId => Process.GetCurrentProcess().Id;

        // TcpListener (not HttpListener): HTTP.SYS retains HttpListener prefixes across Unity
        // domain reloads and leaves a zombie accept that times out /health forever.
        private static System.Net.Sockets.TcpListener _listener;
        private static Thread _thread;
        private static volatile bool _running;
        private static readonly Queue<Action> MainThreadQueue = new Queue<Action>();
        private static readonly object QueueLock = new object();
        private static readonly object ResultLock = new object();
        private static readonly object ImportJobLock = new object();
        private static readonly HashSet<string> InFlightImportRequestIds = new HashSet<string>(StringComparer.Ordinal);
        private static bool _suppressRevisionBump;
        private static string _bridgeToken;
        private static int _bridgePort = DefaultBridgePort;
        private static int _startRetries;
        private static bool _startScheduled;
        private static double _nextStartAttemptAt;
        /// <summary>When true, OccupiedUnresponsive keeps retrying (manual Restart Bridge).</summary>
        private static bool _forceOccupiedRetries;

        static HertzStudioHttpBridge()
        {
            EditorApplication.update += PumpMainThread;
            EditorApplication.quitting += Stop;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
            AssemblyReloadEvents.afterAssemblyReload += OnAfterAssemblyReload;
            ObjectChangeEvents.changesPublished += OnObjectChanges;
            EditorSceneManager.sceneOpened += OnSceneOpened;
            EditorSceneManager.sceneClosing += OnSceneClosing;
            ReloadBridgeToken();
            // Never bind inside the static ctor during domain reload Ã¢â‚¬â€ OnAfterAssemblyReload
            // owns the delayed start. Cold editor open also goes through that event.
            _startRetries = 0;
            ScheduleStart("initialize_on_load", PostDomainReloadDelaySeconds, replace: true);
        }

        private static void OnBeforeAssemblyReload()
        {
            Debug.Log(
                $"HERTZ bridge DOMAIN_RELOAD before pid={CurrentProcessId} stamp={CompileStamp} port={BridgePort}");
            Stop();
        }

        private static void OnAfterAssemblyReload()
        {
            Debug.Log(
                $"HERTZ bridge DOMAIN_RELOAD after pid={CurrentProcessId} stamp={CompileStamp}");
            _startRetries = 0;
            ScheduleStart("after_assembly_reload", PostDomainReloadDelaySeconds, replace: true);
            // Opt-in one-shot: Tools/HertzStudio/data/pending-editor-menu.txt containing a MenuItem path.
            // File is deleted before ExecuteMenuItem so it never re-fires on later sessions.
            EditorApplication.delayCall += ConsumePendingEditorMenuOnce;
        }

        private static void ConsumePendingEditorMenuOnce()
        {
            try
            {
                var path = Path.GetFullPath("Tools/HertzStudio/data/pending-editor-menu.txt");
                if (!File.Exists(path)) return;
                var menu = File.ReadAllText(path, Encoding.UTF8).Trim();
                File.Delete(path);
                if (string.IsNullOrEmpty(menu)) return;
                Debug.Log("HERTZ pending-editor-menu: " + menu);
                EditorApplication.ExecuteMenuItem(menu);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("HERTZ pending-editor-menu failed: " + ex.Message);
            }
        }

        private static void ScheduleStart(string reason, double delaySeconds = -1d, bool replace = false)
        {
            if (_startScheduled)
            {
                if (!replace)
                {
                    return;
                }

                CancelScheduledStart();
            }

            var delay = delaySeconds >= 0d ? delaySeconds : StartRetryDelaySeconds;
            _startScheduled = true;
            _nextStartAttemptAt = EditorApplication.timeSinceStartup + delay;
            EditorApplication.update += RetryScheduledStart;
            Debug.Log(
                $"HERTZ bridge ScheduleStart({reason}) delay={delay:0.00}s pid={CurrentProcessId}");
        }

        private static void RetryScheduledStart()
        {
            if (!_startScheduled || EditorApplication.timeSinceStartup < _nextStartAttemptAt)
            {
                return;
            }

            CancelScheduledStart();
            // Unity can invoke InitializeOnLoad while startup imports or another script compilation
            // is still pending. Binding in that window can strand the listener in the unloading
            // AppDomain: TCP accepts connections, but no managed request loop survives. Wait until
            // the Editor is idle before creating the socket.
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                ScheduleStart("editor_busy", BusyEditorRetryDelaySeconds, replace: true);
                return;
            }

            Start();
        }

        private static void CancelScheduledStart()
        {
            if (!_startScheduled)
            {
                return;
            }

            EditorApplication.update -= RetryScheduledStart;
            _startScheduled = false;
        }

        private static string ProjectRoot
        {
            get
            {
                var data = Application.dataPath.Replace('\\', '/');
                return Directory.GetParent(data)?.FullName ?? data;
            }
        }

        private static string ResultsPath =>
            Path.Combine(ProjectRoot, "Tools", "HertzStudio", "data", "unity-request-results.json");

        private static string BridgeTokenPath =>
            Path.Combine(ProjectRoot, "Tools", "HertzStudio", "data", "secrets", "bridge-token.json");

        private static void ReloadBridgeToken()
        {
            _bridgeToken = null;
            _bridgePort = DefaultBridgePort;
            try
            {
                if (!File.Exists(BridgeTokenPath))
                {
                    return;
                }

                var json = File.ReadAllText(BridgeTokenPath);
                _bridgeToken = ReadString(json, "bridgeToken");
                var configuredPort = ReadInt(json, "bridgePort");
                if (configuredPort >= 1024 && configuredPort <= 65535)
                {
                    _bridgePort = configuredPort;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"HERTZ bridge token load failed: {ex.Message}");
            }
        }

        private static int BridgePort => _bridgePort > 0 ? _bridgePort : DefaultBridgePort;

        /// <summary>
        /// Persist a failover bridgePort into bridge-token.json so connector/API stay aligned.
        /// Does not log or return the token value.
        /// </summary>
        private static bool TryPersistBridgePort(int newPort)
        {
            try
            {
                if (newPort < 1024 || newPort > 65535) return false;
                if (!File.Exists(BridgeTokenPath)) return false;
                var json = File.ReadAllText(BridgeTokenPath);
                if (string.IsNullOrEmpty(json)) return false;
                // Replace existing "bridgePort": N or insert after opening brace.
                var replaced = System.Text.RegularExpressions.Regex.Replace(
                    json,
                    "\"bridgePort\"\\s*:\\s*\\d+",
                    "\"bridgePort\": " + newPort.ToString(CultureInfo.InvariantCulture));
                if (ReferenceEquals(replaced, json) || replaced == json)
                {
                    if (json.IndexOf("\"bridgePort\"", StringComparison.Ordinal) >= 0)
                        return false;
                    var insertAt = json.IndexOf('{');
                    if (insertAt < 0) return false;
                    replaced = json.Insert(insertAt + 1,
                        "\n  \"bridgePort\": " + newPort.ToString(CultureInfo.InvariantCulture) + ",");
                }

                var dir = Path.GetDirectoryName(BridgeTokenPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(BridgeTokenPath, replaced);
                _bridgePort = newPort;
                Debug.Log(
                    $"HERTZ bridge: persisted failover bridgePort={newPort} (zombie previous port). Connector must reread token.");
                return true;
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"HERTZ bridge: failed to persist failover port: {ex.Message}");
                return false;
            }
        }

        private static bool TryBindNextFreePort(int fromPort, int span, out int boundPort)
        {
            boundPort = 0;
            for (var i = 1; i <= span; i++)
            {
                var candidate = fromPort + i;
                if (candidate > 65535) break;
                try
                {
                    var probe = new TcpListener(IPAddress.Loopback, candidate);
                    probe.Start(1);
                    probe.Stop();
                    boundPort = candidate;
                    return true;
                }
                catch
                {
                    // try next
                }
            }

            return false;
        }

        private static void Start()
        {
            if (_running && _listener != null)
            {
                return;
            }

            Stop();
            try
            {
                ReloadBridgeToken();
                // Do not set ReuseAddress on Windows Ã¢â‚¬â€ it can yield WSAEACCES (10013) under Unity/Mono.
                var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, BridgePort);
                listener.Start(8);
                _listener = listener;
                _running = true;
                _thread = new Thread(ListenLoop)
                {
                    IsBackground = true,
                    Name = "HertzStudioHttpBridge"
                };
                _thread.Start();
                _startRetries = 0;
                _forceOccupiedRetries = false;
                CancelScheduledStart();
                Debug.Log(
                    $"HERTZ Studio Editor bridge listening on http://127.0.0.1:{BridgePort}/ stamp={CompileStamp} pid={CurrentProcessId} transport=tcp");
            }
            catch (Exception ex)
            {
                Debug.LogWarning(
                    $"HERTZ Studio Editor bridge failed to start: {ex.Message} stamp={CompileStamp} pid={CurrentProcessId}");
                _running = false;
                var failedListener = _listener;
                _listener = null;
                if (failedListener != null)
                {
                    try
                    {
                        failedListener.Stop();
                    }
                    catch
                    {
                        // A failed bind may already have closed its listener.
                    }
                }

                // Same Editor PID can still own 8791 after a partial Stop/domain reload. Probe and
                // WSAEADDRINUSE both mean further bind retries are useless (healthy orphan, zombie
                // Listen, or OS-held exclusive bind that refuses client connect).
                var portState = ProbeBridgePort();
                if (portState == BridgePortProbe.Healthy)
                {
                    Debug.LogWarning(
                        $"HERTZ bridge: port {BridgePort} already answers health for pid={CurrentProcessId}. " +
                        "Cancelling bind retries. Use Tools > HERTZ Studio > Restart Bridge if needed.");
                    _startRetries = 0;
                    CancelScheduledStart();
                    return;
                }

                if (portState == BridgePortProbe.OccupiedUnresponsive || IsAddressInUse(ex))
                {
                    // After a couple of Stop/wait failures, failover to the next free loopback port
                    // and persist it so the connector stays aligned (same pattern as W03 8791â†’8792).
                    if (_forceOccupiedRetries && _startRetries >= 2 &&
                        TryBindNextFreePort(BridgePort, 5, out var nextPort) &&
                        TryPersistBridgePort(nextPort))
                    {
                        _startRetries = 0;
                        ScheduleStart($"port_failover_{nextPort}", 0.5d, replace: true);
                        return;
                    }

                    if (_forceOccupiedRetries && _startRetries < MaxStartRetries)
                    {
                        _startRetries++;
                        // Same-PID zombie Listen sockets sometimes release a few seconds after Stop().
                        var delay = Math.Min(8d, 1.5d + (_startRetries * 0.75d));
                        Debug.LogWarning(
                            $"HERTZ bridge: port {BridgePort} OccupiedUnresponsive â€” forced retry " +
                            $"{_startRetries}/{MaxStartRetries} in {delay:0.00}s (pid={CurrentProcessId}).");
                        ScheduleStart($"occupied_retry {_startRetries}/{MaxStartRetries}", delay, replace: true);
                        return;
                    }

                    Debug.LogWarning(
                        $"HERTZ bridge: port {BridgePort} cannot be rebound " +
                        $"(probe={portState}, addrInUse={IsAddressInUse(ex)}, pid={CurrentProcessId}). " +
                        "Cancelling bind retries. Use Tools > HERTZ Studio > Restart Bridge; if health " +
                        "still fails, save work and restart the Unity Editor.");
                    _startRetries = 0;
                    _forceOccupiedRetries = false;
                    CancelScheduledStart();
                    return;
                }

                if (_startRetries < MaxStartRetries)
                {
                    _startRetries++;
                    ScheduleStart($"retry {_startRetries}/{MaxStartRetries}");
                }
            }
        }

        private static bool IsAddressInUse(Exception ex)
        {
            if (ex == null)
            {
                return false;
            }

            if (ex is SocketException socketEx &&
                (socketEx.SocketErrorCode == SocketError.AddressAlreadyInUse ||
                 socketEx.ErrorCode == 10048))
            {
                return true;
            }

            var text = ex.Message ?? string.Empty;
            return text.IndexOf("Only one usage of each socket address", StringComparison.OrdinalIgnoreCase) >= 0 ||
                   text.IndexOf("address already in use", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private enum BridgePortProbe
        {
            Free,
            Healthy,
            OccupiedUnresponsive
        }

        /// <summary>
        /// Probes loopback bridge port. OccupiedUnresponsive covers zombie Listen sockets that
        /// complete TCP but never return HTTP â€” the failure mode that previously drove a 40Ã— retry storm.
        /// </summary>
        private static BridgePortProbe ProbeBridgePort()
        {
            try
            {
                using (var client = new System.Net.Sockets.TcpClient())
                {
                    var connect = client.BeginConnect(IPAddress.Loopback, BridgePort, null, null);
                    if (!connect.AsyncWaitHandle.WaitOne(400))
                    {
                        return BridgePortProbe.Free;
                    }

                    client.EndConnect(connect);
                    using (var stream = client.GetStream())
                    {
                        stream.ReadTimeout = 500;
                        stream.WriteTimeout = 400;
                        var req = System.Text.Encoding.ASCII.GetBytes(
                            "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
                        stream.Write(req, 0, req.Length);
                        var buf = new byte[512];
                        try
                        {
                            var n = stream.Read(buf, 0, buf.Length);
                            if (n > 0)
                            {
                                var text = System.Text.Encoding.ASCII.GetString(buf, 0, n);
                                if (text.IndexOf("HTTP/1.", StringComparison.Ordinal) >= 0)
                                {
                                    return BridgePortProbe.Healthy;
                                }
                            }
                        }
                        catch (IOException)
                        {
                            // Read timeout / reset while the port still accepted TCP â†’ zombie listener.
                        }

                        return BridgePortProbe.OccupiedUnresponsive;
                    }
                }
            }
            catch (SocketException)
            {
                return BridgePortProbe.Free;
            }
            catch
            {
                return BridgePortProbe.Free;
            }
        }

        private static void Stop()
        {
            CancelScheduledStart();
            _running = false;
            var listener = _listener;
            var thread = _thread;
            _listener = null;
            _thread = null;

            // TcpListener.Stop unblocks AcceptTcpClient and releases the port without HTTP.SYS.
            if (listener != null)
            {
                try
                {
                    listener.Stop();
                }
                catch
                {
                    // Stop may throw if the listener never completed startup.
                }
            }

            if (thread != null && thread.IsAlive && thread != Thread.CurrentThread)
            {
                try
                {
                    thread.Join(3000);
                }
                catch
                {
                    // Join can fail during domain unload.
                }
            }
        }

        [MenuItem("Tools/HERTZ Studio/Restart Bridge")]
        private static void RestartBridgeMenu()
        {
            Debug.Log($"HERTZ bridge Restart Bridge requested pid={CurrentProcessId} stamp={CompileStamp}");
            _startRetries = 0;
            _forceOccupiedRetries = true;
            CancelScheduledStart();
            Stop();
            // Longer pause so Stop()'s Accept unblock / Join can release a same-PID zombie Listen.
            ScheduleStart("restart_bridge_menu", 2.5d, replace: true);
        }

        private static void OnSceneOpened(Scene scene, OpenSceneMode mode)
        {
            EnsureRevisionInitialized(scene);
        }

        private static void OnSceneClosing(Scene scene, bool removingScene)
        {
            // Force fingerprint refresh next time so reload/reopen is observed.
            if (!string.IsNullOrEmpty(scene.path))
            {
                EditorPrefs.DeleteKey(PrefFingerprintPrefix + scene.path);
            }
        }

        private static void OnObjectChanges(ref ObjectChangeEventStream stream)
        {
            if (_suppressRevisionBump)
            {
                return;
            }

            var scene = SceneManager.GetActiveScene();
            if (!scene.IsValid() || string.IsNullOrEmpty(scene.path))
            {
                return;
            }

            for (var i = 0; i < stream.length; i++)
            {
                var type = stream.GetEventType(i);
                if (type == ObjectChangeKind.ChangeGameObjectOrComponentProperties ||
                    type == ObjectChangeKind.ChangeGameObjectParent ||
                    type == ObjectChangeKind.ChangeGameObjectStructure ||
                    type == ObjectChangeKind.CreateGameObjectHierarchy ||
                    type == ObjectChangeKind.DestroyGameObjectHierarchy ||
                    type == ObjectChangeKind.ChangeScene)
                {
                    // Only bump when content fingerprint actually changed (bridge-originated
                    // deferred events must not invalidate the revision just acknowledged).
                    BumpRevisionForContentChange(scene);
                    return;
                }
            }
        }

        private static void EnsureRevisionInitialized(Scene scene)
        {
            if (string.IsNullOrEmpty(scene.path))
            {
                return;
            }

            var fingerprint = ComputeContentFingerprint(scene);
            var stored = EditorPrefs.GetString(PrefFingerprintPrefix + scene.path, string.Empty);
            if (string.IsNullOrEmpty(stored))
            {
                EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, fingerprint);
                if (!EditorPrefs.HasKey(PrefRevisionPrefix + scene.path))
                {
                    SetRevision(scene.path, 0);
                }

                return;
            }

            if (!string.Equals(stored, fingerprint, StringComparison.Ordinal))
            {
                BumpRevisionForContentChange(scene);
            }
        }

        private static void BumpRevisionForContentChange(Scene scene)
        {
            var fingerprint = ComputeContentFingerprint(scene);
            var stored = EditorPrefs.GetString(PrefFingerprintPrefix + scene.path, string.Empty);
            if (string.Equals(stored, fingerprint, StringComparison.Ordinal))
            {
                return;
            }

            var next = GetRevision(scene.path) + 1;
            SetRevision(scene.path, next);
            EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, fingerprint);
        }

        private static void PumpMainThread()
        {
            while (true)
            {
                Action action = null;
                lock (QueueLock)
                {
                    if (MainThreadQueue.Count > 0)
                    {
                        action = MainThreadQueue.Dequeue();
                    }
                }

                if (action == null)
                {
                    break;
                }

                action();
            }
        }

        private static void EnqueueMain(Action action)
        {
            lock (QueueLock)
            {
                MainThreadQueue.Enqueue(action);
            }
        }

        private static void ListenLoop()
        {
            var listener = _listener;
            while (_running && listener != null)
            {
                TcpClient client;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch
                {
                    // Stop() unblocks AcceptTcpClient Ã¢â‚¬â€ exit when shutting down.
                    break;
                }

                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try
                    {
                        HandleClient(client);
                    }
                    catch (Exception ex)
                    {
                        Debug.LogWarning($"HERTZ bridge request failed: {ex.Message}");
                        try
                        {
                            client.Close();
                        }
                        catch
                        {
                            // Ignore close races.
                        }
                    }
                });
            }
        }

        private static void HandleClient(TcpClient client)
        {
            using (client)
            using (var stream = client.GetStream())
            {
                client.NoDelay = true;
                client.ReceiveTimeout = 15000;
                client.SendTimeout = 15000;
                var exchange = ReadHttpExchange(stream);
                if (exchange == null)
                {
                    return;
                }

                HandleRequest(exchange);
            }
        }

        private static BridgeHttpExchange ReadHttpExchange(NetworkStream stream)
        {
            var headerBytes = new List<byte>(512);
            var buffer = new byte[1];
            while (headerBytes.Count < 65536)
            {
                var read = stream.Read(buffer, 0, 1);
                if (read <= 0)
                {
                    return null;
                }

                headerBytes.Add(buffer[0]);
                var n = headerBytes.Count;
                if (n >= 4 &&
                    headerBytes[n - 4] == (byte)'\r' &&
                    headerBytes[n - 3] == (byte)'\n' &&
                    headerBytes[n - 2] == (byte)'\r' &&
                    headerBytes[n - 1] == (byte)'\n')
                {
                    break;
                }
            }

            var headerText = Encoding.ASCII.GetString(headerBytes.ToArray());
            var lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0)
            {
                return null;
            }

            var parts = lines[0].Split(' ');
            if (parts.Length < 2)
            {
                return null;
            }

            var method = parts[0];
            var target = parts[1];
            var path = target;
            var query = string.Empty;
            var q = target.IndexOf('?');
            if (q >= 0)
            {
                path = target.Substring(0, q);
                query = target.Substring(q + 1);
            }

            path = path.TrimEnd('/');
            if (string.IsNullOrEmpty(path))
            {
                path = "/";
            }

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 1; i < lines.Length; i++)
            {
                var line = lines[i];
                if (string.IsNullOrEmpty(line))
                {
                    break;
                }

                var colon = line.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                var name = line.Substring(0, colon).Trim();
                var value = line.Substring(colon + 1).Trim();
                headers[name] = value;
            }

            var contentLength = 0;
            if (headers.TryGetValue("Content-Length", out var lengthText))
            {
                int.TryParse(lengthText, out contentLength);
            }

            if (contentLength < 0 || contentLength > 32 * 1024 * 1024)
            {
                contentLength = 0;
            }

            var body = string.Empty;
            if (contentLength > 0)
            {
                var bodyBytes = new byte[contentLength];
                var offset = 0;
                while (offset < contentLength)
                {
                    var read = stream.Read(bodyBytes, offset, contentLength - offset);
                    if (read <= 0)
                    {
                        break;
                    }

                    offset += read;
                }

                body = Encoding.UTF8.GetString(bodyBytes, 0, offset);
            }

            return new BridgeHttpExchange(stream, method, path, query, headers, body);
        }

        private static void HandleRequest(BridgeHttpExchange context)
        {
            try
            {
                var path = context.Path;
                var method = context.Method;

                if (method == "GET" && path == "/health")
                {
                    var done = new ManualResetEventSlim(false);
                    ResponsePayload payload = null;
                    EnqueueMain(() =>
                    {
                        try
                        {
                            ReloadBridgeToken();
                            var scene = SceneManager.GetActiveScene();
                            EnsureRevisionInitialized(scene);
                            payload = new ResponsePayload(200, JsonHealth(scene));
                        }
                        catch (Exception ex)
                        {
                            payload = new ResponsePayload(500, $"{{\"error\":{Quote(ex.Message)}}}");
                        }
                        finally
                        {
                            done.Set();
                        }
                    });

                    if (!done.Wait(1500) || payload == null)
                    {
                        // Main thread stalled/unavailable Ã¢â‚¬â€ never report false-positive health.
                        // Connector treats non-2xx as unityReachable=false and leaves mutations queued.
                        WriteJson(context, 503,
                            "{\"ok\":false,\"error\":\"main_thread_unavailable\",\"bridge\":\"listening\",\"scenePath\":\"\",\"sceneName\":\"\",\"unityRevision\":-1,\"note\":\"main_thread_deferred\"}");
                        return;
                    }

                    WriteJson(context, payload.StatusCode, payload.Json);
                    return;
                }

                // Unauthenticated capability probe (formats only; no filesystem access).
                if (path == "/assets/capabilities")
                {
                    WriteJson(context, 200,
                        "{\"importAsset\":true,\"formats\":[\"glb\",\"gltf\",\"png\",\"jpg\",\"wav\",\"ogg\"],\"usdz\":false,\"importer\":\"com.unity.cloud.gltfast\"}");
                    return;
                }

                if (method == "GET" && path == "/scene/export")
                {
                    if (!IsAuthorized(context))
                    {
                        WriteJson(context, 401, "{\"error\":\"Bridge authentication required.\"}");
                        return;
                    }

                    var forceExportRequestId = context.GetQuery("forceExportRequestId");
                    RunOnMainAndRespond(context, () =>
                    {
                        var scene = SceneManager.GetActiveScene();
                        EnsureRevisionInitialized(scene);
                        return ExportScene(forceExportRequestId);
                    }, timeoutMs: 90000);
                    return;
                }

                if (!IsAuthorized(context))
                {
                    WriteJson(context, 401,
                        $"{{\"error\":\"Bridge authentication required.\",\"method\":{Quote(method)},\"path\":{Quote(path)}}}");
                    return;
                }

                var body = context.Body ?? string.Empty;
                if (method == "POST" && path == "/scene/apply")
                {
                    RunOnMainAndRespond(context, () => ApplyEdits(body));
                    return;
                }

                if (method == "POST" && path == "/scene/undo")
                {
                    RunOnMainAndRespond(context, () => UndoLast(body));
                    return;
                }

                if (method == "POST" && path == "/scene/save")
                {
                    RunOnMainAndRespond(context, () => SaveScene(body));
                    return;
                }

                if (method == "POST" && path == "/scene/reopen")
                {
                    RunOnMainAndRespond(context, () => ReopenScene(body));
                    return;
                }

                if (method == "POST" && path == "/assets/import")
                {
                    AcceptStudioAssetImport(context, body);
                    return;
                }

                if (method == "GET" && path == "/assets/import-status")
                {
                    var requestId = context.GetQuery("requestId");
                    WriteJson(context, 200, ImportStatusJson(requestId));
                    return;
                }

                if (method == "GET" && path == "/scenes")
                {
                    RunOnMainAndRespond(context, ListProjectScenes);
                    return;
                }

                if (method == "POST" && path == "/assets/place")
                {
                    RunOnMainAndRespond(context, () => PlaceAssetInScene(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/sync")
                {
                    RunOnMainAndRespond(context, () => SyncWeaponDefinition(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/delete")
                {
                    RunOnMainAndRespond(context, () => DeleteWeaponDefinition(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/resolve")
                {
                    RunOnMainAndRespond(context, () => ResolveWeaponDefinition(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/deploy")
                {
                    RunOnMainAndRespond(context, () => DeployWeaponRuntime(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/inspect-prefab")
                {
                    RunOnMainAndRespond(context, () => InspectWeaponPrefab(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/create-anchor-wrapper")
                {
                    RunOnMainAndRespond(context, () => CreateWeaponAnchorWrapper(body));
                    return;
                }

                if (method == "POST" && path == "/weapons/confirm-anchor-wrapper")
                {
                    RunOnMainAndRespond(context, () => ConfirmWeaponAnchorWrapper(body));
                    return;
                }

                if (method == "POST" && path == "/characters/sync-model")
                {
                    RunOnMainAndRespond(context, () => SyncCharacterModel(body));
                    return;
                }

                if (method == "POST" && path == "/characters/sync-profile")
                {
                    RunOnMainAndRespond(context, () => SyncEnemyProfile(body));
                    return;
                }

                if (method == "POST" && path == "/characters/deploy")
                {
                    RunOnMainAndRespond(context, () => DeployCharacterRuntime(body));
                    return;
                }

                if (method == "POST" && path == "/characters/delete")
                {
                    RunOnMainAndRespond(context, () => DeleteCharacterDefinition(body));
                    return;
                }

                if (method == "POST" && path == "/characters/validate-animation")
                {
                    RunOnMainAndRespond(context, () => ValidateCharacterAnimation(body));
                    return;
                }

                if (method == "GET" && path == "/analytics/pending-capture")
                {
                    RunOnMainAndRespond(context, GetPendingAnalyticsCapture);
                    return;
                }

                if (method == "POST" && path == "/analytics/ack-capture")
                {
                    RunOnMainAndRespond(context, () => AckPendingAnalyticsCapture(body));
                    return;
                }

                if (method == "POST" && path == "/analytics/stage-capture")
                {
                    RunOnMainAndRespond(context, () => StageAnalyticsCaptureFromBody(body));
                    return;
                }

                if (method == "POST" && path == "/sound/sync")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioSoundCommands.SyncSoundBoard(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/materials/targets")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioMaterialCommands.ListTargets(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }
                if (method == "POST" && path == "/materials/inspect")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioMaterialCommands.Inspect(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/materials/apply")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioMaterialCommands.Apply(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/materials/undo")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioMaterialCommands.Undo(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/materials/hdri")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioMaterialCommands.ApplyHdri(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/animation/probe")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.AnimationProbe(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/animation/assign")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.AnimationAssign(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/performance/inspect-static")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.PerformanceInspectStatic(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/performance/editor-capture")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.PerformanceEditorCapture(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/snapshots/capture")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.SnapshotsCapture(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/snapshots/restore")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.SnapshotsRestore(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/encounters/validate")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.EncountersValidate(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/encounters/apply")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.EncountersApply(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                if (method == "POST" && path == "/encounters/runtime")
                {
                    RunOnMainAndRespond(context, () =>
                    {
                        var result = HertzStudioW08W14Commands.EncountersRuntime(body);
                        return new ResponsePayload(result.StatusCode, result.Json);
                    });
                    return;
                }

                WriteJson(context, 404,
                    $"{{\"error\":\"Not found.\",\"method\":{Quote(method)},\"path\":{Quote(path)}}}");
            }
            catch (Exception ex)
            {
                WriteJson(context, 500, $"{{\"error\":{Quote(ex.Message)}}}");
            }
        }

        private static bool IsAuthorized(BridgeHttpExchange request)
        {
            ReloadBridgeToken();
            if (string.IsNullOrEmpty(_bridgeToken))
            {
                return false;
            }

            var header = request.GetHeader("x-hertz-bridge-token");
            if (string.IsNullOrEmpty(header))
            {
                var auth = request.GetHeader("Authorization");
                if (!string.IsNullOrEmpty(auth) && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                {
                    header = auth.Substring("Bearer ".Length).Trim();
                }
            }

            if (string.IsNullOrEmpty(header) || header.Length != _bridgeToken.Length)
            {
                return false;
            }

            var mismatch = 0;
            for (var i = 0; i < header.Length; i++)
            {
                mismatch |= header[i] ^ _bridgeToken[i];
            }

            return mismatch == 0;
        }

        private static void RunOnMainAndRespond(BridgeHttpExchange context, Func<ResponsePayload> work, int timeoutMs = 20000)
        {
            var done = new ManualResetEventSlim(false);
            ResponsePayload payload = null;
            Exception error = null;

            EnqueueMain(() =>
            {
                try
                {
                    payload = work();
                }
                catch (Exception ex)
                {
                    error = ex;
                }
                finally
                {
                    done.Set();
                }
            });

            if (!done.Wait(timeoutMs > 0 ? timeoutMs : 20000))
            {
                WriteJson(context, 504, "{\"error\":\"Timed out waiting for Unity main thread.\"}");
                return;
            }

            if (error != null)
            {
                WriteJson(context, 500, $"{{\"error\":{Quote(error.Message)}}}");
                return;
            }

            WriteJson(context, payload.StatusCode, payload.Json);
        }
        /// <summary>Non-mutating export helper for editor proofs (same payload as GET /scene/export).</summary>
        public static string ExportSceneForProof(out int statusCode)
        {
            var payload = ExportScene(null);
            statusCode = payload.StatusCode;
            return payload.Json;
        }

        private static ResponsePayload ExportScene(string forceExportRequestId = null)
        {
            var scene = SceneManager.GetActiveScene();
            EnsureRevisionInitialized(scene);
            var revision = GetRevision(scene.path);
            var fingerprint = ComputeContentFingerprint(scene);
            EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, fingerprint);
            var objects = new List<string>();
            foreach (var root in scene.GetRootGameObjects())
            {
                var rootId = GlobalObjectId.GetGlobalObjectIdSlow(root).ToString();
                CollectObjects(root.transform, objects, null, rootId, 0, root.transform.GetSiblingIndex());
            }

            // exportSchemaVersion bumps when object provenance / render snapshot fields change so Studio can
            // refresh drafts even when unityRevision is unchanged.
            const int exportSchemaVersion = 3;
            string renderSnapshotJson = "null";
            try
            {
                var snapshot = HertzStudioRenderSnapshotExporter.ExportActiveScene(
                    fingerprint,
                    string.IsNullOrEmpty(forceExportRequestId) ? null : forceExportRequestId,
                    revision);
                if (snapshot != null && snapshot.Ok) renderSnapshotJson = snapshot.Json;
            }
            catch (Exception snapEx)
            {
                Debug.LogWarning($"[HertzStudio] render snapshot skipped: {snapEx.Message}");
            }

            var forceJson = string.IsNullOrEmpty(forceExportRequestId) ? "null" : Quote(forceExportRequestId);
            var json =
                "{" +
                $"\"scenePath\":{Quote(scene.path)}," +
                $"\"sceneName\":{Quote(scene.name)}," +
                $"\"unityRevision\":{revision}," +
                $"\"exportSchemaVersion\":{exportSchemaVersion}," +
                $"\"contentFingerprint\":{Quote(fingerprint)}," +
                $"\"forceExportRequestId\":{forceJson}," +
                $"\"renderSnapshot\":{renderSnapshotJson}," +
                $"\"objects\":[{string.Join(",", objects)}]" +
                "}";
            return new ResponsePayload(200, json);
        }

        private static void CollectObjects(
            Transform transform,
            List<string> objects,
            string parentObjectId,
            string rootObjectId,
            int depth,
            int siblingIndex)
        {
            var go = transform.gameObject;
            var id = GlobalObjectId.GetGlobalObjectIdSlow(go).ToString();
            var localP = transform.localPosition;
            var localR = transform.localEulerAngles;
            var localS = transform.localScale;
            var worldP = transform.position;
            var worldR = transform.eulerAngles;
            var worldS = transform.lossyScale;

            ClassifyExportObject(
                go,
                out var renderRole,
                out var renderCategory,
                out var rendererType,
                out var meshAssetPath,
                out var materialNames,
                out var boundsJson,
                out var prefabAssetPath,
                out var sourceAssetGuid,
                out var isPrefabInstanceRoot,
                out var assetId,
                out var browserPreviewAvailable);

            var mats = materialNames.Count > 0
                ? "[" + string.Join(",", materialNames.ConvertAll(Quote)) + "]"
                : "[]";

            // Authoritative typed-target / walkability metadata (schema v1). Not name heuristics.
            const int targetMetadataSchema = 1;
            var renderer = go.GetComponent<Renderer>();
            var hasRenderer = renderer != null;
            var materialSlotCount = hasRenderer && renderer.sharedMaterials != null
                ? renderer.sharedMaterials.Length
                : 0;
            var hasSpriteRenderer = go.GetComponent<SpriteRenderer>() != null;
            var hasUiImage = go.GetComponent<UnityEngine.UI.Image>() != null;
            var hasAudioSource = go.GetComponent<AudioSource>() != null;
            var hasAnimator = go.GetComponent<Animator>() != null;
            var isProtected = HertzStudioSceneCommands.IsProtectedHierarchy(go) ||
                              renderCategory == "camera" ||
                              renderCategory == "xr_protected";
            ClassifySurfaceKind(go, out var surfaceKind, out var surfaceKindSource, out var surfaceKindSuggested);
            BuildColliderMetadata(go, out var colliderJson);

            objects.Add(
                "{" +
                $"\"objectId\":{Quote(id)}," +
                $"\"unityObjectId\":{Quote(id)}," +
                $"\"parentObjectId\":{(parentObjectId == null ? "null" : Quote(parentObjectId))}," +
                $"\"rootObjectId\":{Quote(rootObjectId ?? id)}," +
                $"\"depth\":{depth}," +
                $"\"siblingIndex\":{siblingIndex}," +
                $"\"active\":{(go.activeInHierarchy ? "true" : "false")}," +
                $"\"name\":{Quote(go.name)}," +
                // Keep world transforms on position/rotation/scale for Apply compatibility.
                $"\"position\":{{\"x\":{F(worldP.x)},\"y\":{F(worldP.y)},\"z\":{F(worldP.z)}}}," +
                $"\"rotation\":{{\"x\":{F(worldR.x)},\"y\":{F(worldR.y)},\"z\":{F(worldR.z)}}}," +
                $"\"scale\":{{\"x\":{F(localS.x)},\"y\":{F(localS.y)},\"z\":{F(localS.z)}}}," +
                $"\"localPosition\":{{\"x\":{F(localP.x)},\"y\":{F(localP.y)},\"z\":{F(localP.z)}}}," +
                $"\"localRotation\":{{\"x\":{F(localR.x)},\"y\":{F(localR.y)},\"z\":{F(localR.z)}}}," +
                $"\"localScale\":{{\"x\":{F(localS.x)},\"y\":{F(localS.y)},\"z\":{F(localS.z)}}}," +
                $"\"worldPosition\":{{\"x\":{F(worldP.x)},\"y\":{F(worldP.y)},\"z\":{F(worldP.z)}}}," +
                $"\"worldRotation\":{{\"x\":{F(worldR.x)},\"y\":{F(worldR.y)},\"z\":{F(worldR.z)}}}," +
                $"\"worldScale\":{{\"x\":{F(worldS.x)},\"y\":{F(worldS.y)},\"z\":{F(worldS.z)}}}," +
                $"\"renderRole\":{Quote(renderRole)}," +
                $"\"renderCategory\":{Quote(renderCategory)}," +
                $"\"rendererType\":{(rendererType == null ? "null" : Quote(rendererType))}," +
                $"\"meshAssetPath\":{(meshAssetPath == null ? "null" : Quote(meshAssetPath))}," +
                $"\"materialNames\":{mats}," +
                $"\"bounds\":{boundsJson}," +
                $"\"prefabInstanceRoot\":{(isPrefabInstanceRoot ? "true" : "false")}," +
                $"\"prefabAssetPath\":{(prefabAssetPath == null ? "null" : Quote(prefabAssetPath))}," +
                $"\"sourceAssetGuid\":{(sourceAssetGuid == null ? "null" : Quote(sourceAssetGuid))}," +
                $"\"assetId\":{(assetId == null ? "null" : Quote(assetId))}," +
                $"\"browserPreviewAvailable\":{(browserPreviewAvailable ? "true" : "false")}," +
                $"\"targetMetadataSchema\":{targetMetadataSchema}," +
                $"\"hasRenderer\":{(hasRenderer ? "true" : "false")}," +
                $"\"materialSlotCount\":{materialSlotCount}," +
                $"\"hasSpriteRenderer\":{(hasSpriteRenderer ? "true" : "false")}," +
                $"\"hasUiImage\":{(hasUiImage ? "true" : "false")}," +
                $"\"hasAudioSource\":{(hasAudioSource ? "true" : "false")}," +
                $"\"hasAnimator\":{(hasAnimator ? "true" : "false")}," +
                $"\"isProtected\":{(isProtected ? "true" : "false")}," +
                $"\"surfaceKind\":{(surfaceKind == null ? "null" : Quote(surfaceKind))}," +
                $"\"surfaceKindSource\":{Quote(surfaceKindSource)}," +
                $"\"surfaceKindSuggested\":{(surfaceKindSuggested == null ? "null" : Quote(surfaceKindSuggested))}," +
                $"\"collider\":{colliderJson}" +
                "}");

            for (var i = 0; i < transform.childCount; i++)
            {
                var child = transform.GetChild(i);
                CollectObjects(child, objects, id, rootObjectId ?? id, depth + 1, i);
            }
        }

        private static void ClassifyExportObject(
            GameObject go,
            out string renderRole,
            out string renderCategory,
            out string rendererType,
            out string meshAssetPath,
            out List<string> materialNames,
            out string boundsJson,
            out string prefabAssetPath,
            out string sourceAssetGuid,
            out bool isPrefabInstanceRoot,
            out string assetId,
            out bool browserPreviewAvailable)
        {
            renderRole = "empty";
            renderCategory = "empty";
            rendererType = null;
            meshAssetPath = null;
            materialNames = new List<string>();
            boundsJson = "null";
            prefabAssetPath = null;
            sourceAssetGuid = null;
            assetId = null;
            browserPreviewAvailable = false;

            var nearestPrefabRoot = PrefabUtility.GetNearestPrefabInstanceRoot(go);
            isPrefabInstanceRoot = nearestPrefabRoot == go && PrefabUtility.IsPartOfPrefabInstance(go);
            if (PrefabUtility.IsPartOfPrefabInstance(go))
            {
                prefabAssetPath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
                if (!string.IsNullOrEmpty(prefabAssetPath))
                {
                    sourceAssetGuid = AssetDatabase.AssetPathToGUID(prefabAssetPath);
                }
            }

            assetId = HertzStudioAssetProvenance.FindAssetIdInHierarchy(go);
            if (string.IsNullOrEmpty(assetId))
            {
                assetId = TryRecoverAssetIdFromImportedPath(prefabAssetPath);
            }

            if (!string.IsNullOrEmpty(assetId) && IsUuid(assetId))
            {
                // Catalog GLB/GLTF is served by Studio; Unity export never exposes raw filesystem URLs.
                browserPreviewAvailable = Directory.Exists(
                    Path.Combine(Application.dataPath, "HertzStudio", "Imported", assetId));
            }

            var nameBlob = (go.name ?? string.Empty).ToLowerInvariant();
            if (ContainsProtectedToken(nameBlob))
            {
                renderRole = "camera";
                renderCategory = "xr_protected";
                if (go.GetComponent<Camera>() != null) renderCategory = "camera";
                return;
            }

            if (go.GetComponent<Camera>() != null)
            {
                renderRole = "camera";
                renderCategory = "camera";
                return;
            }

            if (go.GetComponent<Light>() != null)
            {
                renderRole = "light";
                renderCategory = "light";
                return;
            }

            if (go.GetComponent<Canvas>() != null)
            {
                renderRole = "unsupported";
                renderCategory = "canvas";
                return;
            }

            if (go.GetComponent<ParticleSystem>() != null)
            {
                renderRole = "unsupported";
                renderCategory = "particle_system";
                return;
            }

            if (go.GetComponent<Terrain>() != null)
            {
                renderRole = "unsupported";
                renderCategory = "terrain";
                return;
            }

            var skinned = go.GetComponent<SkinnedMeshRenderer>();
            var meshFilter = go.GetComponent<MeshFilter>();
            var meshRenderer = go.GetComponent<MeshRenderer>();
            if (skinned != null)
            {
                rendererType = "SkinnedMeshRenderer";
                if (skinned.sharedMesh != null)
                {
                    meshAssetPath = AssetDatabase.GetAssetPath(skinned.sharedMesh);
                    if (string.IsNullOrEmpty(meshAssetPath)) meshAssetPath = skinned.sharedMesh.name;
                    boundsJson = BoundsJson(skinned.bounds);
                }

                CollectMaterialNames(skinned.sharedMaterials, materialNames);
                renderRole = isPrefabInstanceRoot || depthZeroRoot(go) ? "model_root" : "mesh";
                renderCategory = !string.IsNullOrEmpty(assetId) && (isPrefabInstanceRoot || nearestPrefabRoot == go)
                    ? "catalog_model_root"
                    : "skinned_mesh";
            }
            else if (meshFilter != null || meshRenderer != null)
            {
                rendererType = meshRenderer != null ? "MeshRenderer" : "MeshFilter";
                if (meshFilter != null && meshFilter.sharedMesh != null)
                {
                    meshAssetPath = AssetDatabase.GetAssetPath(meshFilter.sharedMesh);
                    if (string.IsNullOrEmpty(meshAssetPath)) meshAssetPath = meshFilter.sharedMesh.name;
                }

                if (meshRenderer != null)
                {
                    CollectMaterialNames(meshRenderer.sharedMaterials, materialNames);
                    boundsJson = BoundsJson(meshRenderer.bounds);
                }

                renderRole = isPrefabInstanceRoot || IsModelRootCandidate(go, nearestPrefabRoot)
                    ? "model_root"
                    : "mesh";
                renderCategory = !string.IsNullOrEmpty(assetId) && (isPrefabInstanceRoot || nearestPrefabRoot == go)
                    ? "catalog_model_root"
                    : "native_mesh";
            }
            else if (isPrefabInstanceRoot || (!string.IsNullOrEmpty(assetId) && nearestPrefabRoot == go))
            {
                renderRole = "model_root";
                renderCategory = !string.IsNullOrEmpty(assetId) ? "catalog_model_root" : "empty";
            }
            else if (go.GetComponent<Collider>() != null && go.GetComponents<Component>().Length <= 2)
            {
                renderRole = "empty";
                renderCategory = "collider_only";
            }
            else if (go.GetComponents<Component>().Length <= 1)
            {
                renderRole = "empty";
                renderCategory = "empty";
            }
            else
            {
                renderRole = string.IsNullOrEmpty(assetId) ? "unsupported" : "model_root";
                renderCategory = string.IsNullOrEmpty(assetId) ? "unsupported" : "catalog_model_root";
            }

            // Prefab instance roots always own the visual even when child meshes exist under them.
            if (isPrefabInstanceRoot)
            {
                renderRole = "model_root";
                if (!string.IsNullOrEmpty(assetId)) renderCategory = "catalog_model_root";
            }
            else if (nearestPrefabRoot != null && nearestPrefabRoot != go &&
                     (renderRole == "mesh" || renderRole == "model_root"))
            {
                // Descendant of an already-exported model root Ã¢â‚¬â€ never a second model load target.
                renderRole = renderRole == "mesh" ? "mesh" : "empty";
                if (go.GetComponent<MeshFilter>() != null || go.GetComponent<SkinnedMeshRenderer>() != null)
                {
                    renderRole = "mesh";
                    renderCategory = go.GetComponent<SkinnedMeshRenderer>() != null ? "skinned_mesh" : "native_mesh";
                    // Under a catalog root: geometry comes from catalog GLTF, not a second native load.
                    if (!string.IsNullOrEmpty(assetId))
                    {
                        renderCategory = "native_mesh";
                    }
                }
            }
        }

        private static bool depthZeroRoot(GameObject go) => go.transform.parent == null;

        private static bool IsModelRootCandidate(GameObject go, GameObject nearestPrefabRoot)
        {
            if (nearestPrefabRoot == go) return true;
            if (go.transform.parent == null) return true;
            return false;
        }

        /// <summary>
        /// Authoritative surface classification from HertzStudioSurfaceKind only.
        /// Geometry may emit surfaceKindSuggested for UI hints â€” never authoritative.
        /// </summary>
        private static void ClassifySurfaceKind(
            GameObject go,
            out string surfaceKind,
            out string source,
            out string surfaceKindSuggested)
        {
            surfaceKind = null;
            source = "none";
            surfaceKindSuggested = null;
            if (go == null) return;

            var marker = go.GetComponent<HertzStudioSurfaceKind>();
            if (marker != null)
            {
                surfaceKind = HertzStudioSurfaceKind.ToExportToken(marker.SurfaceKind);
                source = surfaceKind == null ? "component_none" : "component";
            }

            // Non-authoritative UI suggestion only (ignored by replace/walkability).
            var mf = go.GetComponent<MeshFilter>();
            var mesh = mf != null ? mf.sharedMesh : null;
            if (mesh != null)
            {
                var b = mesh.bounds.size;
                var up = go.transform.up;
                var upright = Mathf.Abs(Vector3.Dot(up, Vector3.up)) > 0.85f;
                if (upright && b.y > 0.001f && b.x / b.y > 4f && b.z / b.y > 4f)
                    surfaceKindSuggested = "floor";
                else if (b.y > b.x * 1.5f && b.y > b.z * 1.5f)
                    surfaceKindSuggested = "wall";
            }
        }

        private static void BuildColliderMetadata(GameObject go, out string colliderJson)
        {
            var cols = go.GetComponents<Collider>();
            if (cols == null || cols.Length == 0)
            {
                colliderJson =
                    "{\"present\":false,\"enabled\":false,\"isTrigger\":false,\"hasNonTrigger\":false," +
                    "\"type\":null,\"bounds\":null,\"boundsKey\":null,\"known\":true}";
                return;
            }

            var enabled = false;
            var anyTrigger = false;
            var hasNonTrigger = false;
            string typeName = null;
            Bounds? combined = null;
            foreach (var c in cols)
            {
                if (c == null) continue;
                if (typeName == null) typeName = c.GetType().Name;
                if (c.enabled) enabled = true;
                if (c.isTrigger) anyTrigger = true;
                else hasNonTrigger = true;
                if (!combined.HasValue) combined = c.bounds;
                else
                {
                    var b = combined.Value;
                    b.Encapsulate(c.bounds);
                    combined = b;
                }
            }

            string boundsJson = "null";
            string boundsKey = "null";
            if (combined.HasValue)
            {
                var b = combined.Value;
                boundsJson =
                    $"{{\"center\":{{\"x\":{F(b.center.x)},\"y\":{F(b.center.y)},\"z\":{F(b.center.z)}}}," +
                    $"\"size\":{{\"x\":{F(b.size.x)},\"y\":{F(b.size.y)},\"z\":{F(b.size.z)}}}}}";
                boundsKey = Quote(
                    $"{F(b.center.x)}|{F(b.center.y)}|{F(b.center.z)}|{F(b.size.x)}|{F(b.size.y)}|{F(b.size.z)}");
            }

            colliderJson =
                "{" +
                "\"present\":true," +
                $"\"enabled\":{(enabled ? "true" : "false")}," +
                $"\"isTrigger\":{(anyTrigger && !hasNonTrigger ? "true" : "false")}," +
                $"\"hasNonTrigger\":{(hasNonTrigger ? "true" : "false")}," +
                $"\"type\":{(typeName == null ? "null" : Quote(typeName))}," +
                $"\"bounds\":{boundsJson}," +
                $"\"boundsKey\":{boundsKey}," +
                "\"known\":true" +
                "}";
        }

        private static bool ContainsProtectedToken(string nameBlob)
        {
            if (string.IsNullOrEmpty(nameBlob)) return false;
            return nameBlob.Contains("xr rig") || nameBlob.Contains("xr_rig") || nameBlob.Contains("xr-rig") ||
                   nameBlob.Contains("tracking origin") || nameBlob.Contains("tracking_origin") ||
                   nameBlob.Contains("main camera") || nameBlob.Contains("main_camera") ||
                   nameBlob.Contains("camera offset") || nameBlob.Contains("camera_offset") ||
                   nameBlob.Contains("hmd") || nameBlob.Contains("playspace");
        }

        private static void CollectMaterialNames(Material[] mats, List<string> into)
        {
            if (mats == null) return;
            foreach (var mat in mats)
            {
                if (mat != null && !string.IsNullOrEmpty(mat.name))
                {
                    into.Add(mat.name);
                }
            }
        }

        private static string BoundsJson(Bounds b)
        {
            return
                $"{{\"center\":{{\"x\":{F(b.center.x)},\"y\":{F(b.center.y)},\"z\":{F(b.center.z)}}}," +
                $"\"size\":{{\"x\":{F(b.size.x)},\"y\":{F(b.size.y)},\"z\":{F(b.size.z)}}}}}";
        }

        private static string TryRecoverAssetIdFromImportedPath(string assetPath)
        {
            if (string.IsNullOrEmpty(assetPath)) return null;
            const string prefix = "Assets/HertzStudio/Imported/";
            if (!assetPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
            var rest = assetPath.Substring(prefix.Length);
            var slash = rest.IndexOf('/');
            var candidate = slash >= 0 ? rest.Substring(0, slash) : rest;
            return IsUuid(candidate) ? candidate : null;
        }

        private static string ComputeContentFingerprint(Scene scene)
        {
            var lines = new List<string>();
            foreach (var root in scene.GetRootGameObjects())
            {
                CollectFingerprint(root.transform, lines);
            }

            lines.Sort(StringComparer.Ordinal);
            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", lines)));
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
            {
                sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            }

            return sb.ToString();
        }

        private static void CollectFingerprint(Transform transform, List<string> lines)
        {
            var id = GlobalObjectId.GetGlobalObjectIdSlow(transform.gameObject).ToString();
            var p = transform.position;
            var r = transform.eulerAngles;
            lines.Add($"{id}|{F(p.x)},{F(p.y)},{F(p.z)}|{F(r.x)},{F(r.y)},{F(r.z)}");
            for (var i = 0; i < transform.childCount; i++)
            {
                CollectFingerprint(transform.GetChild(i), lines);
            }
        }

        private static ResponsePayload ApplyEdits(string body)
        {
            var requestId = ReadString(body, "requestId");
            var baseRevision = ReadInt(body, "baseUnityRevision");
            var scenePath = ReadString(body, "scenePath");
            var scene = SceneManager.GetActiveScene();
            EnsureRevisionInitialized(scene);

            if (!string.IsNullOrEmpty(scenePath) &&
                !string.IsNullOrEmpty(scene.path) &&
                !string.Equals(scene.path, scenePath, StringComparison.OrdinalIgnoreCase))
            {
                return Conflict($"Active scene {scene.path} does not match {scenePath}.", GetRevision(scene.path));
            }

            var operations = HertzStudioSceneCommands.ParseOperations(body);
            List<Edit> edits;
            try
            {
                edits = ExtractEdits(body);
            }
            catch (InvalidOperationException ex)
            {
                return new ResponsePayload(400,
                    $"{{\"status\":\"failed\",\"error\":{Quote(ex.Message)}}}");
            }

            if (operations.Count == 0 && edits.Count == 0)
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"No edits or operations provided.\"}");
            }

            var payloadHash = operations.Count > 0
                ? HertzStudioSceneCommands.HashOperations(requestId, scene.path, baseRevision, operations)
                : HashPayload(requestId, scene.path, baseRevision, edits);
            if (!string.IsNullOrEmpty(requestId))
            {
                var cached = FindPersistedResult(requestId);
                if (cached != null)
                {
                    if (string.Equals(cached.PayloadHash, payloadHash, StringComparison.Ordinal) &&
                        string.Equals(cached.ScenePath ?? string.Empty, scene.path ?? string.Empty, StringComparison.OrdinalIgnoreCase))
                    {
                        return new ResponsePayload(cached.StatusCode, cached.Json);
                    }

                    return Conflict("requestId reused with a different payload.", GetRevision(scene.path));
                }
            }

            var currentRevision = GetRevision(scene.path);
            if (baseRevision != currentRevision)
            {
                return Conflict($"Stale base revision {baseRevision}; Unity is at {currentRevision}.", currentRevision);
            }

            if (operations.Count > 0)
            {
                _suppressRevisionBump = true;
                var applyError = HertzStudioSceneCommands.ApplyOrError(scene, operations, out var bindings);
                if (applyError != null)
                {
                    _suppressRevisionBump = false;
                    return new ResponsePayload(400,
                        $"{{\"status\":\"failed\",\"error\":{Quote(applyError)}}}");
                }

                var nextFingerprintOps = ComputeContentFingerprint(scene);
                EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, nextFingerprintOps);
                _suppressRevisionBump = false;
                var nextRevisionOps = currentRevision + 1;
                SetRevision(scene.path, nextRevisionOps);
                EditorSceneManager.MarkSceneDirty(scene);
                var exportOps = ExportScene();
                var responseOps = new ResponsePayload(200,
                    "{" +
                    "\"status\":\"applied\"," +
                    $"\"unityRevision\":{nextRevisionOps}," +
                    $"\"message\":{Quote("Applied typed scene commands on Unity main thread.")}," +
                    $"\"bindings\":[{string.Join(",", bindings)}]," +
                    $"\"sceneExport\":{exportOps.Json}" +
                    "}");
                if (!string.IsNullOrEmpty(requestId))
                {
                    PersistResult(new PersistedResult
                    {
                        RequestId = requestId,
                        PayloadHash = payloadHash,
                        ScenePath = scene.path,
                        StatusCode = 200,
                        Json = responseOps.Json,
                        Status = "applied",
                        UnityRevision = nextRevisionOps
                    });
                }

                return responseOps;
            }

            var resolved = new List<(Edit edit, GameObject go)>();
            foreach (var edit in edits)
            {
                var go = FindByObjectId(edit.ObjectId);
                if (go == null)
                {
                    return new ResponsePayload(400,
                        $"{{\"status\":\"failed\",\"error\":{Quote($"Object not found: {edit.ObjectId}")}}}");
                }

                if (go.scene != scene)
                {
                    return new ResponsePayload(400,
                        $"{{\"status\":\"failed\",\"error\":{Quote($"Object not in active scene: {edit.ObjectId}")}}}");
                }

                if (HertzStudioSceneCommands.IsProtectedHierarchy(go))
                {
                    return new ResponsePayload(400,
                        $"{{\"status\":\"failed\",\"error\":{Quote($"Refusing to move protected XR/camera object: {edit.ObjectId}")}}}");
                }

                resolved.Add((edit, go));
            }

            _suppressRevisionBump = true;
            Undo.IncrementCurrentGroup();
            var group = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("HERTZ Studio Apply");
            string nextFingerprint;
            try
            {
                foreach (var pair in resolved)
                {
                    Undo.RecordObject(pair.go.transform, "HERTZ Studio Move");
                    pair.go.transform.position = pair.edit.Position;
                    EditorUtility.SetDirty(pair.go.transform);
                }

                Undo.CollapseUndoOperations(group);
                nextFingerprint = ComputeContentFingerprint(scene);
                // Publish the post-apply fingerprint before ending suppression so any deferred
                // ObjectChangeEvents for this same mutation see identical content and no-op.
                EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, nextFingerprint);
            }
            catch (Exception ex)
            {
                Undo.RevertAllDownToGroup(group);
                _suppressRevisionBump = false;
                return new ResponsePayload(500,
                    $"{{\"status\":\"failed\",\"error\":{Quote($"Apply rolled back: {ex.Message}")}}}");
            }

            _suppressRevisionBump = false;
            var nextRevision = currentRevision + 1;
            SetRevision(scene.path, nextRevision);
            EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, nextFingerprint);
            EditorSceneManager.MarkSceneDirty(scene);

            var export = ExportScene();
            var response = new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"unityRevision\":{nextRevision}," +
                $"\"message\":{Quote("Applied on Unity main thread.")}," +
                $"\"sceneExport\":{export.Json}" +
                "}");

            if (!string.IsNullOrEmpty(requestId))
            {
                PersistResult(new PersistedResult
                {
                    RequestId = requestId,
                    PayloadHash = payloadHash,
                    ScenePath = scene.path,
                    StatusCode = 200,
                    Json = response.Json,
                    Status = "applied",
                    UnityRevision = nextRevision
                });
            }

            return response;
        }

        private static ResponsePayload UndoLast(string body)
        {
            var requestId = ReadString(body, "requestId");
            Undo.PerformUndo();
            var scene = SceneManager.GetActiveScene();
            var nextRevision = GetRevision(scene.path) + 1;
            SetRevision(scene.path, nextRevision);
            EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, ComputeContentFingerprint(scene));
            EditorSceneManager.MarkSceneDirty(scene);
            var response = new ResponsePayload(200,
                $"{{\"status\":\"applied\",\"unityRevision\":{nextRevision},\"message\":{Quote("Undo performed.")}}}");
            if (!string.IsNullOrEmpty(requestId))
            {
                PersistResult(new PersistedResult
                {
                    RequestId = requestId,
                    PayloadHash = "undo:" + requestId,
                    ScenePath = scene.path,
                    StatusCode = 200,
                    Json = response.Json,
                    Status = "applied",
                    UnityRevision = nextRevision
                });
            }

            return response;
        }

        private static ResponsePayload SaveScene(string body)
        {
            var scene = SceneManager.GetActiveScene();
            var scenePath = ReadString(body, "scenePath");
            if (!string.IsNullOrEmpty(scenePath) &&
                !string.IsNullOrEmpty(scene.path) &&
                !string.Equals(scene.path, scenePath, StringComparison.OrdinalIgnoreCase))
            {
                return Conflict("Scene path mismatch on save.", GetRevision(scene.path));
            }

            if (string.IsNullOrEmpty(scene.path))
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"Active scene has no path.\"}");
            }

            if (!EditorSceneManager.SaveScene(scene))
            {
                return new ResponsePayload(500, "{\"status\":\"failed\",\"error\":\"SaveScene returned false.\"}");
            }

            var nextRevision = GetRevision(scene.path) + 1;
            SetRevision(scene.path, nextRevision);
            EditorPrefs.SetString(PrefFingerprintPrefix + scene.path, ComputeContentFingerprint(scene));
            return new ResponsePayload(200,
                $"{{\"status\":\"applied\",\"unityRevision\":{nextRevision},\"message\":{Quote("Scene saved.")}}}");
        }

        private static ResponsePayload ReopenScene(string body)
        {
            var scene = SceneManager.GetActiveScene();
            var scenePath = ReadString(body, "scenePath") ?? scene.path;
            if (string.IsNullOrEmpty(scenePath))
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"No scene path to reopen.\"}");
            }

            if (scene.isDirty)
            {
                if (!EditorSceneManager.SaveScene(scene))
                {
                    return new ResponsePayload(500, "{\"status\":\"failed\",\"error\":\"Could not save before reopen.\"}");
                }
            }

            var opened = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            EnsureRevisionInitialized(opened);
            var export = ExportScene();
            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"unityRevision\":{GetRevision(opened.path)}," +
                $"\"message\":{Quote("Scene closed and reopened.")}," +
                $"\"sceneExport\":{export.Json}" +
                "}");
        }

        /// <summary>
        /// Accept an import without blocking the HTTP thread for the full AssetDatabase pass.
        /// Staging must live under Library/HertzStudioIncoming (outside Assets) so copies into
        /// Assets do not compete with Unity auto-import. Idempotent per requestId+payload.
        /// </summary>
        private static void AcceptStudioAssetImport(BridgeHttpExchange context, string body)
        {
            var requestId = ReadString(body, "requestId");
            var assetId = ReadString(body, "assetId");
            var fileName = ReadString(body, "fileName") ?? "asset.bin";
            var sourcePath = ReadString(body, "sourcePath");
            var createPrefab = ReadBool(body, "createPrefab");
            var payloadHash = HashImportPayload(requestId, assetId, sourcePath, fileName, body);

            if (string.IsNullOrEmpty(requestId))
            {
                WriteJson(context, 400, "{\"status\":\"failed\",\"error\":\"requestId required.\"}");
                return;
            }

            if (string.IsNullOrEmpty(assetId) || string.IsNullOrEmpty(sourcePath))
            {
                WriteJson(context, 400, "{\"status\":\"failed\",\"error\":\"assetId and sourcePath required.\"}");
                return;
            }

            if (!IsUuid(assetId))
            {
                WriteJson(context, 400, "{\"status\":\"failed\",\"error\":\"assetId must be a UUID.\"}");
                return;
            }

            var cached = FindPersistedResult(requestId);
            if (cached != null)
            {
                if (!string.IsNullOrEmpty(cached.PayloadHash) &&
                    !string.Equals(cached.PayloadHash, payloadHash, StringComparison.Ordinal))
                {
                    WriteJson(context, 409,
                        "{\"status\":\"conflict\",\"error\":\"requestId reused with a different import payload.\"}");
                    return;
                }

                if (string.Equals(cached.Status, "applied", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(cached.Status, "failed", StringComparison.OrdinalIgnoreCase))
                {
                    WriteJson(context, cached.StatusCode > 0 ? cached.StatusCode : 200,
                        string.IsNullOrEmpty(cached.Json)
                            ? $"{{\"status\":{Quote(cached.Status)},\"requestId\":{Quote(requestId)},\"deduplicated\":true}}"
                            : cached.Json);
                    return;
                }
            }

            lock (ImportJobLock)
            {
                if (InFlightImportRequestIds.Contains(requestId))
                {
                    WriteJson(context, 202,
                        "{" +
                        "\"status\":\"in_progress\"," +
                        $"\"requestId\":{Quote(requestId)}," +
                        "\"message\":\"Import already running on Unity main thread.\"" +
                        "}");
                    return;
                }

                InFlightImportRequestIds.Add(requestId);
            }

            PersistResult(new PersistedResult
            {
                RequestId = requestId,
                PayloadHash = payloadHash,
                ScenePath = string.Empty,
                Status = "accepted",
                StatusCode = 202,
                UnityRevision = 0,
                Json = "{" +
                       "\"status\":\"accepted\"," +
                       $"\"requestId\":{Quote(requestId)}," +
                       $"\"assetId\":{Quote(assetId)}" +
                       "}"
            });

            WriteJson(context, 202,
                "{" +
                "\"status\":\"accepted\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"assetId\":{Quote(assetId)}," +
                "\"message\":\"Import accepted; poll /assets/import-status.\"" +
                "}");

            EnqueueMain(() =>
            {
                try
                {
                    var result = ExecuteStudioAssetImport(
                        requestId, assetId, fileName, sourcePath, createPrefab, body, payloadHash);
                    PersistResult(new PersistedResult
                    {
                        RequestId = requestId,
                        PayloadHash = payloadHash,
                        ScenePath = string.Empty,
                        Status = result.StatusLabel,
                        StatusCode = result.StatusCode,
                        UnityRevision = 0,
                        Json = result.Json
                    });
                }
                catch (Exception ex)
                {
                    PersistResult(new PersistedResult
                    {
                        RequestId = requestId,
                        PayloadHash = payloadHash,
                        ScenePath = string.Empty,
                        Status = "failed",
                        StatusCode = 500,
                        UnityRevision = 0,
                        Json = "{" +
                               "\"status\":\"failed\"," +
                               $"\"requestId\":{Quote(requestId)}," +
                               $"\"error\":{Quote(ex.Message)}" +
                               "}"
                    });
                    Debug.LogError($"HERTZ Studio import failed requestId={requestId}: {ex.Message}");
                }
                finally
                {
                    lock (ImportJobLock)
                    {
                        InFlightImportRequestIds.Remove(requestId);
                    }
                }
            });
        }

        private static string ImportStatusJson(string requestId)
        {
            if (string.IsNullOrEmpty(requestId))
            {
                return "{\"status\":\"failed\",\"error\":\"requestId required.\"}";
            }

            lock (ImportJobLock)
            {
                if (InFlightImportRequestIds.Contains(requestId))
                {
                    return "{" +
                           "\"status\":\"in_progress\"," +
                           $"\"requestId\":{Quote(requestId)}" +
                           "}";
                }
            }

            var cached = FindPersistedResult(requestId);
            if (cached == null)
            {
                return "{" +
                       "\"status\":\"unknown\"," +
                       $"\"requestId\":{Quote(requestId)}" +
                       "}";
            }

            return string.IsNullOrEmpty(cached.Json)
                ? "{" +
                  $"\"status\":{Quote(cached.Status)}," +
                  $"\"requestId\":{Quote(requestId)}" +
                  "}"
                : cached.Json;
        }

        private static ResponsePayload ListProjectScenes()
        {
            var active = SceneManager.GetActiveScene();
            // The shared Studio target may be any project scene, regardless of its folder.
            var guids = AssetDatabase.FindAssets("t:Scene", new[] { "Assets" });

            var parts = new List<string>(guids.Length);
            for (var i = 0; i < guids.Length; i++)
            {
                var path = AssetDatabase.GUIDToAssetPath(guids[i]);
                if (string.IsNullOrEmpty(path) ||
                    !path.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                    !path.EndsWith(".unity", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var name = Path.GetFileNameWithoutExtension(path);
                var loaded = FindLoadedSceneByPath(path);
                if (loaded.IsValid()) EnsureRevisionInitialized(loaded);
                var revision = GetRevision(path);
                parts.Add(
                    "{" +
                    $"\"path\":{Quote(path)}," +
                    $"\"name\":{Quote(name)}," +
                    $"\"guid\":{Quote(guids[i])}," +
                    $"\"unityRevision\":{revision}" +
                    "}");
            }

            parts.Sort(StringComparer.OrdinalIgnoreCase);
            return new ResponsePayload(200,
                "{" +
                "\"status\":\"ok\"," +
                $"\"activeScenePath\":{Quote(active.path ?? string.Empty)}," +
                $"\"activeSceneName\":{Quote(active.name ?? string.Empty)}," +
                $"\"scenes\":[{string.Join(",", parts)}]" +
                "}");
        }

        /// <summary>Editor-only proof entry: runs place without HTTP (HertzStudioTest proofs).</summary>
        public static string PlaceAssetInSceneForProof(string body, out int statusCode)
        {
            var result = PlaceAssetInScene(body);
            statusCode = result.StatusCode;
            return result.Json;
        }

        /// <summary>Editor-only proof entry: reads the authoritative revision for a loaded scene.</summary>
        public static int GetSceneRevisionForProof(string scenePath)
        {
            var scene = FindLoadedSceneByPath(scenePath);
            if (!scene.IsValid() || !scene.isLoaded)
            {
                throw new InvalidOperationException($"Proof scene is not loaded: {scenePath}");
            }

            EnsureRevisionInitialized(scene);
            return GetRevision(scene.path);
        }

        /// <summary>Editor-only proof entry: records a saved cleanup through normal revision bookkeeping.</summary>
        public static int RecordSceneContentChangeForProof(string scenePath)
        {
            var scene = FindLoadedSceneByPath(scenePath);
            if (!scene.IsValid() || !scene.isLoaded)
            {
                throw new InvalidOperationException($"Proof scene is not loaded: {scenePath}");
            }

            BumpRevisionForContentChange(scene);
            return GetRevision(scene.path);
        }

        private static ResponsePayload ValidateCharacterAnimation(string body)
        {
            var modelPath = ReadString(body, "modelUnityPath");
            var animPath = ReadString(body, "animationUnityPath");
            var slot = ReadString(body, "slot") ?? "idle";
            var modelAssetId = ReadString(body, "modelAssetId");
            var animationAssetId = ReadString(body, "animationAssetId");
            var result = HertzStudioCharacterCommands.ValidateAnimationBinding(
                modelPath,
                animPath,
                slot,
                modelAssetId,
                animationAssetId);
            result.Source = "unity_bridge";
            return new ResponsePayload(200, result.ToJson());
        }

        private static ResponsePayload DeployCharacterRuntime(string body)
        {
            var requestId = ReadString(body, "requestId");
            var characterId = ReadString(body, "characterId");
            var scenePath = ReadString(body, "scenePath");
            var sceneGuid = ReadString(body, "sceneGuid");
            var confirmSave = ReadBool(body, "confirmSave");
            var expectedRevision = ReadInt(body, "expectedUnityRevision");
            var hasExpectedRevision = body != null && body.IndexOf("\"expectedUnityRevision\"", StringComparison.OrdinalIgnoreCase) >= 0;
            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(characterId) || string.IsNullOrEmpty(scenePath) || string.IsNullOrEmpty(sceneGuid))
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"requestId, characterId, scenePath, and sceneGuid required.\"}");
            }
            if (!scenePath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) || !scenePath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) || scenePath.IndexOf("..", StringComparison.Ordinal) >= 0)
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"scenePath must be an Assets/.../*.unity path.\"}");
            }
            var actualSceneGuid = AssetDatabase.AssetPathToGUID(scenePath);
            if (string.IsNullOrEmpty(actualSceneGuid))
            {
                return new ResponsePayload(404, $"{{\"status\":\"failed\",\"error\":{Quote("Target scene not found.")}}}");
            }
            if (!string.Equals(actualSceneGuid, sceneGuid, StringComparison.OrdinalIgnoreCase))
            {
                return new ResponsePayload(409, $"{{\"status\":\"conflict\",\"error\":{Quote("Target scene path/GUID mismatch. Refresh the Studio scene inventory and retry.")}}}");
            }
            if (!confirmSave || !hasExpectedRevision || expectedRevision < 0)
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"confirmSave and expectedUnityRevision are required.\"}");
            }
            var currentRevision = GetRevision(scenePath);
            if (currentRevision != expectedRevision)
            {
                return Conflict($"Scene revision mismatch: expected {expectedRevision}, have {currentRevision}.", currentRevision);
            }
            if (!TryParsePlaceTransform(body, out var position, out var rotation, out var scale, out var transformError))
            {
                return new ResponsePayload(400, $"{{\"status\":\"failed\",\"error\":{Quote(transformError)}}}");
            }
            var quantity = Math.Max(1, ReadInt(body, "quantity"));
            if (quantity > 8)
            {
                return new ResponsePayload(400, "{\"status\":\"failed\",\"error\":\"quantity must be between 1 and 8.\"}");
            }
            var deploy = HertzStudioCharacterCommands.DeployToScene(
                characterId,
                ReadString(body, "characterKind"),
                ReadString(body, "characterAssetGuid"),
                ReadString(body, "characterAssetPath"),
                ReadString(body, "profileId"),
                ReadString(body, "profileAssetGuid"),
                ReadString(body, "profileAssetPath"),
                scenePath,
                actualSceneGuid,
                expectedRevision,
                confirmSave,
                quantity,
                position,
                rotation,
                scale,
                ReadString(body, "managedObjectId"));
            if (deploy.Conflict)
            {
                return new ResponsePayload(409, $"{{\"status\":\"conflict\",\"requestId\":{Quote(requestId)},\"error\":{Quote(deploy.Error ?? "conflict")}}}");
            }
            if (!deploy.Ok)
            {
                return new ResponsePayload(400, $"{{\"status\":\"failed\",\"requestId\":{Quote(requestId)},\"error\":{Quote(deploy.Error ?? "deploy failed")}}}");
            }
            var idJson = string.Join(",", Array.ConvertAll(deploy.ManagedObjectIds ?? Array.Empty<string>(), Quote));
            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"characterId\":{Quote(characterId)}," +
                $"\"scenePath\":{Quote(scenePath)}," +
                $"\"sceneGuid\":{Quote(actualSceneGuid)}," +
                $"\"unityRevision\":{deploy.UnityRevision}," +
                $"\"managedObjectIds\":[{idJson}]" +
                "}");
        }

        private static ResponsePayload SyncCharacterModel(string body)
        {
            var requestId = ReadString(body, "requestId");
            var characterId = ReadString(body, "characterId");
            var payloadHash = ReadString(body, "payloadHash");
            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(characterId) || string.IsNullOrEmpty(payloadHash))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId, characterId, and payloadHash required.\"}");
            }

            var animPaths = ExtractObject(body, "animationPaths") ?? "{}";
            var req = new HertzStudioCharacterCommands.CharacterModelRequest
            {
                CharacterId = characterId,
                DisplayName = ReadString(body, "displayName") ?? "Character",
                Kind = ReadString(body, "kind") ?? "enemy_visual",
                Enabled = body.IndexOf("\"enabled\"", StringComparison.OrdinalIgnoreCase) < 0 || ReadBool(body, "enabled"),
                Scale = TryReadFloat(body, "scale", out var scale) ? scale : 1f,
                ReplaceTrackedXrRig = body.IndexOf("\"replaceTrackedXrRig\"", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                      ReadBool(body, "replaceTrackedXrRig"),
                Version = Math.Max(1, ReadInt(body, "version")),
                PayloadHash = payloadHash,
                ModelPrefabPath = ReadString(body, "modelPrefabPath"),
                ExpectedAssetGuid = ReadString(body, "expectedAssetGuid"),
                AssetPath = ReadString(body, "assetPath"),
                IdleAnimPath = ReadString(animPaths, "idle"),
                AttackAnimPath = ReadString(animPaths, "attack"),
                LocomotionAnimPath = ReadString(animPaths, "locomotion"),
            };

            var sync = HertzStudioCharacterCommands.SyncCharacterModel(req);
            if (sync.Conflict)
            {
                return new ResponsePayload(409,
                    $"{{\"status\":\"conflict\",\"requestId\":{Quote(requestId)},\"error\":{Quote(sync.Error ?? "conflict")}}}");
            }

            if (!sync.Ok)
            {
                return new ResponsePayload(400,
                    $"{{\"status\":\"failed\",\"requestId\":{Quote(requestId)},\"error\":{Quote(sync.Error ?? "sync failed")}}}");
            }

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"characterId\":{Quote(sync.EntityId)}," +
                $"\"assetGuid\":{Quote(sync.AssetGuid)}," +
                $"\"assetPath\":{Quote(sync.AssetPath)}," +
                $"\"observedPayloadHash\":{Quote(sync.ObservedPayloadHash)}," +
                $"\"observedVersion\":{sync.ObservedVersion}," +
                $"\"assetType\":{Quote(sync.AssetType)}" +
                "}");
        }

        private static ResponsePayload SyncEnemyProfile(string body)
        {
            var requestId = ReadString(body, "requestId");
            var profileId = ReadString(body, "profileId");
            var payloadHash = ReadString(body, "payloadHash");
            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(profileId) || string.IsNullOrEmpty(payloadHash))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId, profileId, and payloadHash required.\"}");
            }

            var behaviorJson = ExtractObject(body, "behavior") ?? "{}";
            var animPaths = ExtractObject(body, "animationPaths") ?? "{}";
            var req = new HertzStudioCharacterCommands.EnemyProfileRequest
            {
                ProfileId = profileId,
                DisplayName = ReadString(body, "displayName") ?? "Enemy Profile",
                Enabled = body.IndexOf("\"enabled\"", StringComparison.OrdinalIgnoreCase) < 0 || ReadBool(body, "enabled"),
                Version = Math.Max(1, ReadInt(body, "version")),
                PayloadHash = payloadHash,
                ExpectedAssetGuid = ReadString(body, "expectedAssetGuid"),
                AssetPath = ReadString(body, "assetPath"),
                ModelAssetGuid = ReadString(body, "modelAssetGuid"),
                MoveSpeed = TryReadFloat(behaviorJson, "moveSpeed", out var ms) ? ms : 2.5f,
                DetectionRangeMeters = TryReadFloat(behaviorJson, "detectionRangeMeters", out var dr) ? dr : 12f,
                AttackRangeMeters = TryReadFloat(behaviorJson, "attackRangeMeters", out var ar) ? ar : 8f,
                WaitReactionDelaySeconds = TryReadFloat(behaviorJson, "waitReactionDelaySeconds", out var wr) ? wr : 0.4f,
                ShotBurstIntervalSeconds = TryReadFloat(behaviorJson, "shotBurstIntervalSeconds", out var sb) ? sb : 0.75f,
                ApproachDistanceMeters = TryReadFloat(behaviorJson, "approachDistanceMeters", out var ad) ? ad : 3f,
                Mode = ReadString(behaviorJson, "mode") ?? "hold_position",
                IdleAnimPath = ReadString(animPaths, "idle"),
                AttackAnimPath = ReadString(animPaths, "attack"),
                LocomotionAnimPath = ReadString(animPaths, "locomotion"),
            };

            var sync = HertzStudioCharacterCommands.SyncEnemyProfile(req);
            if (sync.Conflict)
            {
                return new ResponsePayload(409,
                    $"{{\"status\":\"conflict\",\"requestId\":{Quote(requestId)},\"error\":{Quote(sync.Error ?? "conflict")}}}");
            }

            if (!sync.Ok)
            {
                return new ResponsePayload(400,
                    $"{{\"status\":\"failed\",\"requestId\":{Quote(requestId)},\"error\":{Quote(sync.Error ?? "sync failed")}}}");
            }

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"profileId\":{Quote(sync.EntityId)}," +
                $"\"assetGuid\":{Quote(sync.AssetGuid)}," +
                $"\"assetPath\":{Quote(sync.AssetPath)}," +
                $"\"observedPayloadHash\":{Quote(sync.ObservedPayloadHash)}," +
                $"\"observedVersion\":{sync.ObservedVersion}," +
                $"\"assetType\":{Quote(sync.AssetType)}" +
                "}");
        }

        private static ResponsePayload DeleteCharacterDefinition(string body)
        {
            var requestId = ReadString(body, "requestId");
            var entityKind = ReadString(body, "entityKind") ?? "model";
            var entityId = ReadString(body, "entityId") ?? ReadString(body, "characterId") ?? ReadString(body, "profileId");
            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(entityId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId and entityId required.\"}");
            }

            var sync = HertzStudioCharacterCommands.DeleteDefinition(
                entityKind,
                entityId,
                ReadString(body, "expectedAssetGuid"),
                ReadString(body, "assetPath"));
            if (sync.Conflict)
            {
                return new ResponsePayload(409,
                    $"{{\"status\":\"conflict\",\"requestId\":{Quote(requestId)},\"error\":{Quote(sync.Error ?? "conflict")}}}");
            }

            if (!sync.Ok)
            {
                return new ResponsePayload(400,
                    $"{{\"status\":\"failed\",\"requestId\":{Quote(requestId)},\"error\":{Quote(sync.Error ?? "delete failed")}}}");
            }

            return new ResponsePayload(200,
                $"{{\"status\":\"applied\",\"requestId\":{Quote(requestId)},\"entityId\":{Quote(entityId)},\"assetGuid\":{Quote(sync.AssetGuid)},\"assetPath\":{Quote(sync.AssetPath)}}}");
        }

        /// <summary>
        /// Create/update a Studio-managed <c>HertzWeaponDefinition</c>. Unity returns authoritative GUID/path.
        /// Connector must never invent success â€” only forward this response.
        /// </summary>
        private static ResponsePayload SyncWeaponDefinition(string body)
        {
            var requestId = ReadString(body, "requestId");
            var weaponId = ReadString(body, "weaponId");
            var payloadHash = ReadString(body, "payloadHash");
            if (string.IsNullOrEmpty(requestId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId required.\"}");
            }

            if (string.IsNullOrEmpty(weaponId) || string.IsNullOrEmpty(payloadHash))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"weaponId and payloadHash required.\"}");
            }

            var tuningJson = ExtractObject(body, "tuning") ?? "{}";
            if (!TryReadFloat(tuningJson, "damage", out var damage) ||
                !TryReadFloat(tuningJson, "fireIntervalSeconds", out var fireInterval) ||
                !TryReadFloat(tuningJson, "rangeMeters", out var rangeMeters) ||
                !TryReadFloat(tuningJson, "recoil", out var recoil))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"tuning.damage/fireIntervalSeconds/rangeMeters/recoil required as finite numbers.\"}");
            }

            var req = new HertzStudioWeaponCommands.WeaponSyncRequest
            {
                WeaponId = weaponId,
                DisplayName = ReadString(body, "displayName") ?? "Pistol",
                Role = ReadString(body, "role") ?? "left_pistol",
                Enabled = true,
                FrequencyFlipRequired = true,
                Version = Math.Max(1, ReadInt(body, "version")),
                PayloadHash = payloadHash,
                ModelPrefabPath = ReadString(body, "modelPrefabPath"),
                ExpectedAssetGuid = ReadString(body, "expectedAssetGuid"),
                AssetPath = ReadString(body, "assetPath"),
                Tuning = new HertzStudioWeaponCommands.WeaponTuning
                {
                    Damage = damage,
                    FireIntervalSeconds = fireInterval,
                    RangeMeters = rangeMeters,
                    Recoil = recoil,
                    LeftHandAnchor = ReadString(tuningJson, "leftHandAnchor") ?? "LeftHand",
                    RightHandAnchor = ReadString(tuningJson, "rightHandAnchor") ?? "RightHand",
                    GripAnchor = ReadString(tuningJson, "gripAnchor") ?? "Grip",
                    MuzzleAnchor = ReadString(tuningJson, "muzzleAnchor") ?? "Muzzle",
                },
            };

            if (body.IndexOf("\"enabled\"", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                req.Enabled = ReadBool(body, "enabled");
            }

            if (body.IndexOf("\"frequencyFlipRequired\"", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                req.FrequencyFlipRequired = ReadBool(body, "frequencyFlipRequired");
            }

            var sync = HertzStudioWeaponCommands.SyncDefinition(req);
            if (sync.Conflict)
            {
                return new ResponsePayload(409,
                    "{" +
                    "\"status\":\"conflict\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"weaponId\":{Quote(weaponId)}," +
                    $"\"error\":{Quote(sync.Error ?? "conflict")}" +
                    "}");
            }

            if (!sync.Ok)
            {
                return new ResponsePayload(400,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"weaponId\":{Quote(weaponId)}," +
                    $"\"error\":{Quote(sync.Error ?? "sync failed")}," +
                    $"\"modelImported\":{(sync.ModelImported ? "true" : "false")}," +
                    "\"definitionSynced\":false," +
                    $"\"anchorsValid\":{(sync.AnchorsValid ? "true" : "false")}," +
                    "\"runtimeDeployApplied\":false," +
                    "\"runtimePlayable\":false," +
                    $"\"prefabPath\":{Quote(sync.PrefabPath ?? "")}," +
                    $"\"missingAnchors\":{QuoteStringArray(sync.MissingAnchors)}," +
                    $"\"hierarchy\":{QuoteStringArray(sync.HierarchyNames)}" +
                    "}");
            }

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"weaponId\":{Quote(sync.WeaponId)}," +
                $"\"assetGuid\":{Quote(sync.AssetGuid)}," +
                $"\"assetPath\":{Quote(sync.AssetPath)}," +
                $"\"observedPayloadHash\":{Quote(sync.ObservedPayloadHash)}," +
                $"\"observedVersion\":{sync.ObservedVersion}," +
                $"\"modelImported\":{(sync.ModelImported ? "true" : "false")}," +
                $"\"definitionSynced\":{(sync.DefinitionSynced ? "true" : "false")}," +
                $"\"anchorsValid\":{(sync.AnchorsValid ? "true" : "false")}," +
                $"\"runtimeDeployApplied\":false," +
                $"\"runtimePlayable\":{(sync.RuntimePlayable ? "true" : "false")}," +
                $"\"prefabPath\":{Quote(sync.PrefabPath ?? "")}," +
                $"\"missingAnchors\":{QuoteStringArray(sync.MissingAnchors)}" +
                "}");
        }

        private static ResponsePayload InspectWeaponPrefab(string body)
        {
            var prefabPath = ReadString(body, "prefabPath") ?? ReadString(body, "modelPrefabPath");
            var grip = ReadString(body, "gripAnchor") ?? "Grip";
            var muzzle = ReadString(body, "muzzleAnchor") ?? "Muzzle";
            if (string.IsNullOrEmpty(prefabPath))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"prefabPath required.\"}");
            }

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            if (prefab == null)
            {
                return new ResponsePayload(404,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"error\":{Quote($"Prefab not found at {prefabPath}")}," +
                    "\"modelImported\":false," +
                    "\"anchorsValid\":false," +
                    "\"runtimePlayable\":false" +
                    "}");
            }

            var validation = HertzWeaponAnchorUtility.ValidatePrefabAnchors(prefab, grip, muzzle);
            return new ResponsePayload(200,
                "{" +
                "\"status\":\"ok\"," +
                "\"source\":\"unity_prefab_hierarchy\"," +
                $"\"prefabPath\":{Quote(validation.PrefabPath ?? prefabPath)}," +
                $"\"prefabName\":{Quote(prefab.name)}," +
                $"\"modelImported\":true," +
                $"\"definitionSynced\":false," +
                $"\"anchorsValid\":{(validation.Ok ? "true" : "false")}," +
                $"\"runtimeDeployApplied\":false," +
                $"\"runtimePlayable\":false," +
                $"\"gripAnchor\":{Quote(validation.GripAnchor)}," +
                $"\"muzzleAnchor\":{Quote(validation.MuzzleAnchor)}," +
                $"\"gripFound\":{(validation.GripFound ? "true" : "false")}," +
                $"\"muzzleFound\":{(validation.MuzzleFound ? "true" : "false")}," +
                $"\"missingAnchors\":{QuoteStringArray(validation.MissingAnchors)}," +
                $"\"hierarchy\":{QuoteStringArray(validation.HierarchyNames)}," +
                $"\"error\":{Quote(validation.Error ?? "")}," +
                "\"note\":\"Grip determines hand alignment; Muzzle determines flash/tracer origin and direction. Select existing nodes or create a managed wrapper â€” never silent-guess placement.\"" +
                "}");
        }

        private static ResponsePayload CreateWeaponAnchorWrapper(string body)
        {
            var prefabPath = ReadString(body, "prefabPath") ?? ReadString(body, "modelPrefabPath") ??
                             ReadString(body, "sourcePrefabPath");
            var weaponId = ReadString(body, "weaponId") ?? "unassigned";
            var gripSource = ReadString(body, "gripSourceNode") ?? ReadString(body, "gripAnchor") ?? "GripAttach";
            var muzzleSource = ReadString(body, "muzzleSourceNode") ?? ReadString(body, "muzzleAnchor") ?? "MuzzlePoint";
            if (string.IsNullOrEmpty(prefabPath))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"prefabPath required.\"}");
            }

            var replaceExisting = body != null &&
                body.IndexOf("\"replaceExisting\"", StringComparison.OrdinalIgnoreCase) >= 0 &&
                ReadBool(body, "replaceExisting");
            var expectedGuid = ReadString(body, "sourcePrefabGuid");
            var modelAssetId = ReadString(body, "modelAssetId");
            var created = HertzWeaponAnchorUtility.CreateManagedAnchorWrapper(
                prefabPath, weaponId, gripSource, muzzleSource, replaceExisting, expectedGuid, modelAssetId);
            if (!created.Ok)
            {
                return new ResponsePayload(400,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"error\":{Quote(created.Error ?? "wrapper failed")}," +
                    $"\"code\":{Quote(created.RecoveryReason ?? "wrapper_failed")}," +
                    "\"modelImported\":true," +
                    "\"anchorsValid\":false," +
                    "\"runtimePlayable\":false" +
                    "}");
            }

            var runtimeReady = created.AnchorsConfirmed && !created.AnchorsProvisional && !created.NeedsConfirmation;
            return new ResponsePayload(200,
                "{" +
                "\"status\":\"ok\"," +
                $"\"wrapperPrefabPath\":{Quote(created.WrapperPrefabPath)}," +
                $"\"sourcePrefabPath\":{Quote(created.SourcePrefabPath)}," +
                $"\"sourcePrefabGuid\":{Quote(created.SourcePrefabGuid ?? "")}," +
                $"\"weaponId\":{Quote(weaponId)}," +
                $"\"gripAnchor\":\"Grip\"," +
                $"\"muzzleAnchor\":\"Muzzle\"," +
                $"\"gripSourceNode\":{Quote(created.GripSourceNode ?? "")}," +
                $"\"muzzleSourceNode\":{Quote(created.MuzzleSourceNode ?? "")}," +
                $"\"gripFromSource\":{(created.GripFromSource ? "true" : "false")}," +
                $"\"muzzleFromSource\":{(created.MuzzleFromSource ? "true" : "false")}," +
                $"\"anchorsProvisional\":{(created.AnchorsProvisional ? "true" : "false")}," +
                $"\"anchorsConfirmed\":{(created.AnchorsConfirmed ? "true" : "false")}," +
                $"\"needsConfirmation\":{(created.NeedsConfirmation ? "true" : "false")}," +
                $"\"recoveryReason\":{Quote(created.RecoveryReason ?? "")}," +
                $"\"alreadyExists\":{(created.AlreadyExists ? "true" : "false")}," +
                $"\"idempotentReuse\":{(created.IdempotentReuse ? "true" : "false")}," +
                $"\"createdNewVersion\":{(created.CreatedNewVersion ? "true" : "false")}," +
                $"\"wrapperVersion\":{created.WrapperVersion}," +
                "\"modelImported\":true," +
                $"\"anchorsValid\":{(runtimeReady ? "true" : "false")}," +
                "\"definitionSynced\":false," +
                "\"runtimeDeployApplied\":false," +
                "\"runtimePlayable\":false," +
                $"\"note\":{Quote(created.Note ?? "")}" +
                "}");
        }

        private static ResponsePayload ConfirmWeaponAnchorWrapper(string body)
        {
            var wrapperPath = ReadString(body, "wrapperPrefabPath") ?? ReadString(body, "prefabPath");
            var weaponId = ReadString(body, "weaponId");
            if (string.IsNullOrEmpty(wrapperPath))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"wrapperPrefabPath required.\"}");
            }

            if (string.IsNullOrEmpty(weaponId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"weaponId required for wrapper confirmation.\"}");
            }

            var expectedSourcePath = ReadString(body, "sourcePrefabPath");
            var expectedSourceGuid = ReadString(body, "sourcePrefabGuid");
            var modelAssetId = ReadString(body, "modelAssetId");
            var confirmed = HertzWeaponAnchorUtility.ConfirmWrapperAnchors(
                wrapperPath, weaponId, expectedSourcePath, expectedSourceGuid, modelAssetId);
            if (!confirmed.Ok)
            {
                return new ResponsePayload(400,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"error\":{Quote(confirmed.Error ?? "confirm failed")}," +
                    $"\"code\":{Quote(confirmed.RecoveryReason ?? "confirm_failed")}," +
                    "\"anchorsConfirmed\":false," +
                    "\"needsConfirmation\":true," +
                    "\"anchorsValid\":false" +
                    "}");
            }

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"ok\"," +
                $"\"wrapperPrefabPath\":{Quote(confirmed.WrapperPrefabPath)}," +
                $"\"weaponId\":{Quote(weaponId)}," +
                $"\"sourcePrefabPath\":{Quote(confirmed.SourcePrefabPath ?? expectedSourcePath ?? "")}," +
                $"\"sourcePrefabGuid\":{Quote(confirmed.SourcePrefabGuid ?? expectedSourceGuid ?? "")}," +
                "\"anchorsProvisional\":false," +
                "\"anchorsConfirmed\":true," +
                "\"needsConfirmation\":false," +
                "\"recoveryReason\":\"\"," +
                "\"anchorsValid\":true," +
                $"\"wrapperVersion\":{confirmed.WrapperVersion}," +
                $"\"note\":{Quote(confirmed.Note ?? "")}" +
                "}");
        }

        private static string QuoteStringArray(string[] values)
        {
            if (values == null || values.Length == 0) return "[]";
            var sb = new System.Text.StringBuilder();
            sb.Append('[');
            for (var i = 0; i < values.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(Quote(values[i] ?? ""));
            }

            sb.Append(']');
            return sb.ToString();
        }

        private static ResponsePayload ResolveWeaponDefinition(string body)
        {
            var assetGuid = ReadString(body, "assetGuid");
            var assetPath = ReadString(body, "assetPath");
            var weaponId = ReadString(body, "weaponId");
            if (string.IsNullOrEmpty(assetGuid) && string.IsNullOrEmpty(assetPath))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"assetGuid or assetPath required.\"}");
            }

            var resolved = HertzStudioWeaponCommands.ResolveDefinition(assetGuid, assetPath, weaponId);
            if (!resolved.Ok)
            {
                return new ResponsePayload(404,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"error\":{Quote(resolved.Error ?? "resolve failed")}," +
                    $"\"exists\":{(resolved.Exists ? "true" : "false")}," +
                    $"\"assetGuid\":{Quote(resolved.AssetGuid ?? "")}," +
                    $"\"assetPath\":{Quote(resolved.AssetPath ?? "")}," +
                    $"\"assetType\":{Quote(resolved.AssetType ?? "")}," +
                    $"\"weaponId\":{Quote(resolved.WeaponId ?? "")}" +
                    "}");
            }

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"ok\"," +
                $"\"exists\":true," +
                $"\"assetGuid\":{Quote(resolved.AssetGuid)}," +
                $"\"assetPath\":{Quote(resolved.AssetPath)}," +
                $"\"assetType\":{Quote(resolved.AssetType)}," +
                $"\"weaponId\":{Quote(resolved.WeaponId)}," +
                $"\"studioVersion\":{resolved.StudioVersion}," +
                $"\"studioPayloadHash\":{Quote(resolved.StudioPayloadHash ?? "")}" +
                "}");
        }

        private static ResponsePayload DeleteWeaponDefinition(string body)
        {
            var requestId = ReadString(body, "requestId");
            var weaponId = ReadString(body, "weaponId");
            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(weaponId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId and weaponId required.\"}");
            }

            var deleted = HertzStudioWeaponCommands.DeleteDefinition(
                weaponId,
                ReadString(body, "expectedAssetGuid"),
                ReadString(body, "assetPath"));
            if (!deleted.Ok)
            {
                return new ResponsePayload(400,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"weaponId\":{Quote(weaponId)}," +
                    $"\"error\":{Quote(deleted.Error ?? "delete failed")}" +
                    "}");
            }

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"weaponId\":{Quote(weaponId)}," +
                $"\"assetGuid\":{Quote(deleted.AssetGuid ?? "")}," +
                $"\"assetPath\":{Quote(deleted.AssetPath ?? "")}," +
                $"\"deleted\":{(deleted.Deleted ? "true" : "false")}," +
                $"\"alreadyAbsent\":{(deleted.AlreadyAbsent ? "true" : "false")}" +
                "}");
        }

        /// <summary>
        /// Bind a synced HertzWeaponDefinition into DualPistolRuntime in one explicit scene.
        /// Does not place a raw Asset Library mesh. Never mutates XR Origin / tracked camera.
        /// </summary>
        private static ResponsePayload DeployWeaponRuntime(string body)
        {
            var requestId = ReadString(body, "requestId");
            var weaponId = ReadString(body, "weaponId");
            var scenePath = ReadString(body, "scenePath");
            var sceneGuid = ReadString(body, "sceneGuid");
            var confirmSave = ReadBool(body, "confirmSave");
            var expectedRevision = ReadInt(body, "expectedUnityRevision");
            var hasExpectedRevision = body != null &&
                body.IndexOf("\"expectedUnityRevision\"", StringComparison.OrdinalIgnoreCase) >= 0;

            if (string.IsNullOrEmpty(requestId) || string.IsNullOrEmpty(weaponId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId and weaponId required.\"}");
            }

            if (string.IsNullOrEmpty(scenePath) || string.IsNullOrEmpty(sceneGuid))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"scenePath and sceneGuid required.\"}");
            }

            var actualSceneGuid = AssetDatabase.AssetPathToGUID(scenePath);
            if (string.IsNullOrEmpty(actualSceneGuid))
            {
                return new ResponsePayload(404,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"error\":{Quote("Target scene asset was not found.")}" +
                    "}");
            }
            if (!string.Equals(actualSceneGuid, sceneGuid, StringComparison.OrdinalIgnoreCase))
            {
                return new ResponsePayload(409,
                    "{" +
                    "\"status\":\"conflict\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"error\":{Quote("Target scene path/GUID mismatch. Refresh the Studio scene inventory and retry.")}" +
                    "}");
            }

            if (!confirmSave)
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"confirmSave must be true after explicit Studio confirmation.\"}");
            }

            if (!hasExpectedRevision || expectedRevision < 0)
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"expectedUnityRevision is required and must be non-negative.\"}");
            }

            // Open/check revision before bind (same contract as place-in-scene).
            var target = FindLoadedSceneByPath(scenePath);
            if (!target.IsValid())
            {
                var mode = SceneManager.sceneCount > 1 ? OpenSceneMode.Additive : OpenSceneMode.Single;
                try
                {
                    target = EditorSceneManager.OpenScene(scenePath, mode);
                }
                catch (Exception ex)
                {
                    return new ResponsePayload(404,
                        "{" +
                        "\"status\":\"failed\"," +
                        $"\"requestId\":{Quote(requestId)}," +
                        $"\"error\":{Quote($"Failed to open scene: {ex.Message}")}" +
                        "}");
                }
            }

            if (!target.IsValid() || !target.isLoaded)
            {
                return new ResponsePayload(500,
                    "{\"status\":\"failed\",\"error\":\"Failed to open the target scene.\"}");
            }

            EnsureRevisionInitialized(target);
            var currentRevision = GetRevision(target.path);
            if (expectedRevision != currentRevision)
            {
                return new ResponsePayload(409,
                    "{" +
                    "\"status\":\"conflict\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"error\":{Quote($"Scene revision mismatch: expected {expectedRevision}, have {currentRevision}. Refresh scenes and retry.")}," +
                    $"\"unityRevision\":{currentRevision}" +
                    "}");
            }

            var deploy = HertzStudioWeaponCommands.DeployToScene(
                weaponId,
                ReadString(body, "role") ?? "left_pistol",
                ReadString(body, "assetGuid") ?? ReadString(body, "expectedAssetGuid"),
                ReadString(body, "assetPath"),
                scenePath,
                expectedRevision,
                confirmSave,
                ReadString(body, "managedObjectId"));

            if (deploy.Conflict)
            {
                return new ResponsePayload(409,
                    "{" +
                    "\"status\":\"conflict\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"weaponId\":{Quote(weaponId)}," +
                    $"\"error\":{Quote(deploy.Error ?? "conflict")}" +
                    "}");
            }

            if (!deploy.Ok)
            {
                return new ResponsePayload(400,
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"weaponId\":{Quote(weaponId)}," +
                    $"\"error\":{Quote(deploy.Error ?? "deploy failed")}," +
                    $"\"modelImported\":{(deploy.ModelImported ? "true" : "false")}," +
                    $"\"definitionSynced\":{(deploy.DefinitionSynced ? "true" : "false")}," +
                    $"\"anchorsValid\":{(deploy.AnchorsValid ? "true" : "false")}," +
                    "\"runtimeDeployApplied\":false," +
                    "\"runtimePlayable\":false," +
                    $"\"missingAnchors\":{QuoteStringArray(deploy.MissingAnchors)}," +
                    $"\"unityRevision\":{currentRevision}" +
                    "}");
            }

            // Bump revision after successful save so next deploy needs a refresh.
            BumpRevisionForContentChange(target);
            var newRevision = GetRevision(target.path);

            return new ResponsePayload(200,
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"weaponId\":{Quote(weaponId)}," +
                $"\"managedObjectId\":{Quote(deploy.ManagedObjectId ?? "")}," +
                $"\"assetGuid\":{Quote(deploy.AssetGuid ?? "")}," +
                $"\"assetPath\":{Quote(scenePath)}," +
                $"\"scenePath\":{Quote(scenePath)}," +
                $"\"sceneGuid\":{Quote(actualSceneGuid)}," +
                $"\"updatedExisting\":{(deploy.UpdatedExisting ? "true" : "false")}," +
                $"\"unityRevision\":{newRevision}," +
                $"\"role\":{Quote(deploy.Role ?? "")}," +
                $"\"modelImported\":{(deploy.ModelImported ? "true" : "false")}," +
                $"\"definitionSynced\":{(deploy.DefinitionSynced ? "true" : "false")}," +
                $"\"anchorsValid\":{(deploy.AnchorsValid ? "true" : "false")}," +
                $"\"runtimeDeployApplied\":{(deploy.RuntimeDeployApplied ? "true" : "false")}," +
                $"\"runtimePlayable\":{(deploy.RuntimePlayable ? "true" : "false")}" +
                "}");
        }

        /// <summary>
        /// Place an imported asset into an explicitly chosen scene. Never auto-saves dirty scenes.
        /// Idempotent on requestId + payload hash. Sources confined to Imported/&lt;assetId&gt;/.
        /// </summary>
        private static ResponsePayload PlaceAssetInScene(string body)
        {
            var requestId = ReadString(body, "requestId");
            var assetId = ReadString(body, "assetId");
            var scenePath = ReadString(body, "scenePath");
            var displayName = ReadString(body, "displayName");
            var confirmSave = ReadBool(body, "confirmSave");
            var expectedRevision = ReadInt(body, "expectedUnityRevision");
            var hasExpectedRevision = body != null &&
                body.IndexOf("\"expectedUnityRevision\"", StringComparison.OrdinalIgnoreCase) >= 0;

            if (string.IsNullOrEmpty(requestId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"requestId required for placement.\"}");
            }

            if (string.IsNullOrEmpty(assetId) || !IsUuid(assetId))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"assetId must be a UUID.\"}");
            }

            if (string.IsNullOrEmpty(scenePath) ||
                !scenePath.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) ||
                !scenePath.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) ||
                scenePath.IndexOf("..", StringComparison.Ordinal) >= 0)
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"scenePath must be an Assets/Ã¢â‚¬Â¦/*.unity path.\"}");
            }

            if (!confirmSave)
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"confirmSave must be true after explicit Studio confirmation.\"}");
            }

            if (!hasExpectedRevision || expectedRevision < 0)
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"expectedUnityRevision is required and must be non-negative. Refresh the scene list and retry.\"}");
            }

            if (!TryParsePlaceTransform(body, out var position, out var rotation, out var scale, out var transformError))
            {
                return new ResponsePayload(400,
                    $"{{\"status\":\"failed\",\"error\":{Quote(transformError)}}}");
            }

            var assetFolder = $"Assets/HertzStudio/Imported/{assetId}";
            var resolved = ResolveConfinedPlaceSource(assetId, assetFolder, body, out var resolveError);
            if (resolved == null)
            {
                return new ResponsePayload(404,
                    $"{{\"status\":\"failed\",\"error\":{Quote(resolveError ?? "Imported model/prefab not found under asset folder.")}}}");
            }

            var sourcePath = AssetDatabase.GetAssetPath(resolved);
            var sourceGuid = AssetDatabase.AssetPathToGUID(sourcePath);
            var payloadHash = HashPlacePayload(
                assetId, scenePath, sourcePath, sourceGuid, position, rotation, scale, confirmSave, expectedRevision);

            var cached = FindPersistedResult(requestId);
            if (cached != null)
            {
                if (!string.IsNullOrEmpty(cached.PayloadHash) &&
                    !string.Equals(cached.PayloadHash, payloadHash, StringComparison.Ordinal))
                {
                    return new ResponsePayload(409,
                        "{" +
                        "\"status\":\"conflict\"," +
                        $"\"requestId\":{Quote(requestId)}," +
                        "\"error\":\"requestId reused with a different placement payload.\"" +
                        "}");
                }

                if (string.Equals(cached.Status, "applied", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(cached.Status, "failed", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(cached.Status, "conflict", StringComparison.OrdinalIgnoreCase))
                {
                    var cachedJson = string.IsNullOrEmpty(cached.Json)
                        ? "{" +
                          $"\"status\":{Quote(cached.Status)}," +
                          $"\"requestId\":{Quote(requestId)}," +
                          "\"deduplicated\":true" +
                          "}"
                        : cached.Json.Contains("\"deduplicated\"", StringComparison.Ordinal)
                            ? cached.Json
                            : cached.Json.TrimEnd('}') + ",\"deduplicated\":true}";
                    return new ResponsePayload(
                        cached.StatusCode > 0 ? cached.StatusCode : 200,
                        cachedJson);
                }
            }

            var dirtyBlockers = CollectDirtyOpenScenePaths();
            if (dirtyBlockers.Count > 0)
            {
                var listed = string.Join(", ", dirtyBlockers);
                var json =
                    "{" +
                    "\"status\":\"failed\"," +
                    "\"code\":\"unsaved_unity_changes\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"blockingScenes\":[{string.Join(",", dirtyBlockers.ConvertAll(p => Quote(p)))}]," +
                    $"\"error\":{Quote($"Unsaved Unity changes in: {listed}. Save or discard in the Editor, then retry.")}" +
                    "}";
                PersistResult(new PersistedResult
                {
                    RequestId = requestId,
                    PayloadHash = payloadHash,
                    ScenePath = scenePath,
                    Status = "failed",
                    StatusCode = 409,
                    UnityRevision = 0,
                    Json = json
                });
                return new ResponsePayload(409, json);
            }

            var sceneAbs = Path.GetFullPath(Path.Combine(ProjectRoot, scenePath.Replace('/', Path.DirectorySeparatorChar)));
            var assetsRoot = Path.GetFullPath(Application.dataPath);
            if (!IsPathInside(sceneAbs, assetsRoot) ||
                HasReparsePointInAncestry(sceneAbs, assetsRoot) ||
                !File.Exists(sceneAbs))
            {
                return new ResponsePayload(404,
                    $"{{\"status\":\"failed\",\"error\":{Quote($"Scene not found: {scenePath}")}}}");
            }

            var target = FindLoadedSceneByPath(scenePath);
            if (!target.IsValid())
            {
                // Additive when other scenes are already open so we never silently unload a multi-scene setup.
                var mode = SceneManager.sceneCount > 1 ? OpenSceneMode.Additive : OpenSceneMode.Single;
                target = EditorSceneManager.OpenScene(scenePath, mode);
            }

            if (!target.IsValid() || !target.isLoaded)
            {
                return new ResponsePayload(500,
                    "{\"status\":\"failed\",\"error\":\"Failed to open the target scene.\"}");
            }

            EnsureRevisionInitialized(target);
            var currentRevision = GetRevision(target.path);
            if (expectedRevision != currentRevision)
            {
                var conflictJson =
                    "{" +
                    "\"status\":\"conflict\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"error\":{Quote("Target scene revision mismatch. Re-sync and retry.")}," +
                    $"\"unityRevision\":{currentRevision}," +
                    $"\"expectedUnityRevision\":{expectedRevision}" +
                    "}";
                PersistResult(new PersistedResult
                {
                    RequestId = requestId,
                    PayloadHash = payloadHash,
                    ScenePath = target.path,
                    Status = "conflict",
                    StatusCode = 409,
                    UnityRevision = currentRevision,
                    Json = conflictJson
                });
                return new ResponsePayload(409, conflictJson);
            }

            // Re-validate source immediately before mutation (folder confinement).
            resolved = ResolveConfinedPlaceSource(assetId, assetFolder, body, out resolveError);
            if (resolved == null)
            {
                return new ResponsePayload(404,
                    $"{{\"status\":\"failed\",\"error\":{Quote(resolveError ?? "Source missing before place.")}}}");
            }

            sourcePath = AssetDatabase.GetAssetPath(resolved);
            sourceGuid = AssetDatabase.AssetPathToGUID(sourcePath);
            if (!IsAssetPathInsideFolder(sourcePath, assetFolder))
            {
                return new ResponsePayload(400,
                    "{\"status\":\"failed\",\"error\":\"Resolved source escaped the imported asset folder.\"}");
            }

            if (string.IsNullOrEmpty(displayName))
            {
                displayName = resolved.name;
            }

            displayName = SanitizeFileName(displayName);
            if (string.IsNullOrEmpty(displayName))
            {
                displayName = "HertzAsset";
            }

            var undoGroup = Undo.GetCurrentGroup();
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("HERTZ Studio place asset");

            GameObject instance = null;
            try
            {
                if (PrefabUtility.GetPrefabAssetType(resolved) != PrefabAssetType.NotAPrefab)
                {
                    instance = PrefabUtility.InstantiatePrefab(resolved, target) as GameObject;
                }
                else
                {
                    instance = UnityEngine.Object.Instantiate(resolved);
                    if (instance != null)
                    {
                        SceneManager.MoveGameObjectToScene(instance, target);
                    }
                }

                if (instance == null)
                {
                    throw new InvalidOperationException("Failed to instantiate asset.");
                }

                Undo.RegisterCreatedObjectUndo(instance, "HERTZ Studio place asset");
                instance.name = displayName;
                var t = instance.transform;
                Undo.RecordObject(t, "HERTZ Studio place transform");
                t.position = position;
                t.rotation = rotation;
                t.localScale = scale;

                var hadProvenance = instance.GetComponent<HertzStudioAssetProvenance>() != null;
                var provenance = HertzStudioAssetProvenance.EnsureOn(
                    instance,
                    assetId,
                    sourceGuid,
                    sourcePath);
                if (provenance != null)
                {
                    if (!hadProvenance)
                    {
                        Undo.RegisterCreatedObjectUndo(provenance, "HERTZ Studio asset provenance");
                    }

                    EditorUtility.SetDirty(provenance);
                }

                EditorSceneManager.MarkSceneDirty(target);
                if (!EditorSceneManager.SaveScene(target))
                {
                    Undo.RevertAllDownToGroup(undoGroup);
                    var saveFail =
                        "{" +
                        "\"status\":\"failed\"," +
                        $"\"requestId\":{Quote(requestId)}," +
                        "\"error\":\"SaveScene returned false after place; changes were reverted.\"" +
                        "}";
                    PersistResult(new PersistedResult
                    {
                        RequestId = requestId,
                        PayloadHash = payloadHash,
                        ScenePath = target.path,
                        Status = "failed",
                        StatusCode = 500,
                        UnityRevision = currentRevision,
                        Json = saveFail
                    });
                    return new ResponsePayload(500, saveFail);
                }
            }
            catch (Exception ex)
            {
                Undo.RevertAllDownToGroup(undoGroup);
                var failJson =
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"error\":{Quote(ex.Message)}" +
                    "}";
                PersistResult(new PersistedResult
                {
                    RequestId = requestId,
                    PayloadHash = payloadHash,
                    ScenePath = scenePath,
                    Status = "failed",
                    StatusCode = 500,
                    UnityRevision = currentRevision,
                    Json = failJson
                });
                return new ResponsePayload(500, failJson);
            }
            finally
            {
                Undo.CollapseUndoOperations(undoGroup);
            }

            var nextRevision = currentRevision + 1;
            SetRevision(target.path, nextRevision);
            EditorPrefs.SetString(PrefFingerprintPrefix + target.path, ComputeContentFingerprint(target));
            var globalId = GlobalObjectId.GetGlobalObjectIdSlow(instance).ToString();

            var appliedJson =
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"assetId\":{Quote(assetId)}," +
                $"\"scenePath\":{Quote(target.path)}," +
                $"\"instanceName\":{Quote(instance.name)}," +
                $"\"globalObjectId\":{Quote(globalId)}," +
                $"\"sourcePath\":{Quote(sourcePath)}," +
                $"\"unityRevision\":{nextRevision}," +
                "\"deduplicated\":false," +
                $"\"message\":{Quote($"Placed '{instance.name}' in {target.name}.")}" +
                "}";

            PersistResult(new PersistedResult
            {
                RequestId = requestId,
                PayloadHash = payloadHash,
                ScenePath = target.path,
                Status = "applied",
                StatusCode = 200,
                UnityRevision = nextRevision,
                Json = appliedJson
            });

            return new ResponsePayload(200, appliedJson);
        }

        private static List<string> CollectDirtyOpenScenePaths()
        {
            var list = new List<string>();
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.IsValid() || !scene.isLoaded || !scene.isDirty)
                {
                    continue;
                }

                list.Add(string.IsNullOrEmpty(scene.path) ? "(untitled)" : scene.path);
            }

            return list;
        }

        private static Scene FindLoadedSceneByPath(string scenePath)
        {
            for (var i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (scene.IsValid() &&
                    scene.isLoaded &&
                    string.Equals(scene.path, scenePath, StringComparison.OrdinalIgnoreCase))
                {
                    return scene;
                }
            }

            return default;
        }

        private static bool TryParsePlaceTransform(
            string body,
            out Vector3 position,
            out Quaternion rotation,
            out Vector3 scale,
            out string error)
        {
            position = Vector3.zero;
            rotation = Quaternion.identity;
            scale = Vector3.one;
            error = null;

            if (!TryReadVector3(body, "position", out position, Vector3.zero))
            {
                error = "position must be a finite {x,y,z} object when provided.";
                return false;
            }

            if (body != null && body.IndexOf("\"rotation\"", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                if (TryReadVector3(body, "rotation", out var euler, Vector3.zero))
                {
                    if (!IsFinite(euler))
                    {
                        error = "rotation euler values must be finite.";
                        return false;
                    }

                    rotation = Quaternion.Euler(euler);
                }
                else
                {
                    error = "rotation must be a finite euler {x,y,z} object when provided.";
                    return false;
                }
            }

            if (!TryReadVector3(body, "scale", out scale, Vector3.one))
            {
                error = "scale must be a finite {x,y,z} object when provided.";
                return false;
            }

            if (!IsFinite(position) || !IsFinite(scale))
            {
                error = "position and scale must be finite numbers.";
                return false;
            }

            if (scale.x < PlaceScaleMin || scale.y < PlaceScaleMin || scale.z < PlaceScaleMin ||
                scale.x > PlaceScaleMax || scale.y > PlaceScaleMax || scale.z > PlaceScaleMax)
            {
                error = $"scale components must be between {PlaceScaleMin} and {PlaceScaleMax}.";
                return false;
            }

            return true;
        }

        private static bool TryReadVector3(string body, string key, out Vector3 value, Vector3 fallback)
        {
            value = fallback;
            if (string.IsNullOrEmpty(body))
            {
                return true;
            }

            var token = $"\"{key}\"";
            var idx = body.IndexOf(token, StringComparison.OrdinalIgnoreCase);
            if (idx < 0)
            {
                return true;
            }

            var brace = body.IndexOf('{', idx + token.Length);
            if (brace < 0)
            {
                return false;
            }

            var end = body.IndexOf('}', brace);
            if (end < 0)
            {
                return false;
            }

            var slice = body.Substring(brace, end - brace + 1);
            if (!TryReadFloat(slice, "x", out var x) ||
                !TryReadFloat(slice, "y", out var y) ||
                !TryReadFloat(slice, "z", out var z))
            {
                return false;
            }

            value = new Vector3(x, y, z);
            return true;
        }

        private static bool TryReadFloat(string json, string key, out float value)
        {
            value = 0f;
            var token = $"\"{key}\"";
            var idx = json.IndexOf(token, StringComparison.OrdinalIgnoreCase);
            if (idx < 0)
            {
                return false;
            }

            var colon = json.IndexOf(':', idx + token.Length);
            if (colon < 0)
            {
                return false;
            }

            var i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i]))
            {
                i++;
            }

            var start = i;
            if (i < json.Length && (json[i] == '-' || json[i] == '+'))
            {
                i++;
            }

            while (i < json.Length && (char.IsDigit(json[i]) || json[i] == '.' || json[i] == 'e' || json[i] == 'E' ||
                                       json[i] == '-' || json[i] == '+'))
            {
                i++;
            }

            if (i <= start)
            {
                return false;
            }

            return float.TryParse(
                json.Substring(start, i - start),
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out value);
        }

        private static string HashPlacePayload(
            string assetId,
            string scenePath,
            string sourcePath,
            string sourceGuid,
            Vector3 position,
            Quaternion rotation,
            Vector3 scale,
            bool confirmSave,
            int expectedRevision)
        {
            var euler = rotation.eulerAngles;
            var raw =
                assetId + "|" + scenePath + "|" + sourcePath + "|" + sourceGuid + "|" +
                position.x.ToString("R", CultureInfo.InvariantCulture) + "," +
                position.y.ToString("R", CultureInfo.InvariantCulture) + "," +
                position.z.ToString("R", CultureInfo.InvariantCulture) + "|" +
                euler.x.ToString("R", CultureInfo.InvariantCulture) + "," +
                euler.y.ToString("R", CultureInfo.InvariantCulture) + "," +
                euler.z.ToString("R", CultureInfo.InvariantCulture) + "|" +
                scale.x.ToString("R", CultureInfo.InvariantCulture) + "," +
                scale.y.ToString("R", CultureInfo.InvariantCulture) + "," +
                scale.z.ToString("R", CultureInfo.InvariantCulture) + "|" +
                (confirmSave ? "1" : "0") + "|" + expectedRevision.ToString(CultureInfo.InvariantCulture);

            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
            var hex = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
            {
                hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            }

            return hex.ToString();
        }

        private static bool IsAssetPathInsideFolder(string assetPath, string folder)
        {
            if (string.IsNullOrEmpty(assetPath) || string.IsNullOrEmpty(folder))
            {
                return false;
            }

            var normalized = assetPath.Replace('\\', '/');
            var root = folder.Replace('\\', '/').TrimEnd('/');
            return normalized.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Resolve place source only under Assets/HertzStudio/Imported/&lt;assetId&gt;/.
        /// Client-supplied paths are hints and must still resolve inside that folder.
        /// </summary>
        private static GameObject ResolveConfinedPlaceSource(
            string assetId, string assetFolder, string body, out string error)
        {
            error = null;
            if (string.IsNullOrEmpty(assetId) || !IsUuid(assetId))
            {
                error = "assetId must be a UUID.";
                return null;
            }

            if (!AssetDatabase.IsValidFolder(assetFolder))
            {
                error = $"Imported folder missing: {assetFolder}";
                return null;
            }

            var preferred = new[]
            {
                ReadString(body, "prefabPath"),
                ReadString(body, "importedPath")
            };

            foreach (var candidate in preferred)
            {
                if (string.IsNullOrEmpty(candidate))
                {
                    continue;
                }

                var normalized = candidate.Replace('\\', '/');
                if (normalized.IndexOf("..", StringComparison.Ordinal) >= 0 ||
                    Path.IsPathRooted(normalized) ||
                    !IsAssetPathInsideFolder(normalized, assetFolder))
                {
                    error = $"Rejected path outside {assetFolder}: {candidate}";
                    return null;
                }

                var abs = Path.GetFullPath(Path.Combine(ProjectRoot, normalized.Replace('/', Path.DirectorySeparatorChar)));
                var folderAbs = Path.GetFullPath(Path.Combine(ProjectRoot, assetFolder.Replace('/', Path.DirectorySeparatorChar)));
                if (!IsPathInside(abs, folderAbs) || HasReparsePointInAncestry(abs, folderAbs))
                {
                    error = $"Rejected unsafe path: {candidate}";
                    return null;
                }

                var go = AssetDatabase.LoadAssetAtPath<GameObject>(normalized);
                if (go == null)
                {
                    error = $"No GameObject at confined path: {candidate}";
                    return null;
                }

                return go;
            }

            var prefabGuids = AssetDatabase.FindAssets("t:Prefab", new[] { assetFolder });
            for (var i = 0; i < prefabGuids.Length; i++)
            {
                var path = AssetDatabase.GUIDToAssetPath(prefabGuids[i]);
                if (!IsAssetPathInsideFolder(path, assetFolder))
                {
                    continue;
                }

                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (prefab != null)
                {
                    return prefab;
                }
            }

            var modelGuids = AssetDatabase.FindAssets("t:Model", new[] { assetFolder });
            for (var i = 0; i < modelGuids.Length; i++)
            {
                var path = AssetDatabase.GUIDToAssetPath(modelGuids[i]);
                if (!IsAssetPathInsideFolder(path, assetFolder))
                {
                    continue;
                }

                var model = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (model != null)
                {
                    return model;
                }
            }

            error = $"No prefab/model under {assetFolder}";
            return null;
        }

        /// <summary>
        /// Copy a complete staged package into Assets/HertzStudio/Imported/&lt;assetId&gt;/ then one Refresh.
        /// Never ForceUpdate + Refresh. Skip rewriting byte-identical destination files.
        /// </summary>
        private static ImportResult ExecuteStudioAssetImport(
            string requestId,
            string assetId,
            string fileName,
            string sourcePath,
            bool createPrefab,
            string body,
            string payloadHash)
        {
            var ext = Path.GetExtension(fileName).ToLowerInvariant();
            if (ext == ".usdz" || ext == ".usd")
            {
                return ImportResult.Failed(400, requestId, assetId,
                    "USDZ/USD is unsupported: no USD importer is installed.");
            }

            if (Path.IsPathRooted(sourcePath))
            {
                return ImportResult.Failed(400, requestId, assetId,
                    "sourcePath must be project-relative under Library/HertzStudioIncoming/<assetId>/<requestId>/.");
            }

            if (string.IsNullOrEmpty(requestId) || requestId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                requestId.Contains("..") || requestId.Contains('/') || requestId.Contains('\\'))
            {
                return ImportResult.Failed(400, requestId, assetId, "requestId is unsuitable for staging paths.");
            }

            var stagingRoot = Path.GetFullPath(Path.Combine(ProjectRoot, IncomingStagingRelative));
            var packageIncoming = Path.GetFullPath(Path.Combine(stagingRoot, assetId, requestId));
            var absSource = Path.GetFullPath(Path.Combine(ProjectRoot, sourcePath));
            if (!IsPathInside(absSource, packageIncoming))
            {
                return ImportResult.Failed(400, requestId, assetId,
                    "sourcePath must stay under Library/HertzStudioIncoming/<assetId>/<requestId>/.");
            }

            if (!File.Exists(absSource) || HasReparsePointInAncestry(absSource, packageIncoming))
            {
                return ImportResult.Failed(404, requestId, assetId,
                    "Source file not found or path contains a reparse point.");
            }

            var importedParent = Path.GetFullPath(Path.Combine(Application.dataPath, "HertzStudio", "Imported"));
            var importRoot = Path.GetFullPath(Path.Combine(importedParent, assetId));
            if (!IsPathInside(importRoot, importedParent) || HasReparsePointInAncestry(importRoot, importedParent))
            {
                return ImportResult.Failed(400, requestId, assetId, "Invalid import destination.");
            }

            Directory.CreateDirectory(importRoot);
            var destFileName = SanitizeFileName(fileName);
            var destAbs = Path.GetFullPath(Path.Combine(importRoot, destFileName));
            if (!IsPathInside(destAbs, importRoot))
            {
                return ImportResult.Failed(400, requestId, assetId, "Invalid destination file name.");
            }

            var anyCopied = CopyFileIfDifferent(absSource, destAbs);

            var deps = ReadDependencies(body);
            foreach (var dep in deps)
            {
                var rel = (dep.RelativePath ?? dep.FileName ?? "").Replace('\\', '/');
                if (string.IsNullOrEmpty(rel) || rel.Contains("..") || Path.IsPathRooted(rel))
                {
                    continue;
                }

                var depSourceRel = string.IsNullOrEmpty(dep.SourcePath)
                    ? Path.Combine(IncomingStagingRelative, assetId, requestId, rel).Replace('\\', '/')
                    : dep.SourcePath.Replace('\\', '/');
                if (Path.IsPathRooted(depSourceRel))
                {
                    continue;
                }

                var depAbsSource = Path.GetFullPath(Path.Combine(ProjectRoot, depSourceRel));
                if (!IsPathInside(depAbsSource, packageIncoming) ||
                    !File.Exists(depAbsSource) ||
                    HasReparsePointInAncestry(depAbsSource, packageIncoming))
                {
                    continue;
                }

                var depDestAbs = Path.GetFullPath(Path.Combine(importRoot, rel));
                if (!IsPathInside(depDestAbs, importRoot))
                {
                    continue;
                }

                Directory.CreateDirectory(Path.GetDirectoryName(depDestAbs) ?? importRoot);
                if (CopyFileIfDifferent(depAbsSource, depDestAbs))
                {
                    anyCopied = true;
                }
            }

            // One controlled refresh after the full dependency tree is present.
            // Do not call ForceUpdate, and do not pair ImportAsset with a redundant Refresh.
            if (anyCopied || AssetDatabase.LoadMainAssetAtPath(ToAssetPath(destAbs)) == null)
            {
                AssetDatabase.Refresh(ImportAssetOptions.Default);
            }

            var assetPath = ToAssetPath(destAbs);
            string prefabPath = null;
            var displayPrefabName = SanitizeFileName(
                ReadString(body, "displayName") ?? Path.GetFileNameWithoutExtension(destFileName));
            displayPrefabName = Path.GetFileNameWithoutExtension(displayPrefabName);
            if (string.IsNullOrEmpty(displayPrefabName))
            {
                displayPrefabName = Path.GetFileNameWithoutExtension(destFileName);
            }

            if (createPrefab && (ext == ".glb" || ext == ".gltf" || ext == ".fbx" || ext == ".obj"))
            {
                var imported = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
                if (imported != null)
                {
                    var instance = PrefabUtility.InstantiatePrefab(imported) as GameObject;
                    if (instance == null)
                    {
                        instance = UnityEngine.Object.Instantiate(imported);
                    }

                    instance.name = displayPrefabName;
                    var prefabAssetPath =
                        $"Assets/HertzStudio/Imported/{assetId}/{SanitizeFileName(displayPrefabName)}.prefab";
                    PrefabUtility.SaveAsPrefabAsset(instance, prefabAssetPath);
                    UnityEngine.Object.DestroyImmediate(instance);
                    prefabPath = prefabAssetPath;
                    AssetDatabase.SaveAssets();
                }
            }

            // Clean staging only after a terminal result.
            try
            {
                if (Directory.Exists(packageIncoming))
                {
                    Directory.Delete(packageIncoming, true);
                }

                var assetStaging = Path.GetFullPath(Path.Combine(stagingRoot, assetId));
                if (Directory.Exists(assetStaging) &&
                    Directory.GetFileSystemEntries(assetStaging).Length == 0)
                {
                    Directory.Delete(assetStaging, false);
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"HERTZ Studio staging cleanup deferred for {requestId}: {ex.Message}");
            }

            var json =
                "{" +
                "\"status\":\"applied\"," +
                $"\"requestId\":{Quote(requestId)}," +
                $"\"assetId\":{Quote(assetId)}," +
                $"\"importedPath\":{Quote(assetPath)}," +
                $"\"prefabPath\":{(prefabPath == null ? "null" : Quote(prefabPath))}," +
                $"\"payloadHash\":{Quote(payloadHash)}," +
                $"\"copied\":{(anyCopied ? "true" : "false")}" +
                "}";
            return new ImportResult(200, "applied", json);
        }

        private static bool CopyFileIfDifferent(string sourceAbs, string destAbs)
        {
            if (File.Exists(destAbs) && FilesByteIdentical(sourceAbs, destAbs))
            {
                return false;
            }

            File.Copy(sourceAbs, destAbs, true);
            return true;
        }

        private static bool FilesByteIdentical(string a, string b)
        {
            var fa = new FileInfo(a);
            var fb = new FileInfo(b);
            if (!fa.Exists || !fb.Exists || fa.Length != fb.Length)
            {
                return false;
            }

            const int bufSize = 81920;
            var bufferA = new byte[bufSize];
            var bufferB = new byte[bufSize];
            using var streamA = File.OpenRead(a);
            using var streamB = File.OpenRead(b);
            int readA;
            while ((readA = streamA.Read(bufferA, 0, bufferA.Length)) > 0)
            {
                var readB = streamB.Read(bufferB, 0, bufferB.Length);
                if (readA != readB)
                {
                    return false;
                }

                for (var i = 0; i < readA; i++)
                {
                    if (bufferA[i] != bufferB[i])
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        private static string HashImportPayload(
            string requestId, string assetId, string sourcePath, string fileName, string body)
        {
            var sb = new StringBuilder();
            sb.Append(requestId).Append('|').Append(assetId).Append('|')
                .Append(sourcePath).Append('|').Append(fileName);
            foreach (var dep in ReadDependencies(body))
            {
                sb.Append('|').Append(dep.RelativePath).Append(':').Append(dep.SourcePath);
            }

            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
            var hex = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
            {
                hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            }

            return hex.ToString();
        }

        private sealed class ImportResult
        {
            public readonly int StatusCode;
            public readonly string StatusLabel;
            public readonly string Json;

            public ImportResult(int statusCode, string statusLabel, string json)
            {
                StatusCode = statusCode;
                StatusLabel = statusLabel;
                Json = json;
            }

            public static ImportResult Failed(int code, string requestId, string assetId, string error)
            {
                var json =
                    "{" +
                    "\"status\":\"failed\"," +
                    $"\"requestId\":{Quote(requestId)}," +
                    $"\"assetId\":{Quote(assetId)}," +
                    $"\"error\":{Quote(error)}" +
                    "}";
                return new ImportResult(code, "failed", json);
            }
        }

        private sealed class DependencySpec
        {
            public string RelativePath;
            public string SourcePath;
            public string FileName;
        }

        private static System.Collections.Generic.List<DependencySpec> ReadDependencies(string body)
        {
            var list = new System.Collections.Generic.List<DependencySpec>();
            if (string.IsNullOrEmpty(body))
            {
                return list;
            }

            // Minimal JSON array scrape: "dependencies":[{...},...]
            var key = "\"dependencies\"";
            var idx = body.IndexOf(key, StringComparison.OrdinalIgnoreCase);
            if (idx < 0)
            {
                return list;
            }

            var bracket = body.IndexOf('[', idx);
            if (bracket < 0)
            {
                return list;
            }

            var depth = 0;
            var end = -1;
            for (var i = bracket; i < body.Length; i++)
            {
                if (body[i] == '[') depth++;
                else if (body[i] == ']')
                {
                    depth--;
                    if (depth == 0)
                    {
                        end = i;
                        break;
                    }
                }
            }

            if (end < 0)
            {
                return list;
            }

            var arrayBody = body.Substring(bracket + 1, end - bracket - 1);
            var objects = arrayBody.Split(new[] { "},{" }, StringSplitOptions.None);
            foreach (var raw in objects)
            {
                var obj = raw.Trim().TrimStart('{').TrimEnd('}', ',', ' ', '\n', '\r');
                if (string.IsNullOrEmpty(obj)) continue;
                list.Add(new DependencySpec
                {
                    RelativePath = ReadString("{" + obj + "}", "relativePath"),
                    SourcePath = ReadString("{" + obj + "}", "sourcePath"),
                    FileName = ReadString("{" + obj + "}", "fileName"),
                });
            }

            return list;
        }

        private static string SanitizeFileName(string name)
        {
            var invalid = Path.GetInvalidFileNameChars();
            var cleaned = Path.GetFileName(name ?? "asset.bin");
            foreach (var c in invalid)
            {
                cleaned = cleaned.Replace(c, '_');
            }

            return string.IsNullOrEmpty(cleaned) ? "asset.bin" : cleaned;
        }

        private static bool IsUuid(string value)
        {
            return System.Guid.TryParseExact(value, "D", out _) || System.Guid.TryParse(value, out _);
        }

        private static bool IsPathInside(string candidate, string root)
        {
            var full = Path.GetFullPath(candidate).Replace('\\', '/').TrimEnd('/');
            var rootFull = Path.GetFullPath(root).Replace('\\', '/').TrimEnd('/');
            return full.Equals(rootFull, System.StringComparison.OrdinalIgnoreCase)
                   || full.StartsWith(rootFull + "/", System.StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsReparsePoint(string path)
        {
            try
            {
                // Not-yet-created destinations are not reparse points; only existing nodes can be.
                if (!File.Exists(path) && !Directory.Exists(path))
                {
                    return false;
                }

                var attrs = File.GetAttributes(path);
                return (attrs & FileAttributes.ReparsePoint) != 0;
            }
            catch
            {
                return true;
            }
        }

        /// <summary>
        /// Walk from leaf up to (and including) stopAt directory for junction/symlink escapes.
        /// Missing leaf paths are ok (new import folders); existing ancestors are checked.
        /// </summary>
        private static bool HasReparsePointInAncestry(string path, string stopAt)
        {
            try
            {
                var current = Path.GetFullPath(path);
                var root = Path.GetFullPath(stopAt);
                while (!string.IsNullOrEmpty(current))
                {
                    if ((File.Exists(current) || Directory.Exists(current)) && IsReparsePoint(current))
                    {
                        return true;
                    }

                    if (current.Equals(root, StringComparison.OrdinalIgnoreCase))
                    {
                        break;
                    }

                    var parent = Path.GetDirectoryName(current);
                    if (string.IsNullOrEmpty(parent) || parent.Equals(current, StringComparison.OrdinalIgnoreCase))
                    {
                        break;
                    }

                    current = parent;
                }

                return false;
            }
            catch
            {
                return true;
            }
        }

        private static string ToAssetPath(string absolutePath)
        {
            var full = absolutePath.Replace('\\', '/');
            var data = Application.dataPath.Replace('\\', '/');
            if (full.StartsWith(data, StringComparison.OrdinalIgnoreCase))
            {
                return "Assets" + full.Substring(data.Length);
            }

            return full;
        }

        private static bool ReadBool(string json, string key)
        {
            var token = $"\"{key}\"";
            var idx = json.IndexOf(token, StringComparison.Ordinal);
            if (idx < 0) return false;
            var colon = json.IndexOf(':', idx + token.Length);
            if (colon < 0) return false;
            var slice = json.Substring(colon + 1).TrimStart();
            return slice.StartsWith("true", StringComparison.OrdinalIgnoreCase);
        }

        private static ResponsePayload Conflict(string message, int revision)
        {
            return new ResponsePayload(409,
                $"{{\"status\":\"conflict\",\"message\":{Quote(message)},\"unityRevision\":{revision}}}");
        }

        private static string JsonHealth(Scene scene)
        {
            return "{" +
                   "\"ok\":true," +
                   $"\"scenePath\":{Quote(scene.path)}," +
                   $"\"sceneName\":{Quote(scene.name)}," +
                   $"\"unityRevision\":{GetRevision(scene.path)}," +
                   $"\"authConfigured\":{(string.IsNullOrEmpty(_bridgeToken) ? "false" : "true")}," +
                   $"\"xr\":{JsonXrRuntime()}" +
                   "}";
        }

        private static string JsonXrRuntime()
        {
            // The bridge lives in the project's pre-existing Editor assembly, which does not
            // directly reference the optional XR Management/OpenXR package assemblies. Resolve
            // package-owned types at runtime so projects without either package still compile.
            object loader = null;
            string loaderName = null;
            try
            {
                var settingsType = Type.GetType(
                    "UnityEngine.XR.Management.XRGeneralSettings, Unity.XR.Management",
                    throwOnError: false);
                var settings = settingsType?.GetProperty("Instance")?.GetValue(null, null);
                var manager = settings?.GetType().GetProperty("Manager")?.GetValue(settings, null);
                loader = manager?.GetType().GetProperty("activeLoader")?.GetValue(manager, null);
                loaderName = loader is UnityEngine.Object loaderObject
                    ? loaderObject.name
                    : loader?.GetType().Name;
            }
            catch (Exception)
            {
                loader = null;
                loaderName = null;
            }

            var loaderActive = loader != null;

            var displays = new List<XRDisplaySubsystem>();
            SubsystemManager.GetSubsystems(displays);
            var displayRunning = false;
            for (var i = 0; i < displays.Count; i++)
            {
                if (displays[i] != null && displays[i].running)
                {
                    displayRunning = true;
                    break;
                }
            }

            var hmdDevices = new List<InputDevice>();
            InputDevices.GetDevicesWithCharacteristics(InputDeviceCharacteristics.HeadMounted, hmdDevices);
            var hmdPresent = false;
            string deviceName = null;
            for (var i = 0; i < hmdDevices.Count; i++)
            {
                if (!hmdDevices[i].isValid) continue;
                hmdPresent = true;
                if (string.IsNullOrEmpty(deviceName)) deviceName = hmdDevices[i].name;
            }

            string runtimeName = null;
            if (loaderActive)
            {
                try
                {
                    var runtimeType = Type.GetType(
                        "UnityEngine.XR.OpenXR.OpenXRRuntime, Unity.XR.OpenXR",
                        throwOnError: false);
                    runtimeName = runtimeType?.GetProperty("name")?.GetValue(null, null) as string;
                }
                catch (Exception) { runtimeName = null; }
            }

            return "{" +
                   $"\"loaderActive\":{(loaderActive ? "true" : "false")}," +
                   $"\"displayRunning\":{(displayRunning ? "true" : "false")}," +
                   $"\"hmdPresent\":{(hmdPresent ? "true" : "false")}," +
                   $"\"loaderName\":{Quote(loaderName)}," +
                   $"\"runtimeName\":{Quote(runtimeName)}," +
                   $"\"deviceName\":{Quote(deviceName)}" +
                   "}";
        }

        private static int GetRevision(string scenePath)
        {
            return EditorPrefs.GetInt(PrefRevisionPrefix + (scenePath ?? "untitled"), 0);
        }

        private static void SetRevision(string scenePath, int revision)
        {
            EditorPrefs.SetInt(PrefRevisionPrefix + (scenePath ?? "untitled"), revision);
        }

        private static GameObject FindByObjectId(string objectId)
        {
            if (GlobalObjectId.TryParse(objectId, out var globalId))
            {
                var obj = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(globalId);
                return obj as GameObject;
            }

            return GameObject.Find(objectId);
        }

        private static bool IsFinite(Vector3 value)
        {
            return !(float.IsNaN(value.x) || float.IsNaN(value.y) || float.IsNaN(value.z) ||
                     float.IsInfinity(value.x) || float.IsInfinity(value.y) || float.IsInfinity(value.z));
        }

        private static string HashPayload(string requestId, string scenePath, int baseRevision, List<Edit> edits)
        {
            var sb = new StringBuilder();
            sb.Append(requestId).Append('|').Append(scenePath).Append('|').Append(baseRevision);
            foreach (var edit in edits)
            {
                sb.Append('|').Append(edit.ObjectId).Append(':')
                    .Append(F(edit.Position.x)).Append(',')
                    .Append(F(edit.Position.y)).Append(',')
                    .Append(F(edit.Position.z));
            }

            using var sha = SHA256.Create();
            var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
            var hex = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
            {
                hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
            }

            return hex.ToString();
        }

        private static PersistedResult FindPersistedResult(string requestId)
        {
            lock (ResultLock)
            {
                if (!File.Exists(ResultsPath))
                {
                    return null;
                }

                try
                {
                    var json = File.ReadAllText(ResultsPath);
                    var marker = $"\"requestId\":{Quote(requestId)}";
                    var index = json.IndexOf(marker, StringComparison.Ordinal);
                    if (index < 0)
                    {
                        // also accept without spaces
                        marker = $"\"requestId\": \"{requestId}\"";
                        index = json.IndexOf($"\"requestId\":\"{requestId}\"", StringComparison.Ordinal);
                        if (index < 0)
                        {
                            index = json.IndexOf(marker, StringComparison.Ordinal);
                        }
                    }

                    if (index < 0)
                    {
                        return null;
                    }

                    var start = json.LastIndexOf('{', index);
                    var end = json.IndexOf('}', index);
                    if (start < 0 || end < 0)
                    {
                        return null;
                    }

                    // Prefer scanning objects via simple split of top-level array entries.
                    var results = LoadAllPersistedResults();
                    foreach (var result in results)
                    {
                        if (result.RequestId == requestId)
                        {
                            return result;
                        }
                    }
                }
                catch
                {
                    return null;
                }
            }

            return null;
        }

        private static List<PersistedResult> LoadAllPersistedResults()
        {
            var list = new List<PersistedResult>();
            if (!File.Exists(ResultsPath))
            {
                return list;
            }

            var json = File.ReadAllText(ResultsPath);
            foreach (var chunk in SplitObjects(ExtractArrayBody(json)))
            {
                list.Add(new PersistedResult
                {
                    RequestId = ReadString(chunk, "requestId"),
                    PayloadHash = ReadString(chunk, "payloadHash"),
                    ScenePath = ReadString(chunk, "scenePath"),
                    Status = ReadString(chunk, "status"),
                    StatusCode = ReadInt(chunk, "statusCode"),
                    UnityRevision = ReadInt(chunk, "unityRevision"),
                    Json = UnescapeJson(ReadString(chunk, "json"))
                });
            }

            return list;
        }

        private static string ExtractArrayBody(string json)
        {
            var start = json.IndexOf('[');
            var end = json.LastIndexOf(']');
            if (start < 0 || end <= start)
            {
                return string.Empty;
            }

            return json.Substring(start + 1, end - start - 1);
        }

        private static string UnescapeJson(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "{}";
            }

            return value.Replace("\\\"", "\"").Replace("\\\\", "\\");
        }

        private static void PersistResult(PersistedResult result)
        {
            lock (ResultLock)
            {
                var dir = Path.GetDirectoryName(ResultsPath);
                if (!string.IsNullOrEmpty(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                var existing = LoadAllPersistedResults();
                existing.RemoveAll(r => r.RequestId == result.RequestId);
                existing.Add(result);
                if (existing.Count > 200)
                {
                    existing.RemoveRange(0, existing.Count - 200);
                }

                var sb = new StringBuilder();
                sb.Append("{\"results\":[");
                for (var i = 0; i < existing.Count; i++)
                {
                    if (i > 0)
                    {
                        sb.Append(',');
                    }

                    var item = existing[i];
                    sb.Append('{')
                        .Append("\"requestId\":").Append(Quote(item.RequestId)).Append(',')
                        .Append("\"payloadHash\":").Append(Quote(item.PayloadHash)).Append(',')
                        .Append("\"scenePath\":").Append(Quote(item.ScenePath)).Append(',')
                        .Append("\"status\":").Append(Quote(item.Status)).Append(',')
                        .Append("\"statusCode\":").Append(item.StatusCode).Append(',')
                        .Append("\"unityRevision\":").Append(item.UnityRevision).Append(',')
                        .Append("\"json\":").Append(Quote(item.Json))
                        .Append('}');
                }

                sb.Append("]}");
                var tmp = ResultsPath + "." + ProcessId() + ".tmp";
                File.WriteAllText(tmp, sb.ToString(), Encoding.UTF8);
                if (File.Exists(ResultsPath))
                {
                    File.Delete(ResultsPath);
                }

                File.Move(tmp, ResultsPath);
            }
        }

        private static int ProcessId()
        {
            try
            {
                return System.Diagnostics.Process.GetCurrentProcess().Id;
            }
            catch
            {
                return 0;
            }
        }

        private static List<Edit> ExtractEdits(string body)
        {
            // Typed deserialize via JsonUtility (wrap array Ã¢â‚¬â€ Unity cannot FromJson a raw array).
            var wrapped = "{\"edits\":" + ExtractEditsArrayLiteral(body) + "}";
            ApplyRequestDto request;
            try
            {
                request = JsonUtility.FromJson<ApplyRequestDto>(wrapped);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"Apply body is not valid JSON: {ex.Message}");
            }

            if (request?.edits == null || request.edits.Length == 0)
            {
                return new List<Edit>();
            }

            var edits = new List<Edit>(request.edits.Length);
            var index = body.IndexOf("\"edits\"", StringComparison.Ordinal);
            var arrayStart = index >= 0 ? body.IndexOf('[', index) : -1;
            var arrayEnd = FindMatchingBracket(body, arrayStart);
            var array = arrayStart >= 0 && arrayEnd > arrayStart
                ? body.Substring(arrayStart + 1, arrayEnd - arrayStart - 1)
                : string.Empty;
            var chunks = SplitObjects(array);

            for (var i = 0; i < request.edits.Length; i++)
            {
                var dto = request.edits[i];
                if (dto == null || string.IsNullOrEmpty(dto.objectId))
                {
                    throw new InvalidOperationException("Edit missing objectId.");
                }

                // JsonUtility defaults missing floats to 0 Ã¢â‚¬â€ re-check raw tokens for each axis.
                var chunk = i < chunks.Count ? chunks[i] : string.Empty;
                var posBlock = ExtractObject(chunk, "position");
                if (string.IsNullOrEmpty(posBlock) || posBlock == "{}")
                {
                    throw new InvalidOperationException($"Edit {dto.objectId} missing position object.");
                }

                if (!TryReadRequiredFloat(posBlock, "x", out var x) ||
                    !TryReadRequiredFloat(posBlock, "y", out var y) ||
                    !TryReadRequiredFloat(posBlock, "z", out var z))
                {
                    throw new InvalidOperationException(
                        $"Edit {dto.objectId} has invalid/missing numeric position axes.");
                }

                if (dto.position == null)
                {
                    throw new InvalidOperationException($"Edit {dto.objectId} missing position object.");
                }

                // Require deserialized values match the strict token parse (rejects junk suffixes).
                if (!Approximately(dto.position.x, x) ||
                    !Approximately(dto.position.y, y) ||
                    !Approximately(dto.position.z, z))
                {
                    throw new InvalidOperationException(
                        $"Edit {dto.objectId} position failed typed/token consistency check.");
                }

                var position = new Vector3(x, y, z);
                if (!IsFinite(position))
                {
                    throw new InvalidOperationException($"Edit {dto.objectId} has non-finite position.");
                }

                edits.Add(new Edit
                {
                    ObjectId = dto.objectId,
                    Position = position
                });
            }

            return edits;
        }

        private static string ExtractEditsArrayLiteral(string body)
        {
            var index = body.IndexOf("\"edits\"", StringComparison.Ordinal);
            if (index < 0)
            {
                return "[]";
            }

            var arrayStart = body.IndexOf('[', index);
            var arrayEnd = FindMatchingBracket(body, arrayStart);
            if (arrayStart < 0 || arrayEnd < 0)
            {
                throw new InvalidOperationException("Apply body missing edits array.");
            }

            return body.Substring(arrayStart, arrayEnd - arrayStart + 1);
        }

        private static bool Approximately(float a, float b)
        {
            return Mathf.Abs(a - b) <= 0.0001f;
        }

        private static int FindMatchingBracket(string text, int openIndex)
        {
            if (openIndex < 0 || openIndex >= text.Length || text[openIndex] != '[')
            {
                return -1;
            }

            var depth = 0;
            for (var i = openIndex; i < text.Length; i++)
            {
                if (text[i] == '[')
                {
                    depth++;
                }
                else if (text[i] == ']')
                {
                    depth--;
                    if (depth == 0)
                    {
                        return i;
                    }
                }
            }

            return -1;
        }

        private static List<string> SplitObjects(string arrayBody)
        {
            var list = new List<string>();
            var depth = 0;
            var start = -1;
            for (var i = 0; i < arrayBody.Length; i++)
            {
                var c = arrayBody[i];
                if (c == '{')
                {
                    if (depth == 0)
                    {
                        start = i;
                    }

                    depth++;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth == 0 && start >= 0)
                    {
                        list.Add(arrayBody.Substring(start, i - start + 1));
                        start = -1;
                    }
                }
            }

            return list;
        }

        private static string ExtractObject(string body, string key)
        {
            var index = body.IndexOf($"\"{key}\"", StringComparison.Ordinal);
            if (index < 0)
            {
                return "{}";
            }

            var start = body.IndexOf('{', index);
            if (start < 0)
            {
                return "{}";
            }

            var depth = 0;
            for (var i = start; i < body.Length; i++)
            {
                if (body[i] == '{')
                {
                    depth++;
                }
                else if (body[i] == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        return body.Substring(start, i - start + 1);
                    }
                }
            }

            return "{}";
        }

        private static void WriteJson(BridgeHttpExchange context, int status, string json)
        {
            context.WriteJson(status, json);
        }

        private static string ReadString(string json, string key)
        {
            var token = $"\"{key}\"";
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0)
            {
                return null;
            }

            var colon = json.IndexOf(':', index + token.Length);
            if (colon < 0)
            {
                return null;
            }

            var i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i]))
            {
                i++;
            }

            if (i >= json.Length)
            {
                return null;
            }

            // JSON null / non-string â†’ treat as missing (do not read the next key name as a value).
            if (json[i] != '"')
            {
                if (json.Length >= i + 4 &&
                    string.Compare(json, i, "null", 0, 4, StringComparison.OrdinalIgnoreCase) == 0)
                {
                    return null;
                }

                return null;
            }

            var sb = new StringBuilder();
            for (var p = i + 1; p < json.Length; p++)
            {
                var c = json[p];
                if (c == '\\' && p + 1 < json.Length)
                {
                    sb.Append(json[p + 1]);
                    p++;
                    continue;
                }

                if (c == '"')
                {
                    break;
                }

                sb.Append(c);
            }

            return sb.ToString();
        }

        private static int ReadInt(string json, string key)
        {
            var token = $"\"{key}\"";
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0)
            {
                return 0;
            }

            var start = json.IndexOfAny(new[] { '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9' }, index + token.Length);
            if (start < 0)
            {
                return 0;
            }

            var end = start;
            if (json[end] == '-')
            {
                end++;
            }

            while (end < json.Length && char.IsDigit(json[end]))
            {
                end++;
            }

            return int.TryParse(json.Substring(start, end - start), out var value) ? value : 0;
        }

        /// <summary>
        /// Strict numeric parse for a JSON object property. Rejects missing keys, null,
        /// quoted non-numbers, and values that are not immediately after the colon.
        /// </summary>
        private static bool TryReadRequiredFloat(string json, string key, out float value)
        {
            value = 0f;
            var token = $"\"{key}\"";
            var index = json.IndexOf(token, StringComparison.Ordinal);
            if (index < 0)
            {
                return false;
            }

            var colon = json.IndexOf(':', index + token.Length);
            if (colon < 0)
            {
                return false;
            }

            var i = colon + 1;
            while (i < json.Length && char.IsWhiteSpace(json[i]))
            {
                i++;
            }

            if (i >= json.Length)
            {
                return false;
            }

            // Reject strings/null/objects/arrays Ã¢â‚¬â€ only raw JSON numbers are allowed.
            if (json[i] == '"' || json[i] == 'n' || json[i] == '{' || json[i] == '[')
            {
                return false;
            }

            var start = i;
            if (json[i] == '-' || json[i] == '+')
            {
                i++;
            }

            var sawDigit = false;
            while (i < json.Length && char.IsDigit(json[i]))
            {
                sawDigit = true;
                i++;
            }

            if (i < json.Length && json[i] == '.')
            {
                i++;
                while (i < json.Length && char.IsDigit(json[i]))
                {
                    sawDigit = true;
                    i++;
                }
            }

            if (!sawDigit)
            {
                return false;
            }

            if (i < json.Length && (json[i] == 'e' || json[i] == 'E'))
            {
                i++;
                if (i < json.Length && (json[i] == '+' || json[i] == '-'))
                {
                    i++;
                }

                var expDigits = false;
                while (i < json.Length && char.IsDigit(json[i]))
                {
                    expDigits = true;
                    i++;
                }

                if (!expDigits)
                {
                    return false;
                }
            }

            if (!float.TryParse(
                    json.Substring(start, i - start),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out value))
            {
                return false;
            }

            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                return false;
            }

            // Complete-token check: reject values like 1oops / 1.5x where junk follows the number.
            while (i < json.Length && char.IsWhiteSpace(json[i]))
            {
                i++;
            }

            if (i < json.Length)
            {
                var c = json[i];
                if (c != ',' && c != '}' && c != ']')
                {
                    return false;
                }
            }

            return true;
        }

        private static string Quote(string value)
        {
            if (value == null)
            {
                return "null";
            }

            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        private static string F(float value)
        {
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        [Serializable]
        private sealed class ApplyRequestDto
        {
            public EditDto[] edits;
        }

        [Serializable]
        private sealed class EditDto
        {
            public string objectId;
            public PositionDto position;
        }

        [Serializable]
        private sealed class PositionDto
        {
            public float x;
            public float y;
            public float z;
        }

        private sealed class Edit
        {
            public string ObjectId;
            public Vector3 Position;
        }

        private sealed class BridgeHttpExchange
        {
            private readonly NetworkStream _stream;
            private readonly Dictionary<string, string> _headers;
            private readonly string _query;
            private bool _written;

            public BridgeHttpExchange(
                NetworkStream stream,
                string method,
                string path,
                string query,
                Dictionary<string, string> headers,
                string body)
            {
                _stream = stream;
                Method = method ?? string.Empty;
                Path = path ?? "/";
                _query = query ?? string.Empty;
                _headers = headers ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                Body = body ?? string.Empty;
            }

            public string Method { get; }
            public string Path { get; }
            public string Body { get; }

            public string GetHeader(string name)
            {
                if (string.IsNullOrEmpty(name))
                {
                    return null;
                }

                return _headers.TryGetValue(name, out var value) ? value : null;
            }

            public string GetQuery(string key)
            {
                if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(_query))
                {
                    return null;
                }

                var parts = _query.Split('&');
                for (var i = 0; i < parts.Length; i++)
                {
                    var part = parts[i];
                    var eq = part.IndexOf('=');
                    var name = eq >= 0 ? part.Substring(0, eq) : part;
                    if (!string.Equals(Uri.UnescapeDataString(name.Replace('+', ' ')), key, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (eq < 0)
                    {
                        return string.Empty;
                    }

                    return Uri.UnescapeDataString(part.Substring(eq + 1).Replace('+', ' '));
                }

                return null;
            }

            public void WriteJson(int status, string json)
            {
                if (_written)
                {
                    return;
                }

                _written = true;
                var bodyBytes = Encoding.UTF8.GetBytes(json ?? string.Empty);
                var reason = status == 200 ? "OK" :
                    status == 202 ? "Accepted" :
                    status == 400 ? "Bad Request" :
                    status == 401 ? "Unauthorized" :
                    status == 404 ? "Not Found" :
                    status == 409 ? "Conflict" :
                    status == 500 ? "Internal Server Error" :
                    status == 503 ? "Service Unavailable" :
                    status == 504 ? "Gateway Timeout" : "OK";
                var header =
                    "HTTP/1.1 " + status + " " + reason + "\r\n" +
                    "Content-Type: application/json; charset=utf-8\r\n" +
                    "Content-Length: " + bodyBytes.Length + "\r\n" +
                    "Connection: close\r\n\r\n";
                var headerBytes = Encoding.ASCII.GetBytes(header);
                _stream.Write(headerBytes, 0, headerBytes.Length);
                _stream.Write(bodyBytes, 0, bodyBytes.Length);
                _stream.Flush();
            }
        }
        private const string PendingAnalyticsRelative = "Tools/HertzStudio/data/w06-pending-capture.json";
        private const string PendingAnalyticsQueueRelative = "Tools/HertzStudio/data/w06-pending-queue";

        /// <summary>Enqueue a capture into the durable multi-item pending queue.</summary>
        public static void StagePendingAnalyticsCaptureFile(string sourcePath)
        {
            if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
            {
                throw new FileNotFoundException("Analytics capture source missing.", sourcePath);
            }

            Hertz.Analytics.HertzAnalyticsCapture.StagePendingCapture(sourcePath);
        }

        private static ResponsePayload GetPendingAnalyticsCapture()
        {
            // Prefer durable queue (first pending). Fall back to legacy single file.
            var pending = Hertz.Analytics.HertzAnalyticsCapture.ListPendingCaptures();
            if (pending != null && pending.Count > 0)
            {
                var first = pending[0];
                try
                {
                    var json = File.ReadAllText(first.FilePath, Encoding.UTF8).Trim();
                    if (!string.IsNullOrEmpty(json) && json[0] == '{')
                    {
                        return new ResponsePayload(200,
                            $"{{\"ok\":true,\"captureId\":{Quote(first.CaptureId)},\"queueDepth\":{pending.Count},\"capture\":{json}}}");
                    }
                }
                catch (Exception ex)
                {
                    return new ResponsePayload(500,
                        $"{{\"ok\":false,\"error\":\"corrupt_queue_entry\",\"captureId\":{Quote(first.CaptureId)},\"message\":{Quote(ex.Message)}}}");
                }
            }

            var path = Path.GetFullPath(PendingAnalyticsRelative);
            if (!File.Exists(path))
            {
                return new ResponsePayload(200, "{\"ok\":true,\"capture\":null,\"queueDepth\":0}");
            }

            var legacy = File.ReadAllText(path, Encoding.UTF8).Trim();
            if (string.IsNullOrEmpty(legacy) || legacy[0] != '{')
            {
                return new ResponsePayload(200, "{\"ok\":true,\"capture\":null,\"queueDepth\":0}");
            }

            return new ResponsePayload(200,
                $"{{\"ok\":true,\"captureId\":\"legacy_pending\",\"queueDepth\":1,\"capture\":{legacy}}}");
        }

        private static ResponsePayload AckPendingAnalyticsCapture(string body)
        {
            var captureId = ReadString(body, "captureId");
            if (!string.IsNullOrEmpty(captureId) &&
                !string.Equals(captureId, "legacy_pending", StringComparison.Ordinal) &&
                !string.Equals(captureId, "pending", StringComparison.Ordinal))
            {
                var acked = Hertz.Analytics.HertzAnalyticsCapture.AckPendingCapture(captureId);
                return new ResponsePayload(200,
                    $"{{\"ok\":true,\"acked\":{(acked ? "true" : "false")},\"captureId\":{Quote(captureId)}}}");
            }

            var path = Path.GetFullPath(PendingAnalyticsRelative);
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            return new ResponsePayload(200, "{\"ok\":true,\"acked\":true}");
        }

        private static ResponsePayload StageAnalyticsCaptureFromBody(string body)
        {
            if (string.IsNullOrWhiteSpace(body) || body.TrimStart()[0] != '{')
            {
                return new ResponsePayload(400, "{\"ok\":false,\"error\":\"capture JSON object required\"}");
            }

            var queueRoot = Path.GetFullPath(PendingAnalyticsQueueRelative);
            Directory.CreateDirectory(queueRoot);
            var tmp = Path.Combine(queueRoot, "incoming_" + Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(tmp, body.Trim(), new UTF8Encoding(false));
            var staged = Hertz.Analytics.HertzAnalyticsCapture.StagePendingCapture(tmp);
            try { File.Delete(tmp); } catch { /* best-effort */ }
            return new ResponsePayload(200,
                $"{{\"ok\":true,\"staged\":true,\"path\":{Quote(staged)}}}");
        }

        private sealed class ResponsePayload
        {
            public ResponsePayload(int statusCode, string json)
            {
                StatusCode = statusCode;
                Json = json;
            }

            public int StatusCode { get; }
            public string Json { get; }
        }

        private sealed class PersistedResult
        {
            public string RequestId;
            public string PayloadHash;
            public string ScenePath;
            public string Status;
            public int StatusCode;
            public int UnityRevision;
            public string Json;
        }
    }
}






