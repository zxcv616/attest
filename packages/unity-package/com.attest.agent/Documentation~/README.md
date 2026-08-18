# com.attest.agent

Unity-side half of the Attest daemon connection. See [docs/Attest_MVP_Spec_v0.2.md](../../../../docs/Attest_MVP_Spec_v0.2.md) §6–§7 for the design this implements.

## Status: unverified against a real Unity Editor

This package was written on a machine with no Unity install. Every `.cs` file here has a header saying so. Before relying on any of it:

1. Open `fixtures/platformer-basic` in Unity 6.3 LTS (see that project's own README first — the scene/prefabs need to be built once via an in-Editor script).
2. Add this package by path reference in `fixtures/platformer-basic/Packages/manifest.json` (already wired — see that file).
3. Fix whatever the compiler finds. Expect something; this has never compiled.
4. Run `npm run daemon` from the repo root against the fixture project's path, open **Attest → Status** in Unity, and confirm the handshake completes (`State: Connected`, a session token appears). The daemon side of this exact protocol is real, tested, and known-working — see `packages/daemon/test/rpc-server.test.ts` and `scripts/daemon-smoke.mjs`.

## What's here (M0)

- `Editor/Rpc/AttestConnection.cs` — the reconnecting client. `[InitializeOnLoad]` so it re-runs on every domain reload; discovers the daemon's port from `<project>/.attest/daemon-port`; does the `hello`/`hello_ack` handshake; sends heartbeats.
- `Editor/Rpc/AttestSessionState.cs` — session token + last idempotency key, persisted in `SessionState` (survives domain reload) and a workspace file (survives Editor restart), per spec §6.
- `Editor/Rpc/AttestRpcMessages.cs` — DTOs mirroring `packages/schemas/src/rpc.schema.json`. Kept in sync by hand for now (M1 TODO: codegen).
- `Editor/AttestWindow.cs` — **Attest → Status** menu item. Shows connection state; the fastest way to tell if the above actually works.
- `Runtime/AttestBridge.cs` — placeholder. Probes, event recording, the deterministic clock, and the input driver are M2 work (spec §12) and aren't built yet on purpose.

## What's NOT here yet

The actual tool surface (`scene.apply_transaction`, `editor.enter_play_mode`, inspection, ...) — M1. This package currently proves the connection survives reload/reconnect; it doesn't do anything to a project yet.
