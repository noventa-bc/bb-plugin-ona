// Mocked setTimeout and Date for the files that test waits: each tick is one interval,
// so counts are exact and the tests instant.
import { afterEach, beforeEach, mock } from "node:test";

/** Mock the clock around every test in the calling file. */
export function useFakeClock() {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
  // A sleep aborted at the end of a test removes its fake timer a microtask later; after a
  // reset that removal corrupts the emptied fake queue, and the next test's timers never fire.
  afterEach(async () => {
    await settle();
    mock.timers.reset();
  });
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
