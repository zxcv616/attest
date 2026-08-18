import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Every git invocation the daemon makes goes through this one function, so
 * the "never reset --hard, never unscoped clean" rule (spec §11) has exactly
 * one place to audit rather than being a convention scattered across callers.
 */
export async function git(repoPath: string, args: string[]): Promise<string> {
  for (const forbidden of FORBIDDEN_ARG_PATTERNS) {
    if (forbidden.test(args.join(" "))) {
      throw new Error(
        `Refusing git invocation matching forbidden pattern ${forbidden}: git ${args.join(" ")}. ` +
          `Spec §11 git safety rules: never reset --hard, never unscoped clean.`,
      );
    }
  }
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

const FORBIDDEN_ARG_PATTERNS = [
  /reset\s+--hard/,
  /^clean(\s|$)/, // any bare "clean" invocation — callers must pass explicit -- <paths>
  /clean\s+-[a-z]*f[a-z]*d/, // clean -fd / -xfd etc without explicit paths handled separately
];

export async function currentBranchOrDetachedSha(repoPath: string): Promise<{ branch: string | null; sha: string }> {
  const branch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = await git(repoPath, ["rev-parse", "HEAD"]);
  return { branch: branch === "HEAD" ? null : branch, sha };
}

export async function isDirty(repoPath: string): Promise<boolean> {
  const status = await git(repoPath, ["status", "--porcelain"]);
  return status.length > 0;
}

export async function statusPorcelain(repoPath: string): Promise<string> {
  return git(repoPath, ["status", "--porcelain"]);
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", "--quiet", branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Excludes `pattern` via `.git/info/exclude` — git-native, local-only, and
 * critically NOT the user's tracked `.gitignore` (writing to that would be
 * exactly the kind of unrequested change to their tracked files this whole
 * project refuses to make).
 *
 * This exists for one reason: the daemon's own `.attest/` workspace (its
 * live SQLite task database, session files, port file) lives inside the
 * target project's working tree (spec §6: file access is scoped to the
 * selected repository). If it were left untracked and the worktree was
 * dirty at task start, `createPreTaskCheckpoint`'s `git add -A` would sweep
 * the live database into the snapshot commit, and the branch-switch back to
 * the user's branch would then DELETE it out from under the daemon's own
 * open connection — found by the checkpoint test suite doing exactly that
 * during an end-to-end smoke run. Must be called before anything is ever
 * written into `.attest/`, not just before the first checkpoint, since the
 * daemon itself creates that directory on startup.
 */
export async function ensureLocallyExcluded(repoPath: string, pattern: string): Promise<void> {
  const excludePath = path.join(repoPath, ".git", "info", "exclude");
  await mkdir(path.dirname(excludePath), { recursive: true });
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    /* no exclude file yet — fine, we're about to create one */
  }
  if (content.split("\n").includes(pattern)) return;
  const withNewline = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  await writeFile(excludePath, `${withNewline}${pattern}\n`, "utf8");
}
