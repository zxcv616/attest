// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System.Threading.Tasks;
using Attest.Editor.Rpc;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor.Inspection
{
    /// <summary>
    /// M1 Phase 2 (spec §9 "gameobject.inspect"). Read-only — enumerates
    /// components and their serialized property values via SerializedObject,
    /// never touches anything. `path` uses GameObject.Find's native
    /// '/'-separated hierarchy-path syntax (e.g. "Player" or
    /// "Level1/HUD/HealthText"), scoped to active objects in loaded scenes.
    /// </summary>
    [InitializeOnLoad]
    public static class GameObjectInspect
    {
        static GameObjectInspect()
        {
            AttestRequestDispatcher.Register("gameobject.inspect", Handle);
        }

        private static Task<object> Handle(JObject parameters)
        {
            var path = parameters["path"]?.ToString();
            if (string.IsNullOrEmpty(path))
            {
                throw new System.ArgumentException("gameobject.inspect requires a 'path' parameter");
            }

            var go = GameObject.Find(path);
            if (go == null)
            {
                throw new System.InvalidOperationException($"No active GameObject at path '{path}'");
            }

            var components = new JArray();
            foreach (var component in go.GetComponents<Component>())
            {
                if (component == null) continue; // missing script
                components.Add(SerializeComponent(component));
            }

            var childPaths = new JArray();
            foreach (Transform child in go.transform)
            {
                childPaths.Add($"{path}/{child.name}");
            }

            var result = new JObject
            {
                ["name"] = go.name,
                ["active"] = go.activeSelf,
                ["tag"] = go.tag,
                ["layer"] = LayerMask.LayerToName(go.layer),
                ["components"] = components,
                ["childPaths"] = childPaths,
            };
            return Task.FromResult<object>(result);
        }

        private static JObject SerializeComponent(Component component)
        {
            var so = new SerializedObject(component);
            var properties = new JObject();
            var prop = so.GetIterator();
            var enterChildren = true;
            while (prop.NextVisible(enterChildren))
            {
                enterChildren = false;
                if (prop.name == "m_Script") continue; // the component type is already reported in "type"
                properties[prop.propertyPath] = PropertySerialization.ToJson(prop);
            }
            return new JObject
            {
                ["type"] = component.GetType().FullName,
                ["properties"] = properties,
            };
        }
    }
}
