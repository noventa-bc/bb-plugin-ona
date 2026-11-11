import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "scratch-copy.sh");
const env = scrubbed(process.env);

/** A main checkout with one commit of package.json and package-lock.json, a node_modules folder, and a worktree of that commit. */
function checkouts() {
  const main = tempDir("scratch-copy-main-");
  git(main, env, "init", "-q", "-b", "main");
  writeFileSync(join(main, "package.json"), '{ "name": "fixture" }\n');
  writeFileSync(join(main, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  git(main, env, "add", "package.json", "package-lock.json");
  git(main, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  mkdirSync(join(main, "node_modules"));
  const worktree = join(tempDir("scratch-copy-worktree-"), "wt");
  git(main, env, "worktree", "add", "-q", "--detach", worktree);
  return { main, worktree };
}

/** Runs scratch-copy.sh; returns its exit status, the path it printed and its messages. */
function scratchCopy(worktree: string, sha: string, dir: string) {
  const run = spawnSync(script, [worktree, sha, dir], { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, printed: String(run.stdout).trim(), messages: String(run.stderr) };
}

/** A folder path under a new temp folder, not yet made. */
const newDir = () => join(tempDir("scratch-copy-out-"), "copy");

test("the copy holds the commit with no .git, and its node_modules links to the main checkout's", () => {
  const { main, worktree } = checkouts();
  const dir = newDir();
  const r = scratchCopy(worktree, git(worktree, env, "rev-parse", "HEAD"), dir);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(r.printed), realpathSync(dir));
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.equal(lstatSync(join(dir, "node_modules")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(dir, "node_modules")), realpathSync(join(main, "node_modules")));
});

test("node_modules is not linked when the commit's package-lock.json differs from the main checkout's, and says why", () => {
  const { worktree } = checkouts();
  writeFileSync(join(worktree, "package-lock.json"), '{ "lockfileVersion": 4 }\n');
  git(worktree, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "lock");
  const dir = newDir();
  const r = scratchCopy(worktree, git(worktree, env, "rev-parse", "HEAD"), dir);
  assert.equal(r.status, 0, r.messages);
  assert.equal(existsSync(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("an existing folder is refused before anything is extracted into it", () => {
  const { worktree } = checkouts();
  const dir = tempDir("scratch-copy-existing-");
  const r = scratchCopy(worktree, git(worktree, env, "rev-parse", "HEAD"), dir);
  assert.equal(r.status, 1);
  assert.match(r.messages, /already exists; name a new folder/);
  assert.equal(existsSync(join(dir, "package.json")), false);
});

test("a sha that is not a commit is refused, and no folder is made", () => {
  const { worktree } = checkouts();
  const dir = newDir();
  const r = scratchCopy(worktree, "no-such-commit", dir);
  assert.equal(r.status, 1);
  assert.match(r.messages, /is not a commit of/);
  assert.equal(existsSync(dir), false);
});
