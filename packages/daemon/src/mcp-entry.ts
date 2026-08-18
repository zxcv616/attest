import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startDaemon } from "./index.ts";
import { createAttestMcpServer } from "./mcp-server.ts";

/**
 * The command an MCP client (Claude Code, Claude Desktop, ...) is
 * configured to spawn. It IS the daemon — starting it also opens the Unity
 * WebSocket RPC port and writes .attest/daemon-port, exactly like running
 * index.ts directly does. Two ways to reach Attest (the plain daemon for
 * scripts/manual testing, this for an MCP client) are the same process
 * underneath; see mcp-server.ts's header comment for why that's required,
 * not just convenient.
 *
 * stdout is the MCP wire protocol — nothing here or in anything it calls
 * may console.log to stdout. Startup diagnostics go to stderr
 * (console.error) instead, deliberately, not console.log.
 */

const projectPath = process.argv[2] ?? process.env.ATTEST_PROJECT_PATH;
if (!projectPath) {
  console.error("usage: node mcp-entry.ts <projectPath>  (or set ATTEST_PROJECT_PATH)");
  process.exit(1);
}

const { server } = await startDaemon({ projectPath });
const mcpServer = createAttestMcpServer(server);
const transport = new StdioServerTransport();
await mcpServer.connect(transport);

console.error(`[attest-mcp] connected via stdio, project: ${projectPath}`);
