using UnityEngine;

namespace AttestFixture.Input
{
    /// <summary>
    /// Spec §17 fixture: "input is wrapped by IPlayerInput" — a deliberately
    /// unfamiliar architecture. Attest must find and use this abstraction
    /// rather than assuming direct Input System calls (spec §10 Adapters).
    /// No Dash member here on purpose: this fixture ships with movement
    /// only. Dash is the feature Attest's first task adds.
    /// </summary>
    public interface IPlayerInput
    {
        Vector2 Move { get; }
    }
}
