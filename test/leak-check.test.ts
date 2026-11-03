import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scrubbed } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "leak-check.sh");

// Built from parts, so that this file does not contain the personal paths it looks for.
const usersPath = ["", "Users", "x", ""].join("/");
const homePath = ["", "home", "x", ""].join("/");

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const env = scrubbed(process.env);

function git(dir: string, ...args: string[]) {
  const run = spawnSync("git", ["-C", dir, ...args], { env, stdio: "pipe" });
  assert.equal(run.status, 0, String(run.stderr));
}

/** A new git repository with `files` written and staged. */
function newRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "leak-check-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, "init", "-q");
  git(dir, "add", "--all");
  return dir;
}

function runLeakCheck(dir: string) {
  const run = spawnSync(script, [dir], { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

test("a staged file holding a user folder under the Users root fails the check and is named", () => {
  const r = runLeakCheck(newRepo({ "notes.txt": `first line\nsee ${usersPath}notes\n` }));
  assert.equal(r.status, 1);
  assert.match(r.output, /notes\.txt:2:/);
});

test("a staged file holding a user folder under the home root fails the check and is named", () => {
  const r = runLeakCheck(newRepo({ "notes.txt": `see ${homePath}notes\n` }));
  assert.equal(r.status, 1);
  assert.match(r.output, /notes\.txt:1:/);
});

test("a clean staged file passes the check", () => {
  const r = runLeakCheck(newRepo({ "notes.txt": "no personal path here\n" }));
  assert.equal(r.status, 0, r.output);
});

test("a staged file whose name git quotes (non-ASCII) is checked too", () => {
  const r = runLeakCheck(newRepo({ "nótes.txt": `see ${usersPath}notes\n` }));
  assert.equal(r.status, 1, r.output);
});

test("a commit that keeps an earlier file with a personal path is refused, as git commit --amend keeps it", () => {
  const dir = newRepo({ "old.txt": `see ${usersPath}notes\n` });
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "old");
  writeFileSync(join(dir, "new.txt"), "clean\n");
  git(dir, "add", "--all");
  const r = runLeakCheck(dir);
  assert.equal(r.status, 1, r.output);
});
