import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { capped, pollUntil, sleep } from "../src/time.ts";
import { settle, tick, useFakeClock } from "./fake-clock.ts";

const never = new AbortController().signal;
/** For tests that wait on an abort: a sleep that ignores it would hang, so fail it instead. */
const fast = { timeout: 1_000 };

useFakeClock();

/** A probe that is false once, then throws: a loop that probes past an abort fails instead of spinning. */
function onceThenThrow() {
  let calls = 0;
  return async () => {
    if (++calls > 1) throw new Error("probed after abort");
    return false;
  };
}

test("pollUntil returns the first truthy probe result (fails if it keeps probing past it)", async () => {
  let calls = 0;
  const waiting = pollUntil(async () => (++calls === 3 ? "ready" : false), {
    deadlineMs: 1_000,
    intervalMs: 10,
    signal: never,
  });
  // Ticks past the deadline too, so a loop that ignores the result fails rather than hangs.
  await tick(10, 100);
  assert.equal(await waiting, "ready");
  assert.equal(calls, 3);
});

test("pollUntil probes once per interval until the deadline (fails on a probe after the deadline)", async () => {
  let calls = 0;
  const waiting = pollUntil(async () => void calls++, { deadlineMs: 100, intervalMs: 30, signal: never });
  await tick(30, 5);
  assert.equal(await waiting, undefined);
  assert.equal(calls, 4, "probes at 0, 30, 60 and 90ms");
});

test("an abort ends the wait without waiting out the interval or probing again", fast, async () => {
  const controller = new AbortController();
  const waiting = pollUntil(onceThenThrow(), { deadlineMs: 60_000, intervalMs: 10_000, signal: controller.signal });
  await tick(5);
  controller.abort(new Error("cancelled"));
  // No further tick: the rejection must not depend on the 10s interval passing.
  await assert.rejects(waiting, /cancelled/);
});

test("an abort during the sleep that outlasts the deadline rejects (fails if it returns undefined)", fast, async () => {
  const controller = new AbortController();
  const waiting = pollUntil(onceThenThrow(), { deadlineMs: 10, intervalMs: 50, signal: controller.signal });
  await tick(20);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
});

test("sleep resolves early on abort, at once on an aborted signal, and after `ms` with no signal", fast, async () => {
  const controller = new AbortController();
  const early = sleep(10_000, controller.signal);
  controller.abort();
  await early;
  await sleep(10_000, AbortSignal.abort());
  let done = false;
  const plain = sleep(1).then(() => (done = true));
  await settle();
  assert.equal(done, false);
  mock.timers.tick(1);
  await plain;
});

const MINUTE = 60_000;

// Guard, no `// Bug:` line: a cap timer left behind keeps the process alive for 30 minutes after a finished call.
test("capped clears its timer once the call finishes (fails if the cap still fires after it)", async () => {
  let given: AbortSignal | undefined;
  assert.equal(await capped("working", 30, never, async (signal) => ((given = signal), "done")), "done");
  await tick(MINUTE, 31);
  assert.equal(given?.aborted, false);
});

// Guard, no `// Bug:` line: a plugin reload that lands as the cap expires is the reload's, not the cap's.
test("capped keeps the caller's error when the caller aborts as the cap expires (fails if the cap's wins)", async () => {
  const caller = new AbortController();
  let fail!: (error: Error) => void;
  const run = capped("working", 30, caller.signal, () => new Promise<never>((_, reject) => (fail = reject)));
  run.catch(() => {});
  await tick(MINUTE, 30);
  caller.abort(new Error("plugin reloaded"));
  fail(new Error("stopped by the reload"));
  await assert.rejects(run, { message: "stopped by the reload" });
});
