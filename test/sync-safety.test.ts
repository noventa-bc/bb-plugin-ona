// Sync passes against the safety rules in docs/sync.md: each test fails if the check it names is removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUR, NOW, idle, world } from "./sync-fakes.ts";

test("a daemon repair makes no SSH check when the repair's own listing shows the box stopped (fails if the check before the SSH is dropped)", async () => {
  const { sync, calls } = world([idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR })], {
    stopBeforeRefresh: true,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, [], "the pass's listing said RUNNING, the fresh one STOPPED: no probe");
});

test("two empty Ona listings settle nothing: no lookup by id, no suspend (fails if an empty listing counts as the box missing)", async () => {
  // An empty listing is as likely a wrong `ona context` as no boxes; a lookup by id there finds nothing either.
  const { sync, calls } = world([idle("h1")], { listing: "empty" });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, []);
});

test("an unknown daemon answer is reported as unknown (fails if the fake turns null into true)", async () => {
  const box = idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR });
  const { sync, guard } = world([box], { daemonAlive: null });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.match(guard.records.get("h1")!.reason, /couldn't tell whether the daemon runs/);
});
