# Attest — MVP Product Specification v0.2

**A self-verifying agentic Unity development system**
Revision of the v0.1 draft (July 27, 2026). Changes and rationale are listed in §0.

> **Product promise.** Describe a gameplay feature. Attest changes the real Unity project, plays it, measures it, repairs failures, and returns evidence that the feature works.

---

## 0. What changed from v0.1, and why

The v0.1 bones are good: the positioning (evidence, not plausible code), the Unity-as-serialization-authority rule, the acceptance-criteria contract, the benchmark discipline, and the refusal to build an editor. Those are kept.

Twelve things changed. Ordered by how much they affect the build.

| # | Change | Why |
|---|---|---|
| 1 | **Replays are generated Unity Test Framework Play Mode tests**, not an ad-hoc Play Mode session driven over RPC. | Removes most of the bespoke bridge, makes `InputTestFixture` legitimate (it is a test fixture and disables real devices — it is not supported in a normal Play Mode session), gives machine-readable NUnit results for free, and turns evidence into an artifact the user keeps in their repo. This is the largest simplification in the document. |
| 2 | **Daemon is the RPC server; Unity is the client that reconnects.** Session survival across domain reload, Play Mode transitions, and Editor restart is an M0 exit criterion, not a risk row. | Domain reload destroys all managed state in the Editor on every compile and (by default) on entering Play Mode. If this isn't solved first, every later milestone is built on sand. v0.1 listed it as a risk; it is the central engineering constraint. |
| 3 | **`undoGroup` removed as a rollback mechanism.** Rollback is Git-checkpoint-based only. | The Undo stack is not durable across domain reloads, Play Mode transitions, or Editor restarts. v0.1's transaction result implied it was a rollback primitive. It is a courtesy for the human, nothing more. |
| 4 | **Roslyn dropped from the MVP.** Use Unity's `TypeCache`, `MonoScript`, `AssetDatabase` dependency graph, and read-only YAML/GUID scanning instead. | Hosting Roslyn from a Node daemon is a separate subproject (a .NET sidecar, MSBuild project parsing, version parity with Unity's compiler). `TypeCache` answers most "find symbol / find derived types / find attribute usages" queries instantly and in-process, and Unity already supplies authoritative compile diagnostics. Revisit when refactoring accuracy actually blocks a benchmark task. |
| 5 | **A separate, cheap compile-repair budget** (8 attempts) that does not consume the 3 semantic repair loops. | In practice compile errors dominate iteration count. Spending a full plan→implement→verify cycle on a missing `using` wastes the budget that should be spent on behavior. v0.1 had one undifferentiated repair budget. |
| 6 | **Determinism is measured, not assumed.** Fixed virtual clock via `Time.captureDeltaTime`, fixed `fixedDeltaTime`, seeded RNG — plus a mandatory flake check (every criterion evaluated across ≥2 runs; disagreement ⇒ `unstable`, never `pass`). | "Fixed seed ⇒ comparable results" is not true of Unity by default: frame timing varies, physics steps drift against render frames, and any unseeded `Random` or third-party update loop breaks it. The mechanism was missing and the epistemics were too confident. |
| 7 | **Criteria are frozen and content-hashed before implementation; the evaluator sees criteria + evidence but never the diff.** | The same model writing the code and grading it is the core validity threat. This is a cheap, structural mitigation that v0.1 didn't have. |
| 8 | **Git safety rules made explicit and narrow.** Never `reset --hard` user HEAD, never global `git clean`. Dirty worktrees are committed to an `attest/task-<id>` branch. Rollback is scoped to Attest's own mutation manifest. | "Dirty user changes are preserved and reported" named the goal but not the mechanism, and the obvious mechanisms are data-loss vectors. |
| 9 | **The Runtime assembly can never ship in a user's release build** (asmdef define constraints, `UNITY_EDITOR \|\| DEVELOPMENT_BUILD`). Package is installed by path reference, not embedded in the user's `Packages/` tree. | v0.1's layout would compile probe/bridge code into the customer's shipped game and would put Attest's own source inside the user's repo diff. |
| 10 | **MCP server surface moves from M5 to M1.** CLI and MCP are both thin clients over the same task API. | The loop lives in the daemon either way, so the marginal cost is small, and it buys real dogfooding and a free review UI months earlier. |
| 11 | **Timeline extended 18 → 24 weeks** and resequenced; explicit kill criteria added. | M2 ("closed loop") in three weeks was not achievable alongside domain-reload recovery, probes, replay, capture, and an evaluator. The rest of the plan inherited the optimism. |
| 12 | **Concurrency, Editor-hang recovery, retrieval strategy, cost budgets, and a fast smoke benchmark added.** | Each was absent and each is load-bearing. A 30-task × 3-run benchmark is ~15 hours; you cannot iterate against it daily. |

**Unchanged and deliberately so:** 2D-only, C#-only, local Git projects, Editor Play Mode over built players, one implementation agent, no desktop UI before the loop clears the benchmark, hidden benchmark split, and the "a polished video without reproducible evidence does not count" standard.

### Solo rescope (applied after the v0.2 review)

Staffing is confirmed as **one engineer**. Four scope cuts follow, and they are the difference between shipping and not:

| Was | Now | Why |
|---|---|---|
| Five feature families | **Two shipped** (movement-with-cooldown, repair) + one internal | Each family multiplies benchmark, fixture, and adapter work. Depth beats coverage. §4 |
| 24 weeks, ~2 engineers | **34 weeks, one** | C# editor work and TypeScript agent work become serial, with a real context-switch tax. §12 |
| 30-task benchmark, 10 design partners | **15 tasks, 4 partners** | ~3 weeks of benchmark authoring and a support load one person can't carry while building. §13, §15 |
| CLI-first UX, MCP at M5 | **MCP-first, minimal CLI, both at M1** | An existing coding agent is a free front end. A polished CLI is weeks you don't have. §12 |

Also deferred past MVP: the parallel-clone benchmark harness, signed evidence bundles, and telemetry beyond a local JSONL log. Also added: dogfooding from M2 rather than M5, and a fourth kill criterion at week 7.

**Open decisions for you, not me** — see §16. The name is the live one.

---

## 1. Vision and principles

Attest makes game-development changes trustworthy enough to delegate. The user describes intent at the level of mechanics and player experience; Attest handles inspection, implementation, execution, observation, and repair while preserving source ownership and human control.

**Positioning:** Attest is the self-verifying development agent for Unity. It does not stop at plausible code; it produces gameplay evidence.

### Principles

1. **Prove behavior, not syntax.** Compilation is a gate, not the finish line.
2. **Operate on real projects.** Adapt to unfamiliar architecture, naming, input abstractions, and asset conventions. Never assume a generated template.
3. **Unity is the serialization authority.** Scenes, prefabs, ScriptableObjects, and Input Actions are *written* through Unity editor APIs, never through blind YAML rewriting. (Reading YAML for indexing is fine and cheap; the rule is about writes.)
4. **Keep humans in control.** Changes are isolated, inspectable, reversible, and approval-gated when destructive, broad, or externally connected.
5. **Prefer deterministic systems over agent theater.** One capable implementation agent plus strong transactions, generated tests, probes, and replay. Specialized reviewer agents come later, if measurement justifies them.
6. **Measure your own reliability.** Flakiness, unsafe scope expansion, and rollback failure are product defects with the same status as a crash.
7. **Stay engine-portable above the adapter.** Criteria, task state, evidence, and replay concepts remain Unity-independent where practical.

---

## 2. Problem and opportunity

### The user problem

Coding agents can change C# files, but games fail in ways code-only tools cannot see. A project compiles while the player spawns inside a collider, an animation never transitions, a serialized reference is null, the HUD is off-screen, or a cooldown doesn't match the design. Developers shuttle between the agent, the Editor, the Console, Play Mode, and source control to find out whether a change actually works.

### Why now

- Frontier models handle coordinated multi-file work and tool use well enough for a closed implementation loop.
- Unity provides mature editor automation, package distribution, Play Mode, the Unity Test Framework, and the Input System's test utilities.
- Unity's official AI Assistant ships an MCP server, validating demand for external-agent access to editor context. Attest should interoperate rather than compete on basic connectivity. [2]
- The remaining gap is *reliability*: intent → criteria → safe serialized-state change → repeatable play → proof.

### Competitive boundary

| Category | What it provides | Attest response |
|---|---|---|
| IDE coding agents | Repo search, code edits, commands, diffs | Unity-native transactions, runtime observation, replay, evaluation |
| Unity AI / official MCP | Editor context and agent connectivity | Interoperate; differentiate on verification, isolation, evidence, repair |
| AI game generators | Fast prototypes from prompts | Editable source projects; safe changes to *existing* games |
| Automated QA tools | Test execution and telemetry | Connect QA evidence directly to implementation and bounded autonomous repair |

**Durable moat check.** Connectivity is commodity within a year. The defensible assets are (a) the transaction/rollback layer that doesn't corrupt projects, (b) the determinism harness and flake accounting, and (c) the accumulated benchmark and failure corpus. Build in that order.

---

## 3. Target users

| Primary user | Core job | MVP value |
|---|---|---|
| Technical indie developer | Add and tune mechanics faster without losing source control | Delegates bounded features, receives working changes plus proof |
| Game-jam participant | Reach a playable loop under time pressure | Automates repetitive setup, wiring, smoke testing |
| Student / learner | Understand and modify a project without guessing how pieces connect | Explains the project, proposes a plan, shows evidence |
| Small studio engineer | Reduce integration and regression risk in unfamiliar areas | Deterministic checks, diffs, approvals, rollback |

**Initial persona.** Comfortable opening Unity, reading a diff, and diagnosing an occasional failure, but unwilling to hand-wire every feature. Works on a local Git repository, uses the Input System, accepts placeholder art. Not a nontechnical user expecting a commercial game from one prompt.

---

## 4. Scope and non-goals

### Supported baseline

| Dimension | Decision | Rationale |
|---|---|---|
| Unity version | One pinned Unity 6.3 LTS patch; matrix widens only after CI proves it | Latest LTS as of July 27, 2026 [1]. **Revalidate the exact patch at M0 and pin it in CI.** |
| Project type | Local Git projects, existing or starter | Enables isolation, diffs, checkpoints, rollback |
| Game type | 2D, single-player | Constrains physics, navigation, camera, test coverage |
| Language | C# only | Compiler diagnostics and type metadata available |
| Rendering | Built-in 2D or URP 2D, project-preserving | Never force a pipeline migration |
| Input | Input System first; adapter interface for project abstractions | Deterministic test input without replacing established architecture |
| Platforms | macOS and Windows Editor | Matches local development. **Determinism guarantees are per-machine, not cross-platform.** |
| Clients | **MCP server primary, minimal CLI**, both from M1 | Both are thin clients over one task API. Solo: an existing coding agent is your front end for free |
| Assets | Existing assets and clear placeholders | Asset generation stays off the critical path |

### Supported feature families — two, not five (solo rescope)

v0.1 listed five. For a solo build that is the difference between shipping and not. **Depth on two beats shallow coverage of five**, because the benchmark, the failure fixtures, and the adapter work all multiply per family.

**Shipped and marketed:**

1. **Movement with cooldown feedback** — dash or double-jump. Chosen because it exercises every subsystem at once: C# patching, input asset transaction, timing, physics trace, UI binding, and a visual criterion. If this family works reliably, the machinery for the others already exists.
2. **Repair of a broken scene or prefab** — missing reference, layer, tag, event, component, off-screen UI. Chosen because it is the highest-value job for the target user and the cheapest to verify: it starts from a reproduction, so the criteria are *derived from the failure* rather than authored from a specification.

**Internal only, not marketed:** *collectible / score / objective completion* remains the M2 exit case. It is the simplest possible closed loop and the right thing to prove the pipeline against, but it does not need adapter work, benchmark breadth, or documentation.

**Deferred past MVP:** health/damage as a standalone family (invulnerability is already covered as part of dash), and 2D enemy pursuit/attack entirely. Enemy AI is the worst of the five for a solo dev — it has the largest architecture variance across projects and the least deterministic verification story.

Family 2 is a *mode*, not a mechanic. It shares the loop but replaces criteria-authoring with criteria-from-reproduction.

### Explicit non-goals

- A replacement Unity editor, code editor, or visual scripting system
- 3D, multiplayer, XR, console builds, live-service deployment
- One-prompt production games, final art, music, voice, Asset Store automation
- Unbounded autonomous execution, automatic publishing, silent destructive changes
- Support for every Unity version, pipeline, input architecture, and third-party framework

---

## 5. User stories and the acceptance contract

| ID | User story | Minimum acceptance |
|---|---|---|
| US-01 | Explain an unfamiliar project | Entry scenes, key prefabs, gameplay systems, input paths, dependencies, and **stated uncertainties**, with navigable references |
| US-02 | Find where a mechanic is implemented | Relevant symbols, serialized objects, references, runtime observations — with zero project mutation |
| US-03 | Add a supported mechanic | Compiles; structural and behavioral criteria pass; evidence and diff returned |
| US-04 | Fix a runtime or scene defect | Reproduces the failure first, identifies a cause, applies a bounded fix, demonstrates the previously-failing criterion now passes |
| US-05 | Review before accepting | Planned scope, sensitive actions, file/asset diff, test evidence, screenshots, limitations |
| US-06 | Undo a task | Restores the checkpoint exactly; no generated assets, package manifest changes, or settings left behind |
| US-07 | Rerun the verification | Replays from a known seed and produces results within stated tolerance — **and reports the variance across runs** |

### The acceptance-criteria contract

Before any edit, Attest converts the request into criteria carrying: `id`, `type` (`structural` \| `behavioral` \| `visual`), `observable`, `expected`, `tolerance`, `mandatory`, `evidenceMethod`, `confidence`.

**Three rules, all new in v0.2:**

1. **Freeze and hash.** Once approved, the criteria set is content-hashed. The hash appears in the final report. Criteria cannot be edited by the agent after implementation begins. If implementation reveals the criteria were wrong, the task *stops* and returns to the user for re-approval — it does not silently retarget.
2. **Blind evaluation.** The evaluator receives the frozen criteria and the evidence bundle. It does not receive the diff, the plan, or the implementation transcript. It cannot see what the implementer intended.
3. **Visual criteria never carry a task.** A task whose mandatory criteria are all `visual` is rejected at authoring time. Every feature must have at least one `behavioral` or `structural` mandatory criterion that a deterministic assertion can decide.

**Example (dash):**

```
AC-DASH-01  behavioral  mandatory
  Given Move=(1,0), pressing Dash yields 4.5–6.0 world units of displacement
  within 0.30 s, net of normal movement.
  Evidence: position trace + replay event log.

AC-DASH-02  behavioral  mandatory
  Damage applied during the first 0.20 s of a dash does not reduce health;
  identical damage at t=0.40 s does reduce health.
  Evidence: health probe, controlled damage events, both polarities asserted.

AC-DASH-03  structural  mandatory
  A "Dash" action exists in the project's existing input asset and is bound.
  The asset's pre-existing actions are unchanged.
  Evidence: serialized InputAction inspection, before/after action set diff.

AC-DASH-04  visual  advisory
  The cooldown indicator is visible and changes state until dash is available.
  Evidence: UI state probe + named screenshots at ready/active/ready.
```

Note AC-DASH-02 asserts both polarities. A criterion that only checks "damage was ignored" passes trivially if damage is broken entirely. **Every suppression criterion must be paired with its negative control.** This belongs in the criteria-authoring prompt as a hard rule.

---

## 6. Architecture

Attest separates the model-driven decision loop from deterministic Unity operations. The daemon owns task state, context, policy, evidence, and budgets. The Unity package owns authoritative editor and runtime access.

```
Client        Developer  ·  Coding agent (MCP)  ·  Attest CLI
                              │
Protocol      Attest task/evidence API  ·  MCP server surface
                              │
Orchestration Task engine · Project graph · Evidence store · Policy engine
                              │
Adapter       Versioned Unity RPC (daemon = server, Unity = client)
                              │
Unity package Editor transactions · Attest bridge · Test codegen + runner
                              │
Execution     Unity Editor ⇄ Play Mode ⇄ Unity Test Framework
```

### Components

| Component | Responsibilities | Technology |
|---|---|---|
| Attest CLI | Submit tasks, stream progress, approve actions, inspect evidence, accept/rollback | TypeScript |
| MCP server | Same task API, exposed to external coding agents | TypeScript |
| Agent daemon | Criteria, context, planning, tool calls, retries, policy, task state, model adapters | TypeScript / Node.js |
| Project graph | Types, assemblies, scenes, prefabs, components, serialized references, inputs, tests, task history | SQLite + FTS5 |
| Unity adapter | Typed RPC, version negotiation, transaction and evidence schemas | TypeScript + JSON Schema (schemas are the shared source of truth; C# types generated from them) |
| Unity package | Inspection, structured mutation, compile and Play Mode control, test generation, capture, probes | C# UPM package |
| Evidence store | Logs, traces, screenshots, test results, criteria results, manifests | Content-addressed files + SQLite metadata |

### The connection model (this is the important part)

**The daemon listens on loopback. The Unity package connects to it as a client.**

This inverts v0.1's ambiguity ("the package initiates or explicitly accepts a connection"), and it is not a stylistic choice. Every C# compile triggers a domain reload that destroys all managed state in the Editor, including any listening socket, in-flight request, and static field. Entering Play Mode does the same by default. If Unity holds the server, every compile drops the connection and the daemon has to poll a moving target.

With Unity as the client:

- `[InitializeOnLoad]` re-establishes the connection automatically after every domain reload.
- The session token and in-flight operation ID live in `SessionState` (survives domain reload, cleared on Editor restart) plus a workspace file (survives Editor restart).
- Every mutating RPC carries an **idempotency key**. After a reload, Unity replays its last operation ID on reconnect; the daemon decides whether to re-issue, confirm, or roll back.
- The daemon's task state machine is durable in SQLite and is the single source of truth. Unity holds no authoritative task state.

**Editor lifecycle recovery is a first-class requirement.** The Editor will hang on modal dialogs, import loops, and native crashes — routinely, not exceptionally. The daemon runs a watchdog per operation with a per-operation timeout; on breach it can kill the Editor process, relaunch it against the same project, wait for the import to settle, verify the checkpoint state, and resume or abort the task. A task must survive an Editor kill at any point without corrupting the project. This is an M0 exit criterion.

**Domain reload during Play Mode.** Unity's *Enter Play Mode Options* can disable domain and scene reload, which makes Play Mode entry far faster and more deterministic — but it changes static-state lifetime semantics and breaks projects that rely on reload. Attest **must not silently change this project setting.** It reads the setting, adapts its timing model to whichever mode is configured, and may *suggest* the change with an explicit approval. Both modes must be supported and both must be in CI.

### Deployment

- Local-first. Daemon binds loopback with an authenticated session; all file access is scoped to the selected repository.
- Model calls are provider-neutral and disclose which context categories leave the machine. A no-network mode supports indexing, testing, and local models.
- **One Editor per project path** — Unity locks the project folder. Parallel benchmark runs would therefore need N git clones, each with its own Editor and daemon workspace. **Deferred past MVP:** at 15 tasks the full benchmark runs serially overnight in ~7 hours, so the parallel harness buys nothing a solo dev needs yet. Note the constraint now so the workspace layer doesn't assume a singleton project path.
- Official Unity MCP is an optional interoperability layer. Attest's internal API retains transactions, replay timelines, checkpoints, and evidence bundles that basic MCP tools do not express.

---

## 7. Unity package design

```
com.attest.agent/             ← installed by path reference in the user's
  package.json                   Packages/manifest.json, NOT copied into
  Editor/                        their repo tree
    Attest.Editor.asmdef
    Rpc/            Connection, reconnect, idempotency, version negotiation
    Inspection/     Scene, hierarchy, SerializedObject, prefab, input, TypeCache
    Transactions/   Precondition checks, ops, manifests, save discipline
    Compilation/    CompilationPipeline hooks, diagnostic correlation
    TestGen/        Replay → Play Mode test source generation
    TestRun/        TestRunnerApi execution + result streaming
    Capture/        Camera → RenderTexture → ReadPixels screenshots
    AttestWindow.cs  Minimal status/consent UI
  Runtime/
    Attest.Agent.asmdef     ← Define Constraints: UNITY_EDITOR || DEVELOPMENT_BUILD
    AttestBridge.cs
    ProbeRegistry.cs
    EventRecorder.cs
    DeterministicClock.cs
    InputDriver.cs
  Tests/
    Editor/  Runtime/
  Documentation~/  Samples~/
```

Two placement rules that v0.1 got wrong:

1. **Do not embed the package in the user's `Packages/` directory.** An embedded package is Attest's own source sitting inside the customer's repo and their diffs. Install by relative or absolute path reference in `Packages/manifest.json` — a single line, checkpointed, and reverted on rollback. (Ship a scoped registry or Git URL after beta.)
2. **The `Runtime/` assembly must be unable to enter a release build.** Set asmdef Define Constraints to `UNITY_EDITOR || DEVELOPMENT_BUILD`. Without this, probe and bridge code compiles into the customer's shipped game. That single defect would end an evaluation.

### Editor assembly

- **Inspection.** Active scene, hierarchy, GameObjects, components, `SerializedObject` data, prefabs, assets, Input Actions, build settings, Console, compilation state. Type and reference queries go through `TypeCache` and `AssetDatabase` dependency APIs.
- **Transactions.** Validate every target and value against preconditions, apply through `SerializedObject`/`SerializedProperty` and `PrefabUtility`, save only after full success, return a mutation manifest listing every touched asset path and GUID.
- **Compilation.** Await domain reload, correlate diagnostics to the task's own changed files, re-establish the session.
- **Play Mode / tests.** Generate the replay test, invoke it via `TestRunnerApi`, stream results and captures back.

### Runtime assembly

- **Probe registry.** Explicit, bounded, allowlisted observables. Never unrestricted object serialization — that path produces enormous payloads and leaks user data into model context.
- **Event recorder.** Semantic events with timestamp, frame, entity ID, JSON-safe payload, bounded ring buffer.
- **Deterministic clock.** See §8.
- **Input driver.** Deterministic action injection through a project adapter interface.

### Transaction model

```
transaction {
  id, idempotencyKey, projectRevision, unityVersion, packageSchemaVersion,
  targetAssets[], preconditions[], operations[], validationPlan,
  sensitivity, expectedMutationSet[]
}
result {
  status, modifiedAssets[], createdAssets[], deletedAssets[],
  compilationRequired, diagnostics[], warnings[], evidenceRefs[],
  actualMutationSet[]   // reconciled against expectedMutationSet
}
```

- Structural assets are never free-form text in the normal path. Raw patches are reserved for C#, JSON, Markdown, and explicitly allowlisted config.
- `actualMutationSet` is diffed against `expectedMutationSet`. **Any unexpected modified asset fails the transaction** and triggers checkpoint restore. This catches the whole class of "Unity also re-serialized four unrelated prefabs" surprises, which is the most common source of ugly diffs.
- On partial failure: restore the checkpoint, or report the exact modified set, before any retry. Never retry over unknown state.
- `undoGroup` is recorded for the human's convenience in-session and is **explicitly not a rollback mechanism** (v0.1 implied otherwise). The Undo stack does not reliably survive domain reloads, Play Mode transitions, or Editor restarts.

---

## 8. Determinism and the replay-as-test model

This section is mostly new. It replaces v0.1's assumption that a fixed seed produces comparable results.

### Replays are generated Play Mode tests

A replay compiles to a C# Play Mode test file under `Assets/AttestGenerated/Tests/` (path configurable), executed through `TestRunnerApi`.

**Why this is better than driving Play Mode over RPC:**

- `InputTestFixture` is a NUnit fixture that isolates from real platform input devices. It is designed for tests. Using it in a free-running Play Mode session is unsupported; outside a test you must hand-roll low-level device state injection and manual input pumping, which is a bespoke reimplementation of something Unity already ships. [5]
- The Test Framework already handles Play Mode entry/exit, per-frame stepping via `[UnityTest]` coroutines, setup/teardown, timeouts, and machine-readable NUnit XML results. [6]
- Test results correlate to criteria without an intermediate protocol.
- **The generated test is a product feature, not scaffolding.** The user ends the task owning a regression test that proves the mechanic. Their next task runs it as part of the regression suite. Evidence compounds.

Generated tests are written to a dedicated directory, listed in the mutation manifest, and removed on rollback like any other generated artifact. At accept time the user chooses to keep or discard them (default: keep).

### The determinism stack

Applied inside the generated test's setup, in this order:

1. **Fixed virtual clock.** Set `Time.captureDeltaTime` so each rendered frame advances game time by a fixed amount regardless of wall-clock. This decouples the run from machine load — the single highest-value determinism lever, and it was absent from v0.1.
2. **Fixed physics step.** Pin `Time.fixedDeltaTime` and `Time.maximumDeltaTime`; record both in the evidence manifest.
3. **Seeded RNG.** Seed `UnityEngine.Random`. Detect and report project code using `System.Random` unseeded or `DateTime.Now` — these are determinism hazards Attest cannot fix, and the report must say so rather than pretend the run was deterministic.
4. **Frame-count-based waits, not seconds.** The replay DSL expresses waits in frames or in virtual seconds resolved to frames. Never `WaitForSeconds` against wall-clock.
5. **Disable vsync / pin target frame rate** for the duration.

### Determinism is a claim to be verified, not assumed

**Every criterion is evaluated across at least 2 runs of the same replay.** Three outcomes:

- Agreement, criterion satisfied → `pass`
- Agreement, criterion unsatisfied → `fail`
- Disagreement → **`unstable`** — never `pass`

`unstable` is a first-class result. It counts as a failure for the launch gates and appears in the report with the observed variance. A system that quietly reports the lucky run is worse than one that reports nothing.

Determinism guarantees are scoped to **the same machine, same Unity patch, same package version**. Cross-platform reproducibility is not claimed and should not appear in marketing.

### Screenshot capture

Use a dedicated camera rendering to a `RenderTexture` with a synchronous `ReadPixels`, at a fixed resolution, taken at a named replay checkpoint on a known frame. Do not use the fire-and-forget file screenshot API — its write is asynchronous and its timing relative to the game frame is not guaranteed, which produces exactly the off-by-one-frame evidence that makes a visual criterion untrustworthy.

---

## 9. Agent loop and task lifecycle

| Stage | Agent responsibility | Deterministic gate / output |
|---|---|---|
| 1. Understand | Translate intent; expose assumptions and subjective choices | Editable criteria + risk class; **criteria frozen and hashed on approval** |
| 2. Inspect | Retrieve relevant graph neighborhoods, source, assets, diagnostics, live editor context | Context manifest with provenance and token cost |
| 3. Plan | Select implementation and verification strategy | Change plan, replay plan, sensitive-action list |
| 4. Implement | Patch C#; request Unity transactions | Atomic result set; mutation-set reconciliation; checkpoint |
| 5. Compile | Interpret diagnostics | Clean compile. **Failures enter the compile-repair fast path (§9.1), not the semantic repair loop** |
| 6. Structural check | Edit Mode assertions on references, components, prefab integrity, input assets | Structural criteria decided before Play Mode is ever entered |
| 7. Play | Generate and run the replay test ≥2× | NUnit results, input timeline, runtime trace, per-run variance |
| 8. Observe | Collect probes, events, logs, screenshots, timing | Evidence bundle linked to criterion IDs |
| 9. Evaluate | **Blind** judgement per criterion | pass / fail / unstable / uncertain + rationale |
| 10. Repair | Diagnose failed criteria; choose bounded changes | New checkpoint; max 3 semantic repair loops |
| 11. Report | Summarize outcome and limitations | Diff, results, visuals, cost, rollback control |

### 9.1 The compile-repair fast path

Compile errors are the dominant iteration in practice. They get their own cheap loop:

- Up to **8 compile-fix attempts** per implementation phase, using a minimal-context prompt: the diagnostics, the offending file spans, and the relevant type signatures from `TypeCache`. No re-planning, no re-inspection, no full project context.
- Compile fixes may only touch files already in the current transaction's mutation set. A compile fix that wants to touch a new file escalates to the semantic loop.
- Compile attempts do not consume the 3 semantic repair loops.
- If 8 attempts fail, roll back to checkpoint and escalate to re-planning (which does consume a semantic loop).

Without this split, a missing `using` costs the same budget as a genuine behavioral defect.

### 9.2 Budgets (defaults, all user-overridable)

| Budget | Default | Notes |
|---|---|---|
| Semantic repair loops | 3 | Post-compile, behavior-driven |
| Compile-fix attempts | 8 per implementation phase | Cheap context |
| Wall clock | 20 min | Watchdog kills and reports |
| Model spend | $3.00 | Hard stop; partial work is checkpointed and reported, not discarded |
| Tool calls | 60 | Detects thrashing |
| Files touched | 12 | Exceeding requires approval (scope-creep tripwire) |
| Editor restarts | 2 | Third restart aborts the task |

Budget exhaustion is a *reportable outcome*, not an error. The user receives the checkpoint, the diff so far, what passed, and what was still failing.

### 9.3 Concurrency and ownership (new)

The user may be in the Editor while Attest works. Unhandled, this corrupts both.

- A task acquires an **exclusive control lease** on the Editor. The Attest window shows a clear "Attest is driving" state with a one-click yield.
- Before each transaction, Attest checks for user modifications since checkpoint (asset timestamps + `git status`). Detected user edits **pause the task and ask** — they are never overwritten.
- If the user takes back control mid-task, the task suspends at the last checkpoint and can be resumed or abandoned.

### 9.4 Stop conditions

- **Success** — all mandatory criteria pass, stable across runs, no new critical diagnostics
- **Needs review** — advisory or visual criteria uncertain, all deterministic gates pass
- **Unstable** — a mandatory criterion disagreed across runs
- **Budget exhausted** — any budget in §9.2
- **Blocked** — missing dependency, unsupported architecture, or a required user decision
- **Unsafe** — action exceeds policy or cannot be rolled back reliably

---

## 10. Context retrieval

New section. v0.1 said "context manifest with provenance and token budget" without saying how context is selected, and this is the difference between a system that works on unfamiliar projects and one that doesn't.

**Layered retrieval, cheapest first, escalating only when the previous layer is insufficient:**

1. **Project card** (always, ~1–2k tokens). Unity version, pipeline, input architecture, assembly layout, entry scenes, top-level folder conventions, detected adapters. Cached; invalidated by manifest or assembly changes.
2. **Symbol neighborhood.** From the request, resolve candidate types via `TypeCache` and FTS over the symbol index. Pull declarations and signatures, not bodies.
3. **Bodies on demand.** Full method bodies only for symbols the plan names.
4. **Serialized neighborhood.** For target prefabs/scenes: component list, serialized property names and values, and inbound references — summarized, with an explicit "expand this object" tool rather than dumping the hierarchy.
5. **Live editor context.** Current scene, selection, Console, compile state — small and always fresh.

Rules: every context item carries provenance and token cost; the manifest is shown to the user on request; a task that hits 60% of the model's context window before implementation **stops and reports the project as too large for the current retrieval strategy** rather than degrading silently.

**Adapters.** Project-architecture variance is the main threat to real-world success. Attest detects and, where it cannot detect, asks about: the input abstraction (direct Input System vs. a wrapper interface), the damage/health interface, the UI binding pattern (direct references vs. presenter vs. events), and the scene-loading convention. A detected adapter is recorded in the project card and reused across tasks. An undetected one is a *stated uncertainty*, not a guess.

---

## 11. Safety, privacy, trust

### Git safety rules (tightened)

These are absolute. They exist because the obvious implementations are data-loss vectors.

- **Never** `git reset --hard` on the user's HEAD.
- **Never** `git clean` without an explicit path list drawn from Attest's own mutation manifest.
- **Never** `git checkout`/`switch` away from the user's branch without committing their work first.
- A dirty worktree at task start is committed to an `attest/task-<id>` branch (or stashed with a labeled, recoverable stash) and reported. The user's HEAD and branch are restored on completion.
- Rollback = `git restore` scoped to the paths in the mutation manifest, plus deletion of exactly the created paths, plus reverting the `Packages/manifest.json` line if Attest added it.
- **File-level rollback happens with Unity's asset pipeline quiesced.** Changing files under the Editor's feet, while it holds importer state and `.meta` mappings, can desynchronize GUIDs. Either the Editor performs the restore, or it is paused (`AssetDatabase.StartAssetEditing` bracketing, or the Editor is closed) and a full refresh follows.
- **Rollback verification is part of rollback.** After restore: `git status` clean relative to the checkpoint, project reimports with zero errors, all touched scenes and prefabs open, and the `.meta` GUID set matches the checkpoint. A rollback that isn't verified didn't happen.

### Default safeguards

- Workspace scope + Git checkpoint mandatory before any mutation
- Game execution has network disabled by default where platform controls permit; child processes have timeouts and cleanup
- Secrets, signing material, `.env`, `Library/`, `Temp/`, build outputs, and configured exclusions are never indexed or sent to models
- Evidence and task logs are immutable within a task and record model/provider/version, tool versions, Unity version, package schema version, seed, timestep settings, and project revision
- External model disclosure names the exact context categories leaving the machine; asset uploads require explicit approval
- Downloaded code, binaries, packages, and assets require approval plus source and license metadata

### Approval policy

| Action class | Default | Examples |
|---|---|---|
| Read-only | Allow | Inspect scene, source, references, diagnostics, runtime state |
| Reversible in-task | Allow with visible plan | Patch C#, add component, create placeholder, run tests |
| Broad / project-wide | Ask | Render pipeline, input architecture, package manifest, build settings, **Enter Play Mode Options** |
| Destructive | Ask | Delete or replace assets, scenes, prefabs, tests, or user changes |
| External / executable | Ask | Network calls, package downloads, binaries, uploads, shell outside allowlist |
| Release / credentials | **Deny in MVP** | Publishing, signing, store upload, credential use |

### Trust report

Every task report answers seven questions: what changed, why, what was tested, what passed, what failed or remained subjective, what data left the machine, and how to revert. It additionally states the criteria hash, the per-criterion run variance, and any determinism hazards detected in project code.

---

## 12. Milestones — solo build, 34 weeks

**Staffing assumption: one engineer.** The previous 24-week plan assumed roughly two, working the C# editor surface and the TypeScript daemon in parallel. Solo, those are serial, and the context-switch between Unity editor programming and agent-loop engineering is a real tax — they use different debugging instincts and different iteration speeds.

Sequenced so the two things most likely to kill the product — domain-reload/lifecycle survival and rollback fidelity — are proven in M0, before any feature work depends on them.

| Milestone | Weeks | Deliverable | Exit criteria |
|---|---|---|---|
| **M0 — Lifecycle & safety** | 1–5 | Schemas, repo layout, fixture project, daemon-as-server RPC, Unity client reconnect, idempotency, durable task state, checkpoint/rollback, watchdog + Editor relaunch | Kill the Editor at 20 random points mid-task: task resumes or aborts cleanly every time, integrity verified. Rollback bit-exact on 100 consecutive runs. Reconnect survives compile, Play Mode entry, and Editor restart. |
| **M1 — Inspect & transact** | 6–11 | Read model (`TypeCache`, scene/prefab/serialized inspection), C# patch + compile fast path, scene/prefab transactions, mutation-set reconciliation, **MCP server as primary client** | Add a component and assign a serialized reference on an unfamiliar project without touching YAML. 200-iteration transaction fuzz: zero unexpected drift, zero corruption. Failed transactions leave no residue. |
| **M2 — Verify** | 12–18 | Replay DSL → Play Mode test codegen, determinism stack, input driver + adapter, probes, event recorder, capture, `TestRunnerApi` runner, blind evaluator | Collectible/score task end-to-end with evidence. **Flake rate <5% over 20 reruns.** Both Enter-Play-Mode-Options modes green in CI. **Dogfooding starts here.** |
| **M3 — Two families** | 19–23 | Movement-with-cooldown skill; repair mode; generated structural + Play Mode checks | Both families ≥70% on fixture variants; repair mode reproduces before it fixes. **First design partner watching by week 21.** |
| **M4 — Unfamiliar projects** | 24–29 | Project graph, symbol/reference indexing, layered retrieval, architecture adapters, dirty-worktree handling, concurrency lease | Tasks complete across four unfamiliar small projects with zero asset corruption; adapter detection reports uncertainty rather than guessing |
| **M5 — Beta** | 30–34 | Installer, docs, minimal CLI, benchmark runner, opt-in telemetry | 15-task benchmark meets launch gates; 4 design partners complete guided tasks |

### Solo-specific decisions

- **MCP is the primary client; the CLI is minimal.** This is a change from v0.2's "both from M1." For a solo dev, an existing coding agent *is* your front end — it costs you nothing and it is where your users already are. A polished CLI UX is several weeks you do not have. Ship `attest run`, `attest status`, `attest rollback` and nothing more until after beta.
- **Cut from MVP:** the parallel-clone benchmark harness (15 tasks run serially overnight is ~7 hours — acceptable), signed evidence bundles, and telemetry infrastructure beyond a local JSONL log.
- **Dogfood from M2, not M5.** The largest solo risk is building for twenty weeks before a user touches it. From the moment the closed loop works on a fixture, use it on your own project daily and let that dictate what M3 and M4 actually contain.
- **Recruit design partners during M2, not M5.** Four people, not ten — ten is a support load one person cannot carry while also building. Start the conversations at week 12; you need them warm by week 21.

### Discipline

- No desktop UI until the loop clears the benchmark.
- Every milestone adds benchmark tasks **and failure fixtures** before it adds feature breadth.
- Pin Unity and package versions in CI; test patch upgrades on a branch before widening the matrix.
- Official Unity MCP stays an interoperability track, never a dependency for core local operation.

### Kill criteria

Decide these now, in writing, while you are not emotionally invested. A solo dev has no one else in the room to call it, which makes pre-committing the only defense against sunk cost.

- **After M2 (week 18):** if the flake rate on a single fixture task cannot be driven below 10%, the evidence claim — the entire product thesis — is not deliverable. Stop and rethink the verification model before building any feature families.
- **After M3 (week 23):** if median task cost exceeds $8 or median wall clock exceeds 25 minutes, the daily-use value proposition fails regardless of success rate. Fix retrieval and tool granularity before adding scope.
- **After M4 (week 29):** if success on unfamiliar projects is less than half of success on fixtures, the product is a fixture demo. Narrow the supported architecture set explicitly and market that honestly, rather than claiming generality you can't deliver.
- **Anytime:** if M0 has not cleared its exit criteria by week 7, the Editor-lifecycle problem is harder than this design assumes. That is the signal to consider a built-player execution model instead of Editor Play Mode — a significant redesign, and far cheaper to face at week 7 than week 20.

---

## 13. Benchmark

### Dataset — 15 tasks (solo rescope)

15 tasks across four small, legally redistributable 2D projects: two authored fixtures, one open-source project, one architecture variant created by restructuring a fixture. **Keep the hidden test split** — it is cheap and it is the only thing standing between you and overfitting your own prompts.

Halved from v0.1's 30 because authoring a benchmark task properly (fixture, human-written hidden assertions, expected-failure documentation) is roughly a half-day each, and 30 of them is three weeks of work that produces no product.

| Category | Tasks | Examples | Primary checks |
|---|---|---|---|
| Code + structure | 3 | Cooldown value, component wiring, ScriptableObject field | Compile, serialized reference, type checks |
| Movement / physics | 4 | Dash, double jump, one-way platform | Position/velocity trace, collision state |
| UI | 2 | Cooldown indicator, HUD binding | Binding, layout bounds, screenshots |
| Debugging | 4 | Null reference, broken prefab, wrong layer, missing event | Reproduction, then regression pass |
| Visual repair | 2 | Off-screen HUD, camera framing | Bounds, visibility, before/after review |

Categories track the two shipped families plus repair. Gameplay-systems tasks (collectible, win condition) stay in the fixture corpus for internal M2 use but are out of the scored benchmark.

### Two benchmark tiers

A 15-task × 3-run benchmark is 45 Editor sessions — roughly 7 hours. That is an overnight job, not a development feedback loop, and it runs serially on one machine without the parallel-clone harness.

- **Smoke (5 tasks × 1 run, ~30 min):** one per category. Runs on every meaningful change. Gates merges.
- **Full (15 tasks × 3 runs + 1 varied seed):** overnight. Gates milestones.

### Protocol

- Reset to a recorded commit; clear task-generated evidence; pin model version and budget.
- Fixed seeds for the 3 primary runs; one varied seed where stochasticity matters.
- **Hidden deterministic assertions, authored by a human, scored first** — never assertions the agent wrote. Then visual criteria. Then human review for subjective quality.
- Record: first-run success, final success, **unstable rate**, repair loops, compile-fix attempts, human interventions, wall time, tokens, cost, tool calls, regressions, files/assets changed, rollback fidelity, and Editor restarts.
- Publish representative failures and unsupported cases, not only successful runs.

### Scoring

| Dimension | Weight | Rule |
|---|---|---|
| Mandatory behavioral criteria | 40% | Hidden replay assertions and runtime state. **`unstable` scores 0.** |
| Structural correctness | 20% | Compilation, references, component/prefab/scene invariants |
| Regression safety | 15% | Existing suite + project smoke checks |
| Visual evidence | 10% | Visibility, layout, checkpoint screenshots, evaluator confidence |
| Change quality | 10% | Scope discipline, maintainability, no gratuitous architecture changes |
| Rollback and report | 5% | Verified exact restoration + complete evidence manifest |

---

## 14. Risks

| Risk | Impact | Mitigation / trigger |
|---|---|---|
| **Domain reload / editor lifecycle** | Dropped connections, flaky tasks, corrupt half-states | Daemon-as-server, `[InitializeOnLoad]` reconnect, `SessionState` + workspace persistence, idempotency keys, durable task state, watchdog + relaunch. **Proven in M0 before anything depends on it.** |
| **Nondeterministic gameplay** | False passes and false failures — the most dangerous failure mode, because it makes the product's core claim untrue | Virtual clock, fixed timestep, seeded RNG, frame-based waits, multi-run flake detection, `unstable` as a first-class result, determinism-hazard detection in project code |
| **Serialized asset corruption** | Project loss and permanent distrust | Unity-authoritative writes, preconditions, mutation-set reconciliation, verified rollback, fixture fuzz tests |
| **Project architecture variance** | Low success on real projects | Adapter interfaces, inspect-before-modify, confidence thresholds, explicit unsupported-case reporting, M4 kill criterion |
| **Self-grading** | The system certifies its own broken work | Frozen hashed criteria, blind evaluator, deterministic checks dominate, human-authored hidden benchmark assertions, paired negative controls |
| **Vision evaluator overconfidence** | A polished report hides broken behavior | Visual criteria can never be the sole mandatory criteria; visual outcomes may be `uncertain` and route to human review |
| **Model cost / latency** | Poor daily usability | Layered retrieval, server-side tool sequences, compile-repair fast path, cached project card, model routing, explicit budgets, M3 kill criterion |
| **Unity competes directly** | Basic connectivity becomes commodity | Build above MCP: transactions, replay, acceptance, evidence, repair. Reassess quarterly. |
| **Unity API / terms change** | Integration or commercialization constraints | Documented APIs only, isolated adapter, review current terms before beta and before any commercial release, obtain counsel |
| **Security / data leakage** | Loss of trust or IP exposure | Local-first defaults, exclusion lists, consented context manifest, no execution-time network by default |
| **Generated tests rot** | Users inherit a suite that fails on their next change | Generated tests are labeled, isolated in one directory, and optional at accept time; report explains what each one asserts |

---

## 15. Success metrics

### Launch gates

| Metric | Target | Measurement |
|---|---|---|
| Final task success | ≥70% overall; ≥60% every category | Hidden 15-task benchmark, 3 runs each |
| First-run success | ≥40% | No semantic repair loop after initial implementation |
| **Unstable rate** | **≤5% of completed tasks** | Criterion disagreement across runs |
| Unrecoverable project corruption | 0 incidents | Checkpoint + post-rollback integrity verification |
| Rollback fidelity | 100% for generated changes | Verified clean diff + reimport + GUID set match |
| Human intervention | ≤0.5 per completed task | Approvals excluded; corrective guidance counted |
| Median task time | ≤12 min | Submission to evidence-ready report |
| **Median task cost** | **≤$3.00** | Model spend per completed task |
| Evidence completeness | ≥95% | All mandatory criteria linked to valid evidence |
| New critical regressions | <3% of completed tasks | Existing + hidden smoke tests |
| Design-partner usefulness | ≥3 of 4 would use weekly | Structured interviews after three real tasks on their own project |

### Instrumentation

Telemetry is local; external upload is opt-in. Every task records versions, project revision, model, budgets, tool calls, wall time, cost, criteria results and variance, repair reasons, compile-fix counts, errors, evidence artifacts, approvals, Editor restarts, and final disposition.

**Do not optimize for completion rate alone.** Unsafe scope expansion, flaky evidence, unstable criteria, and rollback failures are first-class defects and are tracked on the same dashboard as success rate.

---

## 16. Open decisions — yours, not mine

These change the build and I don't have enough information to settle them.

1. ~~**The name.**~~ **Resolved: Attest.** No Unity vocabulary collision (Unity's own "Editor/Runtime assembly" convention is untouched by this choice), spellable from hearing it once, six characters in a CLI. This document, the package ID (`com.attest.agent`), the CLI binary (`attest`), and the repo now use it throughout. **Still open:** verify `attest` npm-package and domain availability before anything is printed or shared publicly.
2. ~~**Team size.**~~ **Resolved: solo.** The plan in §12 is rescoped accordingly — 34 weeks, two shipped feature families, MCP-first, 15-task benchmark, four design partners.
3. **Business model, because it changes the architecture.** Local-first + BYO API key is a different product from a hosted service with an included model budget. Local-first is assumed throughout; if a hosted tier is coming, the evidence store and telemetry need multi-tenant design from M0 rather than a retrofit. **For a solo build, local-first + BYO key is strongly recommended** — it removes billing, quota, tenancy, and cost-exposure from the MVP entirely.
4. **Whether to ship generated tests by default.** Keeping them is a strong differentiator (evidence compounds into a regression suite) but adds a maintenance surface the user didn't ask for. Default `keep` is assumed here.
5. **Design-partner recruiting starts at M2 (week 12), not M5.** Four Unity developers with small 2D projects who will let you watch them work is a ~9-week lead time, and they are on the critical path for M4 fixtures.

---

## 17. First demo

**Objective.** From a clean checkout of an unfamiliar 2D platformer, ask Attest to add a dash with directional movement, a 0.7 s cooldown, 0.2 s of invulnerability, and a HUD cooldown indicator. No hand-editing.

### Fixture

Unity 6.3 LTS 2D project with a Player prefab, movement controller, Health component, Input Action asset, HUD prefab, hazard, and one short level. Architecture is deliberately unfamiliar: input is wrapped by `IPlayerInput`, damage goes through `IDamageable`, HUD references are assigned through a presenter. Existing smoke tests, no dash implementation, no dash art.

### Sequence

1. User submits the request. Attest inspects the project and displays four acceptance criteria plus intended scope. **The user approves; criteria are hashed.**
2. Attest locates the Player prefab, movement and health types, the input abstraction, the Input Action asset, and the HUD presenter. It states two assumptions: dash distance target, placeholder icon.
3. Checkpoint. Attest patches the movement code, adds a dash state, updates the project's *existing* input asset through a Unity transaction, adds a placeholder cooldown UI element, assigns references through `SerializedObject`. Mutation set reconciles clean.
4. Recompile. One compile error (missing interface member) is fixed on the fast path in a single attempt without re-planning.
5. Edit Mode structural checks pass: action exists and is bound, pre-existing actions unchanged, component values correct, references assigned, prefab intact.
6. Attest generates a Play Mode test and runs it twice: move right, dash, inject damage during invulnerability, inject damage after it, attempt an early second dash, wait, dash again.
7. **Both runs agree on a failure:** the cooldown icon resets before the cooldown completes. Attest links AC-DASH-04 to the UI probe and screenshot, patches only the presenter timing, and reruns.
8. All mandatory criteria pass and agree across runs. Exit Play Mode; run the existing regression suite.
9. Report: diff, before/after hierarchy, criteria matrix with the frozen hash, position and health traces, three named screenshots, repair history, per-run variance, remaining subjective note, the generated test file, and the rollback control.

### Evidence matrix

| Criterion | Evidence | Pass condition |
|---|---|---|
| Directional dash | Input timeline + position trace | Displacement in range and aligned with input vector, both runs |
| Cooldown | `DashAccepted` / `DashRejected` events | Early attempt rejected; later attempt accepted at ≥0.7 s |
| Invulnerability | Health probe + controlled damage, **both polarities** | Health unchanged during first 0.2 s; damage still lands at 0.4 s |
| Indicator | UI state probe + screenshots at ready/active/ready | Visible, correctly bound, synchronized to cooldown |
| Regression | Existing Edit/Play Mode tests + Console | No new failures or critical log entries |
| Rollback | Post-rollback verification | `git status` clean, project reimports clean, GUID set matches |

### Success standard

The demo succeeds only if a reviewer can independently rerun the replay, inspect the actual project changes, and restore the repository to its exact starting state. A polished video without reproducible evidence does not count.

---

## Appendix A — Core data model

| Entity | Key fields |
|---|---|
| `Task` | request, status, budgets, project revision, plan, approval state, checkpoints, editor restarts |
| `AcceptanceCriterion` | type, observable, expected, tolerance, mandatory, evidenceMethod, result, **per-run results**, confidence |
| `CriteriaSet` | criteria[], **contentHash**, approvedAt, approvedBy |
| `ProjectEntity` | stable ID, kind, asset path, Unity GUID/fileID, graph edges |
| `Transaction` | idempotencyKey, preconditions, operations, sensitivity, targets, expected/actual mutation set, validation |
| `Replay` | seed, timebase, fixedDeltaTime, captureDeltaTime, input actions, waits (frames), hooks, assertions, named captures, **generatedTestPath** |
| `Probe` | provider, target, allowlisted properties, cadence, bounds, schema |
| `Evidence` | kind, source, timestamp/frame, content hash, criterion links, **runIndex**, confidence |
| `Checkpoint` | git ref, branch state, dirty-work commit, package manifest state, verification result |
| `TaskReport` | diff, criteria results + hash, variance, tests, visuals, data disclosure, cost, limits, rollback reference |

## Appendix B — Decisions to revisit

| Decision | MVP choice | Revisit when |
|---|---|---|
| Roslyn | **Dropped**; `TypeCache` + Unity diagnostics + YAML/GUID index | Refactoring accuracy or source-generator awareness blocks a benchmark task |
| Official Unity MCP dependency | Optional interoperability | It exposes durable transactions, replay, and evidence primitives worth reusing |
| Replay execution | **Generated UTF Play Mode tests** | Test framework overhead becomes the latency bottleneck, or a scenario cannot be expressed as a test |
| Enter Play Mode Options | Support both modes; never change silently | Reload-disabled proves reliable across the fixture corpus |
| Test player vs. Editor Play Mode | Editor Play Mode | Headless scale or performance isolation requires built players |
| Desktop UI | Defer | CLI loop clears the benchmark and design partners need review tooling |
| 3D | Out of scope | 2D benchmark clears launch gates and three real 3D cases share stable abstractions |
| Multiple agents | One implementation agent + blind evaluator | An independent reviewer measurably improves success at acceptable cost |
| Generated test retention | Keep by default | User research says otherwise |

## Appendix C — References

Current-product claims were checked against official Unity sources on July 27, 2026. **Package and API details must be revalidated against the exact pinned Unity and package versions at M0** — specifically the `TypeCache`, `TestRunnerApi`, `InputTestFixture`, `SessionState`, and Enter Play Mode Options surfaces this design depends on.

1. Unity 6 release support — LTS designation and support dates for Unity 6.3 LTS
2. MCP servers in game development — Unity's official MCP server ships in the AI Assistant package
3. Creating custom packages — package structure, Editor/Runtime assemblies, test folders
4. Unity Editor command-line arguments — batch mode behavior and automation constraints
5. `InputTestFixture` API — known-state input testing and isolation from platform input
6. Unity Test Framework — Edit Mode and Play Mode testing, `TestRunnerApi`
7. `Time.captureDeltaTime` — fixed virtual time step decoupled from wall clock
8. Enter Play Mode Options — domain and scene reload configuration
