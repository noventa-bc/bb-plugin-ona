import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { envNameForKey } from "../src/provider.ts";
import { daemonEnv, shellQuote, sshCapture, sshExecutor, TunnelManager } from "../src/ssh.ts";
import { pollUntil, sleep } from "../src/time.ts";
import { settle, tick } from "./fake-clock.ts";

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
    for (const envId of ["env-no", "env-throws", "env-yes"]) tunnels.ensure(envId);
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
  tunnels.ensure("env-1");
  tunnels.stop("env-1");
  answer(true);
  await settle();
  assert.equal(spawns, 0);
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
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    tunnels.ensure("env-1");
    await tick(1_000, seconds);
    await settle();
    return times;
  } finally {
    tunnels.stopAll();
    // The aborted sleep removes its fake timer a microtask later; after a reset that removal
    // corrupts the emptied fake queue, and the next test's timers never fire.
    await settle();
    mock.timers.reset();
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
