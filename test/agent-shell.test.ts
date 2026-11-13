import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "agent-shell.sh");

test("agent-shell.sh starts claude with every argument (fails if the first argument is taken as the agent)", () => {
  const repo = tempDir("agent-shell-repo-");
  execFileSync("git", ["init", "-q", repo], { env: scrubbed(process.env) });
  // A stub nono that prints its arguments instead of starting a session.
  const bin = tempDir("agent-shell-bin-");
  writeFileSync(join(bin, "nono"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(join(bin, "nono"), 0o755);
  const run = spawnSync("/bin/bash", [script, "codex", "--resume"], {
    cwd: repo,
    stdio: "pipe",
    env: { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: "x" },
  });
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(String(run.stdout), /\n--\nclaude\ncodex\n--resume\n$/);
});
