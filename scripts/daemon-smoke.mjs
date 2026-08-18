// Manual end-to-end check: boots a real daemon against a real (temp) git
// repo, connects a real WebSocket client, and does the hello/hello_ack
// handshake — the same protocol AttestConnection.cs speaks from the Unity
// side, which cannot be exercised here (no Unity install). Run with:
//   node scripts/daemon-smoke.mjs [projectPath]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startDaemon } from "../packages/daemon/dist/index.js";
import { WebSocket } from "ws";

const projectPath = process.argv[2] ?? mkdtempSync(path.join(tmpdir(), "attest-smoke-"));
if (!process.argv[2]) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectPath });
  execFileSync("git", ["-c", "user.email=a@a.com", "-c", "user.name=a", "commit", "--allow-empty", "-q", "-m", "init"], {
    cwd: projectPath,
  });
}

const { close, port } = await startDaemon({ projectPath });
console.log("daemon up on", port, "project:", projectPath);

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", unityVersion: "6.3.4f1", packageSchemaVersion: "0.1.0" }));
});
ws.on("message", async (raw) => {
  console.log("hello_ack:", raw.toString());
  ws.close();
  await close();
  if (!process.argv[2]) rmSync(projectPath, { recursive: true, force: true });
  process.exit(0);
});
