import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, COOLDOWN_MS, GIVE_UP_AFTER, HostGuard } from "../src/reconcile.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { HOUR, idle, waitingThread, world } from "./sync-fakes.ts";

const REFUSED = "Machine suspension failed: Host is not connected";

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

// A wake has no 15-minute cap of its own (docs/sync.md rule 1): a stop and a start that take 17 minutes
// end in a connect. The mocked clock never fires AbortSignal.timeout, so the test stands in for one that does.
test("a slow stop and start still connect the waiting thread's box (fails if a 15-minute cap aborts the wake)", async (t) => {
  enableFakeClock();
  try {
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
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
