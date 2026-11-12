// The idle release of a machine the guard gave up repairing: the box is still let go, with every hold the release has.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, GIVE_UP_AFTER, HostGuard, RELEASE_IDLE } from "../src/reconcile.ts";
import type { ThreadRecord } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { HOUR, idle, world } from "./sync-fakes.ts";

const REFUSED = "Machine suspension failed: Host is not connected";

/**
 * A box whose daemon restarts fail, after three all-boxes passes 5 and 10 minutes apart: the guard has given up on it,
 * and the third failure's 20-minute quiet period has just begun. Runs on the fake clock the caller enabled.
 */
async function givenUp(options: Parameters<typeof world>[1] = {}) {
  const box = idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR });
  const opts = {
    daemonAlive: false,
    reconnectFails: "daemon restart failed",
    pluginStartedAt: Date.now() - 2 * HOUR,
    ...options,
  };
  const made = world([box], opts);
  const pass = () => made.sync.reconcile(new Set([ALL]), { wait: true });
  for (const minutes of [5, 10, 0]) {
    await pass();
    await tick(minutes * 60_000);
  }
  assert.equal(made.guard.records.get("h1")!.failures, GIVE_UP_AFTER);
  const suspends = () => made.calls.filter((call) => call === "suspend h1").length;
  return { ...made, box, opts, pass, suspends };
}

async function onFakeClock(fn: () => Promise<void>) {
  enableFakeClock();
  try {
    await fn();
  } finally {
    await resetFakeClock();
  }
}

// Bug: the release took only machines the guard may act on, so a given-up machine kept its tunnel and Ona kept its box running.
test("an idle machine the guard gave up on is released once the failure's quiet period ends (fails if a give-up blocks the release, or the release skips the quiet period)", () =>
  onFakeClock(async () => {
    const { pass, suspends, guard, hosts, releasing } = await givenUp();
    await tick(10 * 60_000);
    await pass();
    assert.equal(suspends(), 0, "inside the third failure's quiet period");
    await tick(10 * 60_000);
    await pass();
    assert.equal(suspends(), 1);
    // Released through bb's suspend with the no-stop flag, which the provider's suspend used (safety rule 2).
    assert.equal(hosts.get("h1")!.lifecycle.phase, "suspended");
    assert.equal(releasing.size, 0);
    // A suspended machine starts afresh: bb's resume reconnects it (decision 0003).
    assert.equal(guard.records.get("h1")!.failures, 0);
  }));

test("a given-up machine with a live thread is not released (fails if the release's holds skip a given-up machine)", () =>
  onFakeClock(async () => {
    const { pass, suspends, box } = await givenUp();
    await tick(20 * 60_000);
    const live: ThreadRecord = {
      id: "t1",
      status: "active",
      updatedAt: Date.now(),
      runtime: { displayStatus: "active" },
    };
    box.threads = [live];
    await pass();
    assert.equal(suspends(), 0);
  }));

test("a given-up machine is not released while Ona's listing fails (fails if the release runs on an unknown listing)", () =>
  onFakeClock(async () => {
    const { pass, suspends, opts } = await givenUp();
    await tick(20 * 60_000);
    opts.listing = "fail";
    await pass();
    assert.equal(suspends(), 0);
  }));

test("a release bb refuses past a give-up backs off 40, then 60 minutes, and stops after three tries (fails if the count is not raised, the backoff is a cooldown or uncapped, or the release never stops)", () =>
  onFakeClock(async () => {
    const { pass, suspends, guard } = await givenUp({ refuse: REFUSED });
    const record = () => guard.records.get("h1")!;
    await tick(20 * 60_000);
    for (const [tries, quietMinutes] of [
      [1, 40],
      [2, 60],
    ] as const) {
      await pass();
      assert.equal(suspends(), tries);
      assert.equal(record().failures, GIVE_UP_AFTER + tries);
      assert.equal(record().quietUntil, Date.now() + quietMinutes * 60_000);
      await tick((quietMinutes - 1) * 60_000);
      await pass();
      assert.equal(suspends(), tries, "inside the backoff");
      await tick(60_000);
    }
    await pass();
    assert.equal(suspends(), 3);
    for (let i = 0; i < 6; i++) {
      await tick(HOUR);
      await pass();
    }
    assert.equal(suspends(), 3);
  }));

test("a forced release that fails past a give-up records its own failure, count 1 (fails if a forced failure keeps the other action's record)", async () => {
  const guard = new HostGuard();
  guard.records.set("h1", { action: "heal-daemon", reason: "r", at: 0, failures: GIVE_UP_AFTER, quietUntil: 0 });
  const refused = async () => {
    throw new Error(REFUSED);
  };
  await assert.rejects(guard.run("h1", RELEASE_IDLE, "idle", refused, { force: true }));
  assert.equal(guard.records.get("h1")!.action, RELEASE_IDLE);
  assert.equal(guard.records.get("h1")!.failures, 1);
});

// A refused release past a give-up keeps the repair's record, so the recovery that clears that record still clears it.
test("a refused release keeps the repair's give-up, which a connected box clears so a later daemon drop is repaired (fails if the release's failure replaces the repair's record)", () =>
  onFakeClock(async () => {
    const { pass, suspends, box, hosts, calls } = await givenUp({ refuse: REFUSED });
    await tick(20 * 60_000);
    await pass();
    assert.equal(suspends(), 1);
    // A live thread keeps the box from another release while it recovers.
    box.threads = [{ id: "t1", status: "active", updatedAt: Date.now(), runtime: { displayStatus: "active" } }];
    Object.assign(hosts.get("h1")!, { status: "connected", lastSeenAt: Date.now() });
    await pass();
    Object.assign(hosts.get("h1")!, { status: "disconnected", lastSeenAt: Date.now() - HOUR });
    const probes = calls.filter((call) => call === "probe").length;
    await pass();
    assert.equal(calls.filter((call) => call === "probe").length, probes + 1);
  }));

test("a held give-up still stops the release (fails if the release passes a give-up a thread's hold owns)", async () => {
  const { sync, calls, guard } = world([idle("h1", { status: "disconnected" })]);
  const held = {
    action: "heal-daemon",
    reason: "r",
    at: Date.now(),
    failures: GIVE_UP_AFTER,
    quietUntil: Date.now(),
    threadWaiting: true,
  };
  guard.records.set("h1", held);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(guard.records.get("h1"), held);
});
