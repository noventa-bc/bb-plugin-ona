import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// The agent sandbox hides other processes from `ps`; tests that need to see them run in CI and outside the sandbox.
export const sandboxed = {
  skip: process.env.NONO_CAP_FILE ? "needs to see other processes, hidden in the agent sandbox" : false,
};

// git gives hooks GIT_DIR and the like; a test that makes its own repository must not inherit them.
export function scrubbed(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A new temp folder, removed when the test file ends. */
export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Whether this process may use `path` in `mode` (fs.constants.R_OK or W_OK). Root and some filesystems ignore chmod. */
export function accessible(path: string, mode: number) {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Runs git in `dir` with `env`, which must succeed; returns its stdout, trimmed. */
export function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const run = spawnSync("git", ["-C", dir, ...args], { env, stdio: "pipe" });
  assert.equal(run.status, 0, String(run.stderr));
  return String(run.stdout).trim();
}
