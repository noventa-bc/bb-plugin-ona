import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, GIVE_UP_AFTER } from "../src/reconcile.ts";
import type { ThreadRecord } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { box, connectCalls, register as registerOna } from "./provider-fake.ts";
import { HOUR, idle, NOW, waitingThread, world } from "./sync-fakes.ts";

const REFUSED = "Machine suspension failed: Host is not connected";
const RESUME_REFUSED = "Resume is blocked by an interrupted hook";
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

// Passes alternate between a thread and no thread (its thread read fails); the chain keeps counting across both.
test("a no-thread pass whose thread read failed does not reopen a thread's chain, so the wakes stop at the give-up (fails if the alternation makes more wakes)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, guard } = world([host], {
      refuse: REFUSED,
      wake: async () => {
        wakes++;
        throw new Error("Ona would not start the box");
      },
    });
    for (let pass = 0; pass < 10; pass++) {
      host.threads = pass % 2 === 0 ? [waitingThread()] : "fail";
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(6 * 60_000);
    }
    assert.ok(wakes <= GIVE_UP_AFTER, `${wakes} wakes`);
    assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
    const [row] = await sync.statusRows();
    assert.match(row!.retry ?? "", /^gave up after 3 failures/);
  } finally {
    await resetFakeClock();
  }
});

// A thread's own failure backs off: a pass 2 minutes later stays quiet until the cooldown ends.
test("a thread's own failure backs off: a pass 2 minutes later makes no second suspend (fails if a thread's pass ignores the backoff)", async () => {
  enableFakeClock();
  try {
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, calls } = world([host], {
      refuse: REFUSED,
      wake: async () => {
        throw new Error("Ona would not start the box");
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(2 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(calls.filter((call) => call === "suspend h1").length, 1);
  } finally {
    await resetFakeClock();
  }
});

// A thread pass's success clears the flag, so the give-up that other passes leave after it does not hold the thread.
// An other-action success keeps the flag, so the failures after it still hold the thread.
test("a thread pass's success clears the flag, and an other-action success keeps it (fails if a success clears or keeps it the wrong way)", async () => {
  enableFakeClock();
  async function threadSuccessClears() {
    let wakes = 0;
    let wakeFails = true;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync } = world([host], {
      refuse: REFUSED,
      wake: async () => {
        wakes++;
        if (wakeFails) throw new Error("Ona would not start the box");
        return true;
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(6 * 60_000);
    wakeFails = false;
    await sync.reconcile(new Set(["h1"]), { wait: true });
    host.threads = [];
    for (let pass = 0; pass < 3; pass++) {
      await tick(30 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
    }
    host.threads = [waitingThread()];
    await tick(30 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(wakes, 3);
  }
  async function otherSuccessKeeps() {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const options = {
      refuse: REFUSED,
      daemonAlive: true,
      reconnectFails: "",
      wake: async () => {
        wakes++;
        host.ona = "RUNNING";
        throw new Error("connect failed");
      },
    };
    const { sync, guard } = world([host], options);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(6 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.records.get("h1")!.failures, 1, "the other pass's success keeps the count");
    options.daemonAlive = false;
    options.reconnectFails = "daemon restart failed";
    for (let pass = 0; pass < 3; pass++) {
      await tick(20 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
    }
    host.ona = "STOPPED";
    await tick(20 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(wakes, 1);
  }
  try {
    await threadSuccessClears();
    await otherSuccessKeeps();
  } finally {
    await resetFakeClock();
  }
});

// The wake's connect fails and closes the tunnel. The next RUNNING pass ensures it (an other-action success), and the
// heal-daemon restarts after it fail to the give-up. The flag holds through all of it, so the thread's wakes stop.
test("a failed start's flag holds through an ensure-tunnel success and the heal-daemon failures after it, so a thread's wakes end (fails if a success clears the flag)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync } = world([host], {
      refuse: REFUSED,
      daemonAlive: false,
      reconnectFails: "daemon restart failed",
      wake: async () => {
        wakes++;
        host.ona = "RUNNING";
        host.tunnel = "off";
        throw new Error("connect failed");
      },
    });
    for (let cycle = 0; cycle < 5; cycle++) {
      host.ona = "STOPPED";
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(6 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
      host.tunnel = "up";
      for (let pass = 0; pass < 3; pass++) {
        await tick(20 * 60_000);
        await sync.reconcile(new Set(["h1"]), { wait: true });
      }
      await tick(20 * 60_000);
    }
    assert.ok(wakes <= GIVE_UP_AFTER, `${wakes} wakes`);
  } finally {
    await resetFakeClock();
  }
});

test("a forced sync whose thread pass fails starts the hold: the flag is set and no wake runs inside the backoff (fails if the forced failure drops the flag or the backoff)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync, guard } = world([host], {
      refuse: REFUSED,
      wake: async () => {
        wakes++;
        throw new Error("connect failed");
      },
    });
    await sync.reconcile(new Set(["h1"]), { force: true, wait: true });
    assert.equal(guard.records.get("h1")!.threadWaiting, true);
    await tick(60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(wakes, 1);
  } finally {
    await resetFakeClock();
  }
});

// The first wake leaves the box running in Ona, so the forced `bb ona sync` runs a daemon repair, not the thread's
// pass; its failure ends the hold, and the thread's next pass is forced past the backoff it left.
test("a forced action that is not a thread's pass ends the hold when it fails, so the thread's next pass is forced again (fails if its failure keeps the flag)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
    const { sync } = world([host], {
      refuse: REFUSED,
      daemonAlive: false,
      reconnectFails: "daemon restart failed",
      wake: async () => {
        wakes++;
        host.ona = "RUNNING";
        throw new Error("connect failed");
      },
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    await tick(6 * 60_000);
    await sync.reconcile(new Set(["h1"]), { force: true, wait: true });
    host.ona = "STOPPED";
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(wakes, 2);
  } finally {
    await resetFakeClock();
  }
});

// The wake's connect fails and closes the tunnel. The tunnel repair succeeds, and the daemon repairs are no-op successes
// (the daemon is up): the failure count is kept through them, so the thread's wakes stop at the give-up.
test("a failed start's count holds through the tunnel repair and the no-op daemon repairs after it, so a thread's wakes end (fails if a success resets the count)", async () => {
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
        host.tunnel = "off";
        throw new Error("connect failed");
      },
    });
    for (let cycle = 0; cycle < 6; cycle++) {
      host.ona = "STOPPED";
      await sync.reconcile(new Set(["h1"]), { wait: true });
      await tick(6 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
      host.tunnel = "up";
      for (let pass = 0; pass < 3; pass++) {
        await tick(20 * 60_000);
        await sync.reconcile(new Set(["h1"]), { wait: true });
      }
      await tick(20 * 60_000);
    }
    assert.ok(wakes <= GIVE_UP_AFTER, `${wakes} wakes`);
    const [row] = await sync.statusRows();
    assert.match(row!.retry ?? "", /^gave up/);
  } finally {
    await resetFakeClock();
  }
});

// bb shows the machine connected: the flag, the failure count and the backoff start again. The record below carries an
// hour of backoff, which the connected pass ends. Three no-thread passes then give up on the box, and the thread's pass
// that follows is forced again.
test("a flagged record on a machine bb shows connected loses its flag, its failures and its backoff, so the next thread pass is forced again after another pass's give-up (fails if a connected pass keeps the flag or the backoff)", async () => {
  enableFakeClock();
  try {
    let wakes = 0;
    const host = idle("h1", { ona: "RUNNING", status: "connected", threads: [] });
    const { sync, guard, hosts } = world([host], {
      refuse: REFUSED,
      wake: async () => {
        wakes++;
        return true;
      },
    });
    guard.records.set("h1", {
      action: "suspend-observed",
      reason: "Ona stopped the box",
      at: Date.now(),
      error: "connect failed",
      failures: 2,
      quietUntil: Date.now() + HOUR,
      threadWaiting: true,
    });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.records.get("h1")!.threadWaiting, undefined);
    assert.equal(guard.records.get("h1")!.failures, 0);
    assert.equal(guard.mayAct("h1"), true);
    hosts.get("h1")!.status = "disconnected";
    host.ona = "STOPPED";
    for (let pass = 0; pass < GIVE_UP_AFTER; pass++) {
      await tick(30 * 60_000);
      await sync.reconcile(new Set(["h1"]), { wait: true });
    }
    assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
    host.threads = [waitingThread()];
    await tick(30 * 60_000);
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(wakes, 1);
  } finally {
    await resetFakeClock();
  }
});

// `bb ona sync` on a machine bb shows connected ends the chain as well.
test("bb ona sync on a machine bb shows connected clears its flag (fails if a forced pass on a connected machine keeps the flag)", async () => {
  const host = idle("h1", { ona: "RUNNING", status: "connected", threads: [] });
  const { sync, guard } = world([host], { refuse: REFUSED });
  guard.records.set("h1", {
    action: "suspend-observed",
    reason: "Ona stopped the box",
    at: NOW,
    error: "connect failed",
    failures: 2,
    quietUntil: NOW,
    threadWaiting: true,
  });
  await sync.reconcile(new Set(["h1"]), { force: true, wait: true });
  assert.equal(guard.records.get("h1")!.threadWaiting, undefined);
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

// A no-thread suspend's give-up does not hold a thread that starts waiting after it.
test("a thread that starts waiting after a no-thread suspend gave up still gets its wake (fails if a no-thread suspend failure holds the thread's pass)", async () => {
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

// Bug: bb's refused resume for a waiting thread was returned as a message, so the guard recorded a success: no failure
// and no backoff.
test("a refused resume for a waiting thread is a failure, not a success (fails if the refusal is returned as a success)", async () => {
  const host = idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] });
  const { sync, guard } = world([host], { resumeRefuses: RESUME_REFUSED });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.equal(record.failures, 1);
  assert.equal(
    record.error,
    `couldn't resume it for a waiting thread (bb kept the machine suspended: ${RESUME_REFUSED})`,
  );
  assert.equal(record.threadWaiting, true, "the thread's hold is kept");
});
