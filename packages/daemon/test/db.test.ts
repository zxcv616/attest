import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../src/db.ts";

function validTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    request: "Add a dash with a 0.7s cooldown",
    status: "pending",
    budgets: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("TaskStore: save then get round-trips", () => {
  const store = new TaskStore(":memory:");
  store.saveTask(validTask("task_1"));
  const loaded = store.getTask("task_1");
  assert.equal(loaded?.request, "Add a dash with a 0.7s cooldown");
  store.close();
});

test("TaskStore: refuses to persist a task that fails schema validation", () => {
  const store = new TaskStore(":memory:");
  assert.throws(() => store.saveTask({ id: "bad" } as never), /Refusing to persist invalid task/);
  store.close();
});

test("TaskStore: save is an upsert — second save with the same id replaces, not duplicates", () => {
  const store = new TaskStore(":memory:");
  store.saveTask(validTask("task_1", { status: "pending" }));
  store.saveTask(validTask("task_1", { status: "success" }));
  assert.equal(store.getTask("task_1")?.status, "success");
  assert.equal(store.listTasks().length, 1);
  store.close();
});

test("TaskStore: checkpoints are queryable per task", () => {
  const store = new TaskStore(":memory:");
  const checkpoint = {
    id: "chk_1",
    taskId: "task_1",
    kind: "pre_task" as const,
    gitRef: "abc123",
    preTaskBranch: "main",
    dirtyWorktreeHandling: "none_was_clean" as const,
    createdAt: new Date().toISOString(),
    verification: {
      status: "not_yet_verified" as const,
      gitStatusClean: null,
      reimportedWithoutErrors: null,
      guidSetMatches: null,
      verifiedAt: null,
    },
  };
  store.saveCheckpoint(checkpoint);
  assert.deepEqual(store.getCheckpoint("chk_1"), checkpoint);
  assert.equal(store.listCheckpointsForTask("task_1").length, 1);
  assert.equal(store.listCheckpointsForTask("task_nonexistent").length, 0);
  store.close();
});

test("TaskStore: durable across close/reopen against the same file (not just :memory:)", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "attest-taskstore-"));
  const dbPath = path.join(dir, "sub", "tasks.sqlite");
  try {
    const store1 = new TaskStore(dbPath);
    store1.saveTask(validTask("task_1"));
    store1.close();

    const store2 = new TaskStore(dbPath);
    assert.equal(store2.getTask("task_1")?.id, "task_1");
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
