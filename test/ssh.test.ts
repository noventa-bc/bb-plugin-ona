import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import { daemonEnv, shellQuote, sshCapture, sshExecutor, TunnelManager } from "../src/ssh.ts";
import { pollUntil, sleep } from "../src/time.ts";
import { enableFakeClock, resetFakeClock, settle, tick } from "./fake-clock.ts";

const fakeSsh = fileURLToPath(new URL("./fake-ssh.sh", import.meta.url));
const executor = sshExecutor(fakeSsh, "env-1");
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test("shellQuote keeps safe words and quotes the rest", () => {
  assert.equal(shellQuote("node"), "node");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("executor preserves argv, streams output and pipes stdin", async () => {
  let output = "";
  const { exitCode } = await executor.exec({
    command: ["sh", "-c", "printf '%s|' \"$1\"; cat", "_", "two words; $(rm -rf nope)"],
    stdin: "secret-bundle",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onOutput: (chunk) => (output += chunk),
  });
  assert.equal(exitCode, 0);
  assert.equal(output, "two words; $(rm -rf nope)|secret-bundle");
});

test("executor reports nonzero exit codes", async () => {
  const result = await sshCapture(executor, "echo nope; exit 7", new AbortController().signal);
  assert.deepEqual(result, { exitCode: 7, output: "nope\n" });
});

test("executor enforces timeout and abort", async () => {
  await assert.rejects(
    executor.exec({
      command: ["sleep", "5"],
      stdin: "",
      timeoutMs: 200,
      signal: new AbortController().signal,
      onOutput() {},
    }),
    /timed out/,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("cancelled")), 100);
  await assert.rejects(
    executor.exec({ command: ["sleep", "5"], stdin: "", timeoutMs: 10_000, signal: controller.signal, onOutput() {} }),
    /cancelled/,
  );
});

test("environment names are stable per key", () => {
  assert.equal(envNameForKey("k1"), envNameForKey("k1"));
  assert.notEqual(envNameForKey("k1"), envNameForKey("k2"));
  assert.match(envNameForKey("k1"), /^[a-z]+-[a-z-]+-[0-9a-f]{4}$/);
});

test("daemon env keeps Codex SQLite off the shared home only when configured", () => {
  assert.deepEqual(daemonEnv(""), ["BB_INSTALL_SKIP_SERVICE=1"]);
  assert.deepEqual(daemonEnv("/workspaces/x"), ["BB_INSTALL_SKIP_SERVICE=1", "CODEX_SQLITE_HOME=/workspaces/x"]);
});

test("a tunnel runs ssh only when its gate says yes: a gate that says no or throws never reaches the box", async () => {
  // Bug: Ona's SSH starts a stopped box, so any ssh run past a no (or an unanswered) gate wakes it.
  const dir = mkdtempSync(join(tmpdir(), "bb-ona-ssh-"));
  const log = join(dir, "ssh.log");
  process.env.FAKE_SSH_LOG = log;
  const asked: string[] = [];
  const tunnels = new TunnelManager(
    fakeSsh,
    () => 1,
    () => 2,
    quiet,
    async (envId) => {
      asked.push(envId);
      if (envId === "env-throws") throw new Error("ona environment list failed");
      return envId === "env-yes";
    },
  );
  try {
    for (const envId of ["env-no", "env-throws", "env-yes"]) tunnels.ensure(envId, tunnels.mark());
    // env-yes shows a spawn reaches the log; the other two had the same time to (wrongly) spawn.
    const signal = AbortSignal.timeout(10_000);
    assert.ok(
      await pollUntil(async () => existsSync(log) && readFileSync(log, "utf8").includes("env-yes"), {
        deadlineMs: 10_000,
        intervalMs: 20,
        signal,
      }),
      "env-yes never reached ssh",
    );
    await sleep(200);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 1, calls.join("\n"));
    assert.match(calls[0]!, / env-yes\.ona\.environment$/);
    assert.deepEqual(asked.sort(), ["env-no", "env-throws", "env-yes"]);
  } finally {
    tunnels.stopAll();
    delete process.env.FAKE_SSH_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tunnel stopped while its gate asks Ona never runs ssh", async () => {
  // Bug: bb suspended the machine during the gate's listing, the gate then said yes, and an ssh nothing would kill held the box awake.
  let answer = (_yes: boolean) => {};
  let spawns = 0;
  const tunnels = new TunnelManager(
    "true", // if it ran, it exits at once instead of outliving the test
    () => {
      spawns++; // the remote port is read only to spawn ssh
      return 1;
    },
    () => 2,
    quiet,
    () => new Promise((resolve) => (answer = resolve)),
  );
  tunnels.ensure("env-1", tunnels.mark());
  tunnels.stop("env-1");
  answer(true);
  await settle();
  assert.equal(spawns, 0);
});

test("ensure after stopAll starts no tunnel (fails if stopAll leaves ensure open)", async (t) => {
  // Bug: a connect whose last step was already queued when the plugin was disposed reached ensure after
  // stopAll and started a tunnel loop nothing stopped.
  let asked = 0;
  const tunnels = new TunnelManager(
    "true",
    () => 1,
    () => 2,
    quiet,
    async () => {
      asked++;
      return true;
    },
  );
  t.after(() => tunnels.stop("env-1")); // a tunnel loop that starts would hold the process open
  tunnels.stopAll();
  tunnels.ensure("env-1", tunnels.mark());
  await settle();
  assert.equal(tunnels.status("env-1"), "off");
  assert.equal(asked, 0);
});

// Bug: a connect in flight when bb suspended or removed the machine reopened the box's tunnel after the close, and
// nothing closed it again (R25, R31).
test("ensure with a mark older than the box's last stop opens no tunnel and never asks the gate (fails if a connect in flight reopens a removed box's tunnel)", async (t) => {
  let asked = 0;
  const tunnels = new TunnelManager(
    "true",
    () => 1,
    () => 2,
    quiet,
    async () => {
      asked++;
      return false;
    },
  );
  t.after(() => tunnels.stopAll()); // a tunnel loop that starts would hold the process open
  const before = tunnels.mark();
  const other = tunnels.mark();
  tunnels.stop("env-1");
  assert.equal(tunnels.ensure("env-1", before), false);
  assert.equal(tunnels.ensure("env-1", other), false, "a stop after any mark refuses it");
  await settle();
  assert.equal(tunnels.status("env-1"), "off");
  assert.equal(asked, 0);
  assert.equal(tunnels.ensure("env-2", before), true, "another box's stop refuses nothing");
  assert.equal(tunnels.status("env-2"), "connecting");
});

test("ensure with a mark taken after the box's last stop opens the tunnel", async (t) => {
  const tunnels = new TunnelManager(
    "true",
    () => 1,
    () => 2,
    quiet,
    async () => false,
  );
  t.after(() => tunnels.stopAll());
  tunnels.stop("env-1");
  assert.equal(tunnels.ensure("env-1", tunnels.mark()), true);
  assert.equal(tunnels.status("env-1"), "connecting");
});

/** The fake times, in seconds, at which a tunnel asks `gate` over `seconds` of fake time. */
async function askTimes(gate: () => Promise<boolean>, seconds: number): Promise<number[]> {
  const times: number[] = [];
  const tunnels = new TunnelManager(
    fakeSsh,
    () => 1,
    () => 2,
    quiet,
    async () => {
      times.push(Date.now() / 1_000);
      return gate();
    },
  );
  try {
    enableFakeClock();
    tunnels.ensure("env-1", tunnels.mark());
    await tick(1_000, seconds);
    await settle();
    return times;
  } finally {
    tunnels.stopAll();
    await resetFakeClock();
  }
}

test("a tunnel its gate refused asks again every 10 s for a minute, then every minute", async () => {
  // Bug: a refusal waited 60 s, so a box Ona still showed STARTING just after a resume got its tunnel a minute late.
  // Bug: at 10 s forever, a box stopped for good (or stuck) cost 6 Ona listings and 6 passes a minute.
  assert.deepEqual(await askTimes(async () => false, 180), [0, 10, 20, 30, 40, 50, 60, 120, 180]);
});

test("a tunnel whose gate throws (Ona can't be asked) asks again every minute", async () => {
  // Bug: a throw waited 10 s like a refusal, so a logged-out or down Ona CLI was called 6 times a minute per tunnel.
  const gate = () => Promise.reject(new Error("ona environment list failed"));
  assert.deepEqual(await askTimes(gate, 120), [0, 60, 120]);
});
