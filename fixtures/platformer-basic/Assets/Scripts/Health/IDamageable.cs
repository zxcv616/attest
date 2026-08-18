namespace AttestFixture.Health
{
    /// <summary>
    /// Spec §17 fixture: "damage uses IDamageable" — the second deliberately
    /// unfamiliar abstraction Attest must locate rather than assume.
    /// </summary>
    public interface IDamageable
    {
        void ApplyDamage(int amount);
        bool IsInvulnerable { get; }
    }
}
