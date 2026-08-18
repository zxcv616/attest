// NOT compiled or run against a real Unity Editor — see AttestRpcMessages.cs
// header. This is the C# half of the handshake the daemon side already has
// working, real, tested end-to-end (packages/daemon/test/rpc-server.test.ts
// and scripts/daemon-smoke.mjs). This file is the other half of that same
// contract, written against documented Unity/.NET APIs but unverified by a
// real compiler. Validating it is the very first thing to do once Unity is
// available — see repo root README and fixtures/platformer-basic/README.md.

using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor.Rpc
{
    /// <summary>
    /// Spec §6 "The connection model": the daemon is the server; Unity is
    /// the client that reconnects. This static class's job is entirely
    /// about surviving the things that routinely kill the socket —
    /// compile-triggered domain reload, Play-Mode-triggered domain reload
    /// (when Enter Play Mode Options has reload enabled, which is the
    /// default), and Editor restart — never about the request/response
    /// tool surface itself (that's M1, once scene.apply_transaction etc.
    /// exist on the Unity side).
    ///
    /// [InitializeOnLoad] means the static constructor below runs on EVERY
    /// domain reload, which is exactly the reconnect trigger this design
    /// depends on.
    /// </summary>
    [InitializeOnLoad]
    public static class AttestConnection
    {
        public enum ConnectionState { Disconnected, Connecting, HandshakePending, Connected, Incompatible }

        // Bump alongside packages/schemas and packages/daemon's
        // supportedPackageSchemaVersions default. No codegen keeping these
        // in sync yet (M1 TODO, see AttestRpcMessages.cs header).
        private const string PackageSchemaVersion = "0.1.0";
        private const string ReasonHintKey = "Attest.ReasonHint";
        private const int PortDiscoveryRetries = 5;
        private const double PortDiscoveryRetryDelaySeconds = 1.5;
        private const double HeartbeatIntervalSeconds = 2.0;

        private static ClientWebSocket _socket;
        private static CancellationTokenSource _cts;
        private static double _lastHeartbeatSentAt;
        private static readonly byte[] ReceiveBuffer = new byte[64 * 1024];

        public static ConnectionState State { get; private set; } = ConnectionState.Disconnected;
        public static string SessionToken { get; private set; }
        public static string LastError { get; private set; }

        static AttestConnection()
        {
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            EditorApplication.update += Tick;

            var reason = DetermineReason();
            ConnectAsync(reason); // async void — fire-and-forget is the point; can't be discard-assigned (CS8209)
        }

        /// <summary>Manual retry — wired to the "Reconnect" button in AttestWindow.</summary>
        public static void Reconnect() => ConnectAsync("initial_connect");

        private static string DetermineReason()
        {
            var hint = SessionState.GetString(ReasonHintKey, null);
            if (!string.IsNullOrEmpty(hint))
            {
                SessionState.EraseString(ReasonHintKey);
                return hint;
            }

            if (!AttestSessionState.SeenThisProcessBefore())
            {
                // First time this Editor PROCESS has initialized Attest.
                // If there's a session token left over from a workspace
                // file, the process itself must have restarted mid-task.
                return AttestSessionState.GetSessionToken() != null ? "editor_restart" : "initial_connect";
            }

            return "domain_reload";
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            // These fire whether or not a domain reload actually follows
            // (Enter Play Mode Options can disable reload — spec §6). If a
            // reload DOES follow, DetermineReason() picks up this hint
            // instead of defaulting to the less specific "domain_reload".
            // If no reload follows, the hint is simply never consumed and
            // is overwritten on the next transition — harmless.
            switch (change)
            {
                case PlayModeStateChange.ExitingEditMode:
                    SessionState.SetString(ReasonHintKey, "play_mode_enter");
                    break;
                case PlayModeStateChange.ExitingPlayMode:
                    SessionState.SetString(ReasonHintKey, "play_mode_exit");
                    break;
            }
        }

        private static async void ConnectAsync(string reason)
        {
            State = ConnectionState.Connecting;
            LastError = null;
            try
            {
                int port = await DiscoverDaemonPortAsync();

                _socket?.Dispose();
                _cts?.Cancel();
                _socket = new ClientWebSocket();
                _cts = new CancellationTokenSource();

                await _socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}"), _cts.Token);

                var hello = new HelloMessage
                {
                    UnityVersion = Application.unityVersion,
                    PackageSchemaVersion = PackageSchemaVersion,
                    ProjectPath = ProjectRootPath,
                    SessionToken = AttestSessionState.GetSessionToken(),
                    LastIdempotencyKey = AttestSessionState.GetLastIdempotencyKey(),
                    Reason = reason,
                };
                await SendAsync(hello);
                State = ConnectionState.HandshakePending;

                _ = ReceiveLoopAsync(_cts.Token);
            }
            catch (Exception e)
            {
                LastError = e.Message;
                State = ConnectionState.Disconnected;
                Debug.LogWarning($"[Attest] connection attempt failed ({reason}): {e.Message}");
            }
        }

        private static string ProjectRootPath => Directory.GetParent(Application.dataPath)!.FullName;

        /// <summary>
        /// The daemon writes its bound port to &lt;project&gt;/.attest/daemon-port
        /// on startup (packages/daemon/src/index.ts). Retries with a short
        /// delay since the daemon may not have started yet — most commonly
        /// right after the Editor itself just opened.
        /// </summary>
        private static async Task<int> DiscoverDaemonPortAsync()
        {
            var portFile = Path.Combine(ProjectRootPath, ".attest", "daemon-port");
            for (int attempt = 0; attempt < PortDiscoveryRetries; attempt++)
            {
                if (File.Exists(portFile))
                {
                    var text = File.ReadAllText(portFile).Trim();
                    if (int.TryParse(text, out var port)) return port;
                }
                await Task.Delay(TimeSpan.FromSeconds(PortDiscoveryRetryDelaySeconds));
            }
            throw new InvalidOperationException(
                $"No daemon port file at {portFile} after {PortDiscoveryRetries} attempts — is `npm run daemon` running for this project?");
        }

        private static async Task SendAsync(object message)
        {
            var json = JsonConvert.SerializeObject(message, new JsonSerializerSettings
            {
                NullValueHandling = NullValueHandling.Ignore,
            });
            var bytes = Encoding.UTF8.GetBytes(json);
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);
        }

        private static async Task ReceiveLoopAsync(CancellationToken token)
        {
            try
            {
                while (_socket.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    using var ms = new MemoryStream();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await _socket.ReceiveAsync(new ArraySegment<byte>(ReceiveBuffer), token);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            State = ConnectionState.Disconnected;
                            return;
                        }
                        ms.Write(ReceiveBuffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    var json = Encoding.UTF8.GetString(ms.ToArray());
                    // Awaited, not fire-and-forget: the daemon issues one
                    // request at a time (its task engine executes
                    // transactions sequentially), so processing messages
                    // in order — rather than letting a slow handler race a
                    // later message — is both simpler and matches reality.
                    await HandleMessageAsync(json);
                }
            }
            catch (OperationCanceledException)
            {
                // expected on Reconnect()/domain reload teardown
            }
            catch (Exception e)
            {
                LastError = e.Message;
                State = ConnectionState.Disconnected;
                Debug.LogWarning($"[Attest] receive loop ended: {e.Message}");
            }
        }

        private static async Task HandleMessageAsync(string json)
        {
            var envelope = JsonConvert.DeserializeObject<EnvelopeEnvelope>(json);
            switch (envelope?.Type)
            {
                case "hello_ack":
                    HandleHelloAck(json);
                    break;
                case "response":
                    // The daemon calling INTO Unity is not a thing that
                    // happens — Unity never issues a `request` of its own
                    // (RpcServer's registerHandler/handleRequest path exists
                    // for it structurally, but nothing on this side calls
                    // it). A `response` arriving here would mean the daemon
                    // sent one unprompted, which is a protocol violation;
                    // kept observable via LastResponseJson rather than
                    // silently dropped, in case that assumption is wrong.
                    LastResponseJson = json;
                    Debug.LogWarning("[Attest] received an unexpected `response` — Unity never issues a `request`, so nothing should be answering one.");
                    break;
                case "request":
                    await HandleIncomingRequest(json);
                    break;
                default:
                    Debug.LogWarning($"[Attest] unhandled message type: {envelope?.Type}");
                    break;
            }
        }

        public static string LastResponseJson { get; private set; }

        /// <summary>
        /// M1 §Phase 1: the daemon asking Unity to do something. Sets the
        /// last-idempotency-key BEFORE executing (spec §6) so a domain
        /// reload mid-handler still reports the right key on the next
        /// hello, and clears it after responding either way — a sent
        /// response (success or failure) means this operation is no longer
        /// "in flight" from Unity's side, regardless of outcome.
        /// </summary>
        private static async Task HandleIncomingRequest(string json)
        {
            var req = JsonConvert.DeserializeObject<RequestMessage>(json);

            if (!string.IsNullOrEmpty(req.IdempotencyKey))
            {
                AttestSessionState.SetLastIdempotencyKey(req.IdempotencyKey);
            }

            object result = null;
            RpcError error = null;

            if (!AttestRequestDispatcher.TryGet(req.Method, out var handler))
            {
                error = new RpcError { Code = "unknown_method", Message = $"No handler registered for {req.Method}", Retryable = false };
            }
            else
            {
                try
                {
                    result = await handler(req.Params ?? new JObject());
                }
                catch (Exception e)
                {
                    error = new RpcError { Code = "handler_error", Message = e.Message, Retryable = false };
                }
            }

            await SendAsync(new ResponseMessage
            {
                Type = "response",
                RequestId = req.Id,
                Ok = error == null,
                Result = result,
                Error = error,
            });

            if (!string.IsNullOrEmpty(req.IdempotencyKey))
            {
                AttestSessionState.ClearLastIdempotencyKey();
            }
        }

        private static void HandleHelloAck(string json)
        {
            var ack = JsonConvert.DeserializeObject<HelloAckMessage>(json);
            if (!ack.Compatible)
            {
                State = ConnectionState.Incompatible;
                LastError = $"Daemon rejected Unity {Application.unityVersion} / package schema {PackageSchemaVersion} — version mismatch (spec §4 pinned matrix).";
                Debug.LogError($"[Attest] {LastError}");
                return;
            }

            AttestSessionState.SetSessionToken(ack.SessionToken);
            SessionToken = ack.SessionToken;
            State = ConnectionState.Connected;

            if (ack.PendingReconciliation != null)
            {
                Debug.Log($"[Attest] reconciling in-flight operation {ack.PendingReconciliation.IdempotencyKey}: {ack.PendingReconciliation.Action}");
                // M1 TODO: act on confirm/re_issue/rollback once transactions
                // exist to reconcile. For now this just clears the stale key
                // so it isn't reported again on the next reconnect.
                AttestSessionState.ClearLastIdempotencyKey();
            }
        }

        private static void Tick()
        {
            if (State != ConnectionState.Connected) return;
            if (EditorApplication.timeSinceStartup - _lastHeartbeatSentAt < HeartbeatIntervalSeconds) return;
            _lastHeartbeatSentAt = EditorApplication.timeSinceStartup;

            var heartbeat = new HeartbeatMessage
            {
                At = DateTime.UtcNow.ToString("o"),
                EditorState = EditorApplication.isCompiling ? "compiling"
                    : EditorApplication.isPlayingOrWillChangePlaymode ? "play_mode"
                    : "idle",
            };
            _ = SendAsync(heartbeat);
        }
    }
}
