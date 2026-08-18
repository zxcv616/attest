import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore, startDaemon } from "@attest/daemon";
import { status, rollback } from "../src/cli.ts";

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

test("status: reports no daemon and no tasks for an empty project dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attest-cli-test-"));
  const cap = capture();
  try {
    await status(dir);
    assert.ok(cap.lines.some((l) => l.includes("not running")));
    assert.ok(cap.lines.some((l) => l.includes("none recorded")));
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("status: lists a real task from a real TaskStore", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "attest-cli-test-"));
  const dataDir = path.join(dir, ".attest");
  const store = new TaskStore(path.join(dataDir, "tasks.sqlite"));
  store.saveTask({
    id: "task_1",
    request: "Add a dash",
    status: "pending",
    budgets: {},
    createdAt: new Date().toISOString(),
  });
  store.close();

  const cap = capture();
  try {
    await status(dir);
    assert.ok(cap.lines.some((l) => l.includes("tasks:   1")));
    assert.ok(cap.lines.some((l) => l.includes("task_1") && l.includes("Add a dash")));
  } finally {
    cap.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rollback: requires a taskId", async () => {
  process.exitCode = 0;
  await rollback(undefined, "/tmp");
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});

test("rollback: lists real checkpoints recorded for a task, via the real startDaemon() production path", async () => {
  // Goes through startDaemon() rather than constructing TaskStore/
  // GitCheckpointManager directly, so this exercises the daemon's
  // ensureLocallyExcluded fix (packages/daemon/src/index.ts) for real — an
  // earlier version of this test skipped that and reproduced the exact
  // ".attest/ gets swept into a checkpoint commit and deleted" bug the
  // daemon's own test suite covers explicitly in git-checkpoint.test.ts.
  const dir = await mkdtemp(path.join(tmpdir(), "attest-cli-test-"));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.email=a@a.com", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });

  const { close, taskStore, checkpoints } = await startDaemon({ projectPath: dir });
  const checkpoint = await checkpoints.createPreTaskCheckpoint("chk_1", "task_1");
  taskStore.saveCheckpoint(checkpoint);
  await close();

  const cap = capture();
  process.exitCode = 0;
  try {
    await rollback("task_1", dir);
    assert.ok(cap.lines.some((l) => l.includes("chk_1") && l.includes("pre_task")));
    assert.equal(process.exitCode, 1, "not-yet-wired restore should still exit non-zero");
  } finally {
    cap.restore();
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
});
