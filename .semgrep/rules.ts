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
// Every sshCapture and sshCheck call here is also a hit for ssh-outside-runners (this file
// is outside src/ssh.ts, src/provider.ts and src/provider-connect.ts); an annotation covers one line.
async function fixture3(executor: any, signal: AbortSignal, dir: string, url: string) {
  // ruleid: remote-script-interpolation, ssh-outside-runners
  await sshCapture(executor, `mkdir -p ${dir}`, signal);
  // ruleid: remote-script-interpolation, ssh-outside-runners
  await sshCapture(executor, `mkdir -p ${shellQuote(dir)} && curl ${url}`, signal);
  // ruleid: ssh-outside-runners
  await sshCapture(executor, `mkdir -p ${shellQuote(dir)}`, signal);
  // ruleid: ssh-outside-runners
  await sshCapture(executor, 'mountpoint -q "$HOME"', signal);
  // ruleid: ssh-outside-runners
  await sshCapture(executor, `true`, signal);
  // ruleid: remote-script-interpolation, ssh-outside-runners
  sshCheck(executor, `curl ${url}`, signal, 1);
  // ruleid: ssh-outside-runners
  sshCheck(executor, `curl ${shellQuote(url)}`, signal, 1);
  await executor.exec({
    // ruleid: remote-script-interpolation
    command: ["bash", "-c", `rm -rf ${dir}`],
  });
  await executor.exec({
    // ok: remote-script-interpolation
    command: ["bash", "-c", 'rm -rf "$1"', "bb-ona-fixture", dir],
  });
}

// --- ssh-outside-runners.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture5(sshPath: string, envId: string, signal: AbortSignal, provider: any) {
  // ruleid: ssh-outside-runners
  const executor = sshExecutor(sshPath, envId, []);
  // ruleid: ssh-outside-runners
  await sshExecutor(sshPath, envId, []).exec({ command: ["true"], stdin: "", timeoutMs: 1, signal, onOutput() {} });
  // ok: ssh-outside-runners
  await provider.runCollector(envId, "true", []);
  // ok: ssh-outside-runners
  await provider.daemonAlive({ envId }, signal);
  void executor;
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

// --- raw-sleep-promise.ts ---
// Fixtures for semgrep --test. Not compiled, linted or formatted.
async function fixture6(signal: AbortSignal) {
  // ruleid: raw-sleep-promise
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  // ruleid: raw-sleep-promise
  await new Promise<void>((done) => setTimeout(done, 10));
  // ruleid: raw-sleep-promise
  await new Promise((r) => {
    setTimeout(r, 5_000);
  });
  // ok: raw-sleep-promise
  await sleep(5_000, signal);
  // ok: raw-sleep-promise
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
  // ok: raw-sleep-promise
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 3_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
