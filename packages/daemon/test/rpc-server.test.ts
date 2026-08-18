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
