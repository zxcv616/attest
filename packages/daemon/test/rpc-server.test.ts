import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { RpcServer } from "../src/rpc-server.ts";
import { IdempotencyLedger } from "../src/idempotency.ts";

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

/** Connects and completes the hello/hello_ack handshake, returning the session token — the setup every callUnity() test needs before the server has anywhere to send a request. */
async function connectAndHello(port: number): Promise<{ ws: WebSocket; sessionToken: string }> {
  const ws = await connect(port);
  ws.send(JSON.stringify({ type: "hello", unityVersion: "6000.3.4f1", packageSchemaVersion: "0.1.0" }));
  const ack = (await nextMessage(ws)) as { sessionToken: string };
  return { ws, sessionToken: ack.sessionToken };
}

/** Stands in for AttestConnection.cs's (not-yet-built) request dispatcher: waits for the next `request` envelope and answers it, like a fake Unity client would. */
function actAsUnityFor(ws: WebSocket, respond: (req: { id: string; method: string; params?: unknown }) => unknown): void {
  ws.once("message", (raw) => {
    const req = JSON.parse(raw.toString()) as { type: string; id: string; method: string; params?: unknown };
    if (req.type !== "request") return;
    let result: unknown;
    let error: string | undefined;
    try {
      result = respond(req);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    ws.send(
      JSON.stringify(
        error
          ? { type: "response", requestId: req.id, ok: false, error: { code: "handler_error", message: error, retryable: false } }
          : { type: "response", requestId: req.id, ok: true, result },
      ),
    );
  });
}

test("rpc-server: refuses to bind outside loopback", async () => {
  const server = new RpcServer({
    host: "0.0.0.0",
    supportedUnityVersions: ["6000.3.4f1"],
    supportedPackageSchemaVersions: ["0.1.0"],
  });
  await assert.rejects(() => server.listen(), /loopback/);
});

test("rpc-server: fresh hello with a supported version gets a session token", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const ws = await connect(port);
  try {
    ws.send(JSON.stringify({ type: "hello", unityVersion: "6000.3.4f1", packageSchemaVersion: "0.1.0" }));
    const ack = (await nextMessage(ws)) as { type: string; compatible: boolean; sessionToken: string };
    assert.equal(ack.type, "hello_ack");
    assert.equal(ack.compatible, true);
    assert.ok(ack.sessionToken.length > 0);
  } finally {
    ws.close();
    await server.close();
  }
});

test("rpc-server: hello with an unpinned Unity patch is refused, not silently accepted (spec §4 pinned matrix)", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const ws = await connect(port);
  try {
    ws.send(JSON.stringify({ type: "hello", unityVersion: "6000.3.9f1", packageSchemaVersion: "0.1.0" }));
    const ack = (await nextMessage(ws)) as { compatible: boolean };
    assert.equal(ack.compatible, false);
  } finally {
    ws.close();
    await server.close();
  }
});

test("rpc-server: malformed envelope gets a structured error, not a crash", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const ws = await connect(port);
  try {
    ws.send(JSON.stringify({ type: "hello", unityVersion: "not-a-version" }));
    const res = (await nextMessage(ws)) as { ok: boolean; error: { code: string } };
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "invalid_envelope");
  } finally {
    ws.close();
    await server.close();
  }
});

test("rpc-server: reconnect after simulated domain reload reconciles a completed transaction as 'confirm'", async () => {
  const idempotency = new IdempotencyLedger();
  idempotency.begin("idem_1", { retrySafe: false });
  idempotency.complete("idem_1", { status: "success", modifiedAssets: ["Assets/player.cs"] });

  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"], idempotency });
  const { port } = await server.listen();

  // First connection gets a session token (as Unity would before the reload).
  const ws1 = await connect(port);
  ws1.send(JSON.stringify({ type: "hello", unityVersion: "6000.3.4f1", packageSchemaVersion: "0.1.0" }));
  const ack1 = (await nextMessage(ws1)) as { sessionToken: string };
  ws1.close();

  // Simulate the domain reload dropping the socket and Unity reconnecting
  // with the token it persisted in SessionState + the last idempotencyKey
  // it had in flight before the reload (spec §6).
  const ws2 = await connect(port);
  try {
    ws2.send(
      JSON.stringify({
        type: "hello",
        unityVersion: "6000.3.4f1",
        packageSchemaVersion: "0.1.0",
        sessionToken: ack1.sessionToken,
        lastIdempotencyKey: "idem_1",
        reason: "domain_reload",
      }),
    );
    const ack2 = (await nextMessage(ws2)) as {
      sessionToken: string;
      pendingReconciliation?: { idempotencyKey: string; action: string };
    };
    assert.equal(ack2.sessionToken, ack1.sessionToken, "reconnect should be able to resume the same session");
    assert.deepEqual(ack2.pendingReconciliation, { idempotencyKey: "idem_1", action: "confirm" });
  } finally {
    ws2.close();
    await server.close();
  }
});

test("rpc-server: reconnect with an idempotency key the daemon has no record of reconciles as 'rollback'", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const ws = await connect(port);
  try {
    ws.send(
      JSON.stringify({
        type: "hello",
        unityVersion: "6000.3.4f1",
        packageSchemaVersion: "0.1.0",
        lastIdempotencyKey: "some_untracked_key",
        reason: "editor_restart",
      }),
    );
    const ack = (await nextMessage(ws)) as { pendingReconciliation?: { action: string } };
    assert.equal(ack.pendingReconciliation?.action, "rollback");
  } finally {
    ws.close();
    await server.close();
  }
});

test("rpc-server: request to an unregistered method returns a structured unknown_method error", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const ws = await connect(port);
  try {
    ws.send(JSON.stringify({ type: "request", id: "req_1", method: "scene.apply_transaction" }));
    const res = (await nextMessage(ws)) as { ok: boolean; error: { code: string } };
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "unknown_method");
  } finally {
    ws.close();
    await server.close();
  }
});

test("rpc-server: a registered handler round-trips request -> response", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  server.registerHandler("project.get_summary", async () => ({ scenes: ["Level1"] }));
  const { port } = await server.listen();
  const ws = await connect(port);
  try {
    ws.send(JSON.stringify({ type: "request", id: "req_1", method: "project.get_summary" }));
    const res = (await nextMessage(ws)) as { ok: boolean; requestId: string; result: { scenes: string[] } };
    assert.equal(res.ok, true);
    assert.equal(res.requestId, "req_1");
    assert.deepEqual(res.result, { scenes: ["Level1"] });
  } finally {
    ws.close();
    await server.close();
  }
});

test("callUnity: round-trips a request to a connected Unity session and resolves with its result", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const { ws, sessionToken } = await connectAndHello(port);
  try {
    actAsUnityFor(ws, (req) => {
      assert.equal(req.method, "project.get_summary");
      return { scenes: ["Level1"], unityVersion: "6000.5.5f1" };
    });

    const result = await server.callUnity(sessionToken, "project.get_summary");
    assert.deepEqual(result, { scenes: ["Level1"], unityVersion: "6000.5.5f1" });
  } finally {
    ws.close();
    await server.close();
  }
});

test("callUnity: rejects when Unity responds ok:false", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const { ws, sessionToken } = await connectAndHello(port);
  try {
    actAsUnityFor(ws, () => {
      throw new Error("GameObject not found: Player");
    });

    await assert.rejects(() => server.callUnity(sessionToken, "gameobject.inspect", { path: "Player" }), /GameObject not found: Player/);
  } finally {
    ws.close();
    await server.close();
  }
});

test("callUnity: rejects immediately for an unknown/disconnected session, no hang", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  await server.listen();
  await assert.rejects(() => server.callUnity("nonexistent_token", "project.get_summary"), /No active session/);
  await server.close();
});

test("callUnity: times out if Unity never responds, and marks the idempotency key failed", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const { ws, sessionToken } = await connectAndHello(port);
  try {
    // Deliberately no actAsUnityFor() — Unity never answers.
    await assert.rejects(
      () => server.callUnity(sessionToken, "scene.apply_transaction", {}, { idempotencyKey: "idem_timeout", timeoutMs: 50 }),
      /Timed out/,
    );
    assert.equal(server.idempotency.lookup("idem_timeout")?.status, "failed");
  } finally {
    ws.close();
    await server.close();
  }
});

test("callUnity: a successful mutating call completes the idempotency ledger entry with the result", async () => {
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const { ws, sessionToken } = await connectAndHello(port);
  try {
    actAsUnityFor(ws, () => ({ status: "success", modifiedAssets: ["Assets/Player.prefab"] }));

    await server.callUnity(sessionToken, "scene.apply_transaction", {}, { idempotencyKey: "idem_1", retrySafe: false });

    const record = server.idempotency.lookup("idem_1");
    assert.equal(record?.status, "completed");
    assert.deepEqual(record?.result, { status: "success", modifiedAssets: ["Assets/Player.prefab"] });
  } finally {
    ws.close();
    await server.close();
  }
});

test("callUnity: a reconnect after a domain reload mid-call can find the ledger entry marked failed (spec §6 reconciliation)", async () => {
  // Simulates the exact scenario the reconnect handshake exists for: a
  // mutating call is in flight, the connection drops before a response
  // arrives (here: simulated by closing the socket instead of answering),
  // and the NEXT hello's lastIdempotencyKey should resolve to "rollback" —
  // proving Phase 1's callUnity() and the M0 reconnect machinery actually
  // agree on what happened, not just that each works in isolation.
  const server = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await server.listen();
  const { ws, sessionToken } = await connectAndHello(port);

  const inFlight = server.callUnity(sessionToken, "scene.apply_transaction", {}, { idempotencyKey: "idem_reload", timeoutMs: 200 });
  ws.close(); // simulate the domain reload dropping the socket mid-call

  await assert.rejects(() => inFlight);
  assert.equal(server.idempotency.lookup("idem_reload")?.status, "failed");

  const ws2 = await connect(port);
  try {
    ws2.send(
      JSON.stringify({
        type: "hello",
        unityVersion: "6000.3.4f1",
        packageSchemaVersion: "0.1.0",
        lastIdempotencyKey: "idem_reload",
        reason: "domain_reload",
      }),
    );
    const ack = (await nextMessage(ws2)) as { pendingReconciliation?: { action: string } };
    assert.equal(ack.pendingReconciliation?.action, "rollback");
  } finally {
    ws2.close();
    await server.close();
  }
});
