import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { git } from "../../src/git.ts";

export async function makeGitFixture(): Promise<{ repoPath: string; cleanup: () => Promise<void> }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "attest-git-fixture-"));
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@attest.dev"]);
  await git(repoPath, ["config", "user.name", "Attest Test"]);
  await writeFile(path.join(repoPath, "player.cs"), "// original\n");
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return {
    repoPath,
    cleanup: () => rm(repoPath, { recursive: true, force: true }),
  };
}

export async function readFixtureFile(repoPath: string, rel: string): Promise<string> {
  return readFile(path.join(repoPath, rel), "utf8");
}

export async function writeFixtureFile(repoPath: string, rel: string, content: string): Promise<void> {
  await writeFile(path.join(repoPath, rel), content);
}
