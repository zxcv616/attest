// Boots a real daemon, records a real task + checkpoint against a real temp
// git repo, so `attest status` and `attest rollback` have something real to
// read. Run with: node scripts/cli-smoke.mjs
import { execFileSync } from "node:child_process";
import { startDaemon } from "../packages/daemon/dist/index.js";

const projectPath = process.argv[2];
if (!projectPath) {
  console.error("usage: node scripts/cli-smoke.mjs <projectPath>");
  process.exit(1);
}

const { close, port, taskStore, checkpoints } = await startDaemon({ projectPath });
console.log("daemon up on", port);

taskStore.saveTask({
  id: "task_demo_1",
  request: "Add a dash with a 0.7s cooldown",
  status: "pending",
  budgets: {},
  createdAt: new Date().toISOString(),
});

const checkpoint = await checkpoints.createPreTaskCheckpoint("chk_demo_1", "task_demo_1");
taskStore.saveCheckpoint(checkpoint);
console.log("recorded task_demo_1 with checkpoint", checkpoint.id);

// Leave the daemon running for a few seconds so `attest status` from
// another shell invocation can observe it, then shut down.
setTimeout(async () => {
  await close();
  console.log("daemon stopped");
  execFileSync(process.execPath, [
    new URL("../packages/cli/dist/cli.js", import.meta.url).pathname,
    "status",
    projectPath,
  ], { stdio: "inherit" });
}, 3000);

console.log("(daemon will stay up for 3s — run `attest status` from another shell to check it live if you like)");
