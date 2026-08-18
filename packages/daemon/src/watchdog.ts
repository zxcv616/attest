/**
 * Editor lifecycle recovery, spec §6: "The Editor will hang on modal
 * dialogs, import loops, and native crashes — routinely, not exceptionally.
 * The daemon runs a watchdog per operation with a per-operation timeout; on
 * breach it can kill the Editor process, relaunch it against the same
 * project, wait for the import to settle, verify the checkpoint state, and
 * resume or abort the task."
 *
 * This module owns the timeout/restart-counting policy only. It is
 * deliberately decoupled from the actual Unity Editor process (spawn args,
 * `-batchmode`/`-projectPath` flags, log-file tailing — spec Appendix C ref
 * [4]) behind EditorProcessController, so the policy is unit-testable
 * without a real Editor and the process-control implementation can be
 * swapped in once there's a machine to test it against.
 */

export interface EditorProcessController {
  kill(): Promise<void>;
  relaunch(): Promise<void>;
}

export interface WatchdogOptions {
  /** No heartbeat within this window is treated as a hang. Spec default operation-class timeout is context-dependent; the task-level wall clock budget (spec §9.2) is a separate, longer ceiling. */
  timeoutMs: number;
  /** Spec §9.2 default: 2. A third breach aborts the task rather than restarting again. */
  maxRestarts: number;
  pollIntervalMs?: number;
}

export type WatchdogEvent =
  | { kind: "restarted"; attempt: number }
  | { kind: "aborted"; afterAttempts: number };

export class OperationWatchdog {
  private lastHeartbeatAt: number;
  private restartCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private readonly controller: EditorProcessController;
  private readonly opts: WatchdogOptions;
  private readonly onEvent: (event: WatchdogEvent) => void;
  private readonly now: () => number;

  constructor(
    controller: EditorProcessController,
    opts: WatchdogOptions,
    onEvent: (event: WatchdogEvent) => void = () => {},
    now: () => number = () => Date.now(),
  ) {
    this.controller = controller;
    this.opts = opts;
    this.onEvent = onEvent;
    this.now = now;
    this.lastHeartbeatAt = this.now();
  }

  recordHeartbeat(): void {
    this.lastHeartbeatAt = this.now();
  }

  get restartsUsed(): number {
    return this.restartCount;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.pollIntervalMs ?? Math.max(10, Math.floor(this.opts.timeoutMs / 4));
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, interval);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests so a single breach can be asserted deterministically instead of racing a real timer. */
  async checkOnce(): Promise<void> {
    if (this.stopped) return;
    const elapsed = this.now() - this.lastHeartbeatAt;
    if (elapsed <= this.opts.timeoutMs) return;

    if (this.restartCount >= this.opts.maxRestarts) {
      this.stop();
      this.onEvent({ kind: "aborted", afterAttempts: this.restartCount });
      return;
    }

    this.restartCount += 1;
    await this.controller.kill();
    await this.controller.relaunch();
    this.lastHeartbeatAt = this.now(); // provisional — the real reconnect's `hello` (reason: editor_restart) calls recordHeartbeat() again once the handshake lands.
    this.onEvent({ kind: "restarted", attempt: this.restartCount });
  }
}
