import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

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

// A temp repo holding the script, a HOME with no .claude folder and a stub nono first on PATH: nothing real runs.
function stubbedRun(nonoBody: string) {
  const root = tempDir("agent-run-");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const env = scrubbed({ ...process.env, HOME: join(root, "home"), CLAUDE_CODE_OAUTH_TOKEN: "dummy" });
  for (const dir of [join(repo, "scripts"), join(repo, "node_modules"), bin, env.HOME!])
    mkdirSync(dir, { recursive: true });
  copyFileSync(script, join(repo, "scripts", "agent-run.sh"));
  git(repo, env, "init", "-q");
  git(repo, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(bin, "nono"), `#!/bin/sh\necho "$@" > "${root}/nono-args"\n${nonoBody}\n`, { mode: 0o755 });
  env.PATH = `${bin}:${process.env.PATH}`;
  const run = spawnSync("/bin/bash", [join(repo, "scripts", "agent-run.sh"), "a brief"], { env, stdio: "pipe" });
  return { run, nonoArgs: existsSync(join(root, "nono-args")) ? readFileSync(join(root, "nono-args"), "utf8") : "" };
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
