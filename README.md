# Attest

A self-verifying agentic Unity development system. Describe a gameplay feature; Attest changes the real Unity project, plays it, measures it, repairs failures, and returns evidence that the feature works.

Full product spec: [docs/Attest_MVP_Spec_v0.2.md](docs/Attest_MVP_Spec_v0.2.md). Read §0 first — it's the changelog against the original draft and explains every non-obvious decision below.

## Status

**M0 — Lifecycle & safety**, in progress. See §12 of the spec for the milestone plan and §16 for open decisions.

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
    com.attest.agent/         Unity UPM package (C#). Editor assembly does inspection
                               and transactions; Runtime assembly (UNITY_EDITOR ||
                               DEVELOPMENT_BUILD only) does probes and capture.
  cli/                        Minimal `attest` CLI. Thin client — MCP is the primary
                               client per the solo rescope (spec §12).
fixtures/
  platformer-basic/           M0/M2 fixture Unity project. See its README — the scene
                               and prefabs are NOT checked in as hand-written YAML;
                               they're built by an in-Editor script, once, by whoever
                               has Unity installed.
```

## Why the fixture isn't "just there"

No Unity install was available in the environment that scaffolded this repo. Hand-writing Unity's scene/prefab YAML (GUIDs, fileIDs, cross-references) outside the Editor is exactly the kind of blind serialized-state edit the product itself refuses to do (spec principle 3) — doing it to bootstrap the fixture would be a bad precedent baked into commit one. Instead, `fixtures/platformer-basic/Assets/Editor/FixtureBuilder.cs` builds the scene and prefabs programmatically via `PrefabUtility`/`EditorSceneManager`. Open the project in Unity 6.3 LTS once and run **Attest → Fixtures → Build Platformer Basic**. See [fixtures/platformer-basic/README.md](fixtures/platformer-basic/README.md).

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
