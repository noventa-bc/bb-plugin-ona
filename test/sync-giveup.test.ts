// The idle release of a machine the guard gave up repairing: the box is still let go, with every hold the release has.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, GIVE_UP_AFTER } from "../src/reconcile.ts";
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

test("a release bb refuses past a give-up waits out its backoff (fails if it is retried on the next pass)", () =>
  onFakeClock(async () => {
    const { pass, suspends } = await givenUp({ refuse: REFUSED });
    await tick(20 * 60_000);
    await pass();
    assert.equal(suspends(), 1);
    await tick(60_000);
    await pass();
    assert.equal(suspends(), 1, "inside the fourth failure's 40-minute backoff");
    await tick(40 * 60_000);
    await pass();
    assert.equal(suspends(), 2);
  }));

// The refused release overwrote the repair's record, so bb showing the box connected no longer cleared the give-up.
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
