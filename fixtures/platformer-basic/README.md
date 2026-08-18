# fixtures/platformer-basic

M0/M2 fixture, matching spec §17's demo fixture description: a small 2D project with a deliberately unfamiliar architecture (`IPlayerInput`, `IDamageable`, a HUD presenter) so Attest has to inspect and adapt rather than assume its own generated conventions.

## Nothing here has been opened in Unity yet

No Unity install existed on the machine that scaffolded this repo (see root [README](../../README.md)). What that means concretely:

- **The scene and prefabs are NOT included as files.** Hand-writing Unity's scene/prefab YAML (GUIDs, fileIDs, cross-references) without the Editor to generate it is exactly the blind-serialized-state edit Attest itself refuses to do (spec principle 3) — doing that to bootstrap the fixture would bake the wrong precedent into commit one. Instead, [`Assets/Editor/FixtureBuilder.cs`](Assets/Editor/FixtureBuilder.cs) builds them **programmatically**, through real `PrefabUtility`/`EditorSceneManager`/`InputActionAsset` APIs.
- **`ProjectSettings/ProjectVersion.txt` has a placeholder Unity version** (`6000.3.0f1`). Unity will prompt about a version mismatch if that's not the exact patch installed — this is a safe, expected prompt, not corruption. Update the file (or just let Unity do it) to match spec §4's pinned patch once that's decided at M0.
- **None of the C# here has compiled.** Every file says so in its header.

## Setup

1. Open this folder as a project in Unity 6.3 LTS.
2. Let it import (`com.attest.agent` is wired in via `Packages/manifest.json` as a local `file:` reference — spec §7 placement rule 1 — so it should pull in alongside the rest).
3. Fix whatever the compiler finds across both this project and `com.attest.agent`. Expect something.
4. **Attest → Fixtures → Build Platformer Basic.** This generates `Assets/Input/PlayerControls.inputactions`, `Assets/Prefabs/{Player,Hazard,HUD}.prefab`, and `Assets/Scenes/Level1.unity`. Re-running it is safe — it deletes and rebuilds those assets.
5. Run the Edit Mode tests (`Assets/Tests/Editor`) — they're the "existing smoke tests" spec §17 says the fixture ships with, and they check the fixture built correctly (including asserting Dash does *not* exist yet — see below).
6. Press Play. WASD/left-stick should move the player; walking into the (red) hazard should reduce HP show in the top-left HUD text.

## What's deliberately missing

No dash. No dash art. No `Dash` input action. That's spec §17's concrete first demo: ask Attest to add a directional dash with a cooldown, invulnerability window, and a HUD indicator, with no hand-editing. `PlayerPrefabSmokeTests.PlayerPrefab_HasNoDashAction_Yet` asserts this — if a fixture has been reused after a task added Dash, rebuild a clean one before using it as a benchmark starting state again.

## Why top-down, not side-scrolling

The fixture uses `Rigidbody2D` with `gravityScale = 0` — a top-down controller, not a platformer with jump/ground-checks. Spec §4's two shipped MVP feature families are movement-with-cooldown (dash *or* double-jump) and repair; this fixture is built for the dash variant, and top-down movement avoids gravity/ground-collision complexity that isn't part of what's being exercised. A jump-focused fixture would legitimately want a side-scrolling setup instead.
