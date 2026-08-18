/**
 * Reconciliation for the hello/hello_ack handshake, spec §6 and
 * rpc.schema.json `helloAck.pendingReconciliation`.
 *
 * Every compile triggers a Unity domain reload, which drops the RPC
 * connection mid-operation as a matter of routine, not exception (spec §6).
 * When Unity reconnects it reports the idempotencyKey of whatever it had
 * last in flight; the daemon — which is the durable source of truth, per
 * spec §6 — decides what happens to that operation. This module is that
 * decision, kept as a pure function over an explicit record so it can be
 * tested without a socket in the loop.
 */

export type IdempotencyStatus = "in_flight" | "completed" | "failed";

export interface IdempotencyRecord {
  key: string;
  status: IdempotencyStatus;
  /** True if re-running the operation from scratch is known-safe (e.g. a pure inspection call, or a transaction that hasn't written anything yet). */
  retrySafe: boolean;
  result?: unknown;
}

export type ReconciliationAction = "confirm" | "re_issue" | "rollback";

/**
 * - No record at all (daemon itself doesn't remember this key — e.g. the
 *   daemon process also restarted): rollback. We have no basis for trusting
 *   partial state, so the safe default is "restore the last checkpoint,"
 *   never "assume it's fine."
 * - completed: confirm — hand back the stored result, no rework needed.
 * - in_flight and retry-safe (nothing written yet, or the operation is
 *   naturally idempotent): re_issue.
 * - in_flight and NOT retry-safe: rollback. We don't know how far a
 *   half-applied mutation got, and guessing is exactly the failure mode
 *   the transaction model (spec §7) exists to prevent.
 * - failed: rollback, unconditionally.
 */
export function decideReconciliation(record: IdempotencyRecord | undefined): ReconciliationAction {
  if (!record) return "rollback";
  switch (record.status) {
    case "completed":
      return "confirm";
    case "in_flight":
      return record.retrySafe ? "re_issue" : "rollback";
    case "failed":
      return "rollback";
  }
}

export class IdempotencyLedger {
  private records = new Map<string, IdempotencyRecord>();

  begin(key: string, opts: { retrySafe: boolean }): void {
    if (this.records.has(key)) {
      throw new Error(`Idempotency key already in use: ${key}`);
    }
    this.records.set(key, { key, status: "in_flight", retrySafe: opts.retrySafe });
  }

  complete(key: string, result: unknown): void {
    const record = this.records.get(key);
    if (!record) throw new Error(`Unknown idempotency key: ${key}`);
    record.status = "completed";
    record.result = result;
  }

  fail(key: string): void {
    const record = this.records.get(key);
    if (!record) throw new Error(`Unknown idempotency key: ${key}`);
    record.status = "failed";
  }

  lookup(key: string): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  reconcile(key: string | null | undefined): ReconciliationAction | null {
    if (key === null || key === undefined) return null; // fresh connect, nothing to reconcile
    return decideReconciliation(this.lookup(key));
  }
}
