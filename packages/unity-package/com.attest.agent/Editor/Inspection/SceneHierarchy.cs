// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System.Threading.Tasks;
using Attest.Editor.Rpc;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Attest.Editor.Inspection
{
    /// <summary>
    /// M1 Phase 2 (spec §9 "scene.get_hierarchy"). Read-only.
    /// </summary>
    [InitializeOnLoad]
    public static class SceneHierarchy
    {
        static SceneHierarchy()
        {
            AttestRequestDispatcher.Register("scene.get_hierarchy", Handle);
        }

        private static Task<object> Handle(JObject parameters)
        {
            // Scoped to whatever scene is already open — opening a
            // DIFFERENT scene to inspect it would itself be an editor-state
            // mutation, which a read-only tool shouldn't do. Inspecting an
            // unopened scene is a later concern if it turns out to matter.
            var scene = SceneManager.GetActiveScene();
            if (!scene.IsValid())
            {
                throw new System.InvalidOperationException("No active scene is open.");
            }

            var roots = new JArray();
            foreach (var root in scene.GetRootGameObjects())
            {
                roots.Add(SerializeNode(root, root.name));
            }

            var result = new JObject
            {
                ["scenePath"] = scene.path,
                ["sceneName"] = scene.name,
                ["roots"] = roots,
            };
            return Task.FromResult<object>(result);
        }

        private static JObject SerializeNode(GameObject go, string path)
        {
            var components = new JArray();
            foreach (var c in go.GetComponents<Component>())
            {
                if (c != null) components.Add(c.GetType().FullName); // null = missing script
            }

            var children = new JArray();
            foreach (Transform child in go.transform)
            {
                children.Add(SerializeNode(child.gameObject, $"{path}/{child.name}"));
            }

            return new JObject
            {
                ["name"] = go.name,
                ["path"] = path,
                ["active"] = go.activeSelf,
                ["components"] = components,
                ["children"] = children,
            };
        }
    }
}
