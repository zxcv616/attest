// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System;
using System.Threading.Tasks;
using Attest.Editor.Rpc;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor.Inspection
{
    /// <summary>
    /// M1 Phase 2 (spec §9 "code.find_symbol"). Spec §4: TypeCache instead
    /// of Roslyn. Scoped to MonoBehaviour and ScriptableObject subclasses —
    /// the two categories that matter for "what component/asset type
    /// should a transaction use," which is what this tool exists to
    /// answer for Phase 3. Not a general symbol index: TypeCache has no
    /// raw name-search API, only "derived from X" / "has attribute X", so
    /// this is what's honestly buildable from it, not an approximation of
    /// a real one. Interfaces, static classes, and non-Unity types aren't
    /// found here — Roslyn-backed indexing is the M1+ revisit path if that
    /// turns out to matter (spec Appendix B).
    /// </summary>
    [InitializeOnLoad]
    public static class SymbolSearch
    {
        static SymbolSearch()
        {
            AttestRequestDispatcher.Register("code.find_symbol", Handle);
        }

        private static Task<object> Handle(JObject parameters)
        {
            var query = parameters["query"]?.ToString();
            if (string.IsNullOrEmpty(query))
            {
                throw new ArgumentException("code.find_symbol requires a 'query' parameter");
            }

            var matches = new JArray();
            foreach (var type in TypeCache.GetTypesDerivedFrom<MonoBehaviour>())
            {
                if (Matches(type, query)) matches.Add(Describe(type, "MonoBehaviour"));
            }
            foreach (var type in TypeCache.GetTypesDerivedFrom<ScriptableObject>())
            {
                if (Matches(type, query)) matches.Add(Describe(type, "ScriptableObject"));
            }

            var result = new JObject { ["matches"] = matches };
            return Task.FromResult<object>(result);
        }

        private static bool Matches(Type type, string query) =>
            type.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;

        private static JObject Describe(Type type, string category) => new JObject
        {
            ["typeName"] = type.Name,
            ["fullName"] = type.FullName,
            ["namespace"] = type.Namespace,
            ["assembly"] = type.Assembly.GetName().Name,
            ["category"] = category,
        };
    }
}
