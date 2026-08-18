import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationWatchdog, type EditorProcessController, type WatchdogEvent } from "../src/watchdog.ts";

function makeController() {
  const calls: string[] = [];
  const controller: EditorProcessController = {
    async kill() {
      calls.push("kill");
    },
    async relaunch() {
      calls.push("relaunch");
    },
  };
  return { controller, calls };
}

/** Deterministic clock so tests don't race real timers. */
function makeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("watchdog: no breach while heartbeats are within the timeout window", async () => {
  const { controller, calls } = makeController();
  const clock = makeClock();
  const events: WatchdogEvent[] = [];
  const wd = new OperationWatchdog(controller, { timeoutMs: 1000, maxRestarts: 2 }, (e) => events.push(e), clock.now);

  clock.advance(500);
  wd.recordHeartbeat();
  clock.advance(500);
  await wd.checkOnce();

  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

test("watchdog: breach triggers kill+relaunch and a 'restarted' event", async () => {
  const { controller, calls } = makeController();
  const clock = makeClock();
  const events: WatchdogEvent[] = [];
  const wd = new OperationWatchdog(controller, { timeoutMs: 1000, maxRestarts: 2 }, (e) => events.push(e), clock.now);

  clock.advance(1500); // no heartbeat since construction -> breach
  await wd.checkOnce();

  assert.deepEqual(calls, ["kill", "relaunch"]);
  assert.deepEqual(events, [{ kind: "restarted", attempt: 1 }]);
  assert.equal(wd.restartsUsed, 1);
});

test("watchdog: spec §9.2 default — a third breach aborts rather than restarting again", async () => {
  const { controller, calls } = makeController();
  const clock = makeClock();
  const events: WatchdogEvent[] = [];
  const wd = new OperationWatchdog(controller, { timeoutMs: 1000, maxRestarts: 2 }, (e) => events.push(e), clock.now);

  // Breach #1
  clock.advance(1500);
  await wd.checkOnce();
  // Breach #2 (watchdog resets its heartbeat clock provisionally after a restart)
  clock.advance(1500);
  await wd.checkOnce();
  // Breach #3 — maxRestarts already used, must abort instead
  clock.advance(1500);
  await wd.checkOnce();

  assert.deepEqual(calls, ["kill", "relaunch", "kill", "relaunch"]); // only 2 restarts, not 3
  assert.deepEqual(events, [
    { kind: "restarted", attempt: 1 },
    { kind: "restarted", attempt: 2 },
    { kind: "aborted", afterAttempts: 2 },
  ]);
  assert.equal(wd.restartsUsed, 2);
});

test("watchdog: after abort, further checks are no-ops (stopped)", async () => {
  const { controller, calls } = makeController();
  const clock = makeClock();
  const events: WatchdogEvent[] = [];
  const wd = new OperationWatchdog(controller, { timeoutMs: 100, maxRestarts: 0 }, (e) => events.push(e), clock.now);

  clock.advance(200);
  await wd.checkOnce(); // immediately aborts, maxRestarts=0
  assert.deepEqual(events, [{ kind: "aborted", afterAttempts: 0 }]);

  const callsBefore = calls.length;
  clock.advance(10_000);
  await wd.checkOnce();
  assert.equal(calls.length, callsBefore, "stopped watchdog must not act again");
});
