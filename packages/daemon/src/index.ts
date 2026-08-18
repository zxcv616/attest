import path from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { RpcServer } from "./rpc-server.ts";
import { TaskStore } from "./db.ts";
import { GitCheckpointManager } from "./git-checkpoint.ts";
import { OperationWatchdog, type EditorProcessController } from "./watchdog.ts";
import { ensureLocallyExcluded } from "./git.ts";

export { RpcServer } from "./rpc-server.ts";
export { TaskStore } from "./db.ts";
export { GitCheckpointManager, type Checkpoint, type MutationManifest } from "./git-checkpoint.ts";
export { IdempotencyLedger, decideReconciliation } from "./idempotency.ts";
export { OperationWatchdog, type EditorProcessController, type WatchdogOptions } from "./watchdog.ts";
export { git, ensureLocallyExcluded } from "./git.ts";

/**
 * M0 wiring: RPC server + durable task store, bound to whatever project the
 * daemon is pointed at. There is no real EditorProcessController yet — no
 * Unity install exists in the environment that scaffolded this, so the
 * process-spawn implementation (Unity's `-batchmode -projectPath ...`,
 * spec Appendix C ref [4]) is intentionally not written here rather than
 * written untested. `noopEditorController` below is an explicit placeholder,
 * not a silent stub.
 */

const noopEditorController: EditorProcessController = {
  async kill() {
    console.warn("[attest-daemon] watchdog wants to kill the Editor, but no EditorProcessController is wired yet.");
  },
  async relaunch() {
    console.warn("[attest-daemon] watchdog wants to relaunch the Editor, but no EditorProcessController is wired yet.");
  },
};

export interface StartDaemonOptions {
  projectPath: string;
  dataDir?: string;
  port?: number;
  supportedUnityVersions?: string[];
  supportedPackageSchemaVersions?: string[];
}

export async function startDaemon(opts: StartDaemonOptions) {
  const dataDir = opts.dataDir ?? path.join(opts.projectPath, ".attest");

  // Must run before anything is written into dataDir — see
  // ensureLocallyExcluded's doc comment in git.ts for the corruption this
  // prevents. Skipped (with a warning) if projectPath isn't a git repo yet;
  // spec §4 requires one, but the daemon shouldn't hard-crash on startup
  // just because setup order was slightly off.
  if (existsSync(path.join(opts.projectPath, ".git"))) {
    await ensureLocallyExcluded(opts.projectPath, path.relative(opts.projectPath, dataDir) + "/");
  } else {
    console.warn(`[attest-daemon] ${opts.projectPath} is not a git repository yet — spec §4 requires one. Continuing, but checkpoints will fail until it is.`);
  }

  const taskStore = new TaskStore(path.join(dataDir, "tasks.sqlite"));
  const checkpoints = new GitCheckpointManager(opts.projectPath);

  const server = new RpcServer({
    port: opts.port ?? 0,
    supportedUnityVersions: opts.supportedUnityVersions ?? ["6000.5.5f1"],
    supportedPackageSchemaVersions: opts.supportedPackageSchemaVersions ?? ["0.1.0"],
  });

  const watchdog = new OperationWatchdog(noopEditorController, { timeoutMs: 30_000, maxRestarts: 2 }, (event) => {
    console.warn("[attest-daemon] watchdog event:", event);
  });
  server.onHeartbeat(() => watchdog.recordHeartbeat());

  const { port } = await server.listen();
  watchdog.start();

  // Port discovery for the Unity-side client (packages/unity-package/.../
  // AttestConnection.cs DiscoverDaemonPortAsync): the daemon publishes
  // where it's listening, since the Editor has no other way to find an
  // ephemeral port. Removed on close() so a stale file never points at a
  // dead daemon.
  mkdirSync(dataDir, { recursive: true });
  const portFile = path.join(dataDir, "daemon-port");
  writeFileSync(portFile, String(port), "utf8");

  // Callers should use THIS close(), not server.close() directly, so the
  // port file never outlives the daemon it points at (a stale file would
  // send AttestConnection's Unity-side client to a dead socket).
  async function close(): Promise<void> {
    rmSync(portFile, { force: true });
    watchdog.stop();
    await server.close();
  }

  return { server, taskStore, checkpoints, watchdog, port, close };
}

// Run directly (`npm run dev`) rather than only as a library.
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectPath = process.argv[2] ?? process.cwd();
  startDaemon({ projectPath }).then(({ port }) => {
    console.log(`[attest-daemon] listening on 127.0.0.1:${port}, project: ${projectPath}`);
  });
}
