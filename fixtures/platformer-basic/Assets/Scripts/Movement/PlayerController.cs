using AttestFixture.Input;
using UnityEngine;

namespace AttestFixture.Movement
{
    /// <summary>
    /// Movement only — no dash. Spec §17 fixture: "no dash implementation or
    /// dash artwork." Adding a dash state on top of this, without hand-editing,
    /// is the concrete first demo (spec §17).
    /// </summary>
    [RequireComponent(typeof(Rigidbody2D))]
    public class PlayerController : MonoBehaviour
    {
        [SerializeField] private MonoBehaviour inputSource; // must implement IPlayerInput
        [SerializeField] private float moveSpeed = 5f;

        private IPlayerInput _input;
        private Rigidbody2D _rb;

        private void Awake()
        {
            _input = inputSource as IPlayerInput;
            _rb = GetComponent<Rigidbody2D>();
            if (_input == null)
            {
                Debug.LogError($"[{nameof(PlayerController)}] inputSource does not implement IPlayerInput.", this);
            }
        }

        private void FixedUpdate()
        {
            if (_input == null) return;
            _rb.linearVelocity = _input.Move * moveSpeed;
        }
    }
}
