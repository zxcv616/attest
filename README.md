# Attest

A self-verifying agentic Unity development system. Describe a gameplay feature; Attest changes the real Unity project, plays it, measures it, repairs failures, and returns evidence that the feature works.

Full product spec: [docs/Attest_MVP_Spec_v0.2.md](docs/Attest_MVP_Spec_v0.2.md). Read §0 first — it's the changelog against the original draft and explains every non-obvious decision below.

## Status

**M0 done, M1 in progress** (Phases 1–3 live-verified against a real Editor — Unity 6000.5.5f1; Phase 4's healthy-state case verified live, its error-diagnostics case not yet, see the Unity package's own README; Phase 5 built and tested, not yet used with a real external MCP client). See §12 of the spec for the milestone plan and §16 for open decisions.

## Layout

```
docs/                         Product spec
packages/
  schemas/                    JSON Schema — shared source of truth for task/criteria/
                               transaction/replay/evidence/checkpoint. Daemon and Unity
                               package both derive types from these; edit here first.
  daemon/                     TypeScript agent daemon. Owns task state, the RPC server,
                               git checkpoint/rollback, and (later) the model loop.
  unity-package/
    com.attest.agent/         Unity UPM package (C#). Editor assembly does connection,
                               inspection, and transactions; Runtime assembly
                               (UNITY_EDITOR || DEVELOPMENT_BUILD only) does probes and
                               capture (M2, not built yet). See its own Documentation~/
                               README.md for what's verified live vs. unverified.
  cli/                        Minimal `attest` CLI. Thin client — MCP is the primary
                               client per the solo rescope (spec §12).
scripts/
  call-unity-smoke.mjs        Manual end-to-end check: boots a daemon, waits for the
                               real Unity Editor to connect, calls any registered
                               method through it, prints the result.
  mcp-smoke.mjs                Spawns the real mcp-entry.ts as a child process over
                               real stdio (exactly how an MCP client would) and does
                               a real tool call — proves the spawnable process, not
                               just the in-process protocol logic.
fixtures/
  platformer-basic/           NOT part of this repo — its own independent git repo,
                               on purpose (see below). Not tracked here; open it
                               directly at fixtures/platformer-basic once cloned/built.
```

## Fixtures are separate git repos, not subfolders of this one

Every project Attest manages needs to be its own real git repo — spec §4, and load-bearing for the daemon's checkpoint/rollback machinery specifically: git commands walk up from any subdirectory to find the nearest `.git`, so a fixture nested inside *this* repo would mean a "checkpoint" or "rollback" of the fixture could silently operate on Attest's own uncommitted source instead. `fixtures/*/` is gitignored here for exactly that reason.

`fixtures/platformer-basic` is scaffolded from `Assets/Editor/FixtureBuilder.cs` — the scene and prefabs are built programmatically via `PrefabUtility`/`EditorSceneManager` on first run (**Attest → Fixtures → Build Platformer Basic**), not checked in as hand-written YAML, since hand-writing Unity's serialized formats outside the Editor is exactly the kind of blind edit the product itself refuses to do (spec principle 3). See that fixture's own README once you're in it.

## Getting started

```bash
npm install
npm run build
npm test
```

Daemon dev loop:

```bash
npm run daemon
```

## Using Attest via MCP (M1 Phase 5)

The MCP server **is** the daemon, not a separate process that talks to it — an MCP client is configured to spawn `packages/daemon/src/mcp-entry.ts` directly, and that spawned process both opens the Unity WebSocket RPC port and speaks MCP over stdio. This is required, not just convenient: `RpcServer.callUnity()` only works from the same process holding the live Unity session (in-memory state), so a separately-spawned MCP process could never reach Unity through some other already-running daemon.

For Claude Code, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "attest": {
      "command": "node",
      "args": ["--experimental-strip-types", "packages/daemon/src/mcp-entry.ts", "fixtures/platformer-basic"]
    }
  }
}
```

(Swap the last arg for whatever project you're pointing Attest at. Run from the repo root, or use absolute paths.)

Exposed tools: `attest_status`, `attest_project_summary`, `attest_scene_hierarchy`, `attest_inspect_gameobject`, `attest_find_symbol`, `attest_find_asset_references`, `attest_wait_for_compilation`, `attest_apply_prefab_transaction` — thin wrappers over the same daemon methods `call-unity-smoke.mjs` calls directly; see `packages/daemon/src/mcp-server.ts`.

**Verified:** the full MCP protocol round trip (`packages/daemon/test/mcp-server.test.ts`, via the SDK's own `InMemoryTransport` — a real `Client`/`Server` pair, not a hand-rolled stand-in) and the actual spawnable process talking real stdio (`scripts/mcp-smoke.mjs`), both against a fake Unity client (same pattern as `rpc-server.test.ts`) since no Unity install exists here. **Not yet verified:** an actual external MCP client (Claude Code, Claude Desktop, ...) driving it against a live, Unity-connected daemon.
