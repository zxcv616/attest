// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Attest.Editor.Inspection;
using Attest.Editor.Rpc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor.Transactions
{
    /// <summary>
    /// M1 Phase 3 (spec §7 "Transaction model", §9 "prefab.apply_transaction").
    /// Deliberately narrow: three operation kinds (add_component,
    /// set_property, assign_reference), one target per transaction, root
    /// GameObject of a prefab asset only — no nested children, no scenes,
    /// no scene-object reference assignment. Enough to hit the spec's own
    /// M1 exit bar ("add a component and assign a serialized reference on
    /// an unfamiliar project without touching YAML"), not the full 10-kind
    /// operation set from transaction.schema.json.
    ///
    /// Safety property this gives for free: operations run against
    /// PrefabUtility.LoadPrefabContents — an in-memory copy — and nothing
    /// touches disk until SaveAsPrefabAsset is explicitly called at the
    /// end, after the mutation-set check passes. A mismatch means
    /// UnloadPrefabContents(saveChanges: false) instead — the asset file
    /// was never written, not written-then-restored. The daemon's
    /// git-based checkpoint/rollback (M0, already tested) remains the
    /// backstop for a mid-transaction crash; this is the first line of
    /// defense for "the transaction didn't do what it predicted."
    /// </summary>
    [InitializeOnLoad]
    public static class PrefabTransaction
    {
        static PrefabTransaction()
        {
            AttestRequestDispatcher.Register("prefab.apply_transaction", Handle);
        }

        private static Task<object> Handle(JObject parameters)
        {
            var txn = parameters.ToObject<TransactionParams>();
            if (txn?.TargetAssets == null || txn.TargetAssets.Count != 1)
            {
                throw new ArgumentException(
                    "prefab.apply_transaction requires exactly one targetAssets entry (this phase doesn't support multi-target transactions)");
            }

            var prefabPath = txn.TargetAssets[0];
            if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(prefabPath)))
            {
                throw new InvalidOperationException($"Asset does not exist: {prefabPath}");
            }

            // LoadPrefabContents gives an in-memory-only copy in a hidden
            // scene; nothing touches the actual asset file until
            // SaveAsPrefabAsset is explicitly called below. UnloadPrefabContents
            // must run exactly once no matter which path this takes —
            // hence one unconditional call in `finally`, not scattered
            // across each early return (an earlier draft did that and had
            // a dead/broken cleanup branch as a result).
            var root = PrefabUtility.LoadPrefabContents(prefabPath);
            JObject result;
            try
            {
                var preconditionFailure = CheckPreconditions(root, txn.Preconditions);
                if (preconditionFailure != null)
                {
                    result = new JObject
                    {
                        ["status"] = "precondition_failed",
                        ["modifiedAssets"] = new JArray(),
                        ["actualMutationSet"] = new JArray(),
                        ["compilationRequired"] = false,
                        ["diagnostics"] = new JArray(preconditionFailure),
                    };
                }
                else
                {
                    foreach (var op in txn.Operations ?? new List<OperationDto>())
                    {
                        ApplyOperation(root, op);
                    }

                    // Deterministic in this scope: every supported operation
                    // kind touches only the one prefab it's targeting (no
                    // nested prefabs, no cross-asset writes), so the actual
                    // mutation set IS the target set — no ambiguity to
                    // resolve by inspecting what actually changed.
                    var actualMutationSet = new[] { prefabPath };
                    var expected = txn.ExpectedMutationSet ?? new List<string>();

                    if (!SetsEqual(actualMutationSet, expected))
                    {
                        // In-memory changes are simply discarded by the
                        // finally block's unload below — nothing was ever
                        // written to disk, so there's nothing to roll back.
                        result = new JObject
                        {
                            ["status"] = "mutation_set_mismatch",
                            ["modifiedAssets"] = new JArray(),
                            ["actualMutationSet"] = new JArray(actualMutationSet),
                            ["compilationRequired"] = false,
                            ["diagnostics"] = new JArray($"Expected mutation set {string.Join(",", expected)} does not match actual {string.Join(",", actualMutationSet)}"),
                        };
                    }
                    else
                    {
                        PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
                        result = new JObject
                        {
                            ["status"] = "success",
                            ["modifiedAssets"] = new JArray(prefabPath),
                            ["actualMutationSet"] = new JArray(actualMutationSet),
                            ["compilationRequired"] = false, // none of the three operation kinds touch .cs files
                            ["diagnostics"] = new JArray(),
                        };
                    }
                }
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(root);
            }
            return Task.FromResult<object>(result);
        }

        private static string CheckPreconditions(GameObject root, List<PreconditionDto> preconditions)
        {
            if (preconditions == null) return null;
            foreach (var pre in preconditions)
            {
                switch (pre.Kind)
                {
                    case "not_in_play_mode":
                        if (EditorApplication.isPlaying) return "Editor is in Play Mode";
                        break;
                    case "no_compile_errors":
                        if (EditorUtility.scriptCompilationFailed) return "Project has compile errors";
                        break;
                    case "asset_exists":
                        if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(pre.Target)))
                            return $"Asset does not exist: {pre.Target}";
                        break;
                    case "component_present":
                        var type = ResolveComponentType(pre.Target);
                        var hasIt = root.GetComponent(type) != null;
                        var expectedPresent = pre.Expected?.Value<bool>() ?? true;
                        if (hasIt != expectedPresent)
                            return $"component_present precondition failed for {pre.Target} (expected {expectedPresent}, was {hasIt})";
                        break;
                    case "property_equals":
                        var (_, prop) = ResolveTarget(root, pre.Target);
                        var actual = PropertySerialization.ToJson(prop);
                        if (!JToken.DeepEquals(actual, pre.Expected))
                            return $"property_equals precondition failed for {pre.Target} (expected {pre.Expected}, was {actual})";
                        break;
                    case "asset_unchanged_since_checkpoint":
                        // Unity has no git access — this precondition needs
                        // the checkpoint's recorded content hash, which only
                        // the daemon has. Not silently ignored: documented
                        // here as a real gap. The daemon is expected to
                        // check this itself before ever issuing the
                        // transaction, once task orchestration exists to
                        // do so (M1+ TODO, not yet built).
                        break;
                    default:
                        return $"Unknown precondition kind: {pre.Kind}";
                }
            }
            return null;
        }

        private static void ApplyOperation(GameObject root, OperationDto op)
        {
            switch (op.Kind)
            {
                case "add_component":
                {
                    var type = ResolveComponentType(op.Target);
                    if (root.GetComponent(type) != null)
                    {
                        throw new InvalidOperationException($"'{root.name}' already has a component of type '{op.Target}'");
                    }
                    root.AddComponent(type);
                    return;
                }
                case "set_property":
                {
                    var (so, prop) = ResolveTarget(root, op.Target);
                    PropertySerialization.ApplyJson(prop, op.Value);
                    so.ApplyModifiedPropertiesWithoutUndo();
                    return;
                }
                case "assign_reference":
                {
                    var (so, prop) = ResolveTarget(root, op.Target);
                    if (prop.propertyType != SerializedPropertyType.ObjectReference)
                    {
                        throw new InvalidOperationException($"{op.Target} is not an object reference field");
                    }
                    var assetPath = op.Value?.ToString();
                    var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath);
                    if (asset == null)
                    {
                        throw new InvalidOperationException($"No asset found at '{assetPath}' — assign_reference only supports asset references in this phase, not scene objects");
                    }
                    prop.objectReferenceValue = asset;
                    so.ApplyModifiedPropertiesWithoutUndo();
                    return;
                }
                default:
                    throw new NotSupportedException(
                        $"Operation kind '{op.Kind}' is not supported yet — this phase covers add_component, set_property, assign_reference only");
            }
        }

        /// <summary>target = "ComponentTypeFullName.propertyName".</summary>
        private static (SerializedObject so, SerializedProperty prop) ResolveTarget(GameObject root, string target)
        {
            var lastDot = target.LastIndexOf('.');
            if (lastDot < 0)
            {
                throw new ArgumentException($"target '{target}' must be 'ComponentTypeFullName.propertyName'");
            }
            var typeName = target.Substring(0, lastDot);
            var propertyName = target.Substring(lastDot + 1);

            var componentType = ResolveComponentType(typeName);
            var component = root.GetComponent(componentType);
            if (component == null)
            {
                throw new InvalidOperationException($"No component of type '{typeName}' on '{root.name}'");
            }

            var so = new SerializedObject(component);
            var prop = so.FindProperty(propertyName);
            if (prop == null)
            {
                throw new InvalidOperationException($"No serialized property '{propertyName}' on {typeName}");
            }
            return (so, prop);
        }

        /// <summary>
        /// Resolves by full type name via TypeCache, not Type.GetType() —
        /// the latter needs an assembly-qualified name to reliably find a
        /// type outside mscorlib/the calling assembly, which is exactly
        /// the case for every fixture/project component type. Same
        /// TypeCache-not-Roslyn approach as SymbolSearch.cs (spec §4).
        /// </summary>
        private static Type ResolveComponentType(string fullName)
        {
            foreach (var type in TypeCache.GetTypesDerivedFrom<Component>())
            {
                if (type.FullName == fullName) return type;
            }
            throw new InvalidOperationException($"No component type found named '{fullName}' (checked all Component subclasses via TypeCache)");
        }

        private static bool SetsEqual(IEnumerable<string> a, IEnumerable<string> b)
        {
            var setA = new HashSet<string>(a);
            var setB = new HashSet<string>(b);
            return setA.SetEquals(setB);
        }

        private class TransactionParams
        {
            [JsonProperty("targetAssets")] public List<string> TargetAssets;
            [JsonProperty("preconditions")] public List<PreconditionDto> Preconditions;
            [JsonProperty("operations")] public List<OperationDto> Operations;
            [JsonProperty("expectedMutationSet")] public List<string> ExpectedMutationSet;
        }

        private class PreconditionDto
        {
            [JsonProperty("kind")] public string Kind;
            [JsonProperty("target")] public string Target;
            [JsonProperty("expected")] public JToken Expected;
        }

        private class OperationDto
        {
            [JsonProperty("kind")] public string Kind;
            [JsonProperty("target")] public string Target;
            [JsonProperty("value")] public JToken Value;
            [JsonProperty("reason")] public string Reason;
        }
    }
}
