import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStatus, keepAliveCommand, parseArgs, type KeepAliveDeps } from "../src/commands.ts";
import type { OnaEnvironment } from "../src/ona.ts";
import type { StatusRow } from "../src/sync.ts";

test("parseArgs: positionals, flags, --json, --thread <id> and a shell command after --", () => {
  assert.deepEqual(parseArgs(["status", "box", "--json"]), {
    command: "status",
    ref: "box",
    newName: undefined,
    json: true,
    threadFlag: false,
    threadId: undefined,
    flags: new Set(["--json"]),
    commandArgv: [],
  });
  const ssh = parseArgs(["ssh", "box", "--thread", "thr_1"]);
  assert.equal(ssh.threadFlag, true);
  assert.equal(ssh.threadId, "thr_1");
  assert.equal(ssh.ref, "box", "the thread id isn't read as a positional");
  assert.equal(parseArgs(["ssh", "box", "--thread"]).threadId, undefined);
  const shell = parseArgs(["shell", "box", "--", "git", "status", "--short"]);
  assert.deepEqual(shell.commandArgv, ["git", "status", "--short"]);
  assert.equal(shell.flags.size, 0, "flags after -- belong to the shell command");
  assert.equal(parseArgs(["rename", "box", "new-name"]).newName, "new-name");
  assert.equal(parseArgs([]).command, undefined);
});

function keepAlive(phase: string | null, options: { listing?: "fail"; machine?: boolean } = {}) {
  const started: Array<[string, number]> = [];
  const stopped: string[] = [];
  const envs: OnaEnvironment[] =
    phase === null
      ? []
      : [{ id: "env-1", metadata: { name: "brave-otter" }, status: { phase: `ENVIRONMENT_PHASE_${phase}` } }];
  const deps: KeepAliveDeps = {
    snapshot: {
      refresh: async () => {
        if (options.listing === "fail") throw new Error("not logged in");
        return { envs, at: 0 };
      },
      lastError: options.listing === "fail" ? "not logged in" : null,
    },
    findMachine: async () => (options.machine ? { resource: { envId: "env-1" } } : null),
    resolveEnvId: async (ref) => (ref === "brave-otter" ? "env-1" : ref),
    keepAlives: {
      start: (envId, ms) => {
        started.push([envId, ms]);
        return 0;
      },
      stop: (envId) => {
        stopped.push(envId);
        return envId === "env-1";
      },
    },
  };
  return { deps, started, stopped };
}

test("keep-alive starts only on a box a fresh listing shows running, found by machine or Ona name", async () => {
  for (const machine of [true, false]) {
    const { deps, started } = keepAlive("RUNNING", { machine });
    const result = await keepAliveCommand(deps, "brave-otter", "2h");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(started, [["env-1", 2 * 3_600_000]]);
  }
});

test("keep-alive refuses, and starts nothing, for a stopped, unknown or unlistable box", async () => {
  const cases: Array<[ReturnType<typeof keepAlive>, RegExp]> = [
    [keepAlive("STOPPED"), /is stopped in Ona.*never starts one/],
    [keepAlive("STARTING"), /is starting in Ona/],
    [keepAlive(null), /Ona lists no devbox matching/],
    [keepAlive("RUNNING", { listing: "fail" }), /Can't ask Ona.*not logged in.*nothing changed/],
  ];
  for (const [{ deps, started }, message] of cases) {
    const result = await keepAliveCommand(deps, "brave-otter", "1h");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", message);
    assert.deepEqual(started, []);
  }
});

test("keep-alive checks the duration before asking Ona", async () => {
  for (const value of [undefined, "13h", "forever", "0"]) {
    const { deps, started } = keepAlive("RUNNING", { listing: "fail" });
    const result = await keepAliveCommand(deps, "brave-otter", value);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /Usage: bb ona keep-alive/);
    assert.deepEqual(started, []);
  }
});

test("keep-alive off ends it by machine, Ona name or a box Ona no longer lists", async () => {
  const { deps, stopped } = keepAlive(null);
  assert.match((await keepAliveCommand(deps, "brave-otter", "off")).stdout ?? "", /Ended the keep-alive/);
  assert.match((await keepAliveCommand(deps, "env-9", "off")).stdout ?? "", /had no keep-alive/);
  assert.deepEqual(stopped, ["env-1", "env-9"]);
});

const row = (overrides: Partial<StatusRow> = {}): StatusRow => ({
  machine: "ona:brave-otter",
  hostId: "host_1",
  bb: "connected",
  tunnel: "up",
  ona: "running",
  now: null,
  last: null,
  retry: null,
  keepAliveUntil: null,
  needsRecovery: 0,
  ...overrides,
});
const NOW = 1_000_000_000;

test("status text: header for a healthy, failing or unrepaired CLI", () => {
  const healthy = { lastError: null, listedAt: NOW - 8_000, autoRepair: true };
  assert.equal(formatStatus([], healthy, NOW), "Ona CLI: ok, listed 8s ago\nNo Ona machines yet.");
  assert.match(formatStatus([], { ...healthy, autoRepair: false }, NOW), /\(autoRepair is off\)/);
  assert.match(
    formatStatus([], { lastError: "not logged in\nmore", listedAt: null, autoRepair: true }, NOW),
    /^Ona CLI: ERROR not logged in \(run `ona login`\?\)/,
  );
});

test("status text: one block per machine with what the plugin saw, did and is waiting on", () => {
  const text = formatStatus(
    [
      row({
        now: { reason: "connected", since: NOW - 120_000 },
        last: {
          action: "release-idle",
          reason: "idle for 1h",
          at: NOW - 3 * 3_600_000,
          error: "bb kept the machine active",
        },
        retry: "retrying after 10:00:00",
        needsRecovery: 2,
      }),
    ],
    { lastError: null, listedAt: NOW, autoRepair: true },
    NOW,
  );
  const lines = text.split("\n");
  assert.equal(lines[1], "ona:brave-otter  bb:connected  tunnel:up  ona:running");
  assert.equal(lines[2], "  now: connected (since 2m ago)");
  assert.equal(lines[3], "  last action: release-idle: idle for 1h (3h ago) ERROR bb kept the machine active");
  assert.equal(lines[4], "  retrying after 10:00:00");
  assert.match(lines[5]!, /^  2 workspace\(s\) need recovery; .*bb environment list --host host_1/);
});
