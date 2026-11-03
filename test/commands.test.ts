import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatStatus,
  keepAliveCommand,
  onaCommands,
  parseArgs,
  usage,
  type KeepAliveDeps,
  type OnaCommandDeps,
} from "../src/commands.ts";
import type { OnaEnvironment } from "../src/ona.ts";
import { HostGuard } from "../src/reconcile.ts";
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
  stuckThreads: [],
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

// Bug: a box held awake by a thread bb left "active" gave the owner no reason in status.
test("status text names a busy thread with no update for over 6h", () => {
  const text = formatStatus(
    [row({ stuckThreads: [{ id: "thr_1", status: "active", updatedAt: NOW - 9 * 3_600_000 }] })],
    { lastError: null, listedAt: NOW, autoRepair: true },
    NOW,
  );
  assert.equal(
    text.split("\n")[2],
    "  thread thr_1 is active, last updated 9h ago; it holds this box until it ends or is archived",
  );
});

// Dispatch only; list, sync, status and keep-alive also run end to end in
// test/e2e-commands.test.ts. The fake holds just what these cases call.

const ROW = { hostId: "host_1", machine: "ona:box", status: "active", phase: "active", resource: { envId: "env_1" } };

/**
 * `phase`: the bb lifecycle phase of the one machine. `ona`: its Ona phase, or null when Ona doesn't list it.
 * `extra`: `archived` marks the box archived; `listingFails` makes the listing throw; `duringListing` runs
 * while the listing is taken, so a guard action can start then.
 */
function fakeRun(
  phase = "active",
  ona: string | null = "RUNNING",
  extra: { archived?: boolean; listingFails?: boolean; duringListing?: (guard: HostGuard) => void } = {},
) {
  const calls: string[] = [];
  const machine = { ...ROW, phase };
  const guard = new HostGuard();
  const envs =
    ona === null
      ? []
      : [
          {
            id: "env_1",
            metadata: { name: "box", archivedAt: extra.archived ? "2026-01-01T00:00:00Z" : undefined },
            status: { phase: `ENVIRONMENT_PHASE_${ona}` },
          },
        ];
  const deps = {
    machines: () => Promise.resolve([machine]),
    findMachine: (ref: string) => Promise.resolve(ref === "box" ? machine : null),
    guard,
    snapshot: {
      refresh: async () => {
        extra.duringListing?.(guard);
        if (extra.listingFails) throw new Error("could not reach Ona");
        return { envs, at: 0 };
      },
      lastError: extra.listingFails ? "could not reach Ona" : null,
    },
    provider: { reconnect: async (resource: { envId: string }) => void calls.push(`reconnect ${resource.envId}`) },
    tunnels: { status: () => "up" },
    resolveEnvId: (ref: string) => Promise.resolve(ref === "box" ? "env_1" : ref),
    keepAlives: {
      stop: (envId: string) => {
        calls.push(`keepAlives.stop ${envId}`);
        return true;
      },
    },
  } as unknown as OnaCommandDeps;
  const run = onaCommands(deps);
  return { calls, guard, run: (...argv: string[]) => run(argv, {}) };
}

test("help, --help and no command print the usage", async () => {
  const { run } = fakeRun();
  for (const argv of [["help"], ["--help"], []]) {
    assert.deepEqual(await run(...argv), { exitCode: 0, stdout: usage });
  }
});

test("list --json prints the machines with their tunnel status", async () => {
  const { run } = fakeRun();
  const result = await run("list", "--json");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout ?? ""), [{ ...ROW, tunnel: "up" }]);
});

test("keep-alive <ref> off stops the keep-alive of the resolved box", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await run("keep-alive", "box", "off"), { exitCode: 0, stdout: "Ended the keep-alive for box." });
  assert.deepEqual(calls, ["keepAlives.stop env_1"]);
});

test("an unknown command, or one missing its <ref>, exits 1 with the usage", async () => {
  const { run } = fakeRun();
  assert.deepEqual(await run("frobnicate"), { exitCode: 1, stderr: usage });
  assert.deepEqual(await run("host"), { exitCode: 1, stderr: usage });
});

// Bug: reconnect never checked bb's view, so on a suspended machine it opened a tunnel that kept the box awake (decision 0003).
// Bug: the refusal offered `bb machine resume` in every phase, though bb refuses it for most and is already resuming in one;
// then it told a suspending machine to try again, though a suspend never ends active, and printed "undefined" for a phase it didn't know.
test("reconnect on a machine bb doesn't show active exits 1, never reconnects, and gives each phase's next step", async () => {
  const resume = "Resume it with `bb machine resume ona:box`.";
  const wait = "Try again once bb shows it active.";
  const gone = "It is gone or being removed.";
  for (const [phase, hint] of [
    ["suspended", resume],
    ["suspending", resume],
    ["resuming", wait],
    ["creating", wait],
    ["removing", gone],
    ["destroyed", gone],
    // A phase a newer bb adds.
    ["hibernating", wait],
  ]) {
    const { run, calls } = fakeRun(phase);
    assert.deepEqual(
      await run("reconnect", "box"),
      { exitCode: 1, stderr: `ona:box is ${phase} in bb, so it was not reconnected. ${hint}` },
      phase,
    );
    assert.deepEqual(calls, [], phase);
  }
});

test("reconnect on an active machine reconnects it", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await run("reconnect", "box"), { exitCode: 0, stdout: "Reconnected ona:box" });
  assert.deepEqual(calls, ["reconnect env_1"]);
});

test("reconnect refuses when a guard action takes the machine while Ona is listed, and never calls the provider", async () => {
  let release = () => {};
  const { run, calls } = fakeRun("active", "RUNNING", {
    duringListing: (guard) => {
      void guard.run("host_1", "heal-daemon", "sync", () => new Promise<void>((done) => (release = done)));
    },
  });
  const result = await run("reconnect", "box");
  release();
  assert.deepEqual(result, {
    exitCode: 1,
    stderr: "ona:box is busy (heal-daemon); try again shortly or see `bb ona status`.",
  });
  assert.deepEqual(calls, []);
});

test("reconnect refuses a box the Ona listing lacks, without a provider call", async () => {
  const { run, calls } = fakeRun("active", null);
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr:
      "ona:box is not listed in Ona, so it was not reconnected. Check the box in Ona and `bb ona status ona:box`.",
  });
  assert.deepEqual(calls, []);
});

test("reconnect refuses a STARTING box, without a provider call", async () => {
  const { run, calls } = fakeRun("active", "STARTING");
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr: "ona:box is starting in Ona, so it was not reconnected. Try again once Ona shows it running.",
  });
  assert.deepEqual(calls, []);
});

test("reconnect says what to do for each other state Ona can show, and never calls the provider", async () => {
  const check = "Check the box in Ona and `bb ona status ona:box`.";
  const sync = "Run `bb ona sync ona:box` (bb then shows it suspended), then `bb machine resume ona:box`.";
  const wait = "Try again once Ona shows it running.";
  for (const [ona, archived, state, hint] of [
    ["STOPPED", false, "stopped", sync],
    ["STOPPING", false, "stopping", sync],
    ["PENDING", false, "pending", wait],
    ["CREATING", false, "creating", wait],
    ["DELETING", false, "deleting", check],
    ["DELETED", false, "deleted", check],
    ["STOPPED", true, "archived", check],
  ] as const) {
    const { run, calls } = fakeRun("active", ona, { archived });
    assert.deepEqual(
      await run("reconnect", "box"),
      { exitCode: 1, stderr: `ona:box is ${state} in Ona, so it was not reconnected. ${hint}` },
      state,
    );
    assert.deepEqual(calls, [], state);
  }
});

test("reconnect refuses when Ona cannot be asked, and names Ona's error", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", { listingFails: true });
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr:
      "Can't ask Ona whether ona:box is running (could not reach Ona); not reconnected. Check `ona login` and try again.",
  });
  assert.deepEqual(calls, []);
});
