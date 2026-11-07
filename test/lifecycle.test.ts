import assert from "node:assert/strict";
import { test } from "node:test";
import {
  idleDisconnectSchema,
  lifecycleRefusal,
  machinesToRelease,
  parseDuration,
  workspaceWork,
  settledLifecycle,
  SUSPENDED,
  type MachineActivity,
} from "../src/lifecycle.ts";
import { enableFakeClock, resetFakeClock, settle, tick } from "./fake-clock.ts";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const machine = (hostId: string, overrides: Partial<MachineActivity> = {}): MachineActivity => ({
  hostId,
  phase: "active",
  threadStatuses: [],
  lastActivityAt: NOW - 60 * MIN,
  ...overrides,
});

test("a machine idle for the window is released", () => {
  assert.deepEqual(machinesToRelease([machine("idle")], NOW, 30 * MIN), ["idle"]);
});

test("busy, recently active, recently connected or non-active machines are kept", () => {
  const hosts = machinesToRelease(
    [
      machine("busy", { threadStatuses: ["idle", "active"] }),
      machine("recent", { lastActivityAt: NOW - 5 * MIN }),
      machine("suspended", { phase: "suspended" }),
      machine("resuming", { phase: "resuming" }),
    ],
    NOW,
    30 * MIN,
  );
  assert.deepEqual(hosts, []);
});

test("a zero window releases nothing", () => {
  assert.deepEqual(machinesToRelease([machine("idle")], NOW, 0), []);
});

test("parseDuration reads s/m/h and bare minutes, and treats junk as off", () => {
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("30m"), 30 * MIN);
  assert.equal(parseDuration("2h"), 120 * MIN);
  assert.equal(parseDuration("1.5h"), 90 * MIN);
  assert.equal(parseDuration("15"), 15 * MIN);
  assert.equal(parseDuration(""), 0);
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("soon"), 0);
});

test("idleDisconnect refuses typos parseDuration reads as off, such as 1h30m, 1d or +30m (fails if the schema accepts one)", () => {
  for (const typo of ["1h30m", "1hr", "90min", "30min", "30ms", "1d", "1 day", "+30m", ".5h", "1.", "1,5h", "m"]) {
    assert.equal(idleDisconnectSchema.safeParse(typo).success, false, typo);
  }
});

test("idleDisconnect takes its documented forms, case and spaces aside, and empty for off, each read as its duration (fails if one is refused or misread)", () => {
  const forms: Record<string, number> = {
    "30m": 30 * MIN,
    "2h": 120 * MIN,
    "45s": 45_000,
    "1.5h": 90 * MIN,
    " 30m ": 30 * MIN,
    "30M": 30 * MIN,
    "30 m": 30 * MIN,
    "90": 90 * MIN,
    "0": 0,
    "": 0,
    "  ": 0,
  };
  for (const [form, ms] of Object.entries(forms)) {
    assert.equal(idleDisconnectSchema.safeParse(form).success, true, JSON.stringify(form));
    assert.equal(parseDuration(form), ms, JSON.stringify(form));
  }
});

test("a lifecycle request bb didn't take is reported with bb's reason", () => {
  assert.equal(lifecycleRefusal({ phase: "suspending", message: null }, SUSPENDED), null);
  assert.equal(lifecycleRefusal({ phase: "suspended", message: null }, SUSPENDED), null);
  assert.equal(lifecycleRefusal(undefined, SUSPENDED), null);
  assert.equal(
    lifecycleRefusal({ phase: "active", message: "Automatic cleanup is blocked" }, SUSPENDED),
    "bb kept the machine active: Automatic cleanup is blocked",
  );
  assert.equal(lifecycleRefusal({ phase: "suspended", message: null }, ["active"]), "bb kept the machine suspended");
});

const workspace = (
  status: string,
  phase = "active",
  teardown: string | null = null,
  retireAt: number | null = null,
) => ({
  status,
  lifecycle: { phase, retireAt, teardown: teardown ? { status: teardown } : null },
});

test("workspaceWork: setup and running teardowns are busy; failed teardowns bb gave up on need recovery", () => {
  assert.deepEqual(workspaceWork([], NOW), { busy: false, needsRecovery: 0 });
  assert.deepEqual(workspaceWork([workspace("ready")], NOW), { busy: false, needsRecovery: 0 });
  assert.deepEqual(workspaceWork([workspace("provisioning")], NOW), { busy: true, needsRecovery: 0 });
  assert.deepEqual(workspaceWork([workspace("creating")], NOW), { busy: true, needsRecovery: 0 });
  assert.deepEqual(workspaceWork([workspace("ready", "teardown", "running")], NOW), { busy: true, needsRecovery: 0 });
  assert.deepEqual(workspaceWork([workspace("ready", "teardown")], NOW), { busy: true, needsRecovery: 0 });
  assert.deepEqual(
    workspaceWork([workspace("error", "teardown", "failed"), workspace("error", "teardown", "failed")], NOW),
    {
      busy: false,
      needsRecovery: 2,
    },
  );
});

// Bug: a failed teardown bb was still retrying counted as needing recovery, so `bb ona status` warned while bb retried.
test("workspaceWork: a failed teardown bb will retry is busy, not needing recovery", () => {
  assert.deepEqual(workspaceWork([workspace("error", "teardown", "failed", NOW + MIN)], NOW), {
    busy: true,
    needsRecovery: 0,
  });
});

test("a failed teardown exactly a minute overdue is still busy", () => {
  assert.deepEqual(workspaceWork([workspace("error", "teardown", "failed", NOW - MIN)], NOW), {
    busy: true,
    needsRecovery: 0,
  });
});

test("a failed teardown one millisecond past a minute overdue needs recovery", () => {
  assert.deepEqual(workspaceWork([workspace("error", "teardown", "failed", NOW - MIN - 1)], NOW), {
    busy: false,
    needsRecovery: 1,
  });
});

test("a given-up teardown needs recovery beside a ready workspace", () => {
  assert.deepEqual(workspaceWork([workspace("ready"), workspace("error", "teardown", "failed", null)], NOW), {
    busy: false,
    needsRecovery: 1,
  });
});

test("a provisioning workspace stays busy beside a ready one", () => {
  assert.deepEqual(workspaceWork([workspace("provisioning"), workspace("ready")], NOW), {
    busy: true,
    needsRecovery: 0,
  });
});

test("a failed teardown outside the teardown phase counts as nothing: bb derives the phase from the teardown status", () => {
  assert.deepEqual(workspaceWork([workspace("ready", "active", "failed")], NOW), { busy: false, needsRecovery: 0 });
});

// Bug: a workspace in bb's retiring phase was skipped, so an idle box could be let go during bb's retire grace.
test("workspaceWork: a workspace in its retire grace is busy", () => {
  assert.deepEqual(workspaceWork([workspace("ready", "retiring", null, NOW + MIN)], NOW), {
    busy: true,
    needsRecovery: 0,
  });
});

test("workspaceWork: a retiring workspace past its retireAt is still busy, bb has not started the teardown", () => {
  assert.deepEqual(workspaceWork([workspace("ready", "retiring", null, NOW - MIN)], NOW), {
    busy: true,
    needsRecovery: 0,
  });
});

test("an idle machine whose workspaces bb is working on, or that need recovery, is not let go", () => {
  const idle = [machine("a"), machine("b", { workspacesBlock: true }), machine("c", { workspacesBlock: false })];
  assert.deepEqual(machinesToRelease(idle, NOW, 30 * MIN), ["a", "c"]);
});

test("a suspend bb still runs is read again until bb settles it (fails if the first answer is trusted)", async () => {
  const answers = ["suspending", "active", "suspended"];
  let reads = 0;
  const lifecycle = await settledLifecycle(async () => ({ lifecycle: { phase: answers[reads++]!, message: null } }), {
    intervalMs: 1,
  });
  assert.equal(lifecycle.phase, "active");
  assert.equal(reads, 2);
});

test("a resume bb still runs is read again until bb settles it, and its deadline names the resume (fails if the wait stops at resuming)", async () => {
  const answers = ["resuming", "suspending", "suspended"];
  let reads = 0;
  const lifecycle = await settledLifecycle(async () => ({ lifecycle: { phase: answers[reads++]!, message: null } }), {
    waiting: "resuming",
    intervalMs: 1,
  });
  assert.deepEqual([lifecycle.phase, reads], ["suspending", 2]);
  await assert.rejects(
    settledLifecycle(async () => ({ lifecycle: { phase: "resuming", message: null } }), {
      waiting: "resuming",
      intervalMs: 1,
      deadlineMs: 5,
    }),
    { message: "bb is still resuming the machine" },
  );
});

test("an aborted signal ends the settle at once, before its deadline (fails if the poll runs on after a plugin reload)", async () => {
  const reload = new AbortController();
  reload.abort(new Error("plugin reloaded"));
  await assert.rejects(
    settledLifecycle(async () => ({ lifecycle: { phase: "resuming", message: null } }), {
      waiting: "resuming",
      intervalMs: 1,
      deadlineMs: 50,
      signal: reload.signal,
    }),
    { message: "plugin reloaded" },
  );
});

test("a suspend settle waits 6 minutes (fails if a suspend uses the resume's deadline)", async () => {
  enableFakeClock();
  try {
    let outcome = "pending";
    const settling = settledLifecycle(async () => ({ lifecycle: { phase: "suspending", message: null } })).catch(
      (error: unknown) => (outcome = (error as Error).message),
    );
    await tick(5 * MIN);
    await settle();
    assert.equal(outcome, "pending");
    await tick(MIN);
    await settle();
    assert.equal(outcome, "bb is still suspending the machine");
    await settling;
  } finally {
    await resetFakeClock();
  }
});

test("a resume settle waits 30 minutes, not the suspend's 6 (fails if a resume uses the suspend's deadline)", async () => {
  enableFakeClock();
  try {
    let outcome = "pending";
    const settling = settledLifecycle(async () => ({ lifecycle: { phase: "resuming", message: null } }), {
      waiting: "resuming",
    }).catch((error: unknown) => (outcome = (error as Error).message));
    await tick(7 * MIN);
    await settle();
    assert.equal(outcome, "pending");
    await tick(23 * MIN);
    await settling;
    assert.equal(outcome, "bb is still resuming the machine");
  } finally {
    await resetFakeClock();
  }
});

test("a suspend bb is still running at its deadline is an error, not a settled phase (fails if the poll never ends)", async () => {
  await assert.rejects(
    settledLifecycle(async () => ({ lifecycle: { phase: "suspending", message: null } }), {
      intervalMs: 1,
      deadlineMs: 5,
    }),
    /bb is still suspending the machine/,
  );
});

test("a read that rejects is asked again, and the next settled phase counts (fails if the first rejection ends the wait)", async () => {
  let reads = 0;
  const lifecycle = await settledLifecycle(
    async () => {
      reads++;
      if (reads === 1) throw new Error("bb is down");
      return { lifecycle: { phase: "active", message: "Machine suspension failed: Host is not connected" } };
    },
    { intervalMs: 1 },
  );
  assert.equal(lifecycle.phase, "active");
  assert.equal(reads, 2);
});

test("a settle whose every read fails names the read error at its deadline (fails if the error is the bare still-suspending message)", async () => {
  await assert.rejects(
    settledLifecycle(
      async () => {
        throw new Error("bb is down");
      },
      { intervalMs: 1, deadlineMs: 5 },
    ),
    /bb is still suspending the machine, or could not be read: bb is down/,
  );
});

test("a read that throws when called surfaces at once, not after the deadline (fails if the throw is retried until the deadline)", async () => {
  await assert.rejects(
    settledLifecycle(
      () => {
        throw new TypeError("hosts.get is not a function");
      },
      { intervalMs: 1, deadlineMs: 50 },
    ),
    { name: "TypeError", message: "hosts.get is not a function" },
  );
});

test("a later read that answers clears the remembered read error, so the deadline names no stale error (fails if the old error is kept)", async () => {
  let reads = 0;
  await assert.rejects(
    settledLifecycle(
      async () => {
        reads++;
        if (reads === 1) throw new Error("bb is down");
        return { lifecycle: { phase: "suspending", message: null } };
      },
      { intervalMs: 1, deadlineMs: 200 },
    ),
    { name: "Error", message: "bb is still suspending the machine" },
  );
});

test("a settle whose reads fail with no message says so after the colon (fails if the message is left empty)", async () => {
  await assert.rejects(
    settledLifecycle(
      async () => {
        throw new Error("");
      },
      { intervalMs: 1, deadlineMs: 5 },
    ),
    /could not be read: no detail$/,
  );
});
