import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { RpcServer } from "../src/rpc-server.ts";
import { createAttestMcpServer } from "../src/mcp-server.ts";

/**
 * Real MCP protocol round trip via the SDK's own InMemoryTransport — not a
 * fake stand-in for MCP, the actual Client/Server pair the SDK ships for
 * exactly this kind of test. What IS faked, same as rpc-server.test.ts, is
 * the Unity side: a real WebSocket client standing in for AttestConnection.cs,
 * since no Unity install exists to test against for real (see repo README).
 * So this proves: real MCP client -> real MCP server -> real RpcServer ->
 * (fake) Unity -> back. Everything except the last hop is the real thing.
 */

async function connectedClientAndServer(rpcServer: RpcServer): Promise<{ client: Client; mcpServer: ReturnType<typeof createAttestMcpServer> }> {
  const mcpServer = createAttestMcpServer(rpcServer);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return { client, mcpServer };
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

async function connectFakeUnity(port: number): Promise<WebSocket> {
  const ws = await connectWs(port);
  ws.send(JSON.stringify({ type: "hello", unityVersion: "6000.3.4f1", packageSchemaVersion: "0.1.0" }));
  await nextMessage(ws); // hello_ack
  return ws;
}

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

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content[0]?.text;
  assert.ok(text, "expected a text content block");
  return JSON.parse(text!);
}

test("mcp: lists all registered tools", async () => {
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { client } = await connectedClientAndServer(rpcServer);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "attest_apply_prefab_transaction",
    "attest_find_asset_references",
    "attest_find_symbol",
    "attest_inspect_gameobject",
    "attest_project_summary",
    "attest_scene_hierarchy",
    "attest_status",
    "attest_wait_for_compilation",
  ]);
});

test("mcp: attest_status reports disconnected when no Unity session exists", async () => {
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { client } = await connectedClientAndServer(rpcServer);
  const result = await client.callTool({ name: "attest_status", arguments: {} });
  assert.deepEqual(textOf(result as never), { connected: false, sessionTokens: [] });
});

test("mcp: a tool call with no Unity connected returns isError, not a thrown exception", async () => {
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { client } = await connectedClientAndServer(rpcServer);
  const result = (await client.callTool({ name: "attest_project_summary", arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text!, /not connected/);
});

test("mcp: attest_project_summary round-trips through a real MCP client -> MCP server -> RpcServer -> fake Unity", async () => {
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await rpcServer.listen();
  const unity = await connectFakeUnity(port);
  try {
    actAsUnityFor(unity, (req) => {
      assert.equal(req.method, "project.get_summary");
      return { unityVersion: "6000.5.5f1", activeScene: "Assets/Scenes/Level1.unity" };
    });

    const { client } = await connectedClientAndServer(rpcServer);
    const result = await client.callTool({ name: "attest_project_summary", arguments: {} });
    assert.deepEqual(textOf(result as never), { unityVersion: "6000.5.5f1", activeScene: "Assets/Scenes/Level1.unity" });
  } finally {
    unity.close();
    await rpcServer.close();
  }
});

test("mcp: attest_inspect_gameobject passes its input schema's arguments through to Unity", async () => {
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await rpcServer.listen();
  const unity = await connectFakeUnity(port);
  try {
    actAsUnityFor(unity, (req) => {
      assert.equal(req.method, "gameobject.inspect");
      assert.deepEqual(req.params, { path: "Player" });
      return { name: "Player", components: [] };
    });

    const { client } = await connectedClientAndServer(rpcServer);
    const result = await client.callTool({ name: "attest_inspect_gameobject", arguments: { path: "Player" } });
    assert.deepEqual(textOf(result as never), { name: "Player", components: [] });
  } finally {
    unity.close();
    await rpcServer.close();
  }
});

test("mcp: attest_apply_prefab_transaction rejects a malformed call before it ever reaches Unity (zod validation)", async () => {
  // The SDK reports schema-validation failure as a normal CallToolResult
  // with isError:true, not a rejected promise/thrown exception — confirmed
  // by actually calling it and reading the result, not assumed. An earlier
  // version of this test asserted assert.rejects() and failed, not because
  // validation didn't work (it does — both violations below are caught and
  // named) but because that assertion was checking for the wrong error
  // channel.
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { client } = await connectedClientAndServer(rpcServer);
  const result = (await client.callTool({
    name: "attest_apply_prefab_transaction",
    arguments: { targetAssets: ["Assets/Prefabs/A.prefab", "Assets/Prefabs/B.prefab"], operations: [], expectedMutationSet: [] },
  })) as { isError?: boolean; content: Array<{ text?: string }> };

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text!, /exactly 1 element/); // the targetAssets length(1) violation
  assert.match(result.content[0]!.text!, /at least 1 element/); // the operations min(1) violation
});

test("mcp: attest_apply_prefab_transaction round-trips a real transaction shape through to Unity", async () => {
  const rpcServer = new RpcServer({ supportedUnityVersions: ["6000.3.4f1"], supportedPackageSchemaVersions: ["0.1.0"] });
  const { port } = await rpcServer.listen();
  const unity = await connectFakeUnity(port);
  try {
    actAsUnityFor(unity, (req) => {
      assert.equal(req.method, "prefab.apply_transaction");
      const params = req.params as { targetAssets: string[]; operations: Array<{ kind: string }> };
      assert.deepEqual(params.targetAssets, ["Assets/Prefabs/Hazard.prefab"]);
      assert.equal(params.operations[0]!.kind, "add_component");
      return { status: "success", modifiedAssets: ["Assets/Prefabs/Hazard.prefab"], actualMutationSet: ["Assets/Prefabs/Hazard.prefab"], compilationRequired: false, diagnostics: [] };
    });

    const { client } = await connectedClientAndServer(rpcServer);
    const result = await client.callTool({
      name: "attest_apply_prefab_transaction",
      arguments: {
        targetAssets: ["Assets/Prefabs/Hazard.prefab"],
        operations: [{ kind: "add_component", target: "AttestFixture.Health.Health" }],
        expectedMutationSet: ["Assets/Prefabs/Hazard.prefab"],
      },
    });
    const parsed = textOf(result as never) as { status: string };
    assert.equal(parsed.status, "success");
  } finally {
    unity.close();
    await rpcServer.close();
  }
});
