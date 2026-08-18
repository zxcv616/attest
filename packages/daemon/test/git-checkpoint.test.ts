import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { git, statusPorcelain, branchExists, currentBranchOrDetachedSha, ensureLocallyExcluded } from "../src/git.ts";
import { GitCheckpointManager } from "../src/git-checkpoint.ts";
import { makeGitFixture, readFixtureFile, writeFixtureFile } from "./helpers/git-fixture.ts";

test("git(): refuses reset --hard (spec §11 absolute rule)", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await assert.rejects(() => git(repoPath, ["reset", "--hard", "HEAD"]), /Refusing git invocation/);
  } finally {
    await cleanup();
  }
});

test("git(): refuses bare git clean (spec §11: never unscoped clean)", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await assert.rejects(() => git(repoPath, ["clean", "-fd"]), /Refusing git invocation/);
  } finally {
    await cleanup();
  }
});

test("checkpoint: clean worktree needs no synthetic commit", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    const mgr = new GitCheckpointManager(repoPath);
    const head = await git(repoPath, ["rev-parse", "HEAD"]);
    const checkpoint = await mgr.createPreTaskCheckpoint("chk_1", "task_1");
    assert.equal(checkpoint.dirtyWorktreeHandling, "none_was_clean");
    assert.equal(checkpoint.gitRef, head);
    assert.equal(checkpoint.preTaskBranch, "main");
  } finally {
    await cleanup();
  }
});

test("checkpoint: dirty worktree is committed to attest/task-<id>, user's branch is untouched and clean on return", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await writeFixtureFile(repoPath, "player.cs", "// dirty edit\n");
    const mgr = new GitCheckpointManager(repoPath);

    const checkpoint = await mgr.createPreTaskCheckpoint("chk_1", "task_1");

    assert.equal(checkpoint.dirtyWorktreeHandling, "committed_to_task_branch");
    assert.equal(checkpoint.preTaskBranch, "main");

    // Back on the user's original branch...
    const { branch } = await currentBranchOrDetachedSha(repoPath);
    assert.equal(branch, "main");

    // ...working tree is clean (the dirty edit was committed elsewhere, not discarded)...
    assert.equal(await statusPorcelain(repoPath), "");

    // ...and main's own tip commit was never touched: the file content on
    // main is back to the ORIGINAL content, not the dirty edit. The dirty
    // edit is only reachable via the task branch.
    assert.equal(await readFixtureFile(repoPath, "player.cs"), "// original\n");

    const taskBranch = "attest/task-task_1";
    assert.equal(await branchExists(repoPath, taskBranch), true);
    const dirtyContentOnTaskBranch = await git(repoPath, ["show", `${taskBranch}:player.cs`]);
    assert.equal(dirtyContentOnTaskBranch, "// dirty edit");
  } finally {
    await cleanup();
  }
});

test("rollback: restores modified files, deletes created files, verifies clean status", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    const mgr = new GitCheckpointManager(repoPath);
    const checkpoint = await mgr.createPreTaskCheckpoint("chk_1", "task_1");

    // Simulate Attest's own mutations after the checkpoint.
    await writeFixtureFile(repoPath, "player.cs", "// attest wrote this\n");
    await writeFixtureFile(repoPath, "dash.cs", "// new file from attest\n");
    await git(repoPath, ["add", "-A"]);

    const verification = await mgr.rollback(checkpoint, {
      modifiedAssets: ["player.cs"],
      createdAssets: ["dash.cs"],
    });

    assert.equal(verification.status, "verified");
    assert.equal(verification.gitStatusClean, true);
    assert.equal(await readFixtureFile(repoPath, "player.cs"), "// original\n");
    assert.equal(existsSync(path.join(repoPath, "dash.cs")), false);
    assert.equal(await statusPorcelain(repoPath), "");
  } finally {
    await cleanup();
  }
});

test("rollback: refuses to delete a created path outside the repo", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    const mgr = new GitCheckpointManager(repoPath);
    const checkpoint = await mgr.createPreTaskCheckpoint("chk_1", "task_1");
    await assert.rejects(
      () => mgr.rollback(checkpoint, { modifiedAssets: [], createdAssets: ["../outside.txt"] }),
      /outside the repo/,
    );
  } finally {
    await cleanup();
  }
});

test("ensureLocallyExcluded: writes .git/info/exclude and is idempotent", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await ensureLocallyExcluded(repoPath, ".attest/");
    await ensureLocallyExcluded(repoPath, ".attest/"); // second call must not duplicate
    const contents = await readFixtureFile(repoPath, ".git/info/exclude");
    const lines = contents.split("\n").filter((l) => l === ".attest/");
    assert.equal(lines.length, 1);
  } finally {
    await cleanup();
  }
});

test("ensureLocallyExcluded: does NOT touch the user's tracked .gitignore", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await ensureLocallyExcluded(repoPath, ".attest/");
    assert.equal(existsSync(`${repoPath}/.gitignore`), false);
  } finally {
    await cleanup();
  }
});

test("regression: without exclusion, a dirty worktree's checkpoint sweeps up the daemon's own .attest/ dir and then deletes it on branch-switch-back", async () => {
  // This reproduces the exact bug found running scripts/cli-smoke.mjs
  // end-to-end: the daemon writes .attest/tasks.sqlite into the project
  // root, and if the worktree happens to be dirty, createPreTaskCheckpoint's
  // `git add -A` commits .attest/ into the task branch, then `git switch`
  // back to main deletes it — corrupting the daemon's own live database out
  // from under itself. Asserted here WITHOUT the fix, to prove the fix
  // (next test) is actually necessary and not defensive-programming theater.
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await writeFixtureFile(repoPath, "dirty.txt", "user's uncommitted work\n");
    await mkdir(`${repoPath}/.attest`, { recursive: true });
    await writeFile(`${repoPath}/.attest/tasks.sqlite`, "pretend-sqlite-bytes");

    const mgr = new GitCheckpointManager(repoPath);
    await mgr.createPreTaskCheckpoint("chk_1", "task_1");

    assert.equal(existsSync(`${repoPath}/.attest/tasks.sqlite`), false, "bug reproduced: daemon's own db got deleted by the branch switch back");
  } finally {
    await cleanup();
  }
});

test("fix: with .attest/ excluded first, it never enters the dirty-worktree commit and survives the checkpoint untouched", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    await ensureLocallyExcluded(repoPath, ".attest/");
    await writeFixtureFile(repoPath, "dirty.txt", "user's uncommitted work\n");
    await mkdir(`${repoPath}/.attest`, { recursive: true });
    await writeFile(`${repoPath}/.attest/tasks.sqlite`, "pretend-sqlite-bytes");

    const mgr = new GitCheckpointManager(repoPath);
    const checkpoint = await mgr.createPreTaskCheckpoint("chk_1", "task_1");

    assert.equal(checkpoint.dirtyWorktreeHandling, "committed_to_task_branch", "dirty.txt should still trigger the dirty path");
    assert.equal(existsSync(`${repoPath}/.attest/tasks.sqlite`), true, "the daemon's own db must survive its own checkpoint operation");

    const taskBranchTree = await git(repoPath, ["ls-tree", "-r", "--name-only", "attest/task-task_1"]);
    assert.ok(!taskBranchTree.includes(".attest/tasks.sqlite"), ".attest/ must never be committed, even to the task branch");
  } finally {
    await cleanup();
  }
});

test("rollback: bit-exact across repeated mutate/rollback cycles (stand-in for the M0 100-run fidelity bar)", async () => {
  const { repoPath, cleanup } = await makeGitFixture();
  try {
    const mgr = new GitCheckpointManager(repoPath);
    const checkpoint = await mgr.createPreTaskCheckpoint("chk_1", "task_1");
    const original = await readFixtureFile(repoPath, "player.cs");

    const RUNS = 25;
    for (let i = 0; i < RUNS; i++) {
      await writeFixtureFile(repoPath, "player.cs", `// mutation attempt ${i}\n`);
      await writeFixtureFile(repoPath, `generated-${i}.cs`, "// scratch\n");
      await git(repoPath, ["add", "-A"]);

      const verification = await mgr.rollback(checkpoint, {
        modifiedAssets: ["player.cs"],
        createdAssets: [`generated-${i}.cs`],
      });

      assert.equal(verification.gitStatusClean, true, `run ${i}: expected clean status after rollback`);
      assert.equal(await readFixtureFile(repoPath, "player.cs"), original, `run ${i}: content not bit-exact`);
      assert.equal(existsSync(path.join(repoPath, `generated-${i}.cs`)), false, `run ${i}: created file not removed`);
    }
  } finally {
    await cleanup();
  }
});
