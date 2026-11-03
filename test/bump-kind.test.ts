import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, scrubbed, tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "bump-kind.sh");

/** A throwaway repo with one commit on main, and helpers that run git and bump-kind.sh in it. */
function repo() {
  const dir = tempDir("bump-kind-");
  const env = scrubbed(process.env);
  git(dir, env, "init", "-q", "-b", "main");
  git(dir, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const kind = (title: string) =>
    execFileSync(script, [title, "main"], { cwd: dir, input: "", stdio: "pipe", env }).toString().trim();
  const stage = (name: string) => {
    writeFileSync(join(dir, name), "x\n");
    git(dir, env, "add", name);
  };
  return { kind, stage };
}

test("a staged, uncommitted code change counts toward the bump", () => {
  const r = repo();
  r.stage("a.ts");
  assert.equal(r.kind("fix: a"), "patch");
  assert.equal(r.kind("feat: a"), "minor");
  assert.equal(r.kind("feat!: a"), "major");
  assert.equal(r.kind("refactor: a"), "none");
});

test("a Markdown-only change, or no change, never bumps", () => {
  const r = repo();
  assert.equal(r.kind("fix: a"), "none");
  r.stage("notes.md");
  assert.equal(r.kind("feat: a"), "none");
});
