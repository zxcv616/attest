// NOT compiled or run against a real Unity Editor — see
// ../Rpc/AttestRpcMessages.cs header.

using System.Threading.Tasks;
using Attest.Editor.Rpc;
using Newtonsoft.Json.Linq;
using UnityEditor;

namespace Attest.Editor.Inspection
{
    /// <summary>
    /// M1 Phase 2 (spec §9 "asset.find_references"). Unity has no built-in
    /// reverse-dependency index — only AssetDatabase.GetDependencies(path),
    /// which is forward (what does THIS asset depend on). Finding what
    /// references a given asset means scanning candidates and checking
    /// their forward dependencies for it. Scoped to scenes and prefabs —
    /// where references that matter for gameplay transactions actually
    /// live — rather than every asset in the project, so this doesn't
    /// silently become a full-project scan on a large codebase.
    /// </summary>
    [InitializeOnLoad]
    public static class AssetReferences
    {
        static AssetReferences()
        {
            AttestRequestDispatcher.Register("asset.find_references", Handle);
        }

        private static Task<object> Handle(JObject parameters)
        {
            var assetPath = parameters["assetPath"]?.ToString();
            if (string.IsNullOrEmpty(assetPath))
            {
                throw new System.ArgumentException("asset.find_references requires an 'assetPath' parameter");
            }

            var candidates = AssetDatabase.FindAssets("t:Scene t:Prefab");
            var referencingAssets = new JArray();

            foreach (var guid in candidates)
            {
                var candidatePath = AssetDatabase.GUIDToAssetPath(guid);
                if (candidatePath == assetPath) continue;

                var dependencies = AssetDatabase.GetDependencies(candidatePath, recursive: false);
                if (System.Array.IndexOf(dependencies, assetPath) >= 0)
                {
                    referencingAssets.Add(candidatePath);
                }
            }

            var result = new JObject
            {
                ["assetPath"] = assetPath,
                ["referencedBy"] = referencingAssets,
                ["scope"] = "scenes and prefabs only — see AssetReferences.cs for why",
            };
            return Task.FromResult<object>(result);
        }
    }
}
