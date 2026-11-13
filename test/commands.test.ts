import assert from "node:assert/strict";
import { test } from "node:test";
import { commands, onaCommands, parseArgs, usage, type OnaCommandDeps } from "../src/commands.ts";
import { HostGuard } from "../src/reconcile.ts";
import type { ShellBackend, TerminalInfo } from "../src/shells.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";

test("parseArgs: positionals, flags, --json, --thread <id> and a shell command after --", () => {
  assert.deepEqual(parseArgs(["status", "box", "--json"]), {
    command: "status",
    ref: "box",
    newName: undefined,
    json: true,
    threadId: undefined,
    flags: new Set(["--json"]),
    commandArgv: [],
  });
  const ssh = parseArgs(["ssh", "box", "--thread", "thr_1"]);
  assert.equal(ssh.threadId, "thr_1");
  assert.equal(ssh.ref, "box", "the thread id isn't read as a positional");
  assert.equal(parseArgs(["ssh", "box", "--thread"]).threadId, undefined);
  const shell = parseArgs(["shell", "box", "--", "git", "status", "--short"]);
  assert.deepEqual(shell.commandArgv, ["git", "status", "--short"]);
  assert.equal(shell.flags.size, 0, "flags after -- belong to the shell command");
  assert.equal(parseArgs(["rename", "box", "new-name"]).newName, "new-name");
  assert.equal(parseArgs([]).command, undefined);
});

// Dispatch only; list, sync and status also run end to end in
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
    /** The context the command runs in. */
    ctx?: { signal?: AbortSignal };
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
    provider: {
      reconnect: async (resource: { envId: string }) => void calls.push(`reconnect ${resource.envId}`),
      wake: async (resource: { envId: string }, _report: unknown, signal: AbortSignal, via: string, since: number) => {
        calls.push(`wake ${resource.envId} ${via} since=${since} ctxSignal=${signal === extra.ctx?.signal}`);
        return false;
      },
    },
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
    tunnels: { status: () => "up", mark: () => 7 },
    statusRows: async () => [],
    onaHealth: () => ({ lastError: null, listedAt: null, autoRepair: false }),
    resolveEnvId: (ref: string) => Promise.resolve(ref === "box" ? "env_1" : ref),
    markConnected: async (envId: string) => void calls.push(`mark ${envId}`),
  } as unknown as OnaCommandDeps;
  const run = onaCommands(deps);
  return { calls, guard, logs, run: (...argv: string[]) => run(argv, extra.ctx ?? {}) };
}

test("help, --help and no command print the usage", async () => {
  const { run } = fakeRun();
  for (const argv of [["help"], ["--help"], []]) {
    assert.deepEqual(await run(...argv), { exitCode: 0, stdout: usage });
  }
});

test("keep-alive, open and list are neither listed, in the usage nor run (fails if one comes back)", async () => {
  const { run, calls } = fakeRun();
  for (const name of ["keep-alive", "open", "list"]) {
    assert.equal(
      commands.some((c) => c.name === name),
      false,
      name,
    );
    assert.doesNotMatch(usage, new RegExp(`bb ona ${name}\\b`), name);
  }
  assert.deepEqual(await run("keep-alive", "box", "2h"), { exitCode: 1, stderr: usage });
  assert.deepEqual(await run("open", "box"), { exitCode: 1, stderr: usage });
  assert.deepEqual(await run("list"), { exitCode: 1, stderr: usage });
  assert.deepEqual(calls, []);
});

test("bb ona ssh without --thread exits 1 with the --thread usage (fails if the plain form prints an ssh command)", async () => {
  const { run } = fakeRun();
  for (const argv of [
    ["ssh", "box"],
    ["ssh", "box", "--thread"],
  ]) {
    assert.deepEqual(await run(...argv), { exitCode: 1, stderr: "Usage: bb ona ssh <ref> --thread <thread-id>" });
  }
});

test("an unknown command, or one missing its <ref>, exits 1 with the usage", async () => {
  const { run } = fakeRun();
  assert.deepEqual(await run("frobnicate"), { exitCode: 1, stderr: usage });
  assert.deepEqual(await run("host"), { exitCode: 1, stderr: usage });
  assert.deepEqual(await run("resume"), { exitCode: 1, stderr: usage });
  assert.deepEqual(await run("reconnect"), { exitCode: 1, stderr: usage });
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

// The refusal tests below pin that a refused reconnect stamps nothing: their `calls` stay empty.
test("reconnect on an active machine restarts its idle clock and reconnects it (fails if the next pass can let go the box it just reconnected)", async () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(await run("reconnect", "box"), { exitCode: 0, stdout: "Reconnected ona:box" });
  assert.deepEqual(calls, ["mark env_1", "reconnect env_1"]);
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

test("resume wakes the box with the context's signal and the tunnels' mark (fails if either is dropped)", async () => {
  const signal = new AbortController().signal;
  const { run, calls } = fakeRun("active", "RUNNING", { ctx: { signal } });
  assert.deepEqual(await run("resume", "box"), { exitCode: 0, stdout: "Reconnected ona:box" });
  assert.deepEqual(calls, ["wake env_1 wake-cmd since=7 ctxSignal=true"]);
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

/** `bb ona shell box -- make` with bb reporting `terminal` for its run (null: bb no longer knows it), in context `ctx`. */
function shellRun(
  terminal: TerminalInfo | null,
  ctx: { signal?: AbortSignal } = {},
  onPoll = () => {},
  onCreate = () => {},
) {
  const backend: ShellBackend = {
    createTerminal: async () => {
      onCreate();
      return { id: TERMINAL_ID, status: "running", exitCode: null };
    },
    getTerminal: async () => {
      onPoll();
      return terminal;
    },
    output: async () => "out\n",
  };
  const deps = {
    shellTarget: async () => ({ hostId: "host_1", cwd: null, boxName: "box" }),
    shellBackend: backend,
  } as unknown as OnaCommandDeps;
  return onaCommands(deps)(["shell", "box", "--", "make"], ctx);
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

test("a run still alive when its 10-minute wait ends exits 124 with the Still running note, not the no-code one (fails if the no-code check runs first, the 124 branch is gone, its code changes, or a live signal alone picks the stopped-waiting note)", async () => {
  enableFakeClock();
  try {
    const run = shellRun(
      { id: TERMINAL_ID, status: "running", exitCode: null },
      { signal: new AbortController().signal },
    );
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

// Bug: an aborted wait said "Still running after 10 minutes" though no 10 minutes had passed.
test("a run whose signal is aborted before its first poll exits 124 with the stopped-waiting note, not the 10-minute one (fails if a poll runs after the abort, a run created as running is not counted as still running, or the wait loop's abort check is gone)", async () => {
  // Were it polled, bb would report an exit 0: the 124 shows that the wait never polled.
  const controller = new AbortController();
  const exited: TerminalInfo = { id: TERMINAL_ID, status: "exited", exitCode: 0 };
  assert.deepEqual(await shellRun(exited, { signal: controller.signal }, undefined, () => controller.abort()), {
    exitCode: 124,
    stdout: "out\n",
    stderr: `Stopped waiting before the command finished; it may still be running on the box. Follow it with: bb terminal attach ${TERMINAL_ID}`,
  });
});

// Bug: a run cancelled while its box was being looked up still started the command.
test("a run whose signal is aborted before its command starts never creates the terminal and says it was not run (fails if the abort check before createTerminal is gone)", async () => {
  let created = false;
  const result = await shellRun(null, { signal: AbortSignal.abort() }, undefined, () => {
    created = true;
  });
  assert.equal(created, false);
  assert.deepEqual(result, { exitCode: 1, stderr: "Cancelled before the command started; it was not run." });
});

test("a run whose signal is aborted during the wait exits 124 with the stopped-waiting note (fails if the abort is read before the wait starts, or a poll runs after the abort)", async () => {
  const controller = new AbortController();
  const running: TerminalInfo = { id: TERMINAL_ID, status: "running", exitCode: null };
  const abortThenFailOnPoll = () => {
    // sleep resolves at once when its signal is aborted, so a loop that ignores the abort would spin to its 10-minute deadline.
    if (controller.signal.aborted) throw new Error("polled after the abort");
    controller.abort();
  };
  assert.deepEqual(await shellRun(running, { signal: controller.signal }, abortThenFailOnPoll), {
    exitCode: 124,
    stdout: "out\n",
    stderr: `Stopped waiting before the command finished; it may still be running on the box. Follow it with: bb terminal attach ${TERMINAL_ID}`,
  });
});
