import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL } from "../src/reconcile.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { idle, MISMATCH_LINE, world } from "./sync-fakes.ts";

// The `metric mismatch` line (src/sync.ts) over whole passes. Most boxes here are stopped in Ona while bb shows them
// connected: decide() repairs nothing there, so only the metric line shows it. pluginStartedAt is the mocked now, so no
// test here reaches the idle release (an hour without a thread).
const GONE_LINE = MISMATCH_LINE.replace("active-stopped", "active-gone");
const REFUSED = "Machine suspension failed: Host is not connected";
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
