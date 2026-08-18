# Attest

A self-verifying agentic Unity development system. Describe a gameplay feature; Attest changes the real Unity project, plays it, measures it, repairs failures, and returns evidence that the feature works.

Full product spec: [docs/Attest_MVP_Spec_v0.2.md](docs/Attest_MVP_Spec_v0.2.md). Read §0 first — it's the changelog against the original draft and explains every non-obvious decision below.

## Status

**M0 done, M1 in progress** (Phases 1–3 of 5 live-verified against a real Editor — Unity 6000.5.5f1). See §12 of the spec for the milestone plan and §16 for open decisions.

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
