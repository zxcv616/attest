using UnityEngine;
using UnityEngine.InputSystem;

namespace AttestFixture.Input
{
    /// <summary>
    /// Concrete IPlayerInput backed by the new Input System (spec §4 MVP
    /// decision: "Input System first"). References a Move action from the
    /// project's PlayerControls.inputactions asset — see
    /// Assets/Editor/FixtureBuilder.cs for how that asset and this
    /// component's InputActionReference get wired up.
    /// </summary>
    [DisallowMultipleComponent]
    public class InputSystemPlayerInput : MonoBehaviour, IPlayerInput
    {
        [SerializeField] private InputActionReference moveAction;

        public Vector2 Move => moveAction != null && moveAction.action != null
            ? moveAction.action.ReadValue<Vector2>()
            : Vector2.zero;

        private void OnEnable() => moveAction?.action?.Enable();
        private void OnDisable() => moveAction?.action?.Disable();
    }
}
