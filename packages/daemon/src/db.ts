import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { validate } from "@attest/schemas";
import type { Checkpoint } from "./git-checkpoint.ts";

/**
 * Durable task state, spec §6: "The daemon's task state machine is durable
 * in SQLite and is the single source of truth. Unity holds no authoritative
 * task state." This is what a task resumes from after a daemon restart,
 * independent of anything Unity remembers.
 *
 * Uses node:sqlite (built into Node >=22.5, no native-module compile step —
 * see root package.json engines). It's still an experimental Node API; if
 * that stops being acceptable, swapping the storage engine only touches this
 * file, since callers only see the TaskStore interface below.
 */

export interface TaskRow {
  id: string;
  data: Record<string, unknown>; // validated against @attest/schemas "task" on write
}

export class TaskStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  saveTask(task: Record<string, unknown>): void {
    const { valid, errors } = validate("task", task);
    if (!valid) {
      throw new Error(`Refusing to persist invalid task: ${errors.join("; ")}`);
    }
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    );
    stmt.run(task.id as string, JSON.stringify(task), new Date().toISOString());
  }

  getTask(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare(`SELECT data FROM tasks WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  listTasks(): Record<string, unknown>[] {
    const rows = this.db.prepare(`SELECT data FROM tasks ORDER BY updated_at DESC`).all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  saveCheckpoint(checkpoint: Checkpoint): void {
    const stmt = this.db.prepare(
      `INSERT INTO checkpoints (id, task_id, data, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    );
    stmt.run(checkpoint.id, checkpoint.taskId, JSON.stringify(checkpoint), checkpoint.createdAt);
  }

  getCheckpoint(id: string): Checkpoint | undefined {
    const row = this.db.prepare(`SELECT data FROM checkpoints WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  listCheckpointsForTask(taskId: string): Checkpoint[] {
    const rows = this.db
      .prepare(`SELECT data FROM checkpoints WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  close(): void {
    this.db.close();
  }
}
