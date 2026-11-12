import assert from "node:assert/strict";
import { test } from "node:test";
import { COOLDOWN_MS, HostGuard } from "../src/reconcile.ts";

// Kept apart from reconcile.test.ts: adding these would bring it within 10 lines of the max-lines cap (scripts/lines.sh).

test("guard: a success with cooldown: false waits no time (fails if every success gets the cooldown)", async () => {
  const guard = new HostGuard(2, { now: () => 0 });
  assert.equal(await guard.run("h1", "release-idle", "r", async () => {}, { cooldown: false }), true);
  assert.equal(guard.mayAct("h1"), true);
});

test("guard: a forced success with cooldown: true still waits COOLDOWN_MS (fails if a forced success gets none)", async () => {
  let now = 0;
  const guard = new HostGuard(2, { now: () => now });
  assert.equal(await guard.run("h1", "heal-daemon", "r", async () => {}, { force: true, cooldown: true }), true);
  now += COOLDOWN_MS - 1;
  assert.equal(guard.mayAct("h1"), false, "a forced success still waits COOLDOWN_MS");
  now += 1;
  assert.equal(guard.mayAct("h1"), true);
});

test("guard: a success that keeps a waiting thread's hold keeps its count and flag, and waits COOLDOWN_MS from its end (fails if the wait starts elsewhere, or the count or flag goes)", async () => {
  let now = 10_000;
  const guard = new HostGuard(2, { now: () => now });
  // Two failures in a row: their backoff would be 2 * COOLDOWN_MS, so the test tells it apart from the cooldown.
  guard.records.set("h1", {
    action: "heal-daemon",
    reason: "r",
    at: 5_000,
    failures: 2,
    quietUntil: 8_000,
    threadWaiting: true,
  });
  // The action takes time, so the wait must start when it ends, not when it starts.
  assert.equal(
    await guard.run("h1", "heal-daemon", "r", async () => {
      now += 1_000;
    }),
    true,
  );
  assert.equal(guard.records.get("h1")?.failures, 2, "the hold keeps its count");
  assert.equal(guard.records.get("h1")?.threadWaiting, true, "the hold keeps its flag");
  now += COOLDOWN_MS - 1;
  assert.equal(guard.mayAct("h1"), false, "the hold's success waits COOLDOWN_MS from its end");
  now += 1;
  assert.equal(guard.mayAct("h1"), true);
});
