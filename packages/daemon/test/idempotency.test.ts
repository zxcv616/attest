import { test } from "node:test";
import assert from "node:assert/strict";
import { IdempotencyLedger, decideReconciliation } from "../src/idempotency.ts";

test("decideReconciliation: no record -> rollback (daemon has no basis to trust partial state)", () => {
  assert.equal(decideReconciliation(undefined), "rollback");
});

test("decideReconciliation: completed -> confirm", () => {
  assert.equal(decideReconciliation({ key: "k", status: "completed", retrySafe: false, result: 42 }), "confirm");
});

test("decideReconciliation: in_flight + retrySafe -> re_issue", () => {
  assert.equal(decideReconciliation({ key: "k", status: "in_flight", retrySafe: true }), "re_issue");
});

test("decideReconciliation: in_flight + not retrySafe -> rollback", () => {
  assert.equal(decideReconciliation({ key: "k", status: "in_flight", retrySafe: false }), "rollback");
});

test("decideReconciliation: failed -> rollback", () => {
  assert.equal(decideReconciliation({ key: "k", status: "failed", retrySafe: true }), "rollback");
});

test("IdempotencyLedger: begin/complete/lookup round-trip", () => {
  const ledger = new IdempotencyLedger();
  ledger.begin("idem_1", { retrySafe: false });
  assert.equal(ledger.lookup("idem_1")?.status, "in_flight");
  ledger.complete("idem_1", { status: "success" });
  assert.equal(ledger.lookup("idem_1")?.status, "completed");
  assert.deepEqual(ledger.lookup("idem_1")?.result, { status: "success" });
});

test("IdempotencyLedger: duplicate begin() on the same key throws", () => {
  const ledger = new IdempotencyLedger();
  ledger.begin("idem_1", { retrySafe: false });
  assert.throws(() => ledger.begin("idem_1", { retrySafe: false }));
});

test("IdempotencyLedger: reconcile(null) means fresh connect, nothing to reconcile", () => {
  const ledger = new IdempotencyLedger();
  assert.equal(ledger.reconcile(null), null);
  assert.equal(ledger.reconcile(undefined), null);
});

test("IdempotencyLedger: reconcile() reflects the ledger's current state end-to-end", () => {
  const ledger = new IdempotencyLedger();
  ledger.begin("idem_1", { retrySafe: false });
  assert.equal(ledger.reconcile("idem_1"), "rollback"); // in-flight, not retry-safe
  ledger.complete("idem_1", "done");
  assert.equal(ledger.reconcile("idem_1"), "confirm");
});
