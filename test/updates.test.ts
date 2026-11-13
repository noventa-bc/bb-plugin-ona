import assert from "node:assert/strict";
import { test } from "node:test";
import { hostIsBusy, STUCK_THREAD_MS, stuckThreads, threadStatuses } from "../src/updates.ts";

test("a host with an agent turn in flight is busy", () => {
  assert.equal(hostIsBusy(["idle", "error"]), false);
  assert.equal(hostIsBusy(["idle", "active"]), true);
  assert.equal(hostIsBusy(threadStatuses([{ status: "idle", queuedWork: "waiting" }, { status: "idle" }])), true);
});

// Bug: the owner couldn't see why a box was never released.
test("stuckThreads flags busy threads with no update for over 6h", () => {
  const now = 100 * STUCK_THREAD_MS;
  const old = now - STUCK_THREAD_MS - 1;
  const threads = [
    { id: "stuck", status: "active", updatedAt: old },
    { id: "queued", status: "idle", queuedWork: "waiting", updatedAt: old },
    { id: "recent", status: "active", updatedAt: now - 1 },
    { id: "idle", status: "idle", updatedAt: old },
  ];
  assert.deepEqual(
    stuckThreads(threads, now).map((thread) => `${thread.id} ${thread.status}`),
    ["stuck active", "queued pending"],
  );
});
