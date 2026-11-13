import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "scratch-copy.sh");
const env = scrubbed(process.env);

/** A main checkout with one commit of package.json and package-lock.json, a node_modules folder unless `withModules` is false, and a worktree of that commit. */
function checkouts(withModules = true) {
  const main = tempDir("scratch-copy-main-");
  git(main, env, "init", "-q", "-b", "main");
  writeFileSync(join(main, "package.json"), packageJson("1.0.0"));
  writeFileSync(join(main, "package-lock.json"), lockfile("1.0.0"));
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

/** Runs scratch-copy.sh with `args` in `runEnv`, from `cwd` when given; returns its exit status, the path it printed and its messages. */
function scratchCopy(args: string[], runEnv: NodeJS.ProcessEnv = env, cwd?: string) {
  const run = spawnSync(script, args, { env: runEnv, cwd, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, printed: String(run.stdout).trim(), messages: String(run.stderr) };
}

/** A folder path under a new temp folder, not yet made. */
const newDir = () => join(tempDir("scratch-copy-out-"), "copy");

/** Whether anything is at `path`, a dangling link included. */
function hasEntry(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The `.scratch-copy.*` files in `folder`: the temp archive the script writes beside the copy. */
const archivesIn = (folder: string) => readdirSync(folder).filter((name) => name.startsWith(".scratch-copy."));

/** A folder holding a `git` that runs the shell command `before` when asked to archive, then the real git. */
function gitShim(before: string) {
  const shims = tempDir("scratch-copy-shim-");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(shims, "git"),
    `#!/bin/sh\ncase " $* " in *" archive "*) ${before} ;; esac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shims, "git"), 0o755);
  return shims;
}

/** The environment for a run whose `git` is taken from the shim folder `shims`. */
const withShim = (shims: string): NodeJS.ProcessEnv => ({ ...env, PATH: `${shims}:${env.PATH ?? ""}` });

/** The text of a package.json for "fixture" at `version`, with `fields` beside an empty `dependencies`. */
function packageJson(version: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ name: "fixture", version, dependencies: {}, ...fields }, null, 2) + "\n";
}

/** The text of a package-lock.json for "fixture" at `version`, with `packages` beside the root entry. */
function lockfile(version: string, packages: Record<string, object> = {}) {
  const self = { name: "fixture", version };
  return JSON.stringify({ ...self, lockfileVersion: 3, packages: { "": self, ...packages } }, null, 2) + "\n";
}

/** Writes the two manifests into `worktree` and commits them; returns the new commit's sha. */
function commitManifests(worktree: string, pkg: string, lock: string) {
  writeFileSync(join(worktree, "package.json"), pkg);
  writeFileSync(join(worktree, "package-lock.json"), lock);
  git(worktree, env, "add", "package.json", "package-lock.json");
  return commit(worktree, "manifests");
}

test("the copy holds the commit with no .git, and its node_modules links to the main checkout's", () => {
  const { main, worktree } = checkouts();
  const dir = newDir();
  const r = scratchCopy([worktree, head(worktree), dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(r.printed), realpathSync(dir));
  assert.equal(existsSync(join(dir, ".git")), false);
  assert.equal(lstatSync(join(dir, "node_modules")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(dir, "node_modules")), realpathSync(join(main, "node_modules")));
  assert.deepEqual(archivesIn(dirname(dir)), [], "the temp archive was left beside the copy");
});

test("node_modules is not linked when the commit's package-lock.json differs from the main checkout's, and says why", () => {
  const { worktree } = checkouts();
  writeFileSync(
    join(worktree, "package-lock.json"),
    lockfile("1.0.0").replace('"lockfileVersion": 3', '"lockfileVersion": 4'),
  );
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

test("a version-only difference links: the version is left out of package.json and both lockfile copies", () => {
  const { main, worktree } = checkouts();
  const dir = newDir();
  const r = scratchCopy([worktree, commitManifests(worktree, packageJson("1.0.1"), lockfile("1.0.1")), dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(join(dir, "node_modules")), realpathSync(join(main, "node_modules")));
});

test("a commit that adds only scripts.test to package.json, a script no install hook names, links node_modules", () => {
  const { main, worktree } = checkouts();
  const sha = commitManifests(worktree, packageJson("1.0.0", { scripts: { test: "node --test" } }), lockfile("1.0.0"));
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(join(dir, "node_modules")), realpathSync(join(main, "node_modules")));
});

test("a commit that adds only the install hook scripts.postinstall to package.json does not link, and says why", () => {
  const { worktree } = checkouts();
  const sha = commitManifests(
    worktree,
    packageJson("1.0.0", { scripts: { postinstall: "patch-package" } }),
    lockfile("1.0.0"),
  );
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("a commit whose install hook scripts.prepare differs from the main checkout's does not link, and says why", () => {
  const { main, worktree } = checkouts();
  writeFileSync(join(main, "package.json"), packageJson("1.0.0", { scripts: { prepare: "husky" } }));
  const sha = commitManifests(
    worktree,
    packageJson("1.0.0", { scripts: { prepare: "husky install" } }),
    lockfile("1.0.0"),
  );
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("a commit that removes only workspaces from package.json, with the same lockfile, does not link, and says why", () => {
  const { main, worktree } = checkouts();
  const withWorkspaces = packageJson("1.0.0", { workspaces: ["packages/*"] });
  writeFileSync(join(main, "package.json"), withWorkspaces);
  commitManifests(worktree, withWorkspaces, lockfile("1.0.0"));
  const sha = commitManifests(worktree, packageJson("1.0.0"), lockfile("1.0.0"));
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("a different dependency does not link, and says why", () => {
  const { worktree } = checkouts();
  const sha = commitManifests(
    worktree,
    packageJson("1.0.0", { dependencies: { "left-pad": "1.0.0" } }),
    lockfile("1.0.0"),
  );
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("a devDependencies version change in package.json does not link, and says why", () => {
  const { main, worktree } = checkouts();
  writeFileSync(join(main, "package.json"), packageJson("1.0.0", { devDependencies: { pkg: "1.0.0" } }));
  const sha = commitManifests(worktree, packageJson("1.0.0", { devDependencies: { pkg: "1.0.1" } }), lockfile("1.0.0"));
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(hasEntry(join(dir, "node_modules")), false);
  assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /);
});

test("lockfiles that differ only in a dependency's version under packages do not link, and say why", () => {
  const { main, worktree } = checkouts();
  writeFileSync(join(main, "package-lock.json"), lockfile("1.0.0", { "node_modules/left-pad": { version: "1.0.0" } }));
  const sha = commitManifests(
    worktree,
    packageJson("1.0.0"),
    lockfile("1.0.0", { "node_modules/left-pad": { version: "1.0.1" } }),
  );
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

test("an existing folder is refused before anything is extracted into it", () => {
  const { worktree } = checkouts();
  const dir = tempDir("scratch-copy-existing-");
  const r = scratchCopy([worktree, head(worktree), dir]);
  assert.equal(r.status, 1);
  assert.match(r.messages, /already exists; name a new folder/);
  assert.equal(existsSync(join(dir, "package.json")), false);
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
    assert.match(r.messages, /is inside a git checkout; name a folder outside one/);
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
  assert.match(r.messages, /is inside a git checkout/);
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
  const dir = newDir();
  const parent = dirname(dir);
  const log = join(tempDir("scratch-copy-log-"), "listing.txt");
  // The shim records the parent's listing while git archive runs: the temp archive is there, beside the copy.
  const shims = gitShim(`ls -A "${parent}" > "${log}"; echo "fatal: simulated archive failure" >&2; exit 128`);
  const r = scratchCopy([worktree, sha, dir], withShim(shims));
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /git archive failed/);
  assert.equal(hasEntry(dir), false);
  assert.match(readFileSync(log, "utf8"), /^\.scratch-copy\./m, "the temp archive was not beside the copy");
  assert.deepEqual(archivesIn(parent), [], "the temp archive was left beside the copy");
});

test("a parent folder removed during the copy is not recreated: the copy exits 1 and makes no folder", () => {
  const { worktree } = checkouts();
  const sha = head(worktree);
  const parent = join(tempDir("scratch-copy-gone-"), "parent");
  mkdirSync(parent);
  // The shim removes the parent while git archive runs, after the script's own checks have passed.
  const shims = gitShim(`rm -rf "${parent}"`);
  const r = scratchCopy([worktree, sha, join(parent, "copy")], withShim(shims));
  assert.equal(r.status, 1, r.messages);
  assert.equal(hasEntry(parent), false);
});

test("a tracked node_modules link to a folder is kept, and no link is written into that folder", () => {
  const { worktree } = checkouts();
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "docs", "README.md"), "# Docs\n");
  symlinkSync("docs", join(worktree, "node_modules"));
  git(worktree, env, "add", "docs", "node_modules");
  const sha = commit(worktree, "a node_modules symlink");
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.match(r.messages, /did not link node_modules: the commit already has node_modules/);
  assert.equal(readlinkSync(join(dir, "node_modules")), "docs");
  assert.deepEqual(readdirSync(join(dir, "docs")), ["README.md"], "a link was written into docs");
});

test("a node_modules folder the commit tracks is kept: the copy exits 0 and no link goes inside it", () => {
  const { worktree } = checkouts();
  mkdirSync(join(worktree, "node_modules"));
  writeFileSync(join(worktree, "node_modules", "kept.txt"), "kept\n");
  git(worktree, env, "add", "node_modules");
  const sha = commit(worktree, "a node_modules folder");
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.match(r.messages, /did not link node_modules: the commit already has node_modules/);
  assert.equal(hasEntry(join(dir, "node_modules", "node_modules")), false);
  assert.equal(readFileSync(join(dir, "node_modules", "kept.txt"), "utf8"), "kept\n");
});

test("a tracked node_modules link to nothing is kept too: the copy exits 0 and the link is unchanged", () => {
  const { worktree } = checkouts();
  symlinkSync("missing", join(worktree, "node_modules"));
  git(worktree, env, "add", "node_modules");
  const sha = commit(worktree, "a dangling node_modules link");
  const dir = newDir();
  const r = scratchCopy([worktree, sha, dir]);
  assert.equal(r.status, 0, r.messages);
  assert.match(r.messages, /did not link node_modules: the commit already has node_modules/);
  assert.equal(readlinkSync(join(dir, "node_modules")), "missing");
});

test("an unparseable package.json or lockfile means differs: no link, and the copy exits 0", () => {
  for (const file of ["package.json", "package-lock.json"]) {
    const { worktree } = checkouts();
    writeFileSync(join(worktree, file), "{ not json\n");
    git(worktree, env, "add", file);
    const dir = newDir();
    const r = scratchCopy([worktree, commit(worktree, `broken ${file}`), dir]);
    assert.equal(r.status, 0, `${file}: ${r.messages}`);
    assert.equal(hasEntry(join(dir, "node_modules")), false, file);
    assert.match(r.messages, /did not link node_modules: package\.json or package-lock\.json differs from /, file);
  }
});

test("two arguments are a usage error", () => {
  const { worktree } = checkouts();
  const r = scratchCopy([worktree, head(worktree)]);
  assert.equal(r.status, 2);
  assert.match(r.messages, /usage: scripts\/scratch-copy\.sh <worktree> <sha> <dir>/);
});

test("a folder inside the worktree, named with its letter case changed, is refused where the volume ignores case", (t: TestContext) => {
  const { worktree } = checkouts();
  const upper = worktree.toUpperCase();
  if (!existsSync(upper)) return t.skip("the temp volume is case-sensitive, so the upper-cased path names no folder");
  const r = scratchCopy([worktree, head(worktree), join(upper, "scratch")]);
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /is inside a git checkout/);
  assert.equal(hasEntry(join(worktree, "scratch")), false);
});

test("a folder inside the worktree, reached through the /System/Volumes/Data prefix, is refused where that prefix exists", (t: TestContext) => {
  const { worktree } = checkouts();
  const prefixed = `/System/Volumes/Data${realpathSync(worktree)}`;
  if (!existsSync(prefixed)) return t.skip("this system has no /System/Volumes/Data prefix");
  const r = scratchCopy([worktree, head(worktree), join(prefixed, "scratch")]);
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /is inside a git checkout/);
  assert.equal(hasEntry(join(worktree, "scratch")), false);
});

test("with CDPATH set to the worktree's parent, a relative worktree name and a relative folder inside it are refused", () => {
  const { worktree } = checkouts();
  const parentOfWorktree = dirname(worktree);
  const r = scratchCopy(
    [basename(worktree), head(worktree), join(basename(worktree), "scratch")],
    { ...env, CDPATH: parentOfWorktree },
    parentOfWorktree,
  );
  assert.equal(r.status, 1, r.messages);
  assert.match(r.messages, /is inside a git checkout/);
  assert.equal(hasEntry(join(worktree, "scratch")), false);
});

test("a relative folder whose first name starts with a dash is made", () => {
  const { worktree } = checkouts();
  const cwd = tempDir("scratch-copy-cwd-");
  mkdirSync(join(cwd, "-dash"));
  const r = scratchCopy([worktree, head(worktree), "-dash/copy"], env, cwd);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(r.printed), realpathSync(join(cwd, "-dash", "copy")));
  assert.equal(existsSync(join(cwd, "-dash", "copy", "package.json")), true);
});

test("a relative folder under a folder named - is made there, not under the previous folder", () => {
  const { worktree } = checkouts();
  const cwd = tempDir("scratch-copy-cwd-");
  mkdirSync(join(cwd, "-"));
  const r = scratchCopy([worktree, head(worktree), "-/copy"], { ...env, OLDPWD: tempDir("scratch-copy-oldpwd-") }, cwd);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(r.printed), realpathSync(join(cwd, "-", "copy")));
});

test("a folder name with a backslash is printed as it is on disk", () => {
  const { worktree } = checkouts();
  const parent = join(tempDir("scratch-copy-backslash-"), "a\\tb");
  mkdirSync(parent);
  const r = scratchCopy([worktree, head(worktree), join(parent, "copy")]);
  assert.equal(r.status, 0, r.messages);
  assert.equal(existsSync(join(r.printed, "package.json")), true, r.printed);
});

test("CDPATH does not move a relative folder: the copy is made under the current folder", () => {
  const { worktree } = checkouts();
  const cwd = tempDir("scratch-copy-cwd-");
  const cdpath = tempDir("scratch-copy-cdpath-");
  mkdirSync(join(cwd, "sub"));
  mkdirSync(join(cdpath, "sub"));
  const r = scratchCopy([worktree, head(worktree), join("sub", "copy")], { ...env, CDPATH: cdpath }, cwd);
  assert.equal(r.status, 0, r.messages);
  assert.equal(realpathSync(r.printed), realpathSync(join(cwd, "sub", "copy")));
  assert.equal(existsSync(join(cdpath, "sub", "copy")), false);
});
