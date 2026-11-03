import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scrubbed } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const prepare: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts.prepare;

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const env = scrubbed(process.env);

function newDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  const run = spawnSync("git", ["-C", dir, ...args], { env, stdio: "pipe" });
  assert.equal(run.status, 0, String(run.stderr));
}

/** Run the package.json prepare script in `dir` the way npm does: through sh, from the package folder. */
function runPrepare(dir: string) {
  return spawnSync("sh", ["-c", prepare], { cwd: dir, env, stdio: "pipe" });
}

/** The core.hooksPath set in the repository `dir` itself (not inherited from a global config), if any. */
function localHooksPath(dir: string) {
  const run = spawnSync("git", ["-C", dir, "config", "--local", "--get", "core.hooksPath"], { env, stdio: "pipe" });
  return run.status === 0 ? String(run.stdout).trim() : undefined;
}

test("a folder without .git installs without error", () => {
  const run = runPrepare(newDir("prepare-copy-"));
  assert.equal(run.status, 0, String(run.stderr));
});

test("a plugin folder inside another repository leaves that repository's hooks path alone", () => {
  const outer = newDir("prepare-outer-");
  git(outer, "init", "-q");
  const inner = join(outer, "plugin");
  mkdirSync(inner);
  const run = runPrepare(inner);
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(localHooksPath(outer), undefined);
});

test("a repository root gets core.hooksPath set to .githooks", () => {
  const dir = newDir("prepare-repo-");
  git(dir, "init", "-q");
  assert.equal(runPrepare(dir).status, 0);
  assert.equal(localHooksPath(dir), ".githooks");
});
