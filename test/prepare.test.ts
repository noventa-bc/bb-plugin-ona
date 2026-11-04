import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { accessible, git, scrubbed, tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const prepare: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.prepare;
// The developer's global and system git config must not change the results (a core.hooksPath there would).
const env = { ...scrubbed(process.env), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Runs the package.json prepare script in `dir` the way npm does: through sh, from the package folder. */
function runPrepare(dir: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", ["-c", prepare], { cwd: dir, env: { ...env, ...extra }, stdio: "pipe" });
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

test("a developer's global core.hooksPath does not change the result", () => {
  const globalConfig = join(tempDir("prepare-home-"), ".gitconfig");
  writeFileSync(globalConfig, "[core]\n\thooksPath = /some/other/hooks\n");
  const dir = tempDir("prepare-global-");
  git(dir, env, "init", "-q");
  // git must read the global value through this file, or the result below would pass for the wrong reason.
  const withGlobal = { ...env, GIT_CONFIG_GLOBAL: globalConfig };
  assert.equal(git(dir, withGlobal, "config", "--get", "core.hooksPath"), "/some/other/hooks");
  assert.equal(runPrepare(dir, { GIT_CONFIG_GLOBAL: globalConfig }).status, 0);
  assert.equal(localHooksPath(dir), ".githooks");
});

for (const value of ["./.githooks", ".githooks/"]) {
  test(`a repository root whose core.hooksPath is ${value} is set to .githooks, with no message`, () => {
    const dir = tempDir("prepare-same-");
    git(dir, env, "init", "-q");
    git(dir, env, "config", "core.hooksPath", value);
    const run = runPrepare(dir);
    assert.equal(run.status, 0, String(run.stderr));
    assert.equal(String(run.stdout), "");
    assert.equal(localHooksPath(dir), ".githooks");
  });
}

test("a .git that cannot be written warns and the install still exits 0", (t) => {
  const dir = tempDir("prepare-readonly-");
  git(dir, env, "init", "-q");
  const gitDir = join(dir, ".git");
  chmodSync(gitDir, 0o555);
  try {
    if (accessible(gitDir, constants.W_OK))
      return t.skip("chmod does not stop writes here: root, or a filesystem that ignores it");
    const run = runPrepare(dir);
    assert.equal(run.status, 0, String(run.stderr));
    assert.match(String(run.stdout), /core\.hooksPath could not be set; this repo's hooks will not run/);
  } finally {
    chmodSync(gitDir, 0o755);
  }
});

test("a .git file pointing at a missing folder warns and the install still exits 0", () => {
  const dir = tempDir("prepare-broken-");
  writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "missing")}\n`);
  const run = runPrepare(dir);
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(String(run.stdout), /core\.hooksPath could not be set/);
});
