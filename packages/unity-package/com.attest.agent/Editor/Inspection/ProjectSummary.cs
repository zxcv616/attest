// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System.Threading.Tasks;
using Attest.Editor.Rpc;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace Attest.Editor.Inspection
{
    /// <summary>
    /// M1 Phase 2's first inspection tool (spec §9 "project.get_summary"),
    /// registered here rather than deferred so Phase 1's request dispatcher
    /// has something real to prove end-to-end the moment it's wired in.
    /// Read-only — no mutation, no corruption risk, the safest possible
    /// first thing to run against a real project.
    /// </summary>
    [InitializeOnLoad]
    public static class ProjectSummary
    {
        static ProjectSummary()
        {
            AttestRequestDispatcher.Register("project.get_summary", Handle);
        }

        private static Task<object> Handle(JObject parameters)
        {
            var activeScene = SceneManager.GetActiveScene();
            var pipeline = GraphicsSettings.currentRenderPipeline;

            var result = new JObject
            {
                ["unityVersion"] = Application.unityVersion,
                ["projectName"] = Application.productName,
                ["activeScene"] = activeScene.IsValid() ? activeScene.path : null,
                ["renderPipeline"] = pipeline != null ? pipeline.GetType().Name : "Built-in",
                ["isCompiling"] = EditorApplication.isCompiling,
                ["isPlaying"] = EditorApplication.isPlaying,
            };
            return Task.FromResult<object>(result);
        }
    }
}
