import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "scratch-copy.sh");
const env = scrubbed(process.env);

/** A main checkout with one commit of package.json and package-lock.json, a node_modules folder unless `withModules` is false, and a worktree of that commit. */
function checkouts(withModules = true) {
  const main = tempDir("scratch-copy-main-");
  git(main, env, "init", "-q", "-b", "main");
  writeFileSync(join(main, "package.json"), '{ "name": "fixture" }\n');
  writeFileSync(join(main, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  git(main, env, "add", "package.json", "package-lock.json");
  git(main, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  if (withModules) mkdirSync(join(main, "node_modules"));
  const worktree = join(tempDir("scratch-copy-worktree-"), "wt");
  git(main, env, "worktree", "add", "-q", "--detach", worktree);
  return { main, worktree };
}

/** Commits what is staged in `dir` and returns the new commit's sha. */
function commit(dir: string, message: string) {
  git(dir, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
  return head(dir);
}

const head = (dir: string) => git(dir, env, "rev-parse", "HEAD");

/** Runs scratch-copy.sh with `args` in `runEnv`; returns its exit status, the path it printed and its messages. */
function scratchCopy(args: string[], runEnv: NodeJS.ProcessEnv = env) {
  const run = spawnSync(script, args, { env: runEnv, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, printed: String(run.stdout).trim(), messages: String(run.stderr) };
}

/** A folder path under a new temp folder, not yet made. */
const newDir = () => join(tempDir("scratch-copy-out-"), "copy");

/** A new, empty temp folder to pass as TMPDIR, so a temp file the script leaves behind is seen. */
const freshTmp = () => tempDir("scratch-copy-tmp-");

/** Whether anything is at `path`, a dangling link included. */
function hasEntry(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

test("the copy holds the commit with no .git, and its node_modules links to the main checkout's", () => {
  const { main, worktree } = checkouts();
  const dir = newDir();
  const tmp = freshTmp();
  const r = scratchCopy([worktree, head(worktree), dir], { ...env, TMPDIR: tmp });
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(r.printed), realpathSync(dir));
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.equal(lstatSync(join(dir, "node_modules")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(dir, "node_modules")), realpathSync(join(main, "node_modules")));
  assert.deepEqual(readdirSync(tmp), [], "a temp file was left in TMPDIR");
});

test("node_modules is not linked when the commit's package-lock.json differs from the main checkout's, and says why", () => {
  const { worktree } = checkouts();
  writeFileSync(join(worktree, "package-lock.json"), '{ "lockfileVersion": 4 }\n');
  git(worktree, env, "add", "package-lock.json");
  const sha = commit(worktree, "lock");
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("node_modules is not linked when only package.json differs from the main checkout's, and says why", () => {
  const { worktree } = checkouts();
  writeFileSync(join(worktree, "package.json"), '{ "name": "other" }\n');
  git(worktree, env, "add", "package.json");
  const sha = commit(worktree, "package");
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("node_modules is not linked when the main checkout has none, and says so", () => {
  const { worktree } = checkouts(false);
  const dir = newDir();
  const r = scratchCopy([worktree, head(worktree), dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: .* has none/);
});

test("an existing folder is refused before anything is extracted into it, named directly or through `..`", () => {
  const { worktree } = checkouts();
  const dir = tempDir("scratch-copy-existing-");
  const r = scratchCopy([worktree, head(worktree), dir]);
  assert.equal(r.status, 1);
  assert.match(r.messages, /already exists; name a new folder/);
  assert.equal(existsSync(join(dir, "package.json")), false);
  // A template, not join(): `${dir}/..` names the same folder, and the check must test the path it resolves to.
  const through = scratchCopy([worktree, head(worktree), `${dir}/..`]);
  assert.equal(through.status, 1, through.messages);
  assert.match(through.messages, /already exists; name a new folder/);
});

test("a sha that is not a commit is refused, and no folder is made", () => {
  const { worktree } = checkouts();
  const dir = newDir();
  const r = scratchCopy([worktree, "no-such-commit", dir]);
  assert.equal(r.status, 1);
  assert.match(r.messages, /is not a commit of/);
  assert.equal(existsSync(dir), false);
});

test("a folder inside the worktree or inside the main checkout is refused, and nothing is made there", () => {
  const { main, worktree } = checkouts();
  const sha = head(worktree);
  for (const inside of [worktree, main]) {
    const dir = join(inside, "scratch");
    const r = scratchCopy([worktree, sha, dir]);
    assert.equal(r.status, 1, r.messages);
    assert.match(r.messages, /is inside .*a checkout; name a folder outside it/);
    assert.equal(hasEntry(dir), false);
  }
});

test("a folder reached through a symlink to the worktree is refused as inside it", () => {
  const { worktree } = checkouts();
  const link = join(tempDir("scratch-copy-link-"), "link");
  symlinkSync(worktree, link);
  const r = scratchCopy([worktree, head(worktree), join(link, "scratch")]);
  assert.equal(r.status, 1, r.messages);
  assert.equal(hasEntry(join(worktree, "scratch")), false);
});

test("a `..` after a missing folder is refused, and nothing is made in the worktree or the main checkout", () => {
  const { main, worktree } = checkouts();
  const sha = head(worktree);
  for (const checkout of [worktree, main]) {
    // A template, not join(): join would fold the `..` away before the script sees it.
    const dir = `${dirname(checkout)}/nope/../${basename(checkout)}/x`;
    const r = scratchCopy([worktree, sha, dir]);
    assert.equal(r.status, 1, r.messages);
    assert.match(r.messages, /does not exist; make it first/);
    assert.equal(hasEntry(join(checkout, "x")), false);
  }
});

test("a symlink followed by `..` is refused, and nothing is written into the checkout the link points into", () => {
  const { main, worktree } = checkouts();
  mkdirSync(join(main, "deep"));
  const linkParent = tempDir("scratch-copy-link-");
  symlinkSync(join(main, "deep"), join(linkParent, "link"));
  const r = scratchCopy([worktree, head(worktree), `${linkParent}/link/../x2`]);
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /is inside .*a checkout/);
  assert.equal(hasEntry(join(main, "x2")), false);
});

test("a missing parent folder exits 1, and nothing is made", () => {
  const { worktree } = checkouts();
  const root = tempDir("scratch-copy-missing-");
  const r = scratchCopy([worktree, head(worktree), join(root, "missing", "copy")]);
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /does not exist; make it first/);
  assert.equal(hasEntry(join(root, "missing")), false);
});

test("a failing git archive exits 1 and makes no folder, instead of an empty copy", () => {
  const { worktree } = checkouts();
  const sha = head(worktree);
  const shims = tempDir("scratch-copy-shim-");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(shims, "git"),
    `#!/bin/sh\ncase " $* " in *" archive "*) echo "fatal: simulated archive failure" >&2; exit 128 ;; esac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shims, "git"), 0o755);
  const dir = newDir();
  const tmp = freshTmp();
  const r = scratchCopy([worktree, sha, dir], { ...env, PATH: `${shims}:${env.PATH ?? ""}`, TMPDIR: tmp });
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /git archive failed/);
  assert.equal(hasEntry(dir), false);
  assert.deepEqual(readdirSync(tmp), [], "a temp file was left in TMPDIR");
});

test("a parent folder removed during the copy is not recreated: the copy exits 1 and makes no folder", () => {
  const { worktree } = checkouts();
  const sha = head(worktree);
  const parent = join(tempDir("scratch-copy-gone-"), "parent");
  mkdirSync(parent);
  const shims = tempDir("scratch-copy-shim-");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  // The shim removes the parent while git archive runs, after the script's own checks have passed.
  writeFileSync(
    join(shims, "git"),
    `#!/bin/sh\ncase " $* " in *" archive "*) rm -rf "${parent}" ;; esac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shims, "git"), 0o755);
  const tmp = freshTmp();
  const r = scratchCopy([worktree, sha, join(parent, "copy")], {
    ...env,
    PATH: `${shims}:${env.PATH ?? ""}`,
    TMPDIR: tmp,
  });
  assert.equal(r.status, 1, r.messages);
  assert.equal(hasEntry(parent), false);
  assert.deepEqual(readdirSync(tmp), [], "a temp file was left in TMPDIR");
});

test("a tracked node_modules symlink in the commit is not followed into another folder", () => {
  const { worktree } = checkouts();
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "docs", "README.md"), "# Docs\n");
  symlinkSync("docs", join(worktree, "node_modules"));
  git(worktree, env, "add", "docs", "node_modules");
  const sha = commit(worktree, "a node_modules symlink");
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 1, r.messages);
  assert.equal(hasEntry(join(dir, "docs", "node_modules")), false);
});

test("two arguments are a usage error", () => {
  const { worktree } = checkouts();
  const r = scratchCopy([worktree, head(worktree)]);
  assert.equal(r.status, 2);
  assert.match(r.messages, /usage: scripts\/scratch-copy\.sh <worktree> <sha> <dir>/);
});
