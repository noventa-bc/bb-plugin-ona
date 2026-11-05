import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, GIVE_UP_AFTER } from "../src/reconcile.ts";
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
