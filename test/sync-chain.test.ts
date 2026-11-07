import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ALL, COOLDOWN_MS, GIVE_UP_AFTER, HostGuard } from "../src/reconcile.ts";
import { rowForRef, type Row } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, settle, tick } from "./fake-clock.ts";
import { HOUR, idle, waitingThread, world } from "./sync-fakes.ts";

const REFUSED = "Machine suspension failed: Host is not connected";
const RESUME_REJECTED = "HTTP 409: Only an active or suspended machine can be resumed";
const RESUME_FAILED = "Machine resume failed: Ona environment not found";

// The mocked clock never fires AbortSignal.timeout: this stand-in fires on it, so a test sees a cap abort.
function abortTimeoutsOnFakeClock(t: TestContext): void {
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
}

// bb ona sync runs a repair on the box that succeeds: the forced run ends the chain, so the box's next stop wakes the thread
// even though the repair's cooldown has not passed.
test("a forced run's successful repair ends a thread's chain, so the box's next stop wakes the thread past the repair's cooldown (fails if a forced success keeps the flag)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync } = world([host], {
      refuse: REFUSED,
      daemonAlive: true,
      wake: async () => {
        wakes++;
        host.ona = "RUNNING";
        throw new Error("connect failed");
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(60_000);
    await sync.reconcile(new Set(["h1"]), { force: true, wait: true });
    host.ona = "STOPPED";
    await tick(60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(wakes, 2);
  } finally {
    await resetFakeClock();
  }
});

// Two thread failures and a held repair, then bb shows the machine connected: the count starts again there, so one refused
// idle release does not stop the next release.
test("a machine bb shows connected starts its count again, so one refused idle release does not stop the next (fails if a connected pass keeps the count)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, calls, hosts } = world([host], {
      refuse: REFUSED,
      daemonAlive: true,
      pluginStartedAt: Date.now() - 2 * HOUR,
      wake: async () => {
        wakes++;
        host.ona = "RUNNING";
        throw new Error("connect failed");
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(6 * 60_000);
    host.ona = "STOPPED";
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(12 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    hosts.get("h1")!.status = "connected";
    await sync.reconcile(new Set(["h1"]), { wait: true });
    host.threads = [];
    await tick(6 * 60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    const released = calls.filter((call) => call === "suspend h1").length;
    await tick(6 * 60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.ok(calls.filter((call) => call === "suspend h1").length > released, "the next idle release suspends");
    assert.equal(wakes, 2);
  } finally {
    await resetFakeClock();
  }
});

// Bug: a give-up with no thread waiting outlived bb showing the box connected with its tunnel up, so `bb ona status`
// kept advising `bb ona sync` on a healthy box.
test("a machine bb shows connected with its tunnel up clears a give-up that no thread holds (fails if the clear stays limited to a held record), and its quiet period (fails if the clear keeps the quiet period)", async () => {
  enableFakeClock();
  try {
    const host = idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR });
    const { sync, guard, hosts, calls } = world([host], {
      daemonAlive: false,
      reconnectFails: "daemon restart failed",
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(5 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(10 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
    hosts.get("h1")!.status = "connected";
    await sync.reconcile(new Set(["h1"]), { wait: true });
    const [row] = await sync.statusRows();
    assert.equal(row!.retry, null);
    // The same instant: the clear also resets the quiet period, so the box may be repaired again at once.
    hosts.get("h1")!.status = "disconnected";
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(calls.filter((call) => call === "restart daemon").length, GIVE_UP_AFTER + 1);
  } finally {
    await resetFakeClock();
  }
});

// Bug: a record outlived its quiet period, so `bb ona status` kept printing "retrying after" a time long past. A give-up's
// line has no quiet period: docs/sync.md rule 5 lists what ends a give-up.
test("status shows a retry line only while the quiet period is ahead (fails if a passed quiet period still prints retrying after), and the give-up line either way (fails if it waits on the quiet period)", async () => {
  const { sync, guard } = world([idle("h1")]);
  const retryWith = async (failures: number, quietUntil: number) => {
    guard.records.set("h1", {
      action: "reconnect",
      reason: "requested with bb ona reconnect",
      at: Date.now(),
      failures,
      quietUntil,
    });
    const [row] = await sync.statusRows();
    return row!.retry;
  };
  assert.equal(await retryWith(1, Date.now() - HOUR), null, "the quiet period is over, and no retry is coming");
  assert.match((await retryWith(1, Date.now() + HOUR)) ?? "", /^retrying after /);
  assert.match((await retryWith(GIVE_UP_AFTER, Date.now() - HOUR)) ?? "", /^gave up after /);
});

// Bug: a release's give-up named `bb ona sync <machine>`, a pass that runs no idle release.
test("a release's give-up says to run bb ona sync for all boxes, another action's names the machine (fails if the release's give-up names the machine)", async () => {
  const { sync, guard } = world([idle("h1")]);
  const giveUpWith = async (action: string) => {
    guard.records.set("h1", { action, reason: "r", at: Date.now(), failures: GIVE_UP_AFTER, quietUntil: 0 });
    const [row] = await sync.statusRows();
    return row!.retry;
  };
  const machine = (await sync.statusRows())[0]!.machine;
  assert.equal(await giveUpWith("release-idle"), `gave up after ${GIVE_UP_AFTER} failures; run \`bb ona sync\``);
  assert.equal(
    await giveUpWith("reconnect"),
    `gave up after ${GIVE_UP_AFTER} failures; run \`bb ona sync ${machine}\``,
  );
});

// A forced run ends the give-up, so its failure starts a new count and backoff (docs/sync.md rule 3).
test("a forced failure after a give-up starts a fresh count (fails if a forced failure keeps counting past the give-up)", async () => {
  let now = 0;
  const guard = new HostGuard(2, { now: () => now });
  const fail = async () => {
    throw new Error("boom");
  };
  for (let attempt = 1; attempt <= GIVE_UP_AFTER; attempt++) {
    await assert.rejects(guard.run("h1", "heal-daemon", "r", fail));
    now += COOLDOWN_MS * 2 ** (attempt - 1);
  }
  assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
  await assert.rejects(guard.run("h1", "heal-daemon", "r", fail, { force: true }), /boom/);
  assert.equal(guard.records.get("h1")!.failures, 1);
  assert.equal(guard.records.get("h1")!.quietUntil, now + COOLDOWN_MS);
});

// The connected check must leave a refused release's count alone (docs/sync.md rule 5). Without the give-up the fourth
// try is due at minute 35 (the 36th pass); 40 passes leave a margin and still make 3 attempts.
test("a refused idle suspend on a connected box still gives up after three tries (fails if the connected check clears a release's count, or if mayAct drops the give-up)", async () => {
  enableFakeClock();
  try {
    const { sync, calls } = world([idle("h1")], { refuse: REFUSED, pluginStartedAt: Date.now() - 2 * HOUR });
    for (let pass = 0; pass < 40; pass++) {
      await sync.reconcile(new Set([ALL]), { wait: true });
      await tick(60_000);
    }
    assert.equal(calls.filter((call) => call === "suspend h1").length, GIVE_UP_AFTER);
  } finally {
    await resetFakeClock();
  }
});

// Bug: a forced all-boxes pass skipped an idle release that had given up, so `bb ona sync` did not retry it.
test("a forced all-boxes pass retries a given-up idle release (fails if the release's mayAct ignores force)", async () => {
  enableFakeClock();
  try {
    const { sync, calls } = world([idle("h1")], { refuse: REFUSED, pluginStartedAt: Date.now() - 2 * HOUR });
    for (let pass = 0; pass < 40; pass++) {
      await sync.reconcile(new Set([ALL]), { wait: true });
      await tick(60_000);
    }
    assert.equal(calls.filter((call) => call === "suspend h1").length, GIVE_UP_AFTER);
    await sync.reconcile(new Set([ALL]), { force: true, wait: true });
    assert.equal(calls.filter((call) => call === "suspend h1").length, GIVE_UP_AFTER + 1);
  } finally {
    await resetFakeClock();
  }
});

// A restart's cooldown is a success's: the box reading connected does not end it (docs/sync.md rule 5), so a disconnect
// 2 minutes later waits for it.
test("a success's cooldown survives the connected check (fails if connected() clears every record)", async () => {
  enableFakeClock();
  try {
    const host = idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR });
    const { sync, calls, hosts } = world([host], { daemonAlive: false });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    hosts.get("h1")!.status = "connected";
    await tick(60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(60_000);
    hosts.get("h1")!.status = "disconnected";
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(calls.filter((call) => call === "restart daemon").length, 1);
  } finally {
    await resetFakeClock();
  }
});

// bb reports the machine connected at the pass after a failed wake, but its tunnel is closed: the hold stays, so the wakes
// stay bounded. bb reports disconnected again before Ona stops the box.
test("a connected report with the tunnel closed does not end a thread's hold, so the wakes stay bounded (fails if the gate is dropped)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, hosts } = world([host], {
      refuse: REFUSED,
      daemonAlive: true,
      wake: async () => {
        wakes++;
        host.ona = "RUNNING";
        host.tunnel = "off";
        hosts.get("h1")!.status = "connected";
        throw new Error("connect failed");
      },
    });
    for (let cycle = 0; cycle < 6; cycle++) {
      host.ona = "STOPPED";
      hosts.get("h1")!.status = "disconnected";
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(6 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(20 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(20 * 60_000);
    }
    assert.ok(wakes <= GIVE_UP_AFTER, `${wakes} wakes`);
  } finally {
    await resetFakeClock();
  }
});

// bb reports the machine connected with its tunnel up, but Ona still shows the box stopped: the hold stays, so the wakes stay
// bounded. bb reports disconnected again before each stop.
test("a connected report with Ona still showing the box stopped does not end a thread's hold, so the wakes stay bounded (fails if the Ona check is dropped)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, hosts } = world([host], {
      refuse: REFUSED,
      daemonAlive: true,
      wake: async () => {
        wakes++;
        host.tunnel = "up";
        hosts.get("h1")!.status = "connected";
        throw new Error("connect failed");
      },
    });
    for (let cycle = 0; cycle < 6; cycle++) {
      host.ona = "STOPPED";
      hosts.get("h1")!.status = "disconnected";
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(6 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(20 * 60_000);
    }
    assert.ok(wakes <= GIVE_UP_AFTER, `${wakes} wakes`);
  } finally {
    await resetFakeClock();
  }
});

// Bug: bb's rejected resume for a waiting thread was returned as a message, so the guard recorded a success: no failure,
// no backoff, and the thread's hold cleared.
test("a resume bb rejects for a waiting thread is a failure that starts the thread's hold (fails if the rejection is returned as a success)", async () => {
  const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
  const { sync, guard } = world([host], { resumeThrows: RESUME_REJECTED });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.equal(record.failures, 1);
  assert.equal(record.error, `couldn't confirm the resume for a waiting thread (${RESUME_REJECTED})`);
  assert.equal(record.threadWaiting, true, "the thread's hold is set");
});

// Bug: bb answers a resume `resuming` and runs it detached; a resume that then failed (bb settles the machine suspended)
// was already reported as "resumed for a waiting thread", and that success cleared the thread's hold.
test("a resume bb settles suspended for a waiting thread is a failure that keeps the thread's hold (fails if bb's resuming answer counts as done)", async () => {
  const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
  const { sync, guard } = world([host], { resumeSettles: { phase: "suspended", message: RESUME_FAILED } });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.equal(record.failures, 1);
  assert.equal(
    record.error,
    `couldn't resume it for a waiting thread (bb kept the machine suspended: ${RESUME_FAILED})`,
  );
  assert.equal(record.threadWaiting, true, "the thread's hold is set");
});

// Rule 4: a listing that fails inside the daemon repair asks nothing, so the guard keeps the record's count,
// quiet period and hold. The repair's read fails on two passes, with a good pass between them.
test("a failed Ona listing inside the daemon repair leaves the count alone (fails if the read failure counts as a repair failure)", async () => {
  enableFakeClock();
  try {
    let repairReadFails = false;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, guard } = world([host], {
      refuse: REFUSED,
      daemonAlive: true,
      refreshFails: () => repairReadFails,
      wake: async () => {
        host.ona = "RUNNING";
        throw new Error("connect failed");
      },
    });
    // The thread's wake fails once: the count is 1 and the hold is set.
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.records.get("h1")!.failures, 1);
    await tick(6 * 60_000);
    const { quietUntil } = guard.records.get("h1")!;
    repairReadFails = true;
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.records.get("h1")!.failures, 1);
    assert.equal(guard.records.get("h1")!.quietUntil, quietUntil);
    assert.equal(guard.records.get("h1")!.threadWaiting, true, "the hold is kept");
    await tick(6 * 60_000);
    repairReadFails = false;
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(6 * 60_000);
    repairReadFails = true;
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.records.get("h1")!.failures, 1);
    const [row] = await sync.statusRows();
    assert.doesNotMatch(row!.retry ?? "", /gave up/);
  } finally {
    await resetFakeClock();
  }
});

// A wake gives up after 30 minutes (docs/sync.md rule 1): a stop and a start that take 17 minutes end in a connect.
test("a slow stop and start still connect the waiting thread's box (fails if a 15-minute cap aborts the wake)", async (t) => {
  enableFakeClock();
  try {
    abortTimeoutsOnFakeClock(t);
    const host = idle("h1", { ona: "STOPPING", status: "disconnected", threads: [waitingThread()] });
    const { sync, guard, hosts } = world([host], {
      refuse: REFUSED,
      daemonAlive: true,
      wake: async (_resource, _report, signal) => {
        // Ona reports the box stopped 5 minutes on, and running 12 minutes after that.
        await tick(5 * 60_000);
        signal.throwIfAborted();
        await tick(12 * 60_000);
        signal.throwIfAborted();
        host.ona = "RUNNING";
        hosts.get("h1")!.status = "connected";
        return true;
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    const record = guard.records.get("h1")!;
    assert.equal(record.error, undefined);
    assert.equal(record.failures, 0);
    assert.match(record.reason, /started it for a waiting thread/);
  } finally {
    await resetFakeClock();
  }
});

// A daemon restart gives up after 30 minutes too (docs/sync.md rule 1): a 17-minute reconnect completes.
test("a slow daemon restart still completes (fails if a 15-minute cap aborts the reconnect)", async (t) => {
  enableFakeClock();
  try {
    abortTimeoutsOnFakeClock(t);
    const { sync, guard } = world([idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR })], {
      daemonAlive: false,
      reconnect: async (_resource, _report, signal) => {
        await tick(17 * 60_000);
        signal.throwIfAborted();
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    const record = guard.records.get("h1")!;
    assert.equal(record.error, undefined);
    assert.match(record.reason, /daemon was down; restarted it/);
  } finally {
    await resetFakeClock();
  }
});

// The daemon check has SSHed into the box when the read before the restart fails: the pass is a failure, so its backoff
// keeps the next pass from SSHing again (docs/sync.md rules 4 and 5). The read works again on the second pass, which
// would reach the daemon check if no backoff held it.
test("a failed Ona read after the daemon check fails the pass, so the next pass does not SSH again (fails if that read records nothing or a success)", async () => {
  let readFails = true;
  const { sync, calls, guard } = world([idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR })], {
    daemonAlive: false,
    refreshFails: () => readFails && calls.includes("probe"),
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.match(record.error ?? "", /Ona couldn't confirm the box running before the restart; not restarting/);
  assert.equal(record.failures, 1);
  readFails = false;
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["probe"]);
});

// Rule 4: a repair read without the box (an empty list) is unknown, as a failed one is, never "gone": before the daemon
// check it leaves the record alone; after the check the pass fails and backs off.
test("a repair listing without the box is unknown, not gone (fails if it records a success that resets the count)", async () => {
  enableFakeClock();
  try {
    let emptyRead = 0; // which repair read of the pass comes back empty: 1 before the daemon check, 2 after it
    let reads = 0;
    const { sync, calls, guard } = world([idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR })], {
      daemonAlive: false,
      reconnectFails: "daemon restart failed",
      refreshEmpty: () => ++reads === emptyRead,
    });
    const pass = async (empty: number) => {
      [reads, emptyRead] = [0, empty];
      await sync.reconcile(new Set(["h1"]), { wait: true });
    };
    await pass(0);
    const { failures, quietUntil } = guard.records.get("h1")!;
    assert.equal(failures, 1);
    await tick(6 * 60_000);
    await pass(1);
    assert.deepEqual(calls, ["probe", "restart daemon"], "no daemon check after an empty read");
    assert.equal(guard.records.get("h1")!.failures, 1);
    assert.equal(guard.records.get("h1")!.quietUntil, quietUntil);
    await pass(2);
    assert.deepEqual(calls, ["probe", "restart daemon", "probe"], "no restart after an empty read");
    assert.equal(guard.records.get("h1")!.failures, 2);
  } finally {
    await resetFakeClock();
  }
});

// That read's failure counts toward the give-up like a failed restart (docs/sync.md rule 5): two failed restarts, then a
// failed read after the check, make three in a row.
test("a failed Ona read after the daemon check counts toward the give-up (fails if that read resets the count)", async () => {
  enableFakeClock();
  try {
    let readFails = false;
    const { sync, calls, guard } = world([idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR })], {
      daemonAlive: false,
      reconnectFails: "daemon restart failed",
      refreshFails: () => readFails && calls.at(-1) === "probe",
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(5 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(10 * 60_000);
    readFails = true;
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(calls.filter((call) => call === "restart daemon").length, 2);
    assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
    const [row] = await sync.statusRows();
    assert.match(row!.retry ?? "", /gave up/);
  } finally {
    await resetFakeClock();
  }
});

// A plugin reload aborts the plugin's lifetime signal: a wake still running then ends, and the guard records the abort as
// the pass's failure (docs/sync.md rule 1).
test("a plugin reload ends a wake in flight (fails if the wake ignores the plugin's lifetime signal)", async () => {
  const lifetime = new AbortController();
  const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
  const { sync, guard } = world([host], {
    refuse: REFUSED,
    daemonAlive: true,
    signal: lifetime.signal,
    wake: async (_resource, _report, signal) => {
      lifetime.abort();
      signal.throwIfAborted();
      return true;
    },
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.match(record.error ?? "", /aborted/);
  assert.equal(record.failures, 1);
});

// A reload ends the wait for a resume bb still runs; the error says the resume is unconfirmed (docs/sync.md rule 1).
test("a plugin reload ends the wait for a waiting thread's resume (fails if the settle ignores the lifetime signal or its error is not wrapped)", async () => {
  const lifetime = new AbortController();
  const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
  const { sync, guard, calls, hosts } = world([host], {
    signal: lifetime.signal,
    resumeSettles: { phase: "resuming", message: null },
  });
  const pass = sync.reconcile(new Set(["h1"]), { wait: true });
  for (let turn = 0; turn < 100 && !calls.includes("resume h1"); turn++) await settle();
  assert.ok(calls.includes("resume h1"), "bb was asked to resume");
  lifetime.abort();
  // bb then settles the resume: a settle that ignored the reload would read it as done within a second.
  hosts.get("h1")!.lifecycle.phase = "active";
  await pass;
  const record = guard.records.get("h1")!;
  assert.match(record.error ?? "", /^couldn't confirm the resume for a waiting thread \(.*aborted/);
  assert.equal(record.threadWaiting, true, "the thread's hold is set");
});

// A reload ends a daemon restart the same way (docs/sync.md rule 1).
test("a plugin reload ends a daemon restart in flight (fails if the restart ignores the plugin's lifetime signal)", async () => {
  const lifetime = new AbortController();
  const { sync, guard } = world([idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR })], {
    daemonAlive: false,
    signal: lifetime.signal,
    reconnect: async (_resource, _report, signal) => {
      lifetime.abort();
      signal.throwIfAborted();
    },
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.match(record.error ?? "", /aborted/);
  assert.equal(record.failures, 1);
});

// Bug: a ref took the first row that matched it, so another box's env name could win over the host id the ref names.
test("a ref picks the box whose host id it is, not an earlier box that has it as an env name, and an env name still picks its box (fails if the first matching row wins, or if only host ids match)", () => {
  const earlier = { hostId: "h-a", machine: "box-a", resource: { envId: "env-a", envName: "h-b" } } as Row;
  const named = { hostId: "h-b", machine: "box-b", resource: { envId: "env-b", envName: "box-b-env" } } as Row;
  assert.equal(rowForRef([earlier, named], "h-b"), named);
  assert.equal(rowForRef([earlier, named], "box-b-env"), named);
});

// bb's list leaves a creating host out, so the realtime map never holds it. An includeCreating list (the rename's
// lookup) returns it and leaves the map as it was.
test("machines() keeps a creating host out of hostByEnv, and an includeCreating list leaves hostByEnv as it was (fails if the creating host is mapped)", async () => {
  const { sync, hostByEnv } = world([idle("h1"), idle("h2", { phase: "creating" })]);
  const ids = async (options?: { includeCreating: boolean }) => (await sync.machines(options)).map((row) => row.hostId);
  assert.deepEqual(await ids(), ["h1"]);
  assert.deepEqual(await ids({ includeCreating: true }), ["h1", "h2"]);
  assert.deepEqual([...hostByEnv], [["env-h1", "h1"]]);
});

// Bug: a ref two boxes share by env name picked the first one listed, so bb acted on a box the user did not name.
test("a ref two boxes share by name is refused and names both boxes (fails if the first match wins)", () => {
  const first = { hostId: "h-1", machine: "api", resource: { envId: "env-1", envName: "api" } } as Row;
  const second = { hostId: "h-2", machine: "api", resource: { envId: "env-2", envName: "api" } } as Row;
  assert.throws(() => rowForRef([first, second], "api"), {
    message: '"api" matches 2 devboxes: api (h-1), api (h-2). Use a host id.',
  });
  assert.equal(rowForRef([first, second], "h-2"), second);
});

test("a host id wins over two boxes that share an env name equal to it (fails if the name match is checked first)", () => {
  const named = { hostId: "h-x", machine: "box-x", resource: { envId: "env-x", envName: "h-1" } } as Row;
  const first = { hostId: "h-1", machine: "api", resource: { envId: "env-1", envName: "api" } } as Row;
  const second = { hostId: "h-2", machine: "api", resource: { envId: "env-2", envName: "h-1" } } as Row;
  assert.equal(rowForRef([named, first, second], "h-1"), first);
});
