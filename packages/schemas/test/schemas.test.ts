import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_NAMES,
  createValidator,
  validate,
  listSchemaFilesOnDisk,
} from "../src/index.ts";

test("every .schema.json on disk is registered in SCHEMA_NAMES", () => {
  const onDisk = new Set(listSchemaFilesOnDisk());
  const registered = new Set(SCHEMA_NAMES.map((n) => `${n}.schema.json`));
  assert.deepEqual(onDisk, registered);
});

test("all schemas compile under a single Ajv instance ($refs resolve)", () => {
  const ajv = createValidator();
  for (const name of SCHEMA_NAMES) {
    const fn = ajv.getSchema(`${name}.schema.json`);
    assert.ok(fn, `expected ${name}.schema.json to compile and register`);
  }
});

test("task: minimal valid task passes", () => {
  const { valid, errors } = validate("task", {
    id: "01J8Z1Q1V1V1V1V1V1V1V1V1V1",
    request: "Add a dash with a 0.7s cooldown",
    status: "pending",
    budgets: {},
    createdAt: "2026-07-27T18:00:00.000Z",
  });
  assert.equal(valid, true, errors.join("; "));
});

test("task: missing required field fails", () => {
  const { valid, errors } = validate("task", {
    request: "no id, no status",
  });
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test("criteriaSet: AC-DASH example from spec §5 passes, and enforces tolerance on behavioral criteria", () => {
  const goodBehavioral = {
    taskId: "task_1",
    status: "frozen",
    contentHash: "sha256:" + "a".repeat(64),
    criteria: [
      {
        id: "AC-DASH-01",
        type: "behavioral",
        observable: "player displacement following Dash input",
        expected: { minUnits: 4.5, maxUnits: 6.0, withinSeconds: 0.3 },
        tolerance: { kind: "absolute", value: 0.1 },
        mandatory: true,
        evidenceMethod: "position trace + replay event log",
        confidence: "deterministic",
        result: { status: "pending", runs: [] },
      },
    ],
  };
  const good = validate("criteriaSet", goodBehavioral);
  assert.equal(good.valid, true, good.errors.join("; "));

  const missingTolerance = structuredClone(goodBehavioral);
  // @ts-expect-error intentionally malformed for the negative assertion
  delete missingTolerance.criteria[0].tolerance;
  const bad = validate("criteriaSet", missingTolerance);
  assert.equal(bad.valid, false, "behavioral criteria must require tolerance");
});

test("criterion result: unstable is a valid distinct status from pass/fail", () => {
  const { valid } = validate("criteriaSet", {
    taskId: "task_1",
    status: "draft",
    criteria: [
      {
        id: "AC-DASH-02",
        type: "behavioral",
        observable: "health unchanged during invulnerability window",
        expected: { healthDelta: 0 },
        tolerance: { kind: "absolute", value: 0 },
        mandatory: true,
        evidenceMethod: "health probe",
        confidence: "deterministic",
        result: {
          status: "unstable",
          runs: [
            { runIndex: 0, seed: 42, outcome: "pass" },
            { runIndex: 1, seed: 42, outcome: "fail" },
          ],
        },
      },
    ],
  });
  assert.equal(valid, true);
});

test("transaction: rejects a target asset path outside Assets/ or Packages/", () => {
  const { valid, errors } = validate("transaction", {
    id: "txn_1",
    idempotencyKey: "idem_1",
    taskId: "task_1",
    projectRevision: "abc123",
    unityVersion: "6000.3.4f1",
    packageSchemaVersion: "0.1.0",
    targetAssets: ["../outside/project/evil.cs"],
    operations: [{ kind: "patch_file", target: "../outside/project/evil.cs" }],
    sensitivity: "reversible_in_task",
  });
  assert.equal(valid, false, "assetPath pattern should reject non Assets/Packages paths");
  assert.ok(errors.some((e) => e.includes("targetAssets")));
});

test("replay: rejects negative/zero fixedDeltaTime (determinism stack must be well-formed)", () => {
  const { valid } = validate("replay", {
    id: "replay_1",
    taskId: "task_1",
    seed: 42,
    timebase: { captureDeltaTime: 0.0167, fixedDeltaTime: 0 },
    steps: [{ atFrame: 0, kind: "input_action", action: "Dash" }],
    generatedTestPath: "Assets/AttestGenerated/Tests/AC_DASH_Replay.cs",
  });
  assert.equal(valid, false);
});

test("checkpoint: pre_task checkpoint round-trips with verification block", () => {
  const { valid, errors } = validate("checkpoint", {
    id: "chk_1",
    taskId: "task_1",
    kind: "pre_task",
    gitRef: "0123456789abcdef0123456789abcdef01234567",
    preTaskBranch: "main",
    dirtyWorktreeHandling: "none_was_clean",
    createdAt: "2026-07-27T18:00:00.000Z",
    verification: { status: "verified", gitStatusClean: true, reimportedWithoutErrors: true, guidSetMatches: true },
  });
  assert.equal(valid, true, errors.join("; "));
});

test("rpc: hello_ack with a pending reconciliation validates", () => {
  const { valid, errors } = validate("rpc", {
    type: "hello_ack",
    sessionToken: "sess_abc",
    compatible: true,
    pendingReconciliation: { idempotencyKey: "idem_1", action: "confirm" },
  });
  assert.equal(valid, true, errors.join("; "));
});

test("rpc: a message matching none of the five envelope types is rejected", () => {
  const { valid } = validate("rpc", { type: "not_a_real_message", foo: "bar" });
  assert.equal(valid, false);
});

test("rpc: hello on reconnect after domain reload carries reason and idempotency key", () => {
  const { valid, errors } = validate("rpc", {
    type: "hello",
    unityVersion: "6000.3.4f1",
    packageSchemaVersion: "0.1.0",
    sessionToken: "sess_abc",
    lastIdempotencyKey: "idem_1",
    reason: "domain_reload",
  });
  assert.equal(valid, true, errors.join("; "));
});
