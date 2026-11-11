import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");

// The fixture's cap is 20, so the default margin of 10 lists a file with more than 10 counted lines.
const config =
  'module.exports = [{ rules: { "max-lines": ["error", { max: 20, skipBlankLines: true, skipComments: true }] } }];\n';

const code = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);
const blank = (n: number) => Array<string>(n).fill("");
const comments = (n: number) => Array.from({ length: n }, (_, i) => `// note ${i}`);
const source = (...parts: string[][]) => `${parts.flat().join("\n")}\n`;

// Counted lines skip the blank and comment lines: at-boundary has 17 lines and counts 10.
const files: Record<string, string> = {
  "at-cap.js": source(code(20)),
  "one-over.js": source(code(11)),
  "at-boundary.js": source(code(10), blank(4), comments(3)),
  "one-under.js": source(code(9), comments(2)),
  "mid.js": source(code(6)),
  "small.js": source(code(3)),
};

/** A folder shaped like the repo for lines.sh: the script, a node_modules link to the repo's, `cfg` as eslint.config.js, and the files above. */
function fixture(cfg = config) {
  const root = tempDir("lines-");
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts", "lines.sh"), join(root, "scripts", "lines.sh"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "eslint.config.js"), cfg);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

/** Runs the fixture's lines.sh with `args`; returns its exit status, stdout, stderr and rows as [count, file]. */
function lines(root: string, args: string[]) {
  const run = spawnSync("sh", [join(root, "scripts", "lines.sh"), ...args], { stdio: "pipe", timeout: 120_000 });
  const rows = String(run.stdout)
    .split("\n")
    .filter((row) => row !== "")
    .map((row) => {
      const match = /^(\d+) (.+)$/.exec(row);
      assert.ok(match, `not a "<count> <file>" row: ${row}`);
      return [Number(match[1]), match[2]!] as const;
    });
  return { status: run.status, stdout: String(run.stdout), stderr: String(run.stderr), rows };
}

test("the default margin of 10 lists exactly the files with more than 10 counted lines, highest first", () => {
  const r = lines(fixture(), []);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.rows, [
    [20, "at-cap.js"],
    [11, "one-over.js"],
  ]);
});

test("a margin of 15 lists the files with more than 5 counted lines", () => {
  const r = lines(fixture(), ["15"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.rows, [
    [20, "at-cap.js"],
    [11, "one-over.js"],
    [10, "at-boundary.js"],
    [9, "one-under.js"],
    [6, "mid.js"],
  ]);
});

test("a margin above the cap lists every file with a count, eslint.config.js included", () => {
  const r = lines(fixture(), ["30"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.rows, [
    [20, "at-cap.js"],
    [11, "one-over.js"],
    [10, "at-boundary.js"],
    [9, "one-under.js"],
    [6, "mid.js"],
    [3, "small.js"],
    [1, "eslint.config.js"],
  ]);
});

test("a config with no max-lines cap exits 1 and says so", () => {
  const r = lines(fixture("module.exports = [];\n"), []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /eslint\.config\.js has no max-lines cap/);
});

test("eslint printing no JSON exits 1 and says so", () => {
  // The cap is still readable, but the config does not parse, so eslint prints nothing to read.
  const r = lines(fixture('module.exports = [{ rules: { "max-lines": ["error", { max: 20 }] } }\n'), []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /printed no JSON/);
});

test("a margin with a leading zero, 09 or 010, is a usage error", () => {
  for (const margin of ["09", "010"]) {
    const r = lines(fixture(), [margin]);
    assert.equal(r.status, 2, margin);
    assert.match(r.stderr, /usage: scripts\/lines\.sh \[margin\]/);
  }
});

test("extra arguments are a usage error", () => {
  const r = lines(fixture(), ["10", "extra"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: scripts\/lines\.sh \[margin\]/);
});

test("a margin that is not a number is a usage error", () => {
  const r = lines(fixture(), ["ten"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: scripts\/lines\.sh \[margin\]/);
});

/** A folder with lines.sh and an eslint stand-in that prints `report` as its JSON in place of ESLint's. */
function withReport(report: unknown[]) {
  const root = tempDir("lines-report-");
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts", "lines.sh"), join(root, "scripts", "lines.sh"));
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  const eslint = join(root, "node_modules", ".bin", "eslint");
  writeFileSync(eslint, `#!/bin/sh\ncat <<'REPORT'\n${JSON.stringify(report)}\nREPORT\n`);
  chmodSync(eslint, 0o755);
  writeFileSync(join(root, "eslint.config.js"), config);
  return root;
}

test("a max-lines finding whose message has no line count fails the run and names the message", () => {
  const r = lines(
    withReport([{ filePath: "a.ts", messages: [{ ruleId: "max-lines", message: "File is long." }] }]),
    [],
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no line count: File is long\./);
});

test("only max-lines findings are rows, whatever another rule's message says", () => {
  const r = lines(
    withReport([
      {
        filePath: "a.ts",
        messages: [{ ruleId: "max-lines", message: "File has too many lines (11). Maximum allowed is 10." }],
      },
      { filePath: "b.ts", messages: [{ ruleId: "no-console", message: "File has too many lines (12)." }] },
    ]),
    [],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.rows, [[11, "a.ts"]]);
});

test("with CDPATH set, a relative invocation prints the rows and nothing else", () => {
  const run = spawnSync("sh", ["scripts/lines.sh"], {
    cwd: fixture(),
    env: { ...process.env, CDPATH: "." },
    stdio: "pipe",
    timeout: 120_000,
  });
  assert.equal(run.status, 0, String(run.stderr));
  assert.equal(String(run.stdout), "20 at-cap.js\n11 one-over.js\n");
});
