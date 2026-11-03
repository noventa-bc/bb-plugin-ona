import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const script = join(import.meta.dirname, "..", "scripts", "pr-merge.sh");
const fakeGh = join(import.meta.dirname, "fake-gh.sh");

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Run pr-merge.sh against fake-gh.sh; return its exit status, stderr and the gh calls it made. */
function merge(files: string, behind: string) {
  const dir = mkdtempSync(join(tmpdir(), "pr-merge-"));
  dirs.push(dir);
  symlinkSync(fakeGh, join(dir, "gh"));
  const log = join(dir, "gh.log");
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_GH_FILES: files,
    FAKE_GH_BEHIND: behind,
    FAKE_GH_LOG: log,
  };
  // spawnSync blocks the event loop, so the test timeout cannot stop a script stuck in its wait loop.
  const run = spawnSync(script, ["7"], { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, stderr: String(run.stderr), calls: readFileSync(log, "utf8") };
}

test("a version bump behind main is refused: squashed, it would repeat a released version", () => {
  const r = merge("package.json\nsrc/a.ts", "1");
  assert.notEqual(r.status, 0);
  assert.match(r.calls, /^api repos\/\{owner\}\/\{repo\}\/compare\/main\.\.\.headRefOid --jq \.behind_by$/m);
  assert.match(r.stderr, /not up to date with main \(behind by: 1\)/);
  assert.doesNotMatch(r.calls, /^pr merge/m);
});

test("a version bump is refused when GitHub can't say how far behind main it is", () => {
  const r = merge("package.json", "fail");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /behind by: unknown/);
  assert.doesNotMatch(r.calls, /^pr merge/m);
});

test("a PR without package.json merges when behind main; a bump merges when up to date", () => {
  assert.match(merge("src/a.ts", "1").calls, /^pr merge 7 /m);
  // Only the root package.json carries the released version.
  assert.match(merge("x/package.json\npackage-lock.json", "1").calls, /^pr merge 7 /m);
  assert.match(merge("package.json\nsrc/a.ts", "0").calls, /^pr merge 7 /m);
});
