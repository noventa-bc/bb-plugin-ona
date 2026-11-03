import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const prepare: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.prepare;
const env = scrubbed(process.env);

/** Runs the package.json prepare script in `dir` the way npm does: through sh, from the package folder. */
function runPrepare(dir: string) {
  return spawnSync("sh", ["-c", prepare], { cwd: dir, env, stdio: "pipe" });
}

/** The core.hooksPath set in the repository `dir` itself (not inherited from a global config), if any. */
function localHooksPath(dir: string) {
  const run = spawnSync("git", ["-C", dir, "config", "--local", "--get", "core.hooksPath"], { env, stdio: "pipe" });
  return run.status === 0 ? String(run.stdout).trim() : undefined;
}

/** A repository with one commit on main, and a linked worktree of it. */
function linkedWorktree() {
  const main = tempDir("prepare-main-");
  git(main, env, "init", "-q", "-b", "main");
  git(main, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const linked = join(tempDir("prepare-linked-"), "wt");
  git(main, env, "worktree", "add", "-q", linked, "-b", "linked");
  return { main, linked };
}

test("a folder without .git installs without error", () => {
  const run = runPrepare(tempDir("prepare-copy-"));
  assert.equal(run.status, 0, String(run.stderr));
});

test("a plugin folder inside another repository leaves that repository's hooks path alone", () => {
  const outer = tempDir("prepare-outer-");
  git(outer, env, "init", "-q");
  const inner = join(outer, "plugin");
  mkdirSync(inner);
  const run = runPrepare(inner);
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(localHooksPath(outer), undefined);
});

test("a repository root gets core.hooksPath set to .githooks", () => {
  const dir = tempDir("prepare-repo-");
  git(dir, env, "init", "-q");
  assert.equal(runPrepare(dir).status, 0);
  assert.equal(localHooksPath(dir), ".githooks");
});

test("a repository root keeps another core.hooksPath and prints one line saying its hooks will not run", () => {
  const dir = tempDir("prepare-other-");
  git(dir, env, "init", "-q");
  git(dir, env, "config", "core.hooksPath", "/some/other/hooks");
  const run = runPrepare(dir);
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(localHooksPath(dir), "/some/other/hooks");
  const lines = String(run.stdout).trim().split("\n");
  assert.equal(lines.length, 1, String(run.stdout));
  assert.match(lines[0] ?? "", /hooks will not run/);
});

test("a linked worktree sets the shared core.hooksPath, which its main repository then reads", () => {
  const { main, linked } = linkedWorktree();
  assert.equal(runPrepare(linked).status, 0);
  assert.equal(localHooksPath(main), ".githooks");
});

test("a linked worktree keeps another core.hooksPath on the shared config", () => {
  const { main, linked } = linkedWorktree();
  git(main, env, "config", "core.hooksPath", "/some/other/hooks");
  const run = runPrepare(linked);
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(localHooksPath(main), "/some/other/hooks");
  assert.match(String(run.stdout), /hooks will not run/);
});
