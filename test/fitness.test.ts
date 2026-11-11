import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const repo = join(import.meta.dirname, "..");
const BASELINE = "scripts/fitness-baseline.txt";
const RULE = "a rise needs the owner's yes; a drop is recorded by lowering the baseline in the same PR";

// The fixture's cap is 20, so the default margin of 10 lists a file with more than 10 counted lines. The parser is
// typescript-eslint's, so the fixture's sources can use types as the repo's do.
const config = [
  'const tseslint = require("typescript-eslint");',
  'module.exports = [{ files: ["**/*.ts", "**/*.tsx"], languageOptions: { parser: tseslint.parser }, rules: { "max-lines": ["error", { max: 20, skipBlankLines: true, skipComments: true }] } }];',
  "",
].join("\n");

/** `n` lines of code, each one counted by the max-lines rule. */
const codeLines = (n: number) => `${Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n`;

// One known case for each number. The settings include a type argument on the define call and a quoted key; the commands
// constant is wrapped in as const and satisfies; a settings-like key sits before the define call and a command-like array
// after the commands array.
const FILES: Record<string, string> = {
  "eslint.config.js": `${config}// shortcut: a config comment, counted\n`,
  "package.json":
    '{ "dependencies": { "zod": "^4.6.5", "hono": "^4.11.9" }, "devDependencies": { "typescript": "^5.7.0" } }\n',
  "server.ts": [
    'import { helper } from "./src/helper.ts";',
    "",
    "// shortcut: a server comment, counted",
    "const bb = { settings: { define: (spec: unknown) => spec } };",
    "const limits = {",
    '  gamma: { type: "distractor" },',
    "};",
    "",
    "export function plugin(tick: () => void) {",
    "  const settings = bb.settings.define<Record<string, unknown>>({",
    "    alpha: {",
    '      type: "string",',
    "    },",
    '    "beta": {',
    '      type: "number",',
    "    },",
    "  });",
    "  const timers = [setInterval(tick, 1000), setInterval(tick, 2000)];",
    "  return { settings, limits, timers, helper };",
    "}",
    "",
  ].join("\n"),
  // Twelve counted lines, and one setInterval( that counts.
  "app.tsx": `${codeLines(11)}setInterval(() => undefined, 5000);\n// shortcut: an app comment, counted\n`,
  // Twelve counted lines; the setInterval( here is outside the intervals scope and must not count.
  "test/near.test.ts": `${codeLines(11)}setInterval(() => undefined, 1);\n// shortcut: a test comment, counted\n`,
  "test/fitness.test.ts": "// shortcut: a line in a file the count leaves out\n",
  ".githooks/pre-commit": "#!/bin/sh\n# shortcut: a hook comment, counted\nexit 0\n",
  "scripts/extra.sh": "# shortcut: a script comment, counted\n",
  "src/near.ts": codeLines(12),
  "src/eleven.ts": codeLines(11),
  "src/edge.ts": codeLines(10),
  "src/commands.ts": [
    'const sample = { name: "not-a-command" };',
    "",
    "export const commands = ([",
    '  { name: "alpha", summary: "a", usage: "bb ona alpha" },',
    '  { name: "beta", summary: "b", usage: "bb ona beta" },',
    '  { name: "gamma", summary: "c", usage: "bb ona gamma" },',
    "] as const) satisfies readonly { name: string }[];",
    'const extra = [{ name: "not-a-command" }, { name: "neither" }];',
    "",
  ].join("\n"),
  "src/ssh.ts":
    "// shortcut: a source comment, counted\n// setInterval( in a comment counts too\nexport const sshThing = 1;\n",
  "src/ona.ts": "export const onaThing = 1;\n",
  // One forbidden load in each layered file: names by import, time by require, reconcile by import(), and
  // machine-inputs by export from.
  "src/names.ts": 'import { onaThing } from "./ona.ts";\n\nexport const nameOf = () => onaThing;\n',
  "src/time.ts": 'const ssh = require("./ssh.ts");\n\nexport const now = () => ssh;\n',
  "src/reconcile.ts": 'export const reconcileLoad = () => import("./provider.ts");\n',
  "src/machine-inputs.ts": 'export { syncThing } from "./sync.ts";\n',
  // Two modules that import each other; one import mixes a value with a type, which is still run-time.
  "src/keepalive.ts":
    'import { parseThing, type LifeType } from "./lifecycle.ts";\n\nexport const keepalive = parseThing;\n',
  "src/lifecycle.ts": 'import { keepalive } from "./keepalive.ts";\n\nexport const parseThing = () => keepalive;\n',
  // Three modules in a run-time loop.
  "src/wake.ts": 'import { syncThing } from "./sync.ts";\n\nexport const wakeThing = () => syncThing;\n',
  "src/sync.ts": 'import { updatesThing } from "./updates.ts";\n\nexport const syncThing = () => updatesThing;\n',
  "src/updates.ts": 'import { wakeThing } from "./wake.ts";\n\nexport const updatesThing = () => wakeThing;\n',
  // A loop closed by an import type is no run-time cycle.
  "src/cost.ts": 'import { rpcThing } from "./rpc.ts";\n\nexport const costThing = () => rpcThing;\n',
  "src/rpc.ts": 'import type { CostThing } from "./cost.ts";\n\nexport const rpcThing = 1;\n',
  // A loop closed by export from.
  "src/exa.ts": 'export * from "./exb.ts";\n',
  "src/exb.ts": 'import "./exa.ts";\n\nexport const exbFlag = 1;\n',
  // A loop through server.ts.
  "src/helper.ts": 'import { plugin } from "../server.ts";\n\nexport const helper = () => plugin;\n',
};

const SERVER_LINES = FILES["server.ts"]!.split("\n").length - 1;

/** The numbers the fixture holds, in fitness.sh's order. */
const EXPECTED: [string, number][] = [
  ["near_cap_src", 4], // src/near.ts, src/eleven.ts, app.tsx and server.ts
  ["near_cap_test", 1], // test/near.test.ts
  ["server_lines", SERVER_LINES],
  ["runtime_deps", 2], // zod and hono; typescript is a devDependency
  ["settings", 2], // alpha and "beta"
  ["commands", 3],
  ["intervals", 4], // two in server.ts, one in app.tsx, one in a comment in src/ssh.ts
  ["shortcuts", 7], // one line each in eslint.config.js, server.ts, app.tsx, src/ssh.ts, test/near.test.ts, .githooks, scripts
  ["layering", 4], // one forbidden load in each layered file
  ["cycles", 9], // keepalive and lifecycle; wake, sync and updates; exa and exb; server and helper
];

/** A baseline file: a comment line, then one `name value` line per number. */
function baselineText(numbers: [string, number][]) {
  const lines = numbers.map(([name, value]) => `${name} ${value}`).join("\n");
  return `# The numbers must equal this file: a rise needs the owner's yes, and a drop is recorded by lowering it, in the same PR.\n${lines}\n`;
}

/** EXPECTED with the number `name` set to `value`. */
const withNumber = (name: string, value: number): [string, number][] =>
  EXPECTED.map(([n, v]): [string, number] => [n, n === name ? value : v]);

/** A folder shaped like the repo for fitness.sh: the script, lines.sh, a node_modules link to the repo's, the baseline and `FILES`; `files` replaces or adds to them. */
function fixture(files: Record<string, string> = {}) {
  const root = tempDir("fitness-");
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts", "fitness.sh"), join(root, "scripts", "fitness.sh"));
  copyFileSync(join(repo, "scripts", "lines.sh"), join(root, "scripts", "lines.sh"));
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
  for (const [name, text] of Object.entries({ [BASELINE]: baselineText(EXPECTED), ...FILES, ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** Runs the fixture's fitness.sh with `args` and `env`; returns its exit status, stdout and stderr. */
function fitness(root: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const run = spawnSync("sh", [join(root, "scripts", "fitness.sh"), ...args], { env, stdio: "pipe", timeout: 120_000 });
  return { status: run.status, stdout: String(run.stdout), stderr: String(run.stderr) };
}

// The layered files other than names.ts, clean, for the tests that vary names.ts.
const CLEAN_LAYERED = {
  "src/time.ts": "export const now = () => 0;\n",
  "src/reconcile.ts": "export const reconciled = 1;\n",
  "src/machine-inputs.ts": "export const inputs = 1;\n",
};

test("each number is the fixture's known answer, in the fixed order", () => {
  const r = fitness(fixture());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, EXPECTED.map(([name, value]) => `${name} ${value}\n`).join(""));
});

test("a layered file counts each load of a forbidden module, and not a computed or template argument", () => {
  const loads = [
    'import { onaThing } from "./ona.ts";',
    'export { sshThing } from "./ssh.ts";',
    'const provider = require("./provider.ts");',
    'export const sync = () => import("./sync.ts");',
    'import "./provider-connect.ts";',
    'import { execFile } from "child_process";',
    'const net = require("node:net");',
    'export const http = () => import("http");',
    'export const https = () => import("node:https");',
    // A second load of ona, and a second spelling of child_process: each counts.
    'import "./ona.ts";',
    'const cp = require("node:child_process");',
    // Neither argument is a plain string literal, so neither counts.
    "const dynamic = require(name);",
    "const templated = require(`./provider.ts`);",
    "",
  ].join("\n");
  const r = fitness(fixture({ ...CLEAN_LAYERED, "src/names.ts": loads }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^layering 11$/m);
});

test("an export type from a forbidden module is not a layering violation", () => {
  const r = fitness(fixture({ "src/machine-inputs.ts": 'export type { SyncThing } from "./sync.ts";\n' }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^layering 3$/m);
});

test("a two-file cycle closed by an import type is not counted", () => {
  const r = fitness(
    fixture({
      "src/lifecycle.ts": 'import type { Keepalive } from "./keepalive.ts";\n\nexport const parseThing = () => 0;\n',
    }),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^cycles 7$/m);
});

test("twelve modules that all import each other finish, and each counts as a cycle", () => {
  const clique: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    const imports = Array.from({ length: 12 }, (_, j) => j)
      .filter((j) => j !== i)
      .map((j) => `import "./clique${j}.ts";`);
    clique[`src/clique${i}.ts`] = `${imports.join("\n")}\n`;
  }
  const r = fitness(fixture(clique));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^cycles 21$/m);
});

test("--check passes silently when the numbers equal the baseline", () => {
  const r = fitness(fixture(), ["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, "");
});

test("--check fails on a number above its baseline, showing the difference and the rule", () => {
  const r = fitness(fixture({ [BASELINE]: baselineText(withNumber("commands", 2)) }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^< commands 2$/m);
  assert.match(r.stderr, /^> commands 3$/m);
  assert.ok(r.stderr.includes(RULE), r.stderr);
});

test("--check fails on a number below its baseline, showing the difference and the rule", () => {
  const r = fitness(fixture({ [BASELINE]: baselineText(withNumber("intervals", 5)) }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^< intervals 5$/m);
  assert.match(r.stderr, /^> intervals 4$/m);
  assert.ok(r.stderr.includes(RULE), r.stderr);
});

test("--check fails on a duplicated baseline line", () => {
  const r = fitness(fixture({ [BASELINE]: `${baselineText(EXPECTED)}commands 3\n` }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^< commands 3$/m);
});

test("--check fails on an extra baseline line for a name nothing measures", () => {
  const r = fitness(fixture({ [BASELINE]: `${baselineText(EXPECTED)}retired 0\n` }), ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^< retired 0$/m);
});

test("--check without a baseline file fails and names it", () => {
  const root = fixture();
  rmSync(join(root, BASELINE));
  const r = fitness(root, ["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fitness: scripts\/fitness-baseline\.txt is missing/);
});

test("a server.ts without a bb.settings.define call fails with a message and prints no number", () => {
  const r = fitness(fixture({ "server.ts": "export const plugin = 1;\n" }));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /bb\.settings\.define/);
});

test("a commands constant that is not exported fails with a message and prints no number", () => {
  const r = fitness(fixture({ "src/commands.ts": "const commands = [1, 2];\n" }));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no exported commands array in src\/commands\.ts/);
});

test("a bb.settings.define object with a spread property fails with a message and prints no number", () => {
  const r = fitness(
    fixture({
      "server.ts": [
        "const bb = { settings: { define: (spec: unknown) => spec } };",
        'const base = { alpha: { type: "string" } };',
        'export const plugin = bb.settings.define({ ...base, beta: { type: "number" } });',
        "",
      ].join("\n"),
    }),
  );
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /spread property/);
});

test("a commands array with a spread element fails with a message and prints no number", () => {
  const r = fitness(
    fixture({
      "src/commands.ts": [
        'const base = [{ name: "alpha" }];',
        'export const commands = ([...base, { name: "beta" }] as const) satisfies readonly { name: string }[];',
        "",
      ].join("\n"),
    }),
  );
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /spread element/);
});

test("a grep that exits 2 fails the run with a message", () => {
  const bin = tempDir("fitness-grep-");
  writeFileSync(join(bin, "grep"), "#!/bin/sh\necho 'grep: stand-in failure' >&2\nexit 2\n");
  chmodSync(join(bin, "grep"), 0o755);
  const r = fitness(fixture(), [], { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /grep failed with exit 2/);
});

test("a node that fails while counting fails the run with a message", () => {
  // The stand-in fails only the count, whose source names typescript; lines.sh's own node calls reach the real node.
  const bin = tempDir("fitness-node-");
  const stand = `#!/bin/sh\ncase "$*" in *typescript*) echo "node stand-in failure" >&2; exit 3 ;; esac\nexec "${process.execPath}" "$@"\n`;
  writeFileSync(join(bin, "node"), stand);
  chmodSync(join(bin, "node"), 0o755);
  const r = fitness(fixture(), [], { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /node could not count the repo/);
});

test("a failing scripts/lines.sh fails the run with a message", () => {
  const r = fitness(fixture({ "scripts/lines.sh": "#!/bin/sh\nexit 3\n" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scripts\/lines\.sh 10 failed/);
});

test("any argument other than --check is a usage error", () => {
  const root = fixture();
  for (const args of [["--json"], ["--check", "extra"], [""]]) {
    const r = fitness(root, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /usage: scripts\/fitness\.sh \[--check\]/);
  }
});
