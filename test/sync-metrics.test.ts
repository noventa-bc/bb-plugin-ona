import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL } from "../src/reconcile.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { idle, world } from "./sync-fakes.ts";

// Ona has the box stopped while bb shows it connected: decide() repairs nothing, so only the metric line shows it.
// pluginStartedAt is the mocked now, so no test here reaches the idle release (an hour without a thread).
const MISMATCH = "metric mismatch host=ona:env-h1 kind=active-stopped secs=120";
const mismatchLines = (logs: readonly string[]) => logs.filter((line) => line.startsWith("metric mismatch"));

test("a mismatch held 120 s logs one metric line, and not before (fails if the line is written before the hold ends)", async () => {
  enableFakeClock();
  try {
    const { sync, logs } = world([idle("h1", { ona: "STOPPED" })], { pluginStartedAt: Date.now() });
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(119_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), []);
    await tick(1_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), [MISMATCH]);
  } finally {
    await resetFakeClock();
  }
});

test("a mismatch logs once per incident, not on every pass after the hold (fails if the logged flag is ignored)", async () => {
  enableFakeClock();
  try {
    const { sync, logs } = world([idle("h1", { ona: "STOPPED" })], { pluginStartedAt: Date.now() });
    for (let pass = 0; pass < 4; pass++) {
      await sync.reconcile(new Set([ALL]), { wait: true });
      await tick(120_000);
    }
    assert.deepEqual(mismatchLines(logs), [MISMATCH]);
  } finally {
    await resetFakeClock();
  }
});

test("a mismatch that clears before 120 s logs nothing (fails if a cleared mismatch is logged)", async () => {
  enableFakeClock();
  try {
    const host = idle("h1", { ona: "STOPPED" });
    const { sync, logs } = world([host], { pluginStartedAt: Date.now() });
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(60_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(59_000);
    host.ona = "RUNNING";
    await sync.reconcile(new Set([ALL]), { wait: true });
    await tick(120_000);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(mismatchLines(logs), []);
  } finally {
    await resetFakeClock();
  }
});

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
    assert.deepEqual(mismatchLines(logs), [MISMATCH]);
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
