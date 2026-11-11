import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const BASELINE = "scripts/fitness-baseline.txt";

// The fixture's cap is 20, so the default margin of 10 lists a file with more than 10 counted lines.
const config =
  'module.exports = [{ files: ["**/*.ts", "**/*.tsx"], rules: { "max-lines": ["error", { max: 20, skipBlankLines: true, skipComments: true }] } }];\n';

/** `n` lines of code, each one counted by the max-lines rule. */
const codeLines = (n: number) => `${Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;

// One known case for each number. EXPECTED says what each one must print.
const FILES: Record<string, string> = {
  "eslint.config.js": config,
  "package.json": '{ "dependencies": { "zod": "^4.6.5", "hono": "^4.11.9" } }\n',
  "server.ts": [
    "const bb = { settings: { define: (spec) => spec } };",
    "",
    "export function plugin(tick) {",
    "  const settings = bb.settings.define({",
    "    alpha: {",
    '      type: "string",',
    "    },",
    "    beta: {",
    '      type: "number",',
    "    },",
    "  });",
    // Only the settings block counts: gamma is a four-space key after it.
    "  const limits = {",
    "    gamma: {",
    '      type: "distractor",',
    "    },",
    "  };",
    // Two calls on one line: the count is of occurrences, not of lines.
    "  const timers = [setInterval(tick, 1000), setInterval(tick, 2000)];",
    "  return { settings, limits, timers };",
    "}",
    "",
  ].join("\n"),
  "app.tsx": `${codeLines(12)}// shortcut: a line the shortcut count reads\n`,
  "test/near.test.ts": `${codeLines(12)}// shortcut: a line the shortcut count reads\n`,
  "test/fitness.test.ts": "// shortcut: a line in a file the count leaves out\n",
  "src/near.ts": codeLines(12),
  "src/edge.ts": codeLines(10),
  "src/commands.ts": [
    'const sample = { name: "not-a-command" };',
    "",
    "export const commands = [",
    '  { name: "alpha", summary: "a", usage: "bb ona alpha" },',
    '  { name: "beta", summary: "b", usage: "bb ona beta" },',
    '  { name: "gamma", summary: "c", usage: "bb ona gamma" },',
    "];",
    "",
  ].join("\n"),
  "src/reconcile.ts": "export const reconciled = 1;\n",
  // A run-time import of a forbidden module from a layered file: the one violation.
  "src/names.ts": 'import { onaThing } from "./ona.ts";\n\nexport const nameOf = () => onaThing;\n',
  // A type-only import of a forbidden module is not a violation.
  "src/time.ts": 'import type { SshThing } from "./ssh.ts";\n\nexport const now = () => 0;\n',
  "src/machine-inputs.ts": "export const inputs = 1;\n",
  "src/ona.ts": "export const onaThing = 1;\n",
  "src/ssh.ts": "// shortcut: a line in a source file\nexport const sshThing = 1;\n",
  // A value and a type in one import is a run-time import, so this pair is a two-file cycle.
  "src/keepalive.ts":
    'import { parseThing, type LifeType } from "./lifecycle.ts";\n\nexport const keepalive = parseThing;\n',
  "src/lifecycle.ts": 'import { keepalive } from "./keepalive.ts";\n\nexport const parseThing = () => keepalive;\n',
  // A three-file cycle of run-time imports.
  "src/wake.ts": 'import { syncThing } from "./sync.ts";\n\nexport const wakeThing = () => syncThing;\n',
  "src/sync.ts": 'import { updatesThing } from "./updates.ts";\n\nexport const syncThing = () => updatesThing;\n',
  "src/updates.ts": 'import { wakeThing } from "./wake.ts";\n\nexport const updatesThing = () => wakeThing;\n',
  // The loop closes through an import type, so it is not a run-time cycle.
  "src/cost.ts": 'import { rpcThing } from "./rpc.ts";\n\nexport const costThing = () => rpcThing;\n',
  "src/rpc.ts": 'import type { CostThing } from "./cost.ts";\n\nexport const rpcThing = 1;\n',
};

/** The numbers the fixture holds, in fitness.sh's order. */
const EXPECTED: [string, number][] = [
  ["near_cap_src", 3], // src/near.ts, app.tsx and server.ts
  ["near_cap_test", 1], // test/near.test.ts
  ["server_lines", 19],
  ["runtime_deps", 2],
  ["settings", 2],
  ["commands", 3],
  ["intervals", 2],
  ["shortcuts", 3], // app.tsx, src/ssh.ts and test/near.test.ts; test/fitness.test.ts is left out
  ["layering", 1], // src/names.ts imports src/ona.ts at run time
  ["cycles", 2], // the two-file cycle and the three-file cycle
];

/** A baseline file: a comment line, then one `name value` line per number. */
function baselineText(numbers: [string, number][]) {
  return `# A rise needs the owner's yes and is made in the same PR, by editing this file.\n${numbers
    .map(([name, value]) => `${name} ${value}`)
    .join("\n")}\n`;
}

/** EXPECTED with the number `name` set to `value`. */
const withNumber = (name: string, value: number): [string, number][] =>
  EXPECTED.map(([n, v]) => [n, n === name ? value : v]);

/** A folder shaped like the repo for fitness.sh: the script, lines.sh, a node_modules link to the repo's, the baseline and `FILES`, with `files` replacing or adding to them. */
function fixture(files: Record<string, string> = {}) {
  const root = tempDir("fitness-");
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts", "fitness.sh"), join(root, "scripts", "fitness.sh"));
  copyFileSync(join(repo, "scripts", "lines.sh"), join(root, "scripts", "lines.sh"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  const all = { [BASELINE]: baselineText(EXPECTED), ...FILES, ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** Runs the fixture's fitness.sh with `args`; returns its exit status, stdout and stderr. */
function fitness(root: string, args: string[] = []) {
  const run = spawnSync("sh", [join(root, "scripts", "fitness.sh"), ...args], { stdio: "pipe", timeout: 120_000 });
  return { status: run.status, stdout: String(run.stdout), stderr: String(run.stderr) };
}

test("each number is the fixture's known answer, printed in the fixed order", () => {
  const r = fitness(fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, EXPECTED.map(([name, value]) => `${name} ${value}\n`).join(""));
});

test("an import type of Ona from a layered module is not a layering violation", () => {
  const r = fitness(
    fixture({ "src/names.ts": 'import type { OnaThing } from "./ona.ts";\n\nexport const nameOf = () => 0;\n' }),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^layering 0$/m);
});

test("a two-file cycle whose back edge is an import type is not counted, and the three-file cycle still is", () => {
  const r = fitness(
    fixture({
      "src/lifecycle.ts": 'import type { Keepalive } from "./keepalive.ts";\n\nexport const parseThing = () => 0;\n',
    }),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^cycles 1$/m);
});

test("--check passes silently when every number equals its baseline", () => {
  const r = fitness(fixture(), ["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, "");
});

test("--check fails and names a number above its baseline, with both values", () => {
  const r = fitness(fixture({ [BASELINE]: baselineText(withNumber("commands", 2)) }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fitness: commands is 3, above its baseline of 2/);
});

test("--check passes with a note on a number below its baseline", () => {
  const r = fitness(fixture({ [BASELINE]: baselineText(withNumber("intervals", 3)) }), ["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /fitness: intervals is 2, below its baseline of 3/);
});

test("--check fails on a measured name the baseline lacks", () => {
  const r = fitness(fixture({ [BASELINE]: baselineText(EXPECTED.filter(([name]) => name !== "cycles")) }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fitness: cycles is measured but has no line in scripts\/fitness-baseline\.txt/);
});

test("--check fails on a baseline name nothing measures", () => {
  const r = fitness(fixture({ [BASELINE]: baselineText([...EXPECTED, ["retired", 0]]) }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fitness: retired is in scripts\/fitness-baseline\.txt but is not measured/);
});

test("--check without a baseline file fails and names it", () => {
  const root = fixture();
  rmSync(join(root, BASELINE));
  const r = fitness(root, ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fitness: scripts\/fitness-baseline\.txt is missing/);
});

test("any argument other than --check is a usage error", () => {
  const root = fixture();
  for (const args of [["--json"], ["--check", "extra"]]) {
    const r = fitness(root, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: scripts\/fitness\.sh \[--check\]/);
  }
});
