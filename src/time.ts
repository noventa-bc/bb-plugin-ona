// The sleep and the poll loop the plugin's waits share, both abortable, and the lifecycle timer's tick.
// The default import, not the named one: node:test's mock.timers patches this object.
import timers from "node:timers/promises";

/** Wait `ms`, or less if `signal` aborts. Resolves either way: callers check the signal after. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return timers.setTimeout(ms, undefined, { signal }).catch((error: unknown) => {
    if (!signal?.aborted) throw error;
  });
}

/**
 * Run `probe` every `intervalMs` until it returns a truthy value, which is returned,
 * or `deadlineMs` passes, which returns undefined. Throws the abort reason as soon as
 * `signal` aborts, without probing again.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | false | undefined>,
  options: { deadlineMs: number; intervalMs: number; signal: AbortSignal },
): Promise<T | undefined> {
  const { intervalMs, signal } = options;
  const deadline = Date.now() + options.deadlineMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await probe();
    if (result) return result;
    await sleep(intervalMs, signal);
  }
  signal.throwIfAborted();
  return undefined;
}

/** A provider's progress report, as bb's SDK shapes it. */
type Progress = { step(text: string): void; log(text: string): void };

/**
 * Runs `run` with `signal` that also aborts after `minutes`; `run` has to honour it. `run` reports through the report
 * it is given, which remembers the last step. When the cap aborts it, the error is "Gave up <what> after <minutes>
 * minutes; last step: <step>" (or ends at "minutes." with no step), with run's error as its cause. The caller's own
 * abort keeps the error it caused. setTimeout, not AbortSignal.timeout: the tests' mocked clock drives only setTimeout.
 */
export async function capped<T>(
  what: string,
  minutes: number,
  signal: AbortSignal,
  report: Progress,
  run: (signal: AbortSignal, report: Progress) => Promise<T>,
): Promise<T> {
  let last = "";
  const tracked: Progress = {
    step: (text) => {
      last = text;
      report.step(text);
    },
    log: (text) => report.log(text),
  };
  const gaveUp = `Gave up ${what} after ${minutes} minutes`;
  const cap = new AbortController();
  const timer = setTimeout(() => cap.abort(new Error(`${gaveUp}.`)), minutes * 60_000);
  try {
    return await run(AbortSignal.any([signal, cap.signal]), tracked);
  } catch (error) {
    if (!cap.signal.aborted || signal.aborted) throw error;
    throw new Error(last ? `${gaveUp}; last step: ${last}` : `${gaveUp}.`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** The lifecycle timer ticks every 15 s; every BACKSTOP_TICKS-th tick is the backstop, 2 minutes apart. */
export const TICK_MS = 15_000;
const BACKSTOP_TICKS = 8;
/** A gap longer than this between two ticks means the process slept: bb's SDK has no wake event. */
const SLEEP_GAP_MS = 60_000;

/** What timerTick keeps between ticks: when the last tick ran, and the ticks since the last backstop or sleep. */
export interface TickState {
  last: number;
  count: number;
}

/**
 * One tick at `now`. `slept` is the gap in ms when the tick came after a sleep, else null. A sleep restarts the count
 * and its tick is never a backstop: the pass the sleep schedules covers that moment, so no second pass follows it.
 */
export function timerTick(
  state: TickState,
  now: number,
): { state: TickState; slept: number | null; backstop: boolean } {
  const gap = now - state.last;
  if (gap > SLEEP_GAP_MS) return { state: { last: now, count: 0 }, slept: gap, backstop: false };
  const count = state.count + 1;
  const backstop = count === BACKSTOP_TICKS;
  return { state: { last: now, count: backstop ? 0 : count }, slept: null, backstop };
}
