import assert from "node:assert/strict";
import { test } from "node:test";
import { COOLDOWN_MS, HostGuard } from "../src/reconcile.ts";

// The success cooldown's branches (docs/sync.md rule 5). Kept apart from reconcile.test.ts to stay under the
// max-lines cap in eslint.config.js.

// HostGuard reads only the time, so a number the test moves stands in for the clock.
function movingClock() {
  let now = 0;
  return {
    clock: { now: () => now },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("guard: a success with cooldown: false waits no time (fails if every success gets the cooldown)", async () => {
  const { clock } = movingClock();
  const guard = new HostGuard(2, clock);
  assert.equal(await guard.run("h1", "release-idle", "r", async () => {}, { cooldown: false }), true);
  assert.equal(guard.mayAct("h1"), true);
});

test("guard: a forced success with cooldown: true still waits COOLDOWN_MS (fails if a forced success gets none)", async () => {
  const { clock, advance } = movingClock();
  const guard = new HostGuard(2, clock);
  assert.equal(await guard.run("h1", "heal-daemon", "r", async () => {}, { force: true, cooldown: true }), true);
  advance(COOLDOWN_MS - 1);
  assert.equal(guard.mayAct("h1"), false, "a forced success still waits COOLDOWN_MS");
  advance(1);
  assert.equal(guard.mayAct("h1"), true);
});

test("guard: a success that keeps a waiting thread's hold waits COOLDOWN_MS (fails if it waits nothing, or the failure backoff)", async () => {
  const { clock, advance } = movingClock();
  const guard = new HostGuard(2, clock);
  // Two failures in a row: their backoff would be 2 * COOLDOWN_MS, so the test tells it apart from the cooldown.
  guard.records.set("h1", {
    action: "heal-daemon",
    reason: "r",
    at: 0,
    failures: 2,
    quietUntil: 0,
    threadWaiting: true,
  });
  assert.equal(await guard.run("h1", "heal-daemon", "r", async () => {}), true);
  advance(COOLDOWN_MS - 1);
  assert.equal(guard.mayAct("h1"), false, "the hold's success waits COOLDOWN_MS");
  advance(1);
  assert.equal(guard.mayAct("h1"), true);
});
