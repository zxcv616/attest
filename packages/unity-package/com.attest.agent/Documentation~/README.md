# com.attest.agent

Unity-side half of the Attest daemon connection. See [docs/Attest_MVP_Spec_v0.2.md](../../../../docs/Attest_MVP_Spec_v0.2.md) §6–§7 for the design this implements.

## Status: M0 and M1 Phases 1–2 verified live; Phase 3 unverified

M0 and Phase 1 (connection, reconnect survival, a real daemon→Unity→daemon round trip) and Phase 2 (all four inspection tools, including `gameobject.inspect`'s property serializer — the trickiest code so far) are proven against a real Editor (Unity 6000.5.5f1), not just unit-tested. Two real bugs were only found this way: `Object.GetInstanceID()` is error-level obsolete as of Unity 6.5 (fixed, use `GetEntityId()`), and Unity's Input System package pin (1.11.2) was too old for 6.5 (fixed by letting Package Manager update it).

Phase 3 (below) has **not yet been verified against a real compiler** — same caveat as always.

## What's here

**M0 — connection (verified live):**
- `Editor/Rpc/AttestConnection.cs` — the reconnecting client. `[InitializeOnLoad]` so it re-runs on every domain reload; discovers the daemon's port from `<project>/.attest/daemon-port`; does the `hello`/`hello_ack` handshake; sends heartbeats.
- `Editor/Rpc/AttestSessionState.cs` — session token + last idempotency key, persisted in `SessionState` (survives domain reload) and a workspace file (survives Editor restart), per spec §6.
- `Editor/AttestWindow.cs` — **Attest → Status** menu item.

**M1 Phase 1 — request dispatch (verified live):**
- `Editor/Rpc/AttestRequestDispatcher.cs` — method-name → handler registry. The daemon sends a `request`; `AttestConnection.HandleIncomingRequest` looks up the handler here, awaits it, and sends back a `response`. Wires the idempotency-key tracking (`AttestSessionState`) around execution so a domain reload mid-call still reports correctly on reconnect.
- `Editor/Rpc/AttestRpcMessages.cs` — DTOs mirroring `packages/schemas/src/rpc.schema.json`. `RequestMessage.Params` is a `JObject`, not `Dictionary<string,object>`, so handlers get real JSON structure without a lossy round-trip. Kept in sync by hand (M1 TODO: codegen).

**M1 Phase 2 — inspection tools (verified live), all read-only:**
- `Editor/Inspection/ProjectSummary.cs` — `project.get_summary`. The first registered handler; proved the dispatcher end-to-end.
- `Editor/Inspection/SceneHierarchy.cs` — `scene.get_hierarchy`. Whatever scene is currently open, not an arbitrary one — opening a different scene to inspect it would itself be a mutation.
- `Editor/Inspection/GameObjectInspect.cs` — `gameobject.inspect` (params: `{path}}`, GameObject.Find's native `/`-separated syntax). Enumerates components and serialized property values via `SerializedObject`. Not every `SerializedPropertyType` is handled — unhandled ones come back as an honest `"<TypeName>"` placeholder rather than silently wrong data.
- `Editor/Inspection/SymbolSearch.cs` — `code.find_symbol` (params: `{query}`). `TypeCache`-based per spec §4, scoped to `MonoBehaviour`/`ScriptableObject` subclasses — TypeCache has no raw name-search API, only "derived from X", so this is what's honestly buildable from it.
- `Editor/Inspection/AssetReferences.cs` — `asset.find_references` (params: `{assetPath}`). Unity has no reverse-dependency index, so this scans scenes/prefabs checking their forward dependencies — scoped on purpose, not a full-project scan.

**M1 Phase 3 — transactions (unverified), the first tools that mutate anything:**
- `Editor/Transactions/PrefabTransaction.cs` — `prefab.apply_transaction`. Deliberately narrow: three operation kinds (`add_component`, `set_property`, `assign_reference`), one target prefab per transaction, root GameObject only — not the full 10-kind operation set `transaction.schema.json` defines, not nested children, not scene objects. Enough to hit the spec's own M1 exit bar.
  - Runs against `PrefabUtility.LoadPrefabContents` — an in-memory copy. Nothing touches the actual asset file until `SaveAsPrefabAsset` is called, which only happens after the predicted mutation set (always just the one target prefab, in this scope) is checked against what the transaction claimed it would touch. A mismatch means the in-memory copy is discarded — the file was never written, not written-then-restored.
  - Checks 5 of the schema's 6 precondition kinds (`not_in_play_mode`, `no_compile_errors`, `asset_exists`, `component_present`, `property_equals`). The 6th, `asset_unchanged_since_checkpoint`, needs the checkpoint's recorded git content — Unity has no git access, so that one is the daemon's job once task orchestration calls it (not built yet, documented as a real gap in the code, not silently skipped).
  - Component/type resolution reuses `SymbolSearch.cs`'s `TypeCache` approach; property read/write reuses `PropertySerialization.cs` (extracted from `GameObjectInspect.cs` so the read and write paths can't silently drift on which types are supported).

**Placeholder:**
- `Runtime/AttestBridge.cs` — probes, event recording, the deterministic clock, the input driver: M2 work (spec §12), not built yet on purpose.

## Verifying once you're back in Unity

1. Open the project, confirm it compiles clean, confirm **Attest → Status** still shows `Connected`.
2. From the repo root, `node scripts/call-unity-smoke.mjs <projectPath> <method> [jsonParams]` — starts its own daemon, waits for your already-connected Unity session, calls the given method through it, prints the result. (Close any other daemon process first — only one can own the project's `.attest/daemon-port`.) Examples for each Phase 2 tool are in the script's header comment; a Phase 3 transaction example is below.
3. A real result back (not a thrown error) means that tool works end-to-end, not just in the daemon-side unit tests (`packages/daemon/test/rpc-server.test.ts`, which use a fake WebSocket client standing in for Unity).

### Example Phase 3 transaction

Adds a `Health` component to the Hazard prefab and sets its `maxHealth` — exercises `add_component` and `set_property` together, and is harmless: Hazard doesn't currently check its own health, so this can't break the working demo.

```bash
node scripts/call-unity-smoke.mjs fixtures/platformer-basic prefab.apply_transaction '{"targetAssets":["Assets/Prefabs/Hazard.prefab"],"preconditions":[{"kind":"not_in_play_mode"},{"kind":"no_compile_errors"},{"kind":"component_present","target":"AttestFixture.Health.Health","expected":false}],"operations":[{"kind":"add_component","target":"AttestFixture.Health.Health"},{"kind":"set_property","target":"AttestFixture.Health.Health.maxHealth","value":10}],"expectedMutationSet":["Assets/Prefabs/Hazard.prefab"]}'
```

Expect `"status": "success"`. Afterward, select `Hazard.prefab` in the Project window and confirm it now has a Health component with Max Health = 10 in the Inspector — that's the real, independent proof, not just the JSON response.

## What's NOT here yet

The compile monitor (Phase 4) and the MCP server (Phase 5). Full transaction scope (all 10 operation kinds, multi-target, nested prefab paths, scene-object reference assignment) is also out of scope for this phase — see `PrefabTransaction.cs`'s doc comment for exactly what's narrowed and why.
