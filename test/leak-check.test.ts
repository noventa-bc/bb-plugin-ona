import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "leak-check.sh");

// Built from parts, so that this file does not contain the personal paths it looks for.
const usersFolder = ["", "Users", "x", ""].join("/");
const usersBare = ["", "Users", "x"].join("/");
const homeBare = ["", "home", "x"].join("/");

const env = scrubbed(process.env);

/** A new repository whose index holds `files`; returns the status and output of leak-check.sh on it. */
function leakCheck(files: Record<string, string>) {
  const dir = tempDir("leak-check-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, env, "init", "-q");
  git(dir, env, "add", "--all");
  const run = spawnSync(script, [dir], { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

test("a staged file holding a user folder under the Users root fails the check and is named", () => {
  const r = leakCheck({ "notes.txt": `first line\nsee ${usersFolder}notes\n` });
  assert.equal(r.status, 1);
  assert.match(r.output, /notes\.txt:2:/);
});

test("a staged file holding a user folder under the home root fails the check and is named", () => {
  const r = leakCheck({ "notes.txt": `see ${homeBare}/notes\n` });
  assert.equal(r.status, 1);
  assert.match(r.output, /notes\.txt:1:/);
});

const bareForms: [string, string][] = [
  ["after cd", `cd ${usersBare}`],
  ["in parentheses", `(${usersBare})`],
  ["ending a sentence", `${homeBare}.`],
];
for (const [form, line] of bareForms) {
  test(`a user folder with no trailing slash fails the check when it is ${form}`, () => {
    const r = leakCheck({ "notes.txt": `${line}\n` });
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /notes\.txt:1:/);
  });
}

test("a slash followed by a space, and /usr/local, are not refused", () => {
  const r = leakCheck({ "notes.txt": "use /Users/ or /usr/local here\n" });
  assert.equal(r.status, 0, r.output);
});

test("a match is printed alone, not with the rest of its line", () => {
  const r = leakCheck({ "notes.txt": `token-one ${usersBare} token-two\n` });
  assert.equal(r.status, 1, r.output);
  assert.ok(r.output.includes(`notes.txt:1:${usersBare}`), r.output);
  assert.doesNotMatch(r.output, /token-one|token-two/);
});

test("a binary file holding a user folder fails the check, and its path is not printed", () => {
  const r = leakCheck({ "blob.bin": `\u0000\u0001${usersBare}\u0000` });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Binary file blob\.bin matches/);
  assert.ok(!r.output.includes(usersBare), r.output);
});

test("a clean staged file passes the check", () => {
  const r = leakCheck({ "notes.txt": "no personal path here\n" });
  assert.equal(r.status, 0, r.output);
});

test("a staged file whose name git quotes (non-ASCII) is checked too", () => {
  const r = leakCheck({ "nótes.txt": `see ${usersFolder}notes\n` });
  assert.equal(r.status, 1, r.output);
});

test("a commit that keeps an earlier file with a personal path is refused, as git commit --amend keeps it", () => {
  const dir = tempDir("leak-check-");
  writeFileSync(join(dir, "old.txt"), `see ${usersFolder}notes\n`);
  git(dir, env, "init", "-q");
  git(dir, env, "add", "--all");
  git(dir, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "old");
  writeFileSync(join(dir, "new.txt"), "clean\n");
  git(dir, env, "add", "--all");
  const run = spawnSync(script, [dir], { env, stdio: "pipe", timeout: 30_000 });
  assert.equal(run.status, 1, String(run.stdout) + String(run.stderr));
});

// Bug: under a UTF-8 locale, git grep missed a user folder on a line holding a byte that is not UTF-8.
test("a staged file with a user folder after a Latin-1 byte fails the check under a UTF-8 locale", () => {
  const dir = tempDir("leak-check-");
  writeFileSync(join(dir, "notes.txt"), Buffer.from(`caf\u00e9 ${usersFolder}notes\n`, "latin1"));
  git(dir, env, "init", "-q");
  git(dir, env, "add", "--all");
  const run = spawnSync(script, [dir], { env: { ...env, LC_ALL: "C.UTF-8" }, stdio: "pipe", timeout: 30_000 });
  assert.equal(run.status, 1, String(run.stdout) + String(run.stderr));
});
