import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "bb-source.sh");

// A bb-app folder: a version and a server bundle with two definitions.
const bbApp = tempDir("bb-source-app-");
mkdirSync(join(bbApp, "server", "dist"), { recursive: true });
writeFileSync(join(bbApp, "package.json"), '{\n  "name": "bb-app",\n  "version": "9.9.9"\n}\n');
writeFileSync(
  join(bbApp, "server", "dist", "start-server.js"),
  [
    "const other = 1;",
    "async function listPublicHosts(db) {",
    "  return db;",
    "}",
    "const createMachineBootstrapApi = () => ({});",
    "",
  ].join("\n"),
);

/** Runs bb-source.sh with `args` and the bb-app folder `appDir`; returns the exit status and output. */
function bbSource(args: string[], appDir = bbApp) {
  const env = { ...process.env, BB_APP_DIR: appDir };
  const run = spawnSync(script, args, { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, output: String(run.stdout) + String(run.stderr) };
}

test("prints the bb version, then the definition's line and the lines after it, and no more", () => {
  const r = bbSource(["listPublicHosts", "1"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^bb-app 9\.9\.9: .*start-server\.js$/m);
  assert.match(r.output, /^--- .*start-server\.js:2$/m);
  assert.match(r.output, /^async function listPublicHosts\(db\) \{$/m);
  assert.match(r.output, /^  return db;$/m);
  assert.doesNotMatch(r.output, /^\}$/m, "a line past the requested count is printed");
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

test("--sdk searches the plugin SDK typings in node_modules", () => {
  const r = bbSource(["--sdk", "defineCli", "0"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^--- .*bb-plugin-sdk\.d\.ts:\d+$/m);
  assert.match(r.output, /^declare function defineCli\(spec: PluginCliSpec\)/m);
});

test("a missing name, a non-numeric count or a name that is not an identifier prints the usage and exits 2", () => {
  assert.equal(bbSource([]).status, 2);
  assert.equal(bbSource(["listPublicHosts", "x"]).status, 2);
  assert.equal(bbSource(["list-public-hosts"]).status, 2);
});
