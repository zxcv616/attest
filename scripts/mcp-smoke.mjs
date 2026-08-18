// M1 Phase 5 end-to-end check: spawns the REAL mcp-entry.js as a child
// process over real stdio (exactly how Claude Code/Claude Desktop would
// invoke it — not the in-process InMemoryTransport packages/daemon/test/
// mcp-server.test.ts uses), connects a real MCP Client, lists tools, and
// calls attest_status. Doesn't need Unity connected — attest_status works
// either way — this proves the spawnable process + stdio wire protocol
// itself, which the in-process tests structurally can't.
//
// Run: node scripts/mcp-smoke.mjs <projectPath>

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectPath = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), "attest-mcp-smoke-"));
if (!process.argv[2]) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectPath });
  execFileSync("git", ["-c", "user.email=a@a.com", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: projectPath });
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", path.join(__dirname, "../packages/daemon/src/mcp-entry.ts"), projectPath],
  stderr: "inherit", // so [attest-mcp]/[attest-daemon] logs are visible, not swallowed
});

const client = new Client({ name: "attest-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

console.log("connected to spawned mcp-entry.ts process");

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

const status = await client.callTool({ name: "attest_status", arguments: {} });
console.log("attest_status:", status.content[0].text);

await client.close();
console.log("done");
