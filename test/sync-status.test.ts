import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL } from "../src/reconcile.ts";
import type { ThreadRecord } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock } from "./fake-clock.ts";
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

// Bug: the status row showed bb's raw suspend message, which doesn't say what the user should do.
test("a refused suspend on a stopped box is reported as bb needing the box back (fails if the raw bb message is shown)", async () => {
  const { sync } = world([idle("h1", { ona: "STOPPED", status: "disconnected" })], { refuse: REFUSED });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const [row] = await sync.statusRows();
  assert.equal(row!.last!.error, NOT_CONNECTED);
});

// Bug: an idle box's release was awaited before the next box's, so a box whose suspend bb was still settling held the
// next box's release, and the next box's "right away" pass waited with it.
test("idle boxes are released together: the second's suspend is posted before the first settles (fails if a release waits for the one before it)", async () => {
  const { sync, calls } = world([idle("h1"), idle("h2")], { holdSettle: { hostId: "h1", until: "suspend h2" } });
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.ok(calls.indexOf("suspend h2") !== -1, calls.join(", "));
  assert.ok(calls.indexOf("suspend h2") < calls.indexOf("settled h1"), calls.join(", "));
});

// Bug: a refused suspend that bb settles as `removing` (the machine is being removed) let a waiting thread wake the box.
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
