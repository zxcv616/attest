// M1 end-to-end check: starts the daemon against a real project, waits for
// the real Unity Editor to connect (not a fake WebSocket client — see
// packages/daemon/test/rpc-server.test.ts for that), then calls the given
// method through it and prints the result. Works for any registered
// method, not just project.get_summary — see
// packages/unity-package/com.attest.agent/Editor/Inspection/*.cs for what's
// registered as of a given phase.
//
// Prerequisite: the project is already open in Unity with Attest connected
// (Attest → Status shows Connected) BEFORE you run this — this script
// starts its own daemon process, so close any other one first (only one
// process can bind and own the .attest/daemon-port file for a project).
//
// Run: node scripts/call-unity-smoke.mjs <projectPath> <method> [jsonParams]
// Examples:
//   node scripts/call-unity-smoke.mjs fixtures/platformer-basic project.get_summary
//   node scripts/call-unity-smoke.mjs fixtures/platformer-basic scene.get_hierarchy
//   node scripts/call-unity-smoke.mjs fixtures/platformer-basic gameobject.inspect '{"path":"Player"}'
//   node scripts/call-unity-smoke.mjs fixtures/platformer-basic code.find_symbol '{"query":"Health"}'
//   node scripts/call-unity-smoke.mjs fixtures/platformer-basic asset.find_references '{"assetPath":"Assets/Prefabs/Player.prefab"}'

import { startDaemon } from "../packages/daemon/dist/index.js";

const [projectPath, method, jsonParams] = process.argv.slice(2);
if (!projectPath || !method) {
  console.error("usage: node scripts/call-unity-smoke.mjs <projectPath> <method> [jsonParams]");
  process.exit(1);
}

let params;
if (jsonParams) {
  try {
    params = JSON.parse(jsonParams);
  } catch (e) {
    console.error(`jsonParams is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

const { server, port, close } = await startDaemon({ projectPath });
console.log(`daemon up on ${port}, project: ${projectPath}`);
console.log("waiting for Unity to connect (open the project / click Reconnect in Attest -> Status)...");

const POLL_MS = 1000;
const TIMEOUT_MS = 60_000;
const start = Date.now();

while (server.listSessionTokens().length === 0) {
  if (Date.now() - start > TIMEOUT_MS) {
    console.error(`no Unity session connected after ${TIMEOUT_MS}ms`);
    await close();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

const [sessionToken] = server.listSessionTokens();
console.log("Unity connected, session:", sessionToken);
console.log(`calling ${method}${params ? " " + JSON.stringify(params) : ""}...`);

try {
  const result = await server.callUnity(sessionToken, method, params);
  console.log("result:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("call failed:", err.message);
  process.exitCode = 1;
} finally {
  await close();
}
