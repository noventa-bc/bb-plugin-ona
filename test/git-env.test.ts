import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

/** A main repository with a linked worktree, and the environment a hook gets in that worktree: GIT_DIR names its git directory. */
function linkedWorktreeHook() {
  const main = tempDir("git-env-main-");
  const clean = scrubbed(process.env);
  git(main, clean, "init", "-q", "-b", "main");
  git(main, clean, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "main");
  const linked = join(tempDir("git-env-linked-"), "wt");
  git(main, clean, "worktree", "add", "-q", linked, "-b", "linked");
  const gitDir = git(linked, clean, "rev-parse", "--absolute-git-dir");
  return { main, linked, clean, hook: { ...process.env, GIT_DIR: gitDir } };
}

test("git commands in a temp folder never commit into the repository GIT_DIR names", () => {
  const { linked, clean, hook } = linkedWorktreeHook();
  const headBefore = git(linked, clean, "rev-parse", "HEAD");
  const temp = tempDir("git-env-temp-");
  const env = scrubbed(hook);
  git(temp, env, "init", "-q");
  writeFileSync(join(temp, "a.ts"), "export const a = 1;\n");
  git(temp, env, "add", "a.ts");
  git(temp, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  assert.equal(git(linked, clean, "rev-parse", "HEAD"), headBefore);
});

test("git init -b main in a temp folder never changes core.bare of the repository GIT_DIR names", () => {
  const { main, clean, hook } = linkedWorktreeHook();
  const bareBefore = git(main, clean, "config", "--get", "core.bare");
  const temp = tempDir("git-env-init-");
  git(temp, scrubbed(hook), "init", "-q", "-b", "main");
  assert.equal(git(main, clean, "config", "--get", "core.bare"), bareBefore);
});
