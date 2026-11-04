// Mocked setTimeout and Date for the files that test waits: each tick is one interval,
// so counts are exact and the tests instant.
import { afterEach, beforeEach, mock } from "node:test";

/** Mock the clock around every test in the calling file. */
export function useFakeClock() {
  beforeEach(enableFakeClock);
  afterEach(resetFakeClock);
}

export const enableFakeClock = () => mock.timers.enable({ apis: ["setTimeout", "Date"] });

/**
 * Turns the fake clock off; eslint flags `mock.timers.reset()` and `mock.reset()` elsewhere.
 * Enable the clock only through this file: one enabled through a test's context is reset by
 * Node itself, with no settle.
 * shortcut: Node 24.22.1's mock_timers.js removes an aborted sleep's fake timer in an async
 * finally, after a reset emptied the queue, so the next test's timers never fire (checked
 * 2026-11-03; 24.3.0 does not). Drop the settle once a bare reset right after an aborted sleep
 * passes on the Node CI uses.
 */
export async function resetFakeClock() {
  await settle();
  // eslint-disable-next-line no-restricted-syntax -- the one place the clock is reset
  mock.timers.reset();
}

/** Let pending work run up to its next sleep (setImmediate is not mocked). */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Settle, then pass `ms`; `times` over. */
export async function tick(ms: number, times = 1) {
  for (let i = 0; i < times; i++) {
    await settle();
    mock.timers.tick(ms);
  }
}
