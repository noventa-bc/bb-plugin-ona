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
 * Turns the fake clock off; eslint flags a direct `mock.timers.reset()` elsewhere.
 * shortcut: node:test removes an aborted sleep's fake timer a microtask late, which
 * corrupts the emptied queue so the next test's timers never fire (`check.yml` names the
 * Node versions), drop the settle once a bare reset right after an aborted sleep passes
 * on the Node CI uses.
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
