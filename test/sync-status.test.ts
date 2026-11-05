import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, GIVE_UP_AFTER } from "../src/reconcile.ts";
import type { ThreadRecord } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { box, connectCalls, register as registerOna } from "./provider-fake.ts";
import { HOUR, idle, NOW, world } from "./sync-fakes.ts";

const REFUSED = "Machine suspension failed: Host is not connected";
const NOT_CONNECTED =
  "bb can't suspend it while a turn is still active on the box; it needs the box back to settle the turn";

// The thread list takes 30 s: the thread is stuck when the list returns, but not by the clock status read first.
test("status judges stuck threads on the clock it read first, not on one a slow thread list moved", async () => {
  enableFakeClock();
  try {
    const start = Date.now();
    const thread: ThreadRecord = {
      id: "t1",
      status: "starting",
      updatedAt: start - 6 * HOUR + 1_000,
      runtime: { displayStatus: "starting" },
    };
    const { sync } = world([idle("h1", { threads: [thread], threadsMs: 30_000 })]);
    const [row] = await sync.statusRows();
    assert.deepEqual(row!.stuckThreads, []);
  } finally {
    await resetFakeClock();
  }
});

// Bug: Ona stopped a box under a live turn. bb's suspend failed and left the machine active, and bb's resume does nothing
// on an active machine, so the box never came back.
test("Ona stopped a box mid-turn: bb refuses the suspend, a thread waits, the plugin starts the box and connects (fails if bb's no-op resume is asked)", async () => {
  const ona = registerOna({ found: { ...box("STOPPED"), id: "env-h1" }, phases: ["STOPPED", "RUNNING"] });
  const waiting: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })], {
    refuse: REFUSED,
    wake: ona.wake,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"], "bb's resume is never asked for the active machine");
  assert.deepEqual(ona.calls, ["get STOPPED", "start", "get RUNNING", ...connectCalls]);
  const record = guard.records.get("h1")!;
  assert.match(record.reason, /; started it for a waiting thread$/);
  assert.equal(record.error, undefined);
});

// The sync read the box stopped; Ona had started it again by the time the wake read it.
test("a box Ona starts before the waiting thread's wake is connected, not started, and recorded as a reconnect (fails if the record says started)", async () => {
  const ona = registerOna({ found: { ...box("RUNNING"), id: "env-h1" } });
  const waiting: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })], {
    refuse: REFUSED,
    wake: ona.wake,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.ok(!ona.calls.includes("start"), ona.calls.join(", "));
  assert.deepEqual(ona.calls.slice(-connectCalls.length), connectCalls);
  const record = guard.records.get("h1")!;
  assert.match(record.reason, /; reconnected it for a waiting thread$/);
  assert.equal(record.error, undefined);
});

// Another action gave up on h1. The record is set directly: a real pass would wait out the cooldown on the system
// clock. Its failures do not hold a thread's pass, so the wake runs.
test("a waiting thread's pass runs past another action's give-up, so the wake runs (fails if the pass honours the give-up)", async () => {
  const ona = registerOna({ found: { ...box("STOPPED"), id: "env-h1" }, phases: ["STOPPED", "RUNNING"] });
  const waiting: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })], {
    refuse: REFUSED,
    wake: ona.wake,
  });
  guard.records.set("h1", {
    action: "heal-daemon",
    reason: "the daemon wasn't connected",
    at: NOW,
    error: "restart failed",
    failures: GIVE_UP_AFTER,
    quietUntil: NOW + HOUR,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.deepEqual(ona.calls.slice(-connectCalls.length), connectCalls);
  const record = guard.records.get("h1")!;
  assert.match(record.reason, /; started it for a waiting thread$/);
  assert.equal(record.error, undefined);
});

// Passes that keep finding a thread waiting, with bb refusing the suspend and the wake failing every time.
test("a waiting thread's passes make at most GIVE_UP_AFTER attempts, then the guard gives up (fails if every pass is forced)", async () => {
  enableFakeClock();
  try {
    const waiting: ThreadRecord = {
      id: "t1",
      status: "active",
      updatedAt: NOW,
      runtime: { displayStatus: "waiting-for-host" },
    };
    const { sync, calls, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })], {
      refuse: REFUSED,
      wake: async () => {
        throw new Error("Ona would not start the box");
      },
    });
    for (let pass = 0; pass < 10; pass++) {
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(2 * 60_000);
    }
    assert.equal(calls.filter((call) => call === "suspend h1").length, GIVE_UP_AFTER);
    assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
    const [row] = await sync.statusRows();
    assert.match(row!.retry ?? "", /^gave up after 3 failures/);
  } finally {
    await resetFakeClock();
  }
});

// No thread waits on the box, so the give-up holds the pass: nothing is suspended.
test("a stopped box with no thread waiting makes no suspend once a pass has given up on it (fails if every suspend-observed is forced)", async () => {
  const { sync, calls, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected" })], { refuse: REFUSED });
  guard.records.set("h1", {
    action: "suspend-observed",
    reason: "Ona stopped the box",
    at: NOW,
    error: NOT_CONNECTED,
    failures: GIVE_UP_AFTER,
    quietUntil: NOW + HOUR,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(!calls.includes("suspend h1"), calls.join(", "));
});

// A give-up left by a pass with no thread waiting does not hold a thread that starts waiting after it.
test("a thread that starts waiting after a no-thread pass gave up still gets its wake (fails if a failed observed stop holds the thread's pass)", async () => {
  const ona = registerOna({ found: { ...box("STOPPED"), id: "env-h1" }, phases: ["STOPPED", "RUNNING"] });
  const waiting: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })], {
    refuse: REFUSED,
    wake: ona.wake,
  });
  guard.records.set("h1", {
    action: "suspend-observed",
    reason: "Ona stopped the box",
    at: NOW,
    error: NOT_CONNECTED,
    failures: GIVE_UP_AFTER,
    quietUntil: NOW + HOUR,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.deepEqual(ona.calls.slice(-connectCalls.length), connectCalls);
  assert.match(guard.records.get("h1")!.reason, /; started it for a waiting thread$/);
});

// The thread's own failures count from one: the other action's count does not carry into them.
test("a waiting thread's pass that fails after another action gave up counts its own failures from one (fails if the other count carries over)", async () => {
  const waiting: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })], {
    refuse: REFUSED,
    wake: async () => {
      throw new Error("Ona would not start the box");
    },
  });
  guard.records.set("h1", {
    action: "heal-daemon",
    reason: "the daemon wasn't connected",
    at: NOW,
    error: "restart failed",
    failures: GIVE_UP_AFTER,
    quietUntil: NOW + HOUR,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.equal(record.failures, 1);
  assert.equal(record.threadWaiting, true);
  assert.equal(record.error, "Ona would not start the box");
});

// Bug: the status row showed bb's raw suspend message, which doesn't say what the user should do.
test("a refused suspend on a stopped box is reported as bb needing the box back (fails if the raw bb message is shown)", async () => {
  const { sync } = world([idle("h1", { ona: "STOPPED", status: "disconnected" })], { refuse: REFUSED });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const [row] = await sync.statusRows();
  assert.equal(row!.last!.error, NOT_CONNECTED);
});

// Releases start together: a box whose suspend bb is still settling must not hold the next box's release, or the pass.
test("idle boxes are released together: the second's suspend is posted before the first settles (fails if a release waits for the one before it)", async () => {
  const { sync, calls } = world([idle("h1"), idle("h2")], { holdSettle: { hostId: "h1", until: "suspend h2" } });
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.ok(calls.indexOf("suspend h2") !== -1, calls.join(", "));
  assert.ok(calls.indexOf("suspend h2") < calls.indexOf("settled h1"), calls.join(", "));
});

// A refused suspend that bb settles as `removing` (the machine is being removed) must not let a waiting thread wake the box.
test("a suspend bb settles as removing wakes nothing and keeps the no-stop flag, even with a thread waiting (fails if the active check before the wake is dropped)", async () => {
  const ona = registerOna({ found: { ...box("STOPPED"), id: "env-h1" }, phases: ["STOPPED", "RUNNING"] });
  const waiting: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls, guard, releasing } = world(
    [idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })],
    { suspendSettles: { phase: "removing", message: "Removing the machine" }, wake: ona.wake },
  );
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.deepEqual(ona.calls, [], "nothing is started while bb removes the machine");
  assert.equal(guard.records.get("h1")!.error, "bb kept the machine removing: Removing the machine");
  assert.ok(releasing.has("env-h1"), "bb may still run the suspend, so the no-stop flag stays");
});
