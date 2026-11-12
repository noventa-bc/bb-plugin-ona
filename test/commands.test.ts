import assert from "node:assert/strict";
import { test } from "node:test";
import {
  keepAliveCommand,
  onaCommands,
  parseArgs,
  usage,
  type KeepAliveDeps,
  type OnaCommandDeps,
} from "../src/commands.ts";
import type { OnaEnvironment } from "../src/ona.ts";
import { HostGuard } from "../src/reconcile.ts";
import type { ShellBackend, TerminalInfo } from "../src/shells.ts";
import { AmbiguousRefError } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";

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

function keepAlive(phase: string | null, options: { listing?: "fail"; listingError?: string; machine?: boolean } = {}) {
  const started: Array<[string, number]> = [];
  const stopped: string[] = [];
  const envs: OnaEnvironment[] =
    phase === null
      ? []
      : [{ id: "env-1", metadata: { name: "brave-otter" }, status: { phase: `ENVIRONMENT_PHASE_${phase}` } }];
  const error = options.listingError ?? "not logged in";
  const deps: KeepAliveDeps = {
    snapshot: {
      refresh: async () => {
        if (options.listing === "fail") throw new Error(error);
        return { envs, at: 0 };
      },
      lastError: options.listing === "fail" ? error : null,
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
    [keepAlive("RUNNING", { listing: "fail", listingError: "" }), /Can't ask Ona.*\(no listing\); nothing changed/],
    [keepAlive("RUNNING", { listing: "fail", listingError: "\nnot logged in" }), /\(not logged in\); nothing changed/],
    [
      keepAlive("RUNNING", { listing: "fail", listingError: "unauthenticated\nRun 'ona login' first" }),
      /Can't ask Ona.*\(unauthenticated\nRun 'ona login' first\); nothing changed/,
    ],
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

// Guard: keep-alive off on a shared name must refuse, not answer "had no keep-alive" and leave the keep-alive running.
test("keep-alive off on a name two devboxes share is refused, and stops nothing (fails if the ambiguity is swallowed)", async () => {
  const { deps, stopped } = keepAlive(null);
  const shared = { ...deps, resolveEnvId: async () => Promise.reject(new AmbiguousRefError("shared matches 2")) };
  await assert.rejects(keepAliveCommand(shared, "shared", "off"), AmbiguousRefError);
  assert.deepEqual(stopped, []);
});

// Dispatch only; list, sync, status and keep-alive also run end to end in
// test/e2e-commands.test.ts. The fake holds just what these cases call.

const ROW = { hostId: "host_1", machine: "ona:box", status: "active", phase: "active", resource: { envId: "env_1" } };

/**
 * `phase`: the bb lifecycle phase of the one machine. `ona`: its Ona phase, or null when Ona doesn't list it.
 * `extra`: `listingFails` makes the listing throw `listingError`; `duringListing` runs while the listing is taken,
 * with the guard and the machine, so an action can start, a suspend can finish, or the machine can be replaced.
 */
function fakeRun(
  phase = "active",
  ona: string | null = "RUNNING",
  extra: {
    listingFails?: boolean;
    listingError?: string;
    /** bb lists no machine for the box (an Ona environment bb doesn't manage). */
    noMachine?: boolean;
    /** bb's machine list rejects. */
    machinesFails?: boolean;
    duringListing?: (guard: HostGuard, machine: { phase: string; hostId: string; machine: string }) => void;
  } = {},
) {
  const calls: string[] = [];
  const logs: string[] = [];
  const machine = { ...ROW, phase };
  const guard = new HostGuard();
  const listingError = extra.listingError ?? "could not reach Ona";
  const envs =
    ona === null
      ? []
      : [
          {
            id: "env_1",
            metadata: { name: "box" },
            status: { phase: `ENVIRONMENT_PHASE_${ona}` },
          },
        ];
  const deps = {
    // Like bb's list: a creating machine is left out unless asked for.
    machines: (options?: { includeCreating?: boolean }) => {
      if (extra.machinesFails) return Promise.reject(new Error("bb is down"));
      return Promise.resolve(
        extra.noMachine || (machine.phase === "creating" && !options?.includeCreating) ? [] : [machine],
      );
    },
    // A fresh row per lookup, as bb gives, so a row the command holds doesn't change under it.
    findMachine: (ref: string) => Promise.resolve(ref === "box" ? { ...machine } : null),
    guard,
    snapshot: {
      refresh: async () => {
        extra.duringListing?.(guard, machine);
        if (extra.listingFails) throw new Error(listingError);
        return { envs, at: 0 };
      },
      lastError: extra.listingFails ? listingError : null,
    },
    provider: { reconnect: async (resource: { envId: string }) => void calls.push(`reconnect ${resource.envId}`) },
    ona: { rename: async (envId: string, name: string) => void calls.push(`rename ${envId} ${name}`) },
    bb: {
      sdk: {
        hosts: {
          update: async (args: { hostId: string; name: string }) => void calls.push(`hosts.update ${args.name}`),
        },
      },
      log: { info: (message: string) => void logs.push(message) },
    },
    updateClis: async (options: { ref?: string; force?: boolean }) => {
      calls.push(`updateClis ${options.ref} ${options.force}`);
      return ["up to date"];
    },
    tunnels: { status: () => "up", mark: () => 0 },
    statusRows: async () => [],
    onaHealth: () => ({ lastError: null, listedAt: null, autoRepair: false }),
    resolveEnvId: (ref: string) => Promise.resolve(ref === "box" ? "env_1" : ref),
    keepAlives: {
      stop: (envId: string) => {
        calls.push(`keepAlives.stop ${envId}`);
        return true;
      },
    },
  } as unknown as OnaCommandDeps;
  const run = onaCommands(deps);
  return { calls, guard, logs, run: (...argv: string[]) => run(argv, {}) };
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

test("sync, reconnect and resume each log one metric cmd line; status and a resume without a ref log none (fails if a case logs before its ref check or another command logs one)", async () => {
  const { run, logs } = fakeRun();
  // status runs to its end, so a cmd line written later in its path would show.
  assert.equal((await run("status")).exitCode, 0);
  await run("resume");
  assert.deepEqual(logs, []);
  await run("sync");
  await run("reconnect", "box");
  await run("resume", "box");
  assert.deepEqual(logs, ["metric cmd name=sync", "metric cmd name=reconnect", "metric cmd name=resume"]);
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

// Bug: rename renamed a box bb was still creating, so a create retry that looks the box up by its name made a second box.
test("rename refuses a machine bb doesn't show active, before any Ona rename", async () => {
  for (const [phase, hint] of [
    ["creating", "Try again once bb shows it active."],
    ["resuming", "Try again once bb shows it active."],
    ["suspending", "Resume it with `bb machine resume ona:box`."],
    ["suspended", "Resume it with `bb machine resume ona:box`."],
    ["removing", "It is gone or being removed."],
    ["destroyed", "It is gone or being removed."],
    // A phase a newer bb adds.
    ["hibernating", "Try again once bb shows it active."],
  ]) {
    const { run, calls } = fakeRun(phase);
    assert.deepEqual(
      await run("rename", "box", "new-name"),
      { exitCode: 1, stderr: `ona:box is ${phase} in bb, so it was not renamed. ${hint}` },
      phase,
    );
    assert.deepEqual(calls, [], phase);
  }
});

test("rename stops before any Ona rename when bb can't list its machines (fails if the check fails open)", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", { machinesFails: true });
  const result = await run("rename", "box", "new-name");
  assert.equal(result.exitCode, 1, result.stdout);
  assert.deepEqual(calls, []);
});

test("rename on a box with no bb machine renames it in Ona only, with no bb update", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", { noMachine: true });
  assert.deepEqual(await run("rename", "box", "new-name"), { exitCode: 0, stdout: "Renamed box -> new-name" });
  assert.deepEqual(calls, ["rename env_1 new-name"]);
});

test("rename on an active machine renames the box in Ona and its bb machine", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await run("rename", "box", "new-name"), {
    exitCode: 0,
    stdout: "Renamed box -> new-name (bb machine ona:new-name)",
  });
  assert.deepEqual(calls, ["rename env_1 new-name", "hosts.update ona:new-name"]);
});

test("reconnect on an active machine reconnects it", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await run("reconnect", "box"), { exitCode: 0, stdout: "Reconnected ona:box" });
  assert.deepEqual(calls, ["reconnect env_1"]);
});

test("update <host id> runs the CLI update for that box with no force, as the Update CLIs button sends it (fails if the ref or the force flag changes)", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await run("update", "host_1"), { exitCode: 0, stdout: "up to date" });
  assert.deepEqual(calls, ["updateClis host_1 false"]);
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
  const resume = "Run `bb ona resume ona:box` to start it and reconnect.";
  const wait = "Try again once Ona shows it running.";
  for (const [ona, state, hint] of [
    ["STOPPED", "stopped", resume],
    ["STOPPING", "stopping", resume],
    ["PENDING", "pending", wait],
    ["CREATING", "creating", wait],
    ["DELETING", "deleting", check],
    ["DELETED", "deleted", check],
  ] as const) {
    const { run, calls } = fakeRun("active", ona);
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

test("reconnect refuses a machine a suspend finished while Ona was listed, without a provider call", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", {
    duringListing: (_guard, machine) => {
      machine.phase = "suspended";
    },
  });
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr: "ona:box is suspended in bb, so it was not reconnected. Resume it with `bb machine resume ona:box`.",
  });
  assert.deepEqual(calls, []);
});

// Bug: a machine replaced during the listing (same name and box, new host id) was reconnected under the old host.
test("reconnect refuses when the machine is replaced while Ona is listed, and never calls the provider", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", {
    duringListing: (_guard, machine) => {
      machine.hostId = "host_2";
    },
  });
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr: "ona:box changed while Ona was asked; run `bb ona reconnect ona:box` again.",
  });
  assert.deepEqual(calls, []);
});

// A replacement under a new name: the hint names the machine the re-check found.
test("a machine replaced under a new name while Ona is listed is named in the refusal", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", {
    duringListing: (_guard, machine) => {
      machine.hostId = "host_2";
      machine.machine = "ona:box-2";
    },
  });
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr: "ona:box changed while Ona was asked; run `bb ona reconnect ona:box-2` again.",
  });
  assert.deepEqual(calls, []);
});

test("reconnect names only the first line of Ona's error when the listing fails", async () => {
  const { run, calls } = fakeRun("active", "RUNNING", {
    listingFails: true,
    listingError: "could not reach Ona\n  at the listing call",
  });
  assert.deepEqual(await run("reconnect", "box"), {
    exitCode: 1,
    stderr:
      "Can't ask Ona whether ona:box is running (could not reach Ona); not reconnected. Check `ona login` and try again.",
  });
  assert.deepEqual(calls, []);
});

// Bug: an empty listing error, or one whose first line is empty, printed "()" in the refusal.
test("reconnect names the first non-blank line of Ona's error, or no listing when there is none", async () => {
  for (const [listingError, reason] of [
    ["", "no listing"],
    ["\ncould not reach Ona", "could not reach Ona"],
    ["  could not reach Ona", "could not reach Ona"],
  ] as const) {
    const { run, calls } = fakeRun("active", "RUNNING", { listingFails: true, listingError });
    assert.deepEqual(
      await run("reconnect", "box"),
      {
        exitCode: 1,
        stderr: `Can't ask Ona whether ona:box is running (${reason}); not reconnected. Check \`ona login\` and try again.`,
      },
      JSON.stringify(listingError),
    );
    assert.deepEqual(calls, []);
  }
});

const TERMINAL_ID = "run-7f3";

/** `bb ona shell box -- make` with bb reporting `terminal` for its run (null: bb no longer knows it). */
function shellRun(terminal: TerminalInfo | null) {
  const backend: ShellBackend = {
    createTerminal: async () => ({ id: TERMINAL_ID, status: "running", exitCode: null }),
    getTerminal: async () => terminal,
    output: async () => "out\n",
  };
  const deps = {
    shellTarget: async () => ({ hostId: "host_1", cwd: null, boxName: "box" }),
    shellBackend: backend,
  } as unknown as OnaCommandDeps;
  return onaCommands(deps)(["shell", "box", "--", "make"], {});
}

// Bug: a run whose exit code bb could not read exited 1 with no message, so it looked like a failed command.
test("shell says bb reported no exit code and exits 1 when the terminal is gone or ended without one (fails if the exit code is 0 or the note is missing)", async () => {
  const unreadable: Array<TerminalInfo | null> = [null, { id: TERMINAL_ID, status: "exited", exitCode: null }];
  for (const terminal of unreadable) {
    assert.deepEqual(await shellRun(terminal), {
      exitCode: 1,
      stdout: "out\n",
      stderr: `bb reported no exit code for the command: it ended without one, or its result could not be read. See: bb terminal attach ${TERMINAL_ID}`,
    });
  }
});

test("shell passes a known exit code through with no note, 0 and 1 included (fails if a real exit 0 or 1 gets the note, or exit 0 becomes 1)", async () => {
  for (const exitCode of [0, 1]) {
    assert.deepEqual(await shellRun({ id: TERMINAL_ID, status: "exited", exitCode }), { exitCode, stdout: "out\n" });
  }
});

test("a run still alive when its 10-minute wait ends exits 124 with the Still running note, not the no-code one (fails if the no-code check runs first, the 124 branch is gone, or its code changes)", async () => {
  enableFakeClock();
  try {
    const run = shellRun({ id: TERMINAL_ID, status: "running", exitCode: null });
    await tick(10 * 60_000);
    assert.deepEqual(await run, {
      exitCode: 124,
      stdout: "out\n",
      stderr: `Still running after 10 minutes. Follow it with: bb terminal attach ${TERMINAL_ID}`,
    });
  } finally {
    await resetFakeClock();
  }
});
