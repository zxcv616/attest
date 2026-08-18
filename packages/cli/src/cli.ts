#!/usr/bin/env node
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { TaskStore } from "@attest/daemon";

/**
 * Deliberately thin — solo rescope, spec §12 "Solo-specific decisions":
 * "MCP is the primary client; the CLI is minimal ... Ship `attest run`,
 * `attest status`, `attest rollback` and nothing more until after beta."
 *
 * `status` and the checkpoint listing in `rollback` are real: they read
 * the same daemon-port file and SQLite task store the daemon itself
 * writes (packages/daemon/src/index.ts, src/db.ts). `run` and the actual
 * restore step of `rollback` are honest stubs — the task-submission API
 * and mutation manifests don't exist until M1's tool surface does.
 */

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "status":
      await status(rest[0] ?? process.cwd());
      return;
    case "run":
      run();
      return;
    case "rollback":
      await rollback(rest[0], rest[1] ?? process.cwd());
      return;
    default:
      printHelp();
      process.exitCode = command ? 1 : 0;
  }
}

function printHelp(): void {
  console.log(`attest — status | run <request> | rollback <taskId> [projectPath]

  status [projectPath]    Daemon reachability + recent tasks for a project. Defaults to cwd.
  run <request>            Not implemented yet — the task-submission API lands in M1.
  rollback <taskId>        List recorded checkpoints for a task (read-only for now).

Solo rescope (spec §12): stays intentionally thin. An MCP-connected coding
agent is the primary client once the M1 tool surface exists.`);
}

async function status(projectPath: string): Promise<void> {
  const dataDir = path.join(projectPath, ".attest");
  const portFile = path.join(dataDir, "daemon-port");

  if (!existsSync(portFile)) {
    console.log(`daemon:  not running (no ${portFile})`);
  } else {
    const port = Number(readFileSync(portFile, "utf8").trim());
    const reachable = await pingDaemon(port);
    console.log(reachable ? `daemon:  running on 127.0.0.1:${port}` : `daemon:  port file present (${port}) but unreachable — stale?`);
  }

  const dbPath = path.join(dataDir, "tasks.sqlite");
  if (!existsSync(dbPath)) {
    console.log("tasks:   none recorded yet");
    return;
  }
  const store = new TaskStore(dbPath);
  const tasks = store.listTasks();
  store.close();

  if (tasks.length === 0) {
    console.log("tasks:   none recorded yet");
    return;
  }
  console.log(`tasks:   ${tasks.length}`);
  for (const t of tasks.slice(0, 10)) {
    console.log(`  ${t.id}  ${t.status}  ${String(t.request).slice(0, 60)}`);
  }
}

function pingDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isFinite(port)) {
      resolve(false);
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(false);
    }, 1500);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function run(): void {
  console.log("`attest run` is not implemented yet.");
  console.log(
    "The task-submission API (feature.implement_and_verify) is M1 work — it doesn't exist until\n" +
      "scene.apply_transaction and the rest of the tool surface do. See docs/Attest_MVP_Spec_v0.2.md §9, §12.",
  );
  process.exitCode = 1;
}

async function rollback(taskId: string | undefined, projectPath: string): Promise<void> {
  if (!taskId) {
    console.error("usage: attest rollback <taskId> [projectPath]");
    process.exitCode = 1;
    return;
  }
  const dbPath = path.join(projectPath, ".attest", "tasks.sqlite");
  if (!existsSync(dbPath)) {
    console.error(`no task database at ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  const store = new TaskStore(dbPath);
  const checkpoints = store.listCheckpointsForTask(taskId);
  store.close();

  if (checkpoints.length === 0) {
    console.log(`no checkpoints recorded for task ${taskId}`);
    return;
  }

  console.log(`${checkpoints.length} checkpoint(s) for task ${taskId}:`);
  for (const c of checkpoints) {
    console.log(`  ${c.id}  ${c.kind}  ${c.gitRef.slice(0, 12)}  ${c.dirtyWorktreeHandling}  verification=${c.verification.status}`);
  }
  console.log();
  console.log(
    "Actually restoring isn't wired to the CLI yet: rollback needs a real mutation manifest\n" +
      "(spec Appendix A), which only exists once M1's transactions do. The restore mechanics\n" +
      "themselves are real and tested — see packages/daemon/src/git-checkpoint.ts and\n" +
      "packages/daemon/test/git-checkpoint.test.ts — this command just can't call them safely yet.",
  );
  process.exitCode = 1;
}

export { status, run, rollback, pingDaemon };

// Run directly (`attest ...` / `npm run dev`) rather than on every import —
// importing this module for tests must not have side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
