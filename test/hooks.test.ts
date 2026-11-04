import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { accessible, git, scrubbed, tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const env = scrubbed(process.env);
const usersBare = ["", "Users", "x"].join("/");

function writeExecutable(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** Copies a file of this repository to the same path in `dir`, keeping it executable. */
function copyIn(dir: string, file: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  copyFileSync(join(repo, file), join(dir, file));
  chmodSync(join(dir, file), 0o755);
}

/** node_modules with a typechecker and a prettier that succeed, so the hook's preflight and docs check pass. */
function placeholderTools(dir: string) {
  writeExecutable(join(dir, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
  writeExecutable(join(dir, "node_modules", ".bin", "prettier"), "#!/bin/sh\nexit 0\n");
}

// Fake npm and semgrep on PATH. The fake npm records its environment in the file named by NPM_ENV_FILE.
const fakeBin = tempDir("fake-bin-");
writeExecutable(join(fakeBin, "npm"), '#!/bin/sh\nenv > "$NPM_ENV_FILE"\n');
writeExecutable(join(fakeBin, "semgrep"), "#!/bin/sh\nexit 0\n");

/** A repository committed with the pre-commit hook and the scripts it runs, with placeholder tools. */
function hookRepo() {
  const dir = tempDir("hooks-");
  git(dir, env, "init", "-q", "-b", "main");
  for (const file of [".githooks/pre-commit", "scripts/leak-check.sh", "scripts/docs-check.sh"]) copyIn(dir, file);
  writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(dir, "FACTORY.md"), "# Factory\n");
  writeFileSync(join(dir, "README.md"), "# Readme\n");
  git(dir, env, "add", "--all");
  git(dir, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "base");
  placeholderTools(dir);
  return dir;
}

/** Runs the pre-commit hook in `dir`; the fake npm writes its environment to `npmEnvFile`. */
function runHook(dir: string, npmEnvFile: string, extra: NodeJS.ProcessEnv = {}) {
  const run = spawnSync("sh", [".githooks/pre-commit"], {
    cwd: dir,
    env: { ...env, PATH: `${fakeBin}:${process.env.PATH}`, NPM_ENV_FILE: npmEnvFile, ...extra },
    stdio: "pipe",
    timeout: 60_000,
  });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

function newEnvFile() {
  return join(tempDir("npm-env-"), "env.txt");
}

test("a file staged and then edited again is refused, naming the file", () => {
  const dir = hookRepo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, env, "add", "a.txt");
  writeFileSync(join(dir, "a.txt"), "two\n");
  const r = runHook(dir, newEnvFile());
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /commit or stash the unstaged edits to a\.txt: the checks read the working tree/);
});

test("a non-ASCII file staged and then edited again is refused too", () => {
  const dir = hookRepo();
  writeFileSync(join(dir, "nótes.txt"), "one\n");
  git(dir, env, "add", "nótes.txt");
  writeFileSync(join(dir, "nótes.txt"), "two\n");
  const r = runHook(dir, newEnvFile());
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /commit or stash the unstaged edits to nótes\.txt: /);
});

test("a file staged without later edits passes the hook", () => {
  const dir = hookRepo();
  writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
  git(dir, env, "add", "b.ts");
  const r = runHook(dir, newEnvFile());
  assert.equal(r.status, 0, r.output);
});

test("the checks run without the GIT_* variables git gives the hook", () => {
  const dir = hookRepo();
  const linked = join(tempDir("hooks-linked-"), "wt");
  git(dir, env, "worktree", "add", "-q", linked, "-b", "linked");
  placeholderTools(linked);
  writeFileSync(join(linked, "c.ts"), "export const c = 1;\n");
  git(linked, env, "add", "c.ts");
  const gitDir = git(linked, env, "rev-parse", "--absolute-git-dir");
  const envFile = newEnvFile();
  const r = runHook(linked, envFile, {
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: join(gitDir, "index"),
    GIT_PREFIX: "",
    GIT_AUTHOR_NAME: "hook",
    GIT_CONFIG_PARAMETERS: "'user.name'='t'",
  });
  assert.equal(r.status, 0, r.output);
  const seen = readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("GIT_"));
  assert.deepEqual(seen, []);
});

test("a commit message holding a bare user folder is refused, and only the path is printed", () => {
  const file = join(tempDir("commit-msg-"), "MSG");
  writeFileSync(file, `chore(hooks): see ${usersBare} and token-x\n`);
  const run = spawnSync("sh", [".githooks/commit-msg", file], { cwd: repo, env, stdio: "pipe", timeout: 30_000 });
  const output = String(run.stdout) + String(run.stderr);
  assert.equal(run.status, 1, output);
  assert.match(output, /leak-check: refused, a personal path/);
  assert.ok(output.includes(usersBare), output);
  assert.doesNotMatch(output, /token-x/);
});

/** A new message file holding `text`. */
function messageFile(text: string) {
  const file = join(tempDir("commit-msg-"), "MSG");
  writeFileSync(file, text);
  return file;
}

/** Runs the commit-msg hook on the message `file`; returns its status and output. */
function commitMsg(file: string) {
  const run = spawnSync("sh", [".githooks/commit-msg", file], { cwd: repo, env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

test("a verbose commit message's diff below the scissors line is checked, and a personal path in it is refused", () => {
  const file = messageFile(
    [
      "fix(notes): remove the personal path",
      "",
      "# ------------------------ >8 ------------------------",
      "# Do not modify or remove the line above.",
      "diff --git a/notes.txt b/notes.txt",
      `-see ${usersBare}/notes`,
      "+see notes",
      "",
    ].join("\n"),
  );
  const r = commitMsg(file);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /^6:/m);
});

test("a verbose commit message naming a file under a home folder is refused, as git's diff headers are checked like any line", () => {
  const homeDoc = ["docs", "home", "x.md"].join("/");
  const r = commitMsg(
    messageFile(
      [
        "docs(notes): add a note",
        "",
        "# ------------------------ >8 ------------------------",
        "# Do not modify or remove the line above.",
        `diff --git a/${homeDoc} b/${homeDoc}`,
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        `+++ b/${homeDoc}`,
        "@@ -0,0 +1 @@",
        "+A clean note.",
        "",
      ].join("\n"),
    ),
  );
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /^5:/m);
});

test("a personal path in an added diff line below the scissors line is refused", () => {
  const file = messageFile(
    [
      "fix(notes): add the personal path",
      "",
      "# ------------------------ >8 ------------------------",
      "# Do not modify or remove the line above.",
      "diff --git a/notes.txt b/notes.txt",
      `+see ${usersBare}/notes`,
      "",
    ].join("\n"),
  );
  const r = commitMsg(file);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /^6:/m);
});

test("a personal path on a line shaped like a diff header is refused outside a diff header (fails if every such line is skipped)", () => {
  const header = ["diff --git a/n.txt b/n.txt", "--- a/n.txt", "+++ b/n.txt", "@@ -1 +1 @@"];
  for (const lines of [
    ["docs: body", "", `--- ${usersBare}/notes`],
    ["docs: removed", "", "# ---- >8 ----", ...header, `--- ${usersBare}/notes`, "+plain"],
    ["docs: added", "", "# ---- >8 ----", ...header, "-plain", `+++ ${usersBare}/notes`],
  ]) {
    assert.equal(commitMsg(messageFile([...lines, ""].join("\n"))).status, 1, lines.join(" | "));
  }
});

// Bug: a Latin-1 byte in a message stopped sed under a UTF-8 locale, so the commit was refused.
test("a message with a byte that is not UTF-8 passes under a UTF-8 locale", () => {
  const file = join(tempDir("commit-msg-"), "MSG");
  writeFileSync(file, Buffer.from("chore(hooks): plain subject\n\ncaf\u00e9 body\n", "latin1"));
  const run = spawnSync("sh", [".githooks/commit-msg", file], {
    cwd: repo,
    env: { ...env, LC_ALL: "en_US.UTF-8" },
    stdio: "pipe",
    timeout: 30_000,
  });
  assert.equal(run.status, 0, String(run.stdout) + String(run.stderr));
});

test("text after a scissors-looking comment line is refused", () => {
  const file = messageFile(
    [
      "chore(hooks): plain message",
      "",
      "# ------------------------ >8 ------------------------",
      `See ${usersBare}/notes.`,
      "",
    ].join("\n"),
  );
  const r = commitMsg(file);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /^4:/m);
});

test("a refusal names the line of the path in the message file, comment lines included", () => {
  const r = commitMsg(messageFile(`chore(hooks): plain message\n\n# a comment\n\nSee ${usersBare}/notes.\n`));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /^5:/m);
});

test("an editor-template comment naming a file under a home folder is not checked", () => {
  const homeDoc = ["docs", "home", "x.md"].join("/");
  const r = commitMsg(messageFile(`chore(hooks): plain message\n\n# \tmodified:   ${homeDoc}\n`));
  assert.equal(r.status, 0, r.output);
});

test("a personal path in the body is still refused, with a comment line after it", () => {
  const r = commitMsg(
    messageFile(`chore(hooks): plain message\n\nSee ${usersBare}/notes.\n\n# Please enter the message\n`),
  );
  assert.equal(r.status, 1, r.output);
  assert.ok(r.output.includes(usersBare), r.output);
});

test("a commit message that cannot be read is refused", (t) => {
  const file = messageFile("chore(hooks): plain message\n");
  chmodSync(file, 0o000);
  if (accessible(file, constants.R_OK))
    return t.skip("chmod does not stop reads here: root, or a filesystem that ignores it");
  const r = commitMsg(file);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /leak-check/);
});

test("a conventional commit message without a personal path passes the commit-msg hook", () => {
  const file = join(tempDir("commit-msg-"), "MSG");
  writeFileSync(file, "chore(hooks): plain message\n");
  const run = spawnSync("sh", [".githooks/commit-msg", file], { cwd: repo, env, stdio: "pipe", timeout: 30_000 });
  assert.equal(run.status, 0, String(run.stderr));
});
