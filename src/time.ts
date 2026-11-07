// The sleep and the poll loop the plugin's waits share, both abortable.
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

/**
 * Runs `run` with `signal` that also aborts after `minutes`; `run` has to honour it. When the cap aborts it, the error
 * is "Gave up <what> after <minutes> minutes: <first line of run's error>", the reason left out when `run` rethrew the
 * cap's own abort reason. The caller's own abort keeps the error it caused. setTimeout, not AbortSignal.timeout: the
 * tests' mocked clock drives only setTimeout.
 */
export async function capped<T>(
  what: string,
  minutes: number,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const gaveUp = `Gave up ${what} after ${minutes} minutes`;
  const cap = new AbortController();
  const timer = setTimeout(() => cap.abort(new Error(`${gaveUp}.`)), minutes * 60_000);
  try {
    return await run(AbortSignal.any([signal, cap.signal]));
  } catch (error) {
    if (!cap.signal.aborted || signal.aborted) throw error;
    const reason = error instanceof Error && error !== cap.signal.reason ? error.message.trim().split("\n")[0] : "";
    throw new Error(reason ? `${gaveUp}: ${reason}` : `${gaveUp}.`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
