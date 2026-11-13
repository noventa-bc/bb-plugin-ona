import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

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
