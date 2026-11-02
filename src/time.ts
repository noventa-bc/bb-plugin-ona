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
