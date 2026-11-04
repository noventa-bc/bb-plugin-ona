import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./sandbox.ts";

const script = join(import.meta.dirname, "..", "scripts", "node-check.sh");
const running = process.version.slice(1);

/** Runs node-check.sh against an .nvmrc holding `nvmrc` (no file when undefined); returns the exit status and stderr. */
function nodeCheck(nvmrc: string | undefined) {
  const file = join(tempDir("node-check-"), ".nvmrc");
  if (nvmrc !== undefined) writeFileSync(file, nvmrc);
  // The script runs `node` from PATH: put the Node running the tests first so the two agree.
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const run = spawnSync(script, [file], { env, stdio: "pipe", timeout: 30_000 });
  return { status: run.status, stderr: String(run.stderr) };
}

test("the Node running the tests passes when .nvmrc pins that exact version", () => {
  assert.equal(nodeCheck(`${running}\n`).status, 0);
});

test("a Node other than the one .nvmrc pins fails and names the version to install", () => {
  const r = nodeCheck("0.0.0\n");
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /^Node \d+\.\d+\.\d+ is running; \.nvmrc pins 0\.0\.0\. Run `nvm install 0\.0\.0 && nvm use 0\.0\.0`\.$/m,
  );
});

test("a v-prefixed pin and a CRLF pin both pass when they name the running version", () => {
  assert.equal(nodeCheck(`v${running}\n`).status, 0);
  assert.equal(nodeCheck(`${running}\r\n`).status, 0);
});

test("a missing .nvmrc fails with a message that says so", () => {
  const r = nodeCheck(undefined);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing or empty/);
});

test("an .nvmrc with nothing but whitespace fails with a message that says so", () => {
  const r = nodeCheck("\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing or empty/);
});
