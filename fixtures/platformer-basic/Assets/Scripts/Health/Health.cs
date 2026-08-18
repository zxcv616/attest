using UnityEngine;

namespace AttestFixture.Health
{
    /// <summary>
    /// Fixture's damage/invulnerability system, spec §17. GrantInvulnerability
    /// exists already (e.g. for a respawn grace period) precisely so a future
    /// dash feature can call into an existing mechanism instead of Attest
    /// having to invent a parallel one — the kind of pre-existing hook a real
    /// unfamiliar project often already has.
    /// </summary>
    public class Health : MonoBehaviour, IDamageable
    {
        [SerializeField] private int maxHealth = 3;

        private int _current;
        private float _invulnerableUntil = -1f;

        public int Current => _current;
        public int Max => maxHealth;
        public bool IsInvulnerable => Time.time < _invulnerableUntil;

        private void Awake() => _current = maxHealth;

        public void ApplyDamage(int amount)
        {
            if (IsInvulnerable) return;
            _current = Mathf.Max(0, _current - amount);
        }

        public void GrantInvulnerability(float seconds) => _invulnerableUntil = Time.time + seconds;
    }
}
