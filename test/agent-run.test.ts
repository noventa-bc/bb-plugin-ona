import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { accessible, git, scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "agent-run.sh");

test("agent-run.sh refuses a second argument before it runs anything (fails if the argument is ignored)", () => {
  // An empty PATH: if the check goes, the script stops at its first command instead of starting a run.
  const run = spawnSync("/bin/bash", [script, "a brief", "codex"], {
    stdio: "pipe",
    env: { PATH: tempDir("agent-run-") },
  });
  assert.equal(String(run.stderr), 'usage: scripts/agent-run.sh "<task brief>"\n');
  assert.equal(run.status, 1);
});

// A temp repo holding the script, a HOME whose .claude folder holds `settings` if given and a stub nono first on PATH: nothing real runs.
function stubbedRun(nonoBody: string, settings?: { text: string; mode: number }) {
  const root = tempDir("agent-run-");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const env = scrubbed({ ...process.env, HOME: join(root, "home"), CLAUDE_CODE_OAUTH_TOKEN: "dummy" });
  for (const dir of [join(repo, "scripts"), join(repo, "node_modules"), bin, join(root, "home", ".claude")])
    mkdirSync(dir, { recursive: true });
  copyFileSync(script, join(repo, "scripts", "agent-run.sh"));
  git(repo, env, "init", "-q");
  git(repo, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(bin, "nono"), `#!/bin/sh\necho "$@" > "${root}/nono-args"\n${nonoBody}\n`, { mode: 0o755 });
  const file = join(root, "home", ".claude", "settings.json");
  if (settings) writeFileSync(file, settings.text, { mode: settings.mode });
  env.PATH = `${bin}:${process.env.PATH}`;
  const run = spawnSync("/bin/bash", [join(repo, "scripts", "agent-run.sh"), "a brief"], { env, stdio: "pipe" });
  return {
    run,
    file,
    nonoArgs: existsSync(join(root, "nono-args")) ? readFileSync(join(root, "nono-args"), "utf8") : "",
    worktrees: existsSync(join(root, "bb-ona-worktrees")),
  };
}

test("agent-run.sh runs when ~/.claude/settings.json is missing (fails if a missing file stops the script)", () => {
  // Bug: reading the missing settings file failed the pipeline under pipefail, so the script exited 1 silently.
  const { run, nonoArgs } = stubbedRun("exit 0");
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(nonoArgs, / claude -p /);
  assert.match(String(run.stdout), /^Worktree: /m);
  assert.doesNotMatch(String(run.stderr), /WARNING/);
});

test("agent-run.sh warns when a run creates ~/.claude/settings.json (fails if a new file is not reported)", () => {
  const { run } = stubbedRun('mkdir -p "$HOME/.claude" && echo "{}" > "$HOME/.claude/settings.json"');
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(String(run.stderr), /WARNING: the run changed/);
});

const appendNewline = 'printf "\\n" >> "$HOME/.claude/settings.json"';

test("agent-run.sh warns when a run adds only a final newline to settings.json (fails if content, not a checksum, is compared)", () => {
  const { run } = stubbedRun(appendNewline, { text: "{}", mode: 0o644 });
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(String(run.stderr), /WARNING: the run changed/);
});

test("agent-run.sh stays quiet when a run leaves settings.json unchanged (fails if an existing file always warns)", () => {
  const { run } = stubbedRun("exit 0", { text: "{}\n", mode: 0o644 });
  assert.equal(run.status, 0, String(run.stderr));
  assert.doesNotMatch(String(run.stderr), /WARNING/);
});

test("agent-run.sh stops before the worktree when settings.json is unreadable (fails if a read error counts as empty)", (t) => {
  const { run, file, nonoArgs, worktrees } = stubbedRun("exit 0", { text: "{}", mode: 0o200 });
  if (accessible(file, constants.R_OK)) return t.skip("root reads files whatever their mode");
  assert.notEqual(run.status, 0);
  assert.match(String(run.stderr), /settings\.json/);
  assert.equal(nonoArgs, "");
  assert.equal(worktrees, false);
});
