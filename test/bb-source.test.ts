import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "bb-source.sh");
const repo = join(import.meta.dirname, "..");

// listPublicHosts is defined on line 2 and again on line 76, with 70 filler lines between the two.
const filler = Array.from({ length: 70 }, (_, i) => `// filler ${i + 1}`);
const bundle = [
  "const other = 1;",
  "async function listPublicHosts(db) {",
  "  return db;",
  "}",
  "const createMachineBootstrapApi = () => ({});",
  ...filler,
  "const listPublicHosts = (db) => db;",
  // Not definitions: a property, a comparison and an arrow's parameter.
  "obj.listPublicHosts = 1;",
  "if (listPublicHosts == null) {}",
  "const next = listPublicHosts => 1;",
  // A definition with no `=`, which only the `const` form finds.
  "declare const typedOnly: number;",
  // A `let` with a value, which only the bare `<name> =` form finds.
  "let letDefined = 1;",
  // An object method and a class method, with and without `async`: definitions. The calls after them are not.
  "const machines = {",
  "  async getResource(hostId) {",
  "    return hostId;",
  "  },",
  "};",
  "class Provider {",
  "  reconcileCleanup() {",
  "    return null;",
  "  }",
  "}",
  "  getResource(1);",
  "foo.getResource(2);",
  "if (getResource(3)) {",
  "  getResource(4); if (ok) {",
  "if (foo.getResource(5)) {",
  // Not definitions either: a line of a multi-line `if` header, an object argument, calls after `await` and `return`,
  // a superclass call that does not start its line, and text with a `;` in its parameters.
  "if (ok &&",
  "    getResource(2)) {",
  "getResource({ run() {",
  "  await getResource(6);",
  "  return getResource(7);",
  "class Mixed extends getResource(9) {",
  "  getResource(a; b) {",
  "",
].join("\n");

/** A bb-app folder with `pkg` as its package.json and `text` (the bundle above by default) as its server bundle. */
function bbAppFolder(pkg: string, text = bundle) {
  const dir = tempDir("bb-source-app-");
  mkdirSync(join(dir, "server", "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), pkg);
  writeFileSync(join(dir, "server", "dist", "start-server.js"), text);
  return dir;
}

const bbPkg = '{\n  "name": "bb-app",\n  "version": "9.9.9"\n}\n';
const bbApp = bbAppFolder(bbPkg);

/** A bb-app folder whose server bundle has `count` definitions of `create`, each with one body line. */
function createDefinitions(count: number) {
  const body = Array.from({ length: count }, () => ["  create(x) {", "    return x;", "  }"]);
  return bbAppFolder(bbPkg, `${body.flat().join("\n")}\n`);
}

/** Runs bb-source.sh with `args` and BB_APP_DIR set to `appDir`; returns the exit status and output. */
function bbSource(args: string[], appDir = bbApp) {
  const env = { ...process.env, BB_APP_DIR: appDir };
  const run = spawnSync(script, args, { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

const usage = /usage: scripts\/bb-source\.sh \[--sdk\] <name> \[lines\]/;

test("prints the bb version, then the definition's line and the lines after it, and no more", () => {
  const r = bbSource(["listPublicHosts", "1"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^bb-app 9\.9\.9: .*start-server\.js$/m);
  assert.match(r.output, /^--- .*start-server\.js:2$/m);
  assert.match(r.output, /^async function listPublicHosts\(db\) \{$/m);
  assert.match(r.output, /^  return db;$/m);
  assert.doesNotMatch(r.output, /^\}$/m, "a line past the requested count is printed");
});

test("each definition gets its own header, and 60 lines follow each one by default", () => {
  const r = bbSource(["listPublicHosts"]);
  assert.equal(r.status, 0, r.output);
  const rows = r.output.split("\n");
  const headers = rows.flatMap((text, i) => (text.startsWith("--- ") ? [i] : []));
  assert.equal(headers.length, 2, r.output);
  assert.match(rows[headers[0]!]!, /start-server\.js:2$/);
  assert.match(rows[headers[1]!]!, /start-server\.js:76$/);
  assert.equal(headers[1]! - headers[0]! - 1, 61, "the definition and the 60 lines after it");
});

test("a `declare const <name>` line with no `=` is found", () => {
  const r = bbSource(["typedOnly", "0"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^declare const typedOnly: number;$/m);
});

test("a `let <name> = value` line is found, through the bare `<name> =` form", () => {
  const r = bbSource(["letDefined", "0"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^let letDefined = 1;$/m);
});

test("an object or class method header, with or without `async`, is found", () => {
  for (const [name, header] of [
    ["getResource", "  async getResource(hostId) {"],
    ["reconcileCleanup", "  reconcileCleanup() {"],
  ] as const) {
    const r = bbSource([name, "0"]);
    assert.equal(r.status, 0, `${name}: ${r.output}`);
    assert.ok(r.output.split("\n").includes(header), `${name}: ${r.output}`);
  }
});

test("a call of the name is not a definition: a statement, a member call, await, return, a header or an object argument", () => {
  const r = bbSource(["getResource", "0"]);
  assert.equal(r.status, 0, r.output);
  const headers = r.output.split("\n").filter((row) => row.startsWith("--- "));
  const definition = bundle.split("\n").indexOf("  async getResource(hostId) {") + 1;
  assert.equal(headers.length, 1, r.output);
  assert.ok(headers[0]!.endsWith(`start-server.js:${definition}`), r.output);
});

test("ten definitions of a name print each one's body lines", () => {
  const r = bbSource(["create", "1"], createDefinitions(10));
  assert.equal(r.status, 0, r.output);
  assert.equal(r.output.split("\n").filter((row) => row === "    return x;").length, 10, r.output);
});

test("eleven definitions print the note first, then each location and first line", () => {
  const r = bbSource(["create", "1"], createDefinitions(11));
  assert.equal(r.status, 0, r.output);
  const rows = r.output.split("\n");
  assert.equal(rows.filter((row) => row.startsWith("--- ")).length, 11, r.output);
  assert.equal(rows.filter((row) => row === "  create(x) {").length, 11, r.output);
  assert.equal(rows.filter((row) => row === "    return x;").length, 0, r.output);
  const note = rows.indexOf(
    "bb-source: 11 definitions of create, so only their first lines are printed; pass a more specific name",
  );
  assert.ok(note >= 0, r.output);
  assert.ok(note < rows.findIndex((row) => row.startsWith("--- ")), "the note comes after the listing");
});

test("a name with no definition fails and says so", () => {
  const r = bbSource(["nothingDefinesThis"]);
  assert.equal(r.status, 1);
  assert.match(r.output, /no definition of nothingDefinesThis in /);
});

test("a missing bb-app folder fails and names BB_APP_DIR", () => {
  const r = bbSource(["listPublicHosts"], join(bbApp, "absent"));
  assert.equal(r.status, 1);
  assert.match(r.output, /no bb server bundle at .*start-server\.js; set BB_APP_DIR/);
});

test("with BB_APP_DIR unset, the bb-app folder inside /Applications/bb.app is the one read", () => {
  const env = { ...process.env };
  delete env.BB_APP_DIR;
  const run = spawnSync(script, ["listPublicHosts", "0"], { env, stdio: "pipe", timeout: 30_000 });
  assert.match(
    String(run.stdout) + String(run.stderr),
    /\/Applications\/bb\.app\/Contents\/Resources\/app\.asar\.unpacked\/node_modules\/bb-app\/server\/dist\/start-server\.js/,
  );
});

test("a bb-app package.json with no version fails and says so", () => {
  const r = bbSource(["listPublicHosts"], bbAppFolder('{\n  "name": "bb-app"\n}\n'));
  assert.equal(r.status, 1);
  assert.match(r.output, /no version in .*package\.json/);
});

test("no name prints the usage and exits 2", () => {
  const r = bbSource([]);
  assert.equal(r.status, 2);
  assert.match(r.output, usage);
});

test("a count with a leading zero, 09 or 010, is a usage error", () => {
  for (const count of ["09", "010"]) {
    const r = bbSource(["listPublicHosts", count]);
    assert.equal(r.status, 2, count);
    assert.match(r.output, usage);
  }
});

test("extra arguments are a usage error", () => {
  const r = bbSource(["listPublicHosts", "5", "extra"]);
  assert.equal(r.status, 2);
  assert.match(r.output, usage);
});

test("a count that is not a number, or a name that is not an identifier, is a usage error", () => {
  for (const args of [["listPublicHosts", "x"], ["list-public-hosts"]]) {
    const r = bbSource(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.output, usage);
  }
});

test("--sdk finds an interface, a const and a generic function in the SDK typings", () => {
  for (const [name, declaration] of [
    ["PluginCliSpec", /^interface PluginCliSpec \{$/m],
    ["rpcErrorCodes", /^declare const rpcErrorCodes\b/m],
    ["defineRpcContract", /^declare function defineRpcContract</m],
  ] as const) {
    const r = bbSource(["--sdk", name, "0"]);
    assert.equal(r.status, 0, `${name}: ${r.output}`);
    assert.match(r.output, /^--- .*bb-plugin-sdk\.d\.ts:\d+$/m);
    assert.match(r.output, declaration);
  }
});

test("--sdk fails with a message when the repo has no SDK typings", () => {
  const root = tempDir("bb-source-root-");
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts", "bb-source.sh"));
  const run = spawnSync("sh", [join(root, "scripts", "bb-source.sh"), "--sdk", "defineCli"], {
    stdio: "pipe",
    timeout: 30_000,
  });
  assert.equal(run.status, 1);
  assert.match(String(run.stderr), /no SDK typings at .*bb-plugin-sdk\.d\.ts; run npm ci/);
});

test("with CDPATH set, a relative invocation of --sdk prints the typings' path and the declaration", () => {
  const run = spawnSync("sh", ["scripts/bb-source.sh", "--sdk", "defineCli", "0"], {
    cwd: repo,
    env: { ...process.env, CDPATH: "." },
    stdio: "pipe",
    timeout: 30_000,
  });
  assert.equal(run.status, 0, String(run.stderr));
  assert.match(
    String(run.stdout),
    /^--- \/.*bb-plugin-sdk\.d\.ts:\d+\ndeclare function defineCli\(spec: PluginCliSpec\)/m,
  );
});

test("a bb-app folder with a backslash in its name is printed as it is on disk", () => {
  const appDir = join(tempDir("bb-source-backslash-"), "app\\tx");
  cpSync(bbApp, appDir, { recursive: true });
  const file = join(appDir, "server", "dist", "start-server.js");
  const r = bbSource(["letDefined", "0"], appDir);
  assert.equal(r.status, 0, r.output);
  assert.ok(r.output.includes(`bb-app 9.9.9: ${file}\n`), r.output);
  assert.ok(r.output.includes(`--- ${file}:`), r.output);
});
