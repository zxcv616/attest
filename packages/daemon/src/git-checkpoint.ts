import { rm } from "node:fs/promises";
import path from "node:path";
import { git, currentBranchOrDetachedSha, isDirty, statusPorcelain } from "./git.ts";

/**
 * Implements spec §11 "Git safety rules" and the Checkpoint entity from
 * Appendix A. This is the ONLY rollback primitive in Attest — Unity's Undo
 * stack is explicitly not durable across domain reload / Play Mode / Editor
 * restart and is never used for rollback (spec §7).
 *
 * Absolute rules enforced here, not just documented:
 *   - never `git reset --hard` on the user's HEAD              (git.ts guard)
 *   - never `git clean` without an explicit path list           (not used at all — see below)
 *   - never checkout away from the user's branch without first committing their work
 *   - rollback restores exactly the paths in the mutation manifest, nothing broader
 *
 * "git clean" is not used anywhere in this module. Created-path deletion
 * uses fs.rm against the exact paths in the transaction's mutation
 * manifest — narrower and safer than any git-clean flag combination, and it
 * can't accidentally sweep up files git doesn't know about yet for reasons
 * unrelated to Attest (a build tool's scratch output, say).
 */

export type DirtyWorktreeHandling = "none_was_clean" | "committed_to_task_branch" | "labeled_stash";

export interface Checkpoint {
  id: string;
  taskId: string;
  kind: "pre_task" | "post_transaction" | "post_repair";
  gitRef: string;
  preTaskBranch: string | null;
  dirtyWorktreeHandling: DirtyWorktreeHandling;
  createdAt: string;
  verification: {
    status: "not_yet_verified" | "verified" | "failed";
    gitStatusClean: boolean | null;
    reimportedWithoutErrors: boolean | null; // Unity-side concern; null until the Unity package wires a result in.
    guidSetMatches: boolean | null; // ditto.
    verifiedAt: string | null;
  };
}

export interface MutationManifest {
  /** Tracked files to restore to the checkpoint's content. */
  modifiedAssets: string[];
  /** Files Attest created since the checkpoint; deleted by exact path, never by pattern. */
  createdAssets: string[];
}

function taskBranchName(taskId: string): string {
  return `attest/task-${taskId}`;
}

export class GitCheckpointManager {
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /**
   * Spec §11: "A dirty worktree at task start is committed to a
   * `attest/task-<id>` branch ... and reported. The user's HEAD and branch
   * are restored on completion."
   *
   * Sequence when dirty (all safe — no destructive discard at any step):
   *   1. `git switch -c attest/task-<id>`  — same commit, working tree untouched
   *   2. `git add -A && git commit`         — the user's edits become a real commit
   *   3. `git switch <originalBranch>`      — safe: working tree is now clean,
   *      and the original branch's ref never moved, so nothing is lost.
   *
   * The returned checkpoint's gitRef is the snapshot commit (or, if the tree
   * was already clean, simply the current HEAD — no synthetic commit is
   * created when there's nothing to preserve).
   */
  async createPreTaskCheckpoint(id: string, taskId: string): Promise<Checkpoint> {
    const { branch: originalBranch } = await currentBranchOrDetachedSha(this.repoPath);
    const dirty = await isDirty(this.repoPath);

    let gitRef: string;
    let dirtyWorktreeHandling: DirtyWorktreeHandling;

    if (dirty) {
      const branch = taskBranchName(taskId);
      await git(this.repoPath, ["switch", "-c", branch]);
      await git(this.repoPath, ["add", "-A"]);
      await git(this.repoPath, ["commit", "-m", `attest: pre-task snapshot for task ${taskId}`]);
      gitRef = await git(this.repoPath, ["rev-parse", "HEAD"]);
      if (originalBranch) {
        await git(this.repoPath, ["switch", originalBranch]);
      }
      dirtyWorktreeHandling = "committed_to_task_branch";
    } else {
      gitRef = await git(this.repoPath, ["rev-parse", "HEAD"]);
      dirtyWorktreeHandling = "none_was_clean";
    }

    return {
      id,
      taskId,
      kind: "pre_task",
      gitRef,
      preTaskBranch: originalBranch,
      dirtyWorktreeHandling,
      createdAt: new Date().toISOString(),
      verification: {
        status: "not_yet_verified",
        gitStatusClean: null,
        reimportedWithoutErrors: null,
        guidSetMatches: null,
        verifiedAt: null,
      },
    };
  }

  /**
   * Restores exactly the paths named in `manifest` to their content at
   * `checkpoint.gitRef`, deletes exactly the created paths, and returns the
   * checkpoint's `verification` block populated — never claims success
   * without checking. Spec §11: "a rollback that isn't verified didn't
   * happen."
   *
   * Does NOT touch any file outside the manifest. Does NOT run git clean.
   * Does NOT reset --hard.
   */
  async rollback(checkpoint: Checkpoint, manifest: MutationManifest): Promise<Checkpoint["verification"]> {
    if (manifest.modifiedAssets.length > 0) {
      // `git checkout <ref> -- <paths>` restores BOTH the index and the
      // worktree in one shot. `git restore` (without --staged --worktree)
      // only touches the worktree — if Attest's own transaction had staged
      // its edit (git add), a worktree-only restore leaves the stale
      // staged version behind and `git status` would NOT come back clean.
      // Caught by the checkpoint test suite before this shipped.
      await git(this.repoPath, ["checkout", checkpoint.gitRef, "--", ...manifest.modifiedAssets]);
    }
    for (const created of manifest.createdAssets) {
      const abs = path.resolve(this.repoPath, created);
      if (!abs.startsWith(path.resolve(this.repoPath) + path.sep)) {
        throw new Error(`Refusing to delete path outside the repo: ${created}`);
      }
      await rm(abs, { force: true });
      try {
        // Unstage it too, in case it had been `git add`-ed — same reasoning
        // as above. Harmless if it was never staged.
        await git(this.repoPath, ["rm", "--cached", "-f", "--", created]);
      } catch {
        /* not in the index — nothing to unstage */
      }
    }

    if (checkpoint.preTaskBranch) {
      const { branch: current } = await currentBranchOrDetachedSha(this.repoPath);
      if (current !== checkpoint.preTaskBranch) {
        await git(this.repoPath, ["switch", checkpoint.preTaskBranch]);
      }
    }

    const status = await statusPorcelain(this.repoPath);
    const gitStatusClean = status.length === 0;

    return {
      status: gitStatusClean ? "verified" : "failed",
      gitStatusClean,
      // Reimport and GUID-set verification happen inside the Unity Editor
      // (spec §11) and are not observable from the daemon alone. A real
      // rollback report is not "verified" end-to-end until the Unity
      // package fills these in over the RPC connection — M1 work once
      // transactions exist. Recorded as null here rather than true, so
      // nothing downstream can mistake "the daemon didn't check" for "it
      // passed."
      reimportedWithoutErrors: null,
      guidSetMatches: null,
      verifiedAt: new Date().toISOString(),
    };
  }
}
