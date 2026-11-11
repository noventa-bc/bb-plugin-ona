import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "bb-source.sh");

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
  "",
].join("\n");

/** A bb-app folder with `pkg` as its package.json and the bundle above as its server bundle. */
function bbAppFolder(pkg: string) {
  const dir = tempDir("bb-source-app-");
  mkdirSync(join(dir, "server", "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), pkg);
  writeFileSync(join(dir, "server", "dist", "start-server.js"), bundle);
  return dir;
}

const bbApp = bbAppFolder('{\n  "name": "bb-app",\n  "version": "9.9.9"\n}\n');

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

test("a `const <name> =` definition is found", () => {
  const r = bbSource(["createMachineBootstrapApi", "0"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^const createMachineBootstrapApi = \(\) => \(\{\}\);$/m);
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
