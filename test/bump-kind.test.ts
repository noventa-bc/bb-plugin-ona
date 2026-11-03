import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scrubbed } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "bump-kind.sh");

/** A throwaway repo with one commit on main, and a helper that runs git in it. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "bump-kind-"));
  const env = scrubbed(process.env);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env }).toString();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const kind = (title: string) =>
    execFileSync(script, [title, "main"], { cwd: dir, input: "", stdio: "pipe", env }).toString().trim();
  const stage = (name: string) => {
    writeFileSync(join(dir, name), "x\n");
    git("add", name);
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
