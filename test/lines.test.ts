import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const script = join(repo, "scripts", "lines.sh");

// Read the cap the way the script does, so a new cap moves these checks with it.
const cap = Number(/"max-lines".*max: (\d+)/.exec(readFileSync(join(repo, "eslint.config.js"), "utf8"))?.[1]);

/** Runs lines.sh with `args`; returns its exit status, its stderr and its rows as [count, file]. */
function lines(args: string[]) {
  const run = spawnSync(script, args, { stdio: "pipe", timeout: 120_000 });
  const rows = String(run.stdout)
    .split("\n")
    .filter((row) => row !== "")
    .map((row) => {
      const match = /^(\d+) (\S+)$/.exec(row);
      assert.ok(match, `not a "<count> <file>" row: ${row}`);
      return [Number(match[1]), match[2]!] as const;
    });
  return { status: run.status, stderr: String(run.stderr), rows };
}

test("with a margin of 450, lists each file over the cap less 450, highest count first, as `<count> <file>`", () => {
  const r = lines(["450"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.rows.length > 0, "no file is listed");
  for (const [count] of r.rows) assert.ok(count > cap - 450, `${count} lines is not over ${cap - 450}`);
  for (let i = 1; i < r.rows.length; i++) {
    assert.ok(r.rows[i - 1]![0] >= r.rows[i]![0], `row ${i + 1} is higher than the row above it`);
  }
});

test("the default margin of 10 lists exactly the files with fewer than 10 lines under the cap", () => {
  const wide = lines(["450"]);
  const narrow = lines([]);
  assert.equal(narrow.status, 0, narrow.stderr);
  assert.deepEqual(
    narrow.rows,
    wide.rows.filter(([count]) => count > cap - 10),
  );
});

test("a margin that is not a number fails with the usage", () => {
  const r = lines(["ten"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: scripts\/lines\.sh \[margin\]/);
});
