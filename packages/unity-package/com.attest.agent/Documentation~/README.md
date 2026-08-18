# com.attest.agent

Unity-side half of the Attest daemon connection. See [docs/Attest_MVP_Spec_v0.2.md](../../../../docs/Attest_MVP_Spec_v0.2.md) §6–§7 for the design this implements.

## Status: M0 and M1 Phases 1–3 verified live; Phase 4 unverified

M0, Phase 1 (connection, reconnect survival, a real daemon→Unity→daemon round trip), Phase 2 (all four inspection tools), and Phase 3 (`prefab.apply_transaction` — a real, persisted mutation, independently confirmed in the Inspector) are proven against a real Editor (Unity 6000.5.5f1), not just unit-tested. Real bugs found only by testing live, all fixed: `Object.GetInstanceID()` is error-level obsolete as of Unity 6.5 (use `GetEntityId()`), the Input System package pin was too old for 6.5, and `Sprite.Create()` from an in-memory `Texture2D` has no file identity so a reference to it silently drops when saved into a prefab (fixtures/platformer-basic's own `FixtureBuilder.cs` — same lesson applied there).

Phase 4's healthy-state case (`isCompiling: false, scriptCompilationFailed: false, diagnostics: []`) is verified live. Its error-diagnostics case (step 2 below) is **not** — reconnecting via the Attest window's button while a compile error is present did not succeed in testing, for reasons not yet root-caused (possibly Unity editor windows behaving differently while broken, possibly something else — genuinely unclear). The `CompileMonitor.cs` code itself is written directly against documented `CompilationPipeline` APIs and is believed correct, but "believed correct" is exactly the caveat every other unverified piece in this file carries too — don't treat this one as more trustworthy just because part of it was proven.

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

**M1 Phase 3 — transactions (verified live), the first tools that mutate anything:**
- `Editor/Transactions/PrefabTransaction.cs` — `prefab.apply_transaction`. Deliberately narrow: three operation kinds (`add_component`, `set_property`, `assign_reference`), one target prefab per transaction, root GameObject only — not the full 10-kind operation set `transaction.schema.json` defines, not nested children, not scene objects. Enough to hit the spec's own M1 exit bar.
  - Runs against `PrefabUtility.LoadPrefabContents` — an in-memory copy. Nothing touches the actual asset file until `SaveAsPrefabAsset` is called, which only happens after the predicted mutation set (always just the one target prefab, in this scope) is checked against what the transaction claimed it would touch. A mismatch means the in-memory copy is discarded — the file was never written, not written-then-restored.
  - Checks 5 of the schema's 6 precondition kinds (`not_in_play_mode`, `no_compile_errors`, `asset_exists`, `component_present`, `property_equals`). The 6th, `asset_unchanged_since_checkpoint`, needs the checkpoint's recorded git content — Unity has no git access, so that one is the daemon's job once task orchestration calls it (not built yet, documented as a real gap in the code, not silently skipped).
  - Component/type resolution reuses `SymbolSearch.cs`'s `TypeCache` approach; property read/write reuses `PropertySerialization.cs` (extracted from `GameObjectInspect.cs` so the read and write paths can't silently drift on which types are supported).

**M1 Phase 4 — compile monitor (healthy-state verified live; error-state unverified, see status note above):**
- `Editor/Compilation/CompileMonitor.cs` — `editor.wait_for_compilation`. Deliberately a cheap snapshot, not a long-lived wait: compilation is exactly what triggers a domain reload, which would destroy any in-progress `await` inside a handler that tried to "wait through" it. The daemon is expected to poll this — same pattern the connection/reconnect layer already uses (`AttestConnection.cs`) — rather than this method trying to survive the thing it's monitoring. Reports `isCompiling`, `scriptCompilationFailed`, and `diagnostics` (file/line/column/type/message per `CompilerMessage`, captured via `CompilationPipeline.assemblyCompilationFinished`, cleared at `compilationStarted` so stale diagnostics from a previous compile never linger into a new poll).
- Daemon-side companion fix in `packages/daemon/src/rpc-server.ts`: a socket closing mid-`callUnity()` (the exact shape a compile-triggered domain reload takes) now rejects the pending call immediately instead of after the full timeout — real bug, found while building this phase, fixed with tests proving the timing (`packages/daemon/test/rpc-server.test.ts`).

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

### Verifying Phase 4

Unlike the other phases, proving diagnostic capture doesn't need real-time polling during a compile — `EditorUtility.scriptCompilationFailed` and the captured diagnostics persist as Editor state until the *next* successful compile, so three separate one-shot calls are enough:

```bash
# 1. Idle/healthy baseline
node scripts/call-unity-smoke.mjs fixtures/platformer-basic editor.wait_for_compilation
# expect: isCompiling: false, scriptCompilationFailed: false, diagnostics: []

# 2. Introduce a deliberate one-line compile error somewhere (e.g. a stray
#    semicolon-less statement in any fixture script), save, let Unity fail
#    to compile, THEN:
node scripts/call-unity-smoke.mjs fixtures/platformer-basic editor.wait_for_compilation
# expect: scriptCompilationFailed: true, diagnostics containing the real file/line/message

# 3. Fix the error, let it recompile successfully, THEN:
node scripts/call-unity-smoke.mjs fixtures/platformer-basic editor.wait_for_compilation
# expect: back to the step-1 clean state
```

## What's NOT here yet

The MCP server (Phase 5). Full transaction scope (all 10 operation kinds, multi-target, nested prefab paths, scene-object reference assignment) is also out of scope for M1 — see `PrefabTransaction.cs`'s doc comment for exactly what's narrowed and why. Diagnostic-to-task correlation (matching compile errors to what a specific task changed) is M2 territory — this phase reports everything from the last compile, unfiltered.
