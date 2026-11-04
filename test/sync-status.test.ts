import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRecord } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock } from "./fake-clock.ts";
import { HOUR, idle, world } from "./sync-fakes.ts";

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
