import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ALL } from "../src/reconcile.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { idle, MISMATCH_LINE, REFUSED, world } from "./sync-fakes.ts";

// The `metric mismatch` line (src/sync.ts) over whole passes. Most boxes here are stopped in Ona while bb shows them
// connected: decide() repairs nothing there, so only the metric line shows it. pluginStartedAt is the mocked now, so no
// test here reaches the idle release (an hour without a thread).
const GONE_LINE = MISMATCH_LINE.replace("active-stopped", "active-gone");
const mismatchLines = (logs: readonly string[]) => logs.filter((line) => line.startsWith("metric mismatch"));

test("a new incident after a cleared one logs again after its own 120 s (fails if a cleared mismatch keeps its hold)", async () => {
  enableFakeClock();
  try {
    const host = idle("h1", { ona: "STOPPED" });
    const { sync, logs } = world([host], { pluginStartedAt: Date.now() });
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(60_000);
    host.ona = "RUNNING";
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(60_000);
    host.ona = "STOPPED";
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(119_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [], "the second incident has held 119 s");
    await tick(1_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE]);
  } finally {
    await resetFakeClock();
  }
});

test("a machine that leaves the bb listing drops its incident, so its next one starts a new hold (fails if an absent machine keeps its entry)", async () => {
  enableFakeClock();
  try {
    const { sync, logs, hosts } = world([idle("h1", { ona: "STOPPED" })], { pluginStartedAt: Date.now() });
    await sync.reconcile(new Set([ALL]), { wait: true });
    const host = hosts.get("h1")!;
    hosts.delete("h1");
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    hosts.set("h1", host);
    await tick(120_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), []);
  } finally {
    await resetFakeClock();
  }
});

test("a failed listing in the middle of an incident neither restarts the hold nor logs a second line (fails if a failed listing drops the entry)", async () => {
  enableFakeClock();
  try {
    const options: { pluginStartedAt: number; listing?: "fail" } = { pluginStartedAt: Date.now() };
    const { sync, logs } = world([idle("h1", { ona: "STOPPED" })], options);
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(120_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE]);
    options.listing = "fail";
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    delete options.listing;
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(120_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE], "the same incident: no second line");
  } finally {
    await resetFakeClock();
  }
});

test("one listing that omits the box neither ends the incident nor logs a second line (fails if a pass that omits the box drops the entry)", async () => {
  enableFakeClock();
  try {
    // h2 keeps Ona's listing non-empty: an empty listing is unknown, so the omitted h1 would not be read at all.
    const host = idle("h1", { ona: "STOPPED" });
    const { sync, logs } = world([host, idle("h2")], { pluginStartedAt: Date.now() });
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(120_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE]);
    host.ona = null;
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    host.ona = "STOPPED";
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(120_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE], "the same incident: no second line");
  } finally {
    await resetFakeClock();
  }
});

test("a box Ona lacks that bb refuses to suspend stays active, and its line follows 120 s after the first pass that saw it (fails if the active-gone kind is not reported)", async () => {
  enableFakeClock();
  try {
    // h2 keeps Ona's listing non-empty: an empty listing is unknown, not "h1 is gone" (rule 4).
    const { sync, logs, hosts } = world([idle("h1", { ona: null }), idle("h2")], {
      refuse: REFUSED,
      pluginStartedAt: Date.now(),
    });
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [], "held 60 s");
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.equal(hosts.get("h1")!.lifecycle.phase, "active");
    assert.deepEqual(mismatchLines(logs), [GONE_LINE]);
  } finally {
    await resetFakeClock();
  }
});

test("an incident first seen by a pass with a slow listing is timed from that pass's start (fails if the hold starts when the listing returns)", async () => {
  // Bug: the hold started when Ona's listing returned, so a slow listing could delay the line by a whole cycle.
  enableFakeClock();
  try {
    // Pass 1 starts at 0 and its listing takes 30 s; pass 2 starts at 120 s, and its listing is fast.
    const options: { pluginStartedAt: number; listingMs?: number } = { pluginStartedAt: Date.now(), listingMs: 30_000 };
    const { sync, logs } = world([idle("h1", { ona: "STOPPED" })], options);
    await sync.reconcile(new Set([ALL]), { wait: true });
    delete options.listingMs;
    await tick(90_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE]);
  } finally {
    await resetFakeClock();
  }
});

test("an incident first seen by a pass with a slow bb host listing is timed from that pass's start (fails if the hold starts after bb's host listing)", async () => {
  // Bug: the hold started after bb's host listing and Ona's listing, so a slow read of either could delay the line by a whole cycle.
  enableFakeClock();
  try {
    // Pass 1 starts at 0 and bb's host listing takes 30 s; pass 2 starts at 120 s, and its host listing is fast.
    // The hook runs inside the listing, so it moves the clock with mock.timers.tick (tick() is async).
    let slowHostList = true;
    const options = {
      pluginStartedAt: Date.now(),
      afterCall: (call: string) => {
        if (call === "list" && slowHostList) mock.timers.tick(30_000);
      },
    };
    const { sync, logs } = world([idle("h1", { ona: "STOPPED" })], options);
    await sync.reconcile(new Set([ALL]), { wait: true });
    slowHostList = false;
    await tick(90_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH_LINE]);
  } finally {
    await resetFakeClock();
  }
});
