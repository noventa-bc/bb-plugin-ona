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

/** The lifecycle timer ticks every 15 s. */
export const TICK_MS = 15_000;
/** A backstop pass comes on the first tick at least this long after the last backstop or wake. */
const BACKSTOP_MS = 120_000;
/** A timer can fire a few ms early, so a tick 1 s short of BACKSTOP_MS still counts, not a whole tick later. */
const BACKSTOP_SLACK_MS = 1_000;
/** A gap longer than this between two ticks is taken as a sleep: bb's SDK has no wake event. */
const SLEEP_GAP_MS = 60_000;

/** What timerTick keeps between ticks: when the last tick ran, and when the last backstop or wake was. */
export interface TickState {
  last: number;
  backstopAt: number;
}

/**
 * One tick at `now`. `sleptMs` is the gap in ms when the tick is taken as a sleep, else null. A sleep sets
 * `backstopAt`, and its tick is never a backstop: the pass the sleep schedules covers that moment, so the tick adds
 * no pass of its own. A clock that stepped back is a backstop, since `backstopAt` would otherwise stay in the future.
 */
export function timerTick(
  state: TickState,
  now: number,
): { state: TickState; sleptMs: number | null; backstop: boolean } {
  const gap = now - state.last;
  if (gap > SLEEP_GAP_MS) return { state: { last: now, backstopAt: now }, sleptMs: gap, backstop: false };
  const backstop = now < state.backstopAt || now - state.backstopAt >= BACKSTOP_MS - BACKSTOP_SLACK_MS;
  return { state: { last: now, backstopAt: backstop ? now : state.backstopAt }, sleptMs: null, backstop };
}
