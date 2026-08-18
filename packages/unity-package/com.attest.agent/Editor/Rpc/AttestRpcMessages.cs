// Mirrors packages/schemas/src/rpc.schema.json. If you change one, change
// the other — there is no codegen wiring these together yet (an M1 TODO;
// see spec §6 "Unity adapter: typed RPC client, version negotiation,
// transaction and evidence schemas").
//
// NOT compiled or run against a real Unity Editor: this repository was
// scaffolded on a machine with no Unity install (see repo root README).
// These types are written carefully against documented Unity/.NET APIs but
// have not been verified by the compiler. Treat as a strong draft, not a
// proven artifact, until someone with Unity 6.3 LTS opens this package and
// it compiles clean.

using System.Collections.Generic;
using Newtonsoft.Json;

namespace Attest.Editor.Rpc
{
    /// <summary>
    /// First message sent on every connect/reconnect, including after a
    /// domain reload. Spec §6 "The connection model".
    /// </summary>
    public class HelloMessage
    {
        [JsonProperty("type")] public string Type = "hello";
        [JsonProperty("unityVersion")] public string UnityVersion;
        [JsonProperty("packageSchemaVersion")] public string PackageSchemaVersion;
        [JsonProperty("projectPath")] public string ProjectPath;
        [JsonProperty("sessionToken")] public string SessionToken;
        [JsonProperty("lastIdempotencyKey")] public string LastIdempotencyKey;

        /// <summary>initial_connect | domain_reload | play_mode_enter | play_mode_exit | editor_restart</summary>
        [JsonProperty("reason")] public string Reason;
    }

    public class PendingReconciliation
    {
        [JsonProperty("idempotencyKey")] public string IdempotencyKey;

        /// <summary>confirm | re_issue | rollback</summary>
        [JsonProperty("action")] public string Action;
    }

    public class HelloAckMessage
    {
        [JsonProperty("type")] public string Type;
        [JsonProperty("sessionToken")] public string SessionToken;
        [JsonProperty("compatible")] public bool Compatible;
        [JsonProperty("pendingReconciliation")] public PendingReconciliation PendingReconciliation;
    }

    public class RequestMessage
    {
        [JsonProperty("type")] public string Type = "request";
        [JsonProperty("id")] public string Id;
        [JsonProperty("method")] public string Method;
        [JsonProperty("params")] public Dictionary<string, object> Params;
        [JsonProperty("idempotencyKey")] public string IdempotencyKey;
    }

    public class RpcError
    {
        [JsonProperty("code")] public string Code;
        [JsonProperty("message")] public string Message;
        [JsonProperty("retryable")] public bool Retryable;
    }

    public class ResponseMessage
    {
        [JsonProperty("type")] public string Type;
        [JsonProperty("requestId")] public string RequestId;
        [JsonProperty("ok")] public bool Ok;
        [JsonProperty("result")] public object Result;
        [JsonProperty("error")] public RpcError Error;
    }

    public class HeartbeatMessage
    {
        [JsonProperty("type")] public string Type = "heartbeat";
        [JsonProperty("at")] public string At;

        /// <summary>idle | compiling | play_mode | importing | modal_blocked</summary>
        [JsonProperty("editorState")] public string EditorState;
    }

    /// <summary>
    /// Just enough to read the "type" discriminator before deciding which
    /// concrete class to deserialize the rest of the payload as.
    /// </summary>
    public class EnvelopeEnvelope
    {
        [JsonProperty("type")] public string Type;
    }
}
