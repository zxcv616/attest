// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor.Inspection
{
    /// <summary>
    /// SerializedProperty &lt;-&gt; JSON, shared by GameObjectInspect (read,
    /// M1 Phase 2) and PrefabTransaction (write via set_property, and read
    /// again for property_equals preconditions — M1 Phase 3). One switch
    /// statement covering the supported SerializedPropertyType cases, not
    /// two copies that could drift on which types are handled.
    /// </summary>
    public static class PropertySerialization
    {
        /// <summary>
        /// Not exhaustive — anything not listed here (Gradient,
        /// AnimationCurve, ManagedReference, ...) comes back as an honest
        /// "&lt;TypeName&gt;" placeholder rather than silently wrong or
        /// dropped data.
        /// </summary>
        public static JToken ToJson(SerializedProperty prop)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer: return prop.intValue;
                case SerializedPropertyType.Boolean: return prop.boolValue;
                case SerializedPropertyType.Float: return prop.floatValue;
                case SerializedPropertyType.String: return prop.stringValue;
                case SerializedPropertyType.Enum:
                    return prop.enumValueIndex >= 0 && prop.enumValueIndex < prop.enumDisplayNames.Length
                        ? prop.enumDisplayNames[prop.enumValueIndex]
                        : prop.enumValueIndex.ToString();
                case SerializedPropertyType.ObjectReference:
                    if (prop.objectReferenceValue == null) return null;
                    var assetPath = AssetDatabase.GetAssetPath(prop.objectReferenceValue);
                    return string.IsNullOrEmpty(assetPath)
                        ? $"SceneObject:{prop.objectReferenceValue.GetEntityId()}"
                        : assetPath;
                case SerializedPropertyType.Vector2:
                    return new JObject { ["x"] = prop.vector2Value.x, ["y"] = prop.vector2Value.y };
                case SerializedPropertyType.Vector3:
                    return new JObject { ["x"] = prop.vector3Value.x, ["y"] = prop.vector3Value.y, ["z"] = prop.vector3Value.z };
                case SerializedPropertyType.Color:
                    var c = prop.colorValue;
                    return new JObject { ["r"] = c.r, ["g"] = c.g, ["b"] = c.b, ["a"] = c.a };
                default:
                    return $"<{prop.propertyType}>";
            }
        }

        /// <summary>
        /// Applies a JSON value to a SerializedProperty. Only supports the
        /// same cases ToJson does — deliberately, so "can this tool read a
        /// field" and "can this tool write it" never silently diverge.
        /// ObjectReference is excluded on purpose: assigning references is
        /// its own operation kind (assign_reference), not set_property —
        /// see PrefabTransaction.cs — because a reference assignment needs
        /// asset resolution, not just a value copy.
        /// </summary>
        public static void ApplyJson(SerializedProperty prop, JToken value)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer:
                    prop.intValue = value.Value<int>();
                    return;
                case SerializedPropertyType.Boolean:
                    prop.boolValue = value.Value<bool>();
                    return;
                case SerializedPropertyType.Float:
                    prop.floatValue = value.Value<float>();
                    return;
                case SerializedPropertyType.String:
                    prop.stringValue = value.Value<string>();
                    return;
                case SerializedPropertyType.Enum:
                    var name = value.Value<string>();
                    var idx = System.Array.IndexOf(prop.enumDisplayNames, name);
                    if (idx < 0)
                    {
                        throw new System.ArgumentException(
                            $"Unknown enum value '{name}' for {prop.propertyPath}. Valid: {string.Join(", ", prop.enumDisplayNames)}");
                    }
                    prop.enumValueIndex = idx;
                    return;
                case SerializedPropertyType.Vector2:
                    prop.vector2Value = new Vector2(value["x"]!.Value<float>(), value["y"]!.Value<float>());
                    return;
                case SerializedPropertyType.Vector3:
                    prop.vector3Value = new Vector3(value["x"]!.Value<float>(), value["y"]!.Value<float>(), value["z"]!.Value<float>());
                    return;
                case SerializedPropertyType.Color:
                    prop.colorValue = new Color(
                        value["r"]!.Value<float>(), value["g"]!.Value<float>(), value["b"]!.Value<float>(), value["a"]!.Value<float>());
                    return;
                case SerializedPropertyType.ObjectReference:
                    throw new System.InvalidOperationException(
                        $"{prop.propertyPath} is an object reference — use an assign_reference operation, not set_property.");
                default:
                    throw new System.NotSupportedException(
                        $"set_property does not support {prop.propertyType} yet (matches this class's ToJson coverage).");
            }
        }
    }
}
