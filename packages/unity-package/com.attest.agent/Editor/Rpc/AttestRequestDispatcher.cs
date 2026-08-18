// NOT compiled or run against a real Unity Editor — see AttestRpcMessages.cs header.

using System.Collections.Generic;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace Attest.Editor.Rpc
{
    /// <summary>
    /// M1 §Phase 1: the daemon-initiated half of the tool surface. The
    /// daemon decides an inspection or transaction call is needed and sends
    /// a `request` envelope (see RpcServer.callUnity on the daemon side);
    /// AttestConnection deserializes it and looks up the handler here by
    /// method name. Kept separate from AttestConnection — which only owns
    /// socket lifecycle (connect/reconnect/heartbeat) — so tool handlers
    /// (Phase 2 inspection, Phase 3 transactions) can register themselves
    /// via their own [InitializeOnLoad] static constructors without
    /// depending on connection internals.
    /// </summary>
    public static class AttestRequestDispatcher
    {
        public delegate Task<object> Handler(JObject parameters);

        private static readonly Dictionary<string, Handler> Handlers = new Dictionary<string, Handler>();

        /// <summary>
        /// Last registration for a given method wins — intentional, so a
        /// script-reload that re-runs [InitializeOnLoad] constructors
        /// simply replaces the old delegate rather than needing explicit
        /// unregistration first.
        /// </summary>
        public static void Register(string method, Handler handler) => Handlers[method] = handler;

        public static bool TryGet(string method, out Handler handler) => Handlers.TryGetValue(method, out handler);

        public static IReadOnlyCollection<string> RegisteredMethods => Handlers.Keys;
    }
}
