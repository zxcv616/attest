import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RpcServer } from "./rpc-server.ts";

/**
 * M1 Phase 5. Runs IN-PROCESS with the daemon's RpcServer, not spawned as a
 * separate process — callUnity() only works from the same process holding
 * the live Unity WebSocket session (in-memory state; there is no
 * cross-process control channel, and building one isn't in scope here). An
 * MCP client is configured to spawn the DAEMON itself as its MCP server
 * (see mcp-entry.ts) — "the MCP server" and "the daemon" are the same
 * process, not two things that talk to each other.
 *
 * Exposes the M1 Phase 2-4 tool surface. Each tool is a thin wrapper around
 * RpcServer.callUnity() — no new logic lives here, just translation between
 * MCP's calling convention and the same protocol packages/daemon/test/
 * rpc-server.test.ts already exercises against a fake Unity client.
 */
export function createAttestMcpServer(rpcServer: RpcServer): McpServer {
  const server = new McpServer({ name: "attest", version: "0.1.0" });

  function getSessionOrThrow(): string {
    const [token] = rpcServer.listSessionTokens();
    if (!token) {
      throw new Error(
        "Unity is not connected to the Attest daemon. Open the project in Unity and confirm Attest -> Status shows Connected.",
      );
    }
    return token;
  }

  function textResult(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  }

  function errorResult(err: unknown) {
    return {
      content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }

  server.registerTool(
    "attest_status",
    { description: "Check whether Unity is connected to the Attest daemon." },
    async () => textResult({ connected: rpcServer.listSessionTokens().length > 0, sessionTokens: rpcServer.listSessionTokens() }),
  );

  server.registerTool(
    "attest_project_summary",
    { description: "Summary of the currently open Unity project: version, active scene, render pipeline, compile/play state." },
    async () => {
      try {
        return textResult(await rpcServer.callUnity(getSessionOrThrow(), "project.get_summary"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "attest_scene_hierarchy",
    { description: "Full GameObject hierarchy of the currently open scene, with each object's components." },
    async () => {
      try {
        return textResult(await rpcServer.callUnity(getSessionOrThrow(), "scene.get_hierarchy"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "attest_inspect_gameobject",
    {
      description: "Inspect a GameObject's components and serialized property values by hierarchy path, e.g. 'Player' or 'HUD/HealthText'.",
      inputSchema: { path: z.string().describe("Hierarchy path — GameObject.Find's '/'-separated syntax") },
    },
    async ({ path }) => {
      try {
        return textResult(await rpcServer.callUnity(getSessionOrThrow(), "gameobject.inspect", { path }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "attest_find_symbol",
    {
      description: "Find MonoBehaviour/ScriptableObject types by name substring. TypeCache-based, not a full symbol index (spec §4).",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      try {
        return textResult(await rpcServer.callUnity(getSessionOrThrow(), "code.find_symbol", { query }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "attest_find_asset_references",
    {
      description: "Find scenes/prefabs that reference a given asset path. Forward-dependency scan scoped to scenes and prefabs, not the whole project.",
      inputSchema: { assetPath: z.string() },
    },
    async ({ assetPath }) => {
      try {
        return textResult(await rpcServer.callUnity(getSessionOrThrow(), "asset.find_references", { assetPath }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "attest_wait_for_compilation",
    {
      description:
        "Unity's current compile state and the most recent compile's diagnostics. A snapshot, not a blocking wait " +
        "(compilation itself triggers a domain reload, which would kill any long-lived wait) — call this repeatedly " +
        "if you need to wait out a compile.",
    },
    async () => {
      try {
        return textResult(await rpcServer.callUnity(getSessionOrThrow(), "editor.wait_for_compilation"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const operationShape = {
    kind: z.enum(["add_component", "set_property", "assign_reference"]),
    target: z
      .string()
      .describe("'ComponentTypeFullName' for add_component, or 'ComponentTypeFullName.propertyName' for set_property/assign_reference"),
    value: z.unknown().optional().describe("Required for set_property (the new value) and assign_reference (an asset path string)"),
    reason: z.string().optional().describe("One-line justification, surfaced to a human reviewing this change (spec US-05)"),
  };
  const preconditionShape = {
    kind: z.enum(["not_in_play_mode", "no_compile_errors", "asset_exists", "component_present", "property_equals"]),
    target: z.string().optional(),
    expected: z.unknown().optional(),
  };

  server.registerTool(
    "attest_apply_prefab_transaction",
    {
      description:
        "Apply a bounded transaction to a prefab asset: add_component, set_property, and/or assign_reference only " +
        "(not the full transaction schema — see PrefabTransaction.cs). Runs against an in-memory copy of the prefab; " +
        "nothing is written to disk unless expectedMutationSet matches what actually gets touched, which in this " +
        "scope is always exactly the one target prefab.",
      inputSchema: {
        targetAssets: z.array(z.string()).length(1).describe("Exactly one prefab asset path — this phase doesn't support multi-target transactions"),
        preconditions: z.array(z.object(preconditionShape)).optional(),
        operations: z.array(z.object(operationShape)).min(1),
        expectedMutationSet: z.array(z.string()).describe("Must equal targetAssets in this phase — included explicitly so a caller states its prediction rather than the tool assuming it"),
      },
    },
    async (params) => {
      try {
        const idempotencyKey = `mcp_${Date.now()}_${randomBytes(4).toString("hex")}`;
        return textResult(
          await rpcServer.callUnity(getSessionOrThrow(), "prefab.apply_transaction", params, { idempotencyKey, retrySafe: false }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
