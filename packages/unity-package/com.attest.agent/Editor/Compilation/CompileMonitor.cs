// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Attest.Editor.Rpc;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Compilation;

namespace Attest.Editor.Compilation
{
    /// <summary>
    /// M1 Phase 4 (spec §9 "editor.wait_for_compilation", §7 "await domain
    /// reloads, correlate diagnostics to task changes").
    ///
    /// Deliberately NOT a long-lived wait: compilation is exactly what
    /// triggers a domain reload, and a domain reload destroys all managed
    /// state — including any in-progress `await` inside this handler. A
    /// method that tried to "wait through" a reload would be killed by the
    /// very thing it's waiting for. Instead this is a cheap, synchronous
    /// snapshot; the daemon is expected to poll it (same pattern the
    /// connection/reconnect layer already uses for the same reason — see
    /// AttestConnection.cs). A poll call that lands mid-reload simply fails
    /// like any other request would (spec §6 reconciliation, and M1 Phase
    /// 4's RpcServer.handleSocketClosed on the daemon side rejects it
    /// promptly rather than after a full timeout); the next poll, after
    /// Unity reconnects, succeeds normally.
    /// </summary>
    [InitializeOnLoad]
    public static class CompileMonitor
    {
        private static readonly List<JObject> LastDiagnostics = new List<JObject>();

        static CompileMonitor()
        {
            AttestRequestDispatcher.Register("editor.wait_for_compilation", Handle);

            // Cleared at the START of a compile pass, not the end — so a
            // poll landing between "compile started" and "first assembly
            // finished" doesn't report stale diagnostics from a previous,
            // unrelated compile.
            CompilationPipeline.compilationStarted += _ => LastDiagnostics.Clear();
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
        }

        private static void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] messages)
        {
            foreach (var msg in messages)
            {
                LastDiagnostics.Add(new JObject
                {
                    ["assembly"] = Path.GetFileName(assemblyPath),
                    ["file"] = msg.file,
                    ["line"] = msg.line,
                    ["column"] = msg.column,
                    ["type"] = msg.type.ToString(), // "Error" | "Warning"
                    ["message"] = msg.message,
                });
            }
        }

        private static Task<object> Handle(JObject parameters)
        {
            var result = new JObject
            {
                ["isCompiling"] = EditorApplication.isCompiling,
                ["scriptCompilationFailed"] = EditorUtility.scriptCompilationFailed,
                // Diagnostics from the most recently finished (or currently
                // running) compile pass — unfiltered. Correlating this list
                // to a specific task's changed files is the caller's job
                // (the daemon knows what a task touched; this tool doesn't
                // know what a "task" is) — M2 territory, not built yet.
                ["diagnostics"] = new JArray(LastDiagnostics.ToArray()),
            };
            return Task.FromResult<object>(result);
        }
    }
}
