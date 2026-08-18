// NOT compiled or run against a real Unity Editor — see repo root README.

using AttestFixture.Health;
using AttestFixture.Input;
using AttestFixture.Movement;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace AttestFixture.Tests.Editor
{
    /// <summary>
    /// Spec §17 fixture: "The repository includes existing smoke tests but
    /// no dash implementation." These are that existing suite — the thing
    /// Attest's regression check (spec §9 stage 11 / demo step "Runtime
    /// exits Play Mode and runs existing regression tests") runs against
    /// after implementing a feature, to prove it didn't break what was
    /// already here. Deliberately structural/Edit-Mode: no Play Mode
    /// dependency, so these are cheap and always available even before the
    /// replay-as-generated-test machinery (spec §8) exists.
    /// </summary>
    public class PlayerPrefabSmokeTests
    {
        private const string PlayerPrefabPath = "Assets/Prefabs/Player.prefab";

        [Test]
        public void PlayerPrefab_Exists()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PlayerPrefabPath);
            Assert.IsNotNull(prefab, $"Expected {PlayerPrefabPath} — run Attest → Fixtures → Build Platformer Basic first.");
        }

        [Test]
        public void PlayerPrefab_HasExpectedComponents()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(PlayerPrefabPath);
            Assert.IsNotNull(prefab, $"Expected {PlayerPrefabPath} — run Attest → Fixtures → Build Platformer Basic first.");

            Assert.IsNotNull(prefab.GetComponent<Rigidbody2D>());
            Assert.IsNotNull(prefab.GetComponent<Health.Health>());
            Assert.IsNotNull(prefab.GetComponent<InputSystemPlayerInput>());
            Assert.IsNotNull(prefab.GetComponent<PlayerController>());

            // The fixture's architecture contract (spec §17): PlayerController
            // must resolve its input through the IPlayerInput abstraction,
            // not a direct Input System dependency.
            Assert.IsInstanceOf<IPlayerInput>(prefab.GetComponent<InputSystemPlayerInput>());
        }

        [Test]
        public void PlayerPrefab_HasNoDashAction_Yet()
        {
            var inputActions = AssetDatabase.LoadAssetAtPath<UnityEngine.InputSystem.InputActionAsset>("Assets/Input/PlayerControls.inputactions");
            Assert.IsNotNull(inputActions);
            var playerMap = inputActions.FindActionMap("Player");
            Assert.IsNotNull(playerMap);
            Assert.IsNotNull(playerMap.FindAction("Move"), "Move action should exist in the fixture.");
            Assert.IsNull(playerMap.FindAction("Dash"), "Dash should NOT exist yet — spec §17: 'no dash implementation.' If this fails, the fixture was rebuilt after a task added Dash; regenerate a clean fixture before reusing it as a benchmark starting state.");
        }
    }
}
