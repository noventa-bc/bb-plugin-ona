// --- child-process-outside-runners.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
// ruleid: child-process-outside-runners
import { spawn } from "node:child_process";
// ruleid: child-process-outside-runners
import { execFile } from "child_process";
// ruleid: child-process-outside-runners
import * as cp from "node:child_process";
// ok: child-process-outside-runners
import { readFile } from "node:fs/promises";

// ruleid: child-process-outside-runners
const legacy = require("node:child_process");

// ok: child-process-outside-runners
const script = String.raw`const { spawn } = require("node:child_process");`;

// ruleid: child-process-outside-runners
const dyn = await import("node:child_process");
void dyn;

// --- console-instead-of-bb-log.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
function fixture(bb: any, error: unknown) {
  // ruleid: console-instead-of-bb-log
  console.log("tunnel up");
  // ruleid: console-instead-of-bb-log
  console.error(error);
  // ok: console-instead-of-bb-log
  bb.log.warn(`tunnel failed: ${String(error)}`);
}

// ok: console-instead-of-bb-log
const remote = String.raw`console.log(JSON.stringify({ ok: true }));`;

// --- ona-lifecycle-outside-onacli.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture2(run: (argv: string[]) => Promise<string>, envId: string) {
  // ruleid: ona-lifecycle-outside-onacli
  await run(["environment", "start", envId]);
  // ruleid: ona-lifecycle-outside-onacli
  await run(["environment", "stop", envId]);
  // ruleid: ona-lifecycle-outside-onacli
  await run(["--quiet", "environment", "delete", envId]);
  // ruleid: ona-lifecycle-outside-onacli
  await run(["environment", "ssh", envId]);
  // ok: ona-lifecycle-outside-onacli
  await run(["environment", "ssh-config"]);
  // ok: ona-lifecycle-outside-onacli
  await run(["environment", "list", "-o", "json"]);
  // ok: ona-lifecycle-outside-onacli
  await run(["environment", "keep-alive", "--environment-id", envId]);
}

// --- remote-script-interpolation.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture3(executor: any, signal: AbortSignal, dir: string, url: string) {
  // ruleid: remote-script-interpolation
  await sshCapture(executor, `mkdir -p ${dir}`, signal);
  // ruleid: remote-script-interpolation
  await sshCapture(executor, `mkdir -p ${shellQuote(dir)} && curl ${url}`, signal);
  // ok: remote-script-interpolation
  await sshCapture(executor, `mkdir -p ${shellQuote(dir)}`, signal);
  // ok: remote-script-interpolation
  await sshCapture(executor, 'mountpoint -q "$HOME"', signal);
  // ok: remote-script-interpolation
  await sshCapture(executor, `true`, signal);
  await executor.exec({
    // ruleid: remote-script-interpolation
    command: ["bash", "-c", `rm -rf ${dir}`],
  });
  await executor.exec({
    // ok: remote-script-interpolation
    command: ["bash", "-c", 'rm -rf "$1"', "bb-ona-fixture", dir],
  });
}

// --- secret-in-kv-key.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture4(bb: any, kv: any, envId: string, value: string) {
  // ruleid: secret-in-kv-key
  await bb.storage.kv.set("ona:token", value);
  // ruleid: secret-in-kv-key
  await bb.storage.kv.set(`password:${envId}`, value);
  // ruleid: secret-in-kv-key
  await kv.set("enroll-Secret", value);
  // ok: secret-in-kv-key
  await bb.storage.kv.set("ona:tunnels", [envId]);
  // ok: secret-in-kv-key
  await kv.set(`connected-at:${envId}`, Date.now());
}
