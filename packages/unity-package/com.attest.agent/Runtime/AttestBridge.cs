// NOT compiled or run against a real Unity Editor — see
// Editor/Rpc/AttestRpcMessages.cs header.

using UnityEngine;

namespace Attest.Agent
{
    /// <summary>
    /// Spec §7 "Runtime assembly" and §6 architecture: the in-Play-Mode
    /// facade the Editor assembly's Play Mode controller talks to directly
    /// (same process, same domain — no socket needed here; only the Editor
    /// assembly's AttestConnection talks to the daemon). This class is a
    /// structural placeholder: ProbeRegistry, EventRecorder,
    /// DeterministicClock, and InputDriver are M2 deliverables (spec §12
    /// milestone table) and are deliberately not built yet — writing stub
    /// implementations for them now, before the replay-as-generated-test
    /// model (spec §8) is built, would be exactly the kind of building-ahead-
    /// of-milestone the spec's own discipline section (§12) warns against.
    ///
    /// What's real here: the asmdef Define Constraints on Attest.Agent.asmdef
    /// (UNITY_EDITOR || DEVELOPMENT_BUILD) — the actual safety rule (spec §7
    /// placement rule 2) that this class, and everything else in this
    /// assembly, can never compile into a customer's shipped release build.
    /// </summary>
    public static class AttestBridge
    {
        public static bool IsPresent => true;

        // M2 TODO, in the order spec §7 lists them:
        //   - ProbeRegistry: explicit, bounded, component-aware observables.
        //   - EventRecorder: semantic events (timestamp, frame, entity ID, JSON-safe payload).
        //   - DeterministicClock: Time.captureDeltaTime + fixedDeltaTime pinning (spec §8).
        //   - InputDriver: deterministic action injection through a project adapter.
    }
}
