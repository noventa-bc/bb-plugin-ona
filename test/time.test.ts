import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { capped, pollUntil, sleep, TICK_MS, timerTick, type TickState } from "../src/time.ts";
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
const quiet = { step() {}, log() {} };

/** Reports `steps`, then logs `logs`, then waits for its signal and rejects with `error(signal)`. */
function reportThenHang(steps: string[], error: (signal: AbortSignal) => Error, logs: string[] = []) {
  return (signal: AbortSignal, report: { step(text: string): void; log(text: string): void }) => {
    for (const text of steps) report.step(text);
    for (const text of logs) report.log(text);
    return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(error(signal))));
  };
}

// Guard, no `// Bug:` line: a cap timer left behind keeps the process alive for 30 minutes after a finished call.
test("capped clears its timer once the call finishes (fails if the cap still fires after it)", async () => {
  let given: AbortSignal | undefined;
  assert.equal(await capped("working", 30, never, quiet, async (signal) => ((given = signal), "done")), "done");
  await tick(MINUTE, 31);
  assert.equal(given?.aborted, false);
});

// Guard, no `// Bug:` line: a plugin reload that lands as the cap expires is the reload's, not the cap's.
test("capped keeps the caller's error when the caller aborts as the cap expires (fails if the cap's wins)", async () => {
  const caller = new AbortController();
  let fail!: (error: Error) => void;
  const run = capped("working", 30, caller.signal, quiet, () => new Promise<never>((_, reject) => (fail = reject)));
  run.catch(() => {});
  await tick(MINUTE, 30);
  caller.abort(new Error("plugin reloaded"));
  fail(new Error("stopped by the reload"));
  await assert.rejects(run, { message: "stopped by the reload" });
});

// Guard, no `// Bug:` line: the user sees only the message, so a cap cut names the last step the call reported.
// bb's installer output goes through `log`: forwarded, and never taken for a step.
test("a cap cut names the last step, not a later log line; both reach the caller's report; run's error is the cause", async () => {
  const seen: string[] = [];
  const logged: string[] = [];
  const inner = new Error("inner");
  const report = { step: (text: string) => void seen.push(text), log: (text: string) => void logged.push(text) };
  const run = capped(
    "working",
    30,
    never,
    report,
    reportThenHang(["one", "two"], () => inner, ["installer line"]),
  );
  run.catch(() => {});
  await tick(MINUTE, 30);
  await assert.rejects(run, { message: "Gave up working after 30 minutes; last step: two", cause: inner });
  assert.deepEqual(seen, ["one", "two"]);
  assert.deepEqual(logged, ["installer line"]);
});

test("a cap cut with no step reported gives the bare message (fails on an empty last step)", async () => {
  const run = capped(
    "working",
    30,
    never,
    quiet,
    reportThenHang([], () => new Error("inner")),
  );
  run.catch(() => {});
  await tick(MINUTE, 30);
  await assert.rejects(run, { message: "Gave up working after 30 minutes." });
});

// bb's bootstrap rethrows its signal's reason, which is the cap's own error.
test("a cap cut whose run rethrows the cap's reason still names the last step", async () => {
  const run = capped(
    "working",
    30,
    never,
    quiet,
    reportThenHang(["installing"], (signal) => signal.reason as Error),
  );
  run.catch(() => {});
  await tick(MINUTE, 30);
  await assert.rejects(run, { message: "Gave up working after 30 minutes; last step: installing" });
});

/** Feeds timerTick the tick times in order, from `state`; returns the times that backstop and the state after. */
function runTicks(state: TickState, times: number[]) {
  const backstops: number[] = [];
  for (const at of times) {
    const step = timerTick(state, at);
    state = step.state;
    if (step.backstop) backstops.push(at);
  }
  return { backstops, state };
}

/** The times of `count` ticks after `from`, one TICK_MS apart. */
const ticksAfter = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + (i + 1) * TICK_MS);

test("a tick 15 s after the last is neither a sleep nor a backstop (fails if it reports a sleep or backstops)", () => {
  const step = timerTick({ last: 0, count: 0 }, TICK_MS);
  assert.equal(step.slept, null);
  assert.equal(step.backstop, false);
});

test("every 8th tick is the backstop, 2 minutes apart (fails at a period of 7 or 9 ticks, or with no backstop)", () => {
  assert.deepEqual(runTicks({ last: 0, count: 0 }, ticksAfter(0, 20)).backstops, [2 * MINUTE, 4 * MINUTE]);
});

test("a gap just over 60 s is a sleep, and its length is reported (fails if a sleep is not reported)", () => {
  const step = timerTick({ last: 0, count: 3 }, MINUTE + 1);
  assert.equal(step.slept, MINUTE + 1);
  assert.equal(step.backstop, false);
});

test("a gap of exactly 60 s is not a sleep (fails if the sleep test is >= rather than >)", () => {
  assert.equal(timerTick({ last: 0, count: 0 }, MINUTE).slept, null);
});

test("a sleep on the 8th tick is not also a backstop (fails if the sleep's pass is followed by a backstop)", () => {
  const step = timerTick({ last: 0, count: 7 }, 10 * MINUTE);
  assert.equal(step.slept, 10 * MINUTE);
  assert.equal(step.backstop, false);
});

test("a sleep restarts the count, so the next backstop is 8 ticks after the wake (fails if the count carries on)", () => {
  const wake = 10 * MINUTE;
  const { state } = runTicks({ last: 0, count: 5 }, [wake]);
  assert.deepEqual(runTicks(state, ticksAfter(wake, 8)).backstops, [wake + 2 * MINUTE]);
});
