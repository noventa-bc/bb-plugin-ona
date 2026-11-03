import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scrubbed } from "./sandbox.ts";

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function newDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Run git in `cwd` with `env`, which must succeed; return its trimmed output. */
function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const run = spawnSync("git", ["-C", cwd, ...args], { env, stdio: "pipe" });
  assert.equal(run.status, 0, String(run.stderr));
  return String(run.stdout).trim();
}

test("git commands in a temp folder never commit into the repository GIT_DIR names", () => {
  const victim = newDir("git-env-victim-");
  const clean = scrubbed(process.env);
  git(victim, clean, "init", "-q", "-b", "main");
  git(victim, clean, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "victim");
  const headBefore = git(victim, clean, "rev-parse", "HEAD");

  // The environment a hook gets in a linked worktree: GIT_DIR names the victim's repository.
  const hooked = { ...process.env, GIT_DIR: join(victim, ".git") };
  const temp = newDir("git-env-temp-");
  const env = scrubbed(hooked);
  git(temp, env, "init", "-q");
  writeFileSync(join(temp, "a.ts"), "export const a = 1;\n");
  git(temp, env, "add", "a.ts");
  git(temp, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

  assert.equal(git(victim, clean, "rev-parse", "HEAD"), headBefore);
});
