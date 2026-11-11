import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeUsageBucket } from "../src/cost.ts";
import { createThreadCost } from "../src/cost-service.ts";
import type { Devbox, ThreadCost } from "../src/rpc.ts";
import { CODEX_FIGURE, OLD, ONE_DOLLAR_BUCKET } from "./cost-fakes.ts";
import { tick, useFakeClock } from "./fake-clock.ts";

// A fake of the bb calls the cost check makes (CostBb): one thread on one devbox,
// whose newest finished turn is `turnSeq` (none with `noTurn`) and whose agent
// sessions are `sessions` (none with `noSession`), and a fresh Ona listing that
// shows the box in phase `ona` (RUNNING by default) or fails with it. Each call
// reads the options, so a test can change the thread between polls.

useFakeClock();

const MINUTE = 60_000;
const KEY = "cost2:t1"; // the record the code reads and writes
const OLD_KEY = "cost:t1"; // the record key from before the Codex fix (docs/ona-notes.md)

const FIGURE: ThreadCost = { provider: "claude-code", usd: 1, basis: "list-price", partial: false, updatedAt: OLD };
// Codex's account/usage/read answer: with groups once the usage is recorded, without them before.
const recorded = (usd: number) => ({ estimatedUsageUsdMicros: usd * 1_000_000, groups: [{}] });
const UNRECORDED = { estimatedUsageUsdMicros: 0, groups: [] };

interface Stored {
  cost: ThreadCost | null;
  seq: string;
  checkedAt: number;
  runs?: number;
}

function world(options: {
  status?: string;
  turnSeq?: number | string;
  noTurn?: boolean;
  stored?: Stored;
  collect?: () => Promise<unknown>;
  provider?: "claude-code" | "codex";
  sessions?: string[];
  ona?: string | Error;
  noSession?: boolean;
}) {
  const kv = new Map<string, unknown>(options.stored ? [[KEY, options.stored]] : []);
  const warnings: string[] = [];
  const collectorRuns: string[] = [];
  const listings = { count: 0 };
  const box = { envId: "env-1", status: options.status ?? "connected" } as Devbox;
  const identity = (options.sessions ?? ["session-1"]).map((id, i) => ({ seq: i + 1, data: { providerThreadId: id } }));
  const costs = createThreadCost({
    bb: {
      sdk: {
        threads: {
          get: async () => ({ providerId: options.provider ?? "claude-code" }),
          events: {
            list: async ({ types }) => {
              if (types?.[0] === "turn/completed") return options.noTurn ? [] : [{ seq: options.turnSeq ?? 7 }];
              return options.noSession ? [] : identity;
            },
          },
        },
      },
      storage: {
        kv: {
          get: async <T>(key: string) => kv.get(key) as T | undefined,
          set: async (key, value) => void kv.set(key, value),
          delete: async (key) => void kv.delete(key),
        },
      },
      log: { warn: (message) => void warnings.push(message) },
    },
    runCollector: async (envId) => {
      collectorRuns.push(envId);
      return (options.collect ?? (async () => ({ buckets: [ONE_DOLLAR_BUCKET] })))();
    },
    threadDevbox: async () => box,
    snapshot: {
      refresh: async () => {
        listings.count++;
        if (options.ona instanceof Error) throw options.ona;
        return {
          envs: [{ id: "env-1", metadata: {}, status: { phase: options.ona ?? "ENVIRONMENT_PHASE_RUNNING" } }],
          at: 0,
        };
      },
    },
  });
  return { costs, kv, warnings, collectorRuns, listings };
}

type World = ReturnType<typeof world>;

/** Moves the clock on by `minutes`, as the time between two polls. */
const later = (minutes: number) => tick(minutes * MINUTE);
/** Moves the clock past the 5-minute floor, so the next poll checks the thread. */
const pastFloor = () => later(5);

/** Polls once a minute, as the header does; `changes[minute]` runs before that minute's poll. */
async function pollMinutely(w: World, lastMinute: number, changes: Record<number, () => void>) {
  let figure: ThreadCost | null = null;
  for (let minute = 0; minute <= lastMinute; minute++) {
    if (minute > 0) await later(1);
    changes[minute]?.();
    figure = await w.costs.threadCost("t1");
  }
  return figure;
}

test("a box that is not connected returns the stored figure and is never collected from", async () => {
  const w = world({ status: "suspended", turnSeq: 8, stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a paused Claude thread with only a record under the old cost: key keeps that figure (fails if the upgrade drops it)", async () => {
  // Bug: after the cost2: upgrade a paused Claude thread showed nothing until its box ran again.
  const w = world({ status: "suspended", turnSeq: 8 });
  w.kv.set(OLD_KEY, { cost: FIGURE, seq: 7, checkedAt: OLD });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a paused Codex thread keeps an old cost: figure above $0.00 and drops a $0.00 one (fails if either is handled the other way)", async () => {
  // Guard: a Codex $0.00 under the old key may come from the usage lag (docs/ona-notes.md), so only it is dropped.
  const kept = world({ status: "suspended", provider: "codex", turnSeq: 8 });
  kept.kv.set(OLD_KEY, { cost: CODEX_FIGURE, seq: 7, checkedAt: OLD });
  assert.deepEqual(await kept.costs.threadCost("t1"), CODEX_FIGURE);
  const dropped = world({ status: "suspended", provider: "codex", turnSeq: 8 });
  dropped.kv.set(OLD_KEY, { cost: { ...CODEX_FIGURE, usd: 0 }, seq: 7, checkedAt: OLD });
  assert.equal(await dropped.costs.threadCost("t1"), null);
  assert.deepEqual([...kept.collectorRuns, ...dropped.collectorRuns], []);
});

test("a Claude turn with a priced figure runs the collector once, not again after the floor (fails if a priced figure is checked again)", async () => {
  // Guard: a Claude turn is read again only when its first read finds nothing.
  const w = world({ turnSeq: 8, stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 } });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  await pastFloor();
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
});

test("a Claude figure an older version settled stays settled after the upgrade (fails if the old record is read again)", async () => {
  // Guard: the upgrade must not cost an extra collector run per Claude thread.
  const w = world({ turnSeq: 7 });
  w.kv.set(OLD_KEY, { cost: FIGURE, seq: 7, checkedAt: OLD });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a lower partial Claude figure replaces the stored one (fails if the Codex-only rule applies to Claude)", async () => {
  // Guard: only a partial Codex figure waits for usage not recorded yet; a Claude figure is always the latest read.
  const w = world({
    turnSeq: 8,
    stored: { cost: { ...FIGURE, usd: 5 }, seq: "7", checkedAt: OLD, runs: 2 },
    collect: async () => ({ buckets: [{ ...ONE_DOLLAR_BUCKET, model: "claude-unknown-9" }] }),
  });
  const cost = await w.costs.threadCost("t1");
  assert.equal(cost?.partial, true);
  assert.equal(cost?.usd < 5, true);
});

test("bb says connected but a fresh Ona listing says stopped: the stored figure comes back, no collector runs, and the floor applies", async () => {
  // Bug: the collector trusted bb's "connected", which lags a stop made in Ona's UI, and Ona's SSH starts a stopped box.
  const w = world({
    ona: "ENVIRONMENT_PHASE_STOPPED",
    turnSeq: 8,
    stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 },
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
  // Bug: storing nothing paged events and listed Ona on every chip poll while bb kept the stopped box active.
  const kept = w.kv.get(KEY) as { cost: ThreadCost; seq: string; checkedAt: number };
  assert.deepEqual([kept.cost, kept.seq], [FIGURE, "7"]);
  assert.ok(kept.checkedAt > OLD);
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.equal(w.listings.count, 1);
  // With nothing stored no record is written, so the next poll asks Ona again and a box that starts is priced at once.
  const empty = world({ ona: "ENVIRONMENT_PHASE_STOPPED", turnSeq: 8 });
  assert.equal(await empty.costs.threadCost("t1"), null);
  assert.equal(empty.kv.has(KEY), false);
});

test("bb says connected but Ona can't be asked: the stored figure comes back and no collector runs", async () => {
  // Bug: the collector ran without asking Ona; unknown must not count as running.
  const w = world({
    ona: new Error("ona environment list failed"),
    turnSeq: 8,
    stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 },
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
  assert.deepEqual(w.warnings, ["thread cost for t1: ona environment list failed"]);
});

test("a thread with no agent session asks Ona nothing and runs no collector", async () => {
  // Guards the order: Ona is asked only when there is a session to price, not on every poll of an empty thread.
  const w = world({ turnSeq: 8, noSession: true });
  assert.equal(await w.costs.threadCost("t1"), null);
  assert.equal(w.listings.count, 0);
  assert.deepEqual(w.collectorRuns, []);
});

test("the same finished turn returns the stored figure without collecting", async () => {
  const w = world({ turnSeq: 7, stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 2 } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a new finished turn collects once for two callers at the same time, and stores the figure", async () => {
  // The complete $1 replaces the stored $0.50.
  const w = world({ turnSeq: 8, stored: { cost: { ...FIGURE, usd: 0.5 }, seq: "7", checkedAt: OLD, runs: 1 } });
  const [a, b] = await Promise.all([w.costs.threadCost("t1"), w.costs.threadCost("t1")]);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
  assert.equal(a?.usd, 1);
  assert.deepEqual(a, b);
  assert.equal((w.kv.get(KEY) as { seq: string }).seq, "8");
});

test("a figure checked less than 5 minutes ago is returned without collecting, even after a new turn", async () => {
  const w = world({ turnSeq: 8, stored: { cost: FIGURE, seq: "7", checkedAt: Date.now(), runs: 1 } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a collector error warns, returns the stored figure, and retries only after the floor", async () => {
  // Bug: a failed round stored nothing, so a failing collector was retried on every poll, once a minute.
  const w = world({
    turnSeq: 8,
    stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 },
    collect: () => Promise.reject(new Error("ssh failed")),
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.warnings, ["thread cost for t1: ssh failed"]);
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
  await pastFloor();
  await w.costs.threadCost("t1");
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a Claude round with nothing to price keeps the last good figure, is read once more, then settles (fails if the empty round is not read again, or a third runs)", async () => {
  const w = world({
    turnSeq: 8,
    stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 },
    collect: async () => ({ buckets: [] }),
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  await pastFloor();
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  await pastFloor();
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a first round with nothing to price collects again after the floor (fails if the empty first round is not retried)", async () => {
  // Bug: the empty chip stayed empty for a whole turn although a retry would price it.
  let buckets: ClaudeUsageBucket[] = [];
  const w = world({ turnSeq: 8, collect: async () => ({ buckets }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  buckets = [ONE_DOLLAR_BUCKET];
  await pastFloor();
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a Codex round where every session is missing is retried on every poll past the floor (fails if the second empty round settles it)", async () => {
  // Bug: two all-missing rounds settled the turn, but Codex records a turn's usage late (docs/ona-notes.md).
  const w = world({
    turnSeq: 8,
    provider: "codex",
    collect: async () => ({ results: { "session-1": { error: "no usage" } } }),
  });
  assert.equal(await w.costs.threadCost("t1"), null);
  await pastFloor();
  assert.equal(await w.costs.threadCost("t1"), null);
  await pastFloor();
  assert.equal(await w.costs.threadCost("t1"), null);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1", "env-1"]);
});

test("a Codex thread whose usage Codex has not recorded shows no figure, then its figure once recorded (fails if the $0 is shown)", async () => {
  // Bug: Codex answers $0 with no groups until it records the turn's usage, and that $0 was shown until the next turn.
  let usage: unknown = UNRECORDED;
  const w = world({ turnSeq: 8, provider: "codex", collect: async () => ({ results: { "session-1": usage } }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  usage = recorded(1);
  await pastFloor();
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
});

test("a later turn whose total has not grown is retried, then shows the new total once it grows (fails if a flat total settles the turn)", async () => {
  // Bug: a turn whose total had not grown settled at once, so the total Codex recorded later never showed.
  let usage = recorded(1);
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: CODEX_FIGURE, seq: "7", checkedAt: OLD, runs: 12 },
    collect: async () => ({ results: { "session-1": usage } }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  await later(5);
  usage = recorded(3);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 3);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 3);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a Codex turn whose total never grows is checked 12 rounds, then settles (fails if a flat total settles it at once)", async () => {
  // Bug: a flat total settled the turn at once, so a total Codex recorded later never showed.
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: CODEX_FIGURE, seq: "7", checkedAt: OLD, runs: 12 },
    collect: async () => ({ results: { "session-1": recorded(1) } }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  // Eleven more rounds, five minutes apart: the twelfth is 55 minutes after the first.
  for (let i = 0; i < 11; i++) {
    await pastFloor();
    assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  }
  assert.equal(w.collectorRuns.length, 12);
  assert.equal((w.kv.get(KEY) as { seq: string }).seq, "8");
  // A poll after the twelfth round makes no collector run.
  await pastFloor();
  await w.costs.threadCost("t1");
  assert.equal(w.collectorRuns.length, 12);
});

test("a two-session Codex thread with one session unrecorded is retried until both are recorded (fails if the partial figure settles the turn)", async () => {
  // Bug: a partial figure settled the turn, so the session Codex recorded later never showed.
  let second: unknown = UNRECORDED;
  const w = world({
    turnSeq: 8,
    provider: "codex",
    sessions: ["session-1", "session-2"],
    collect: async () => ({ results: { "session-1": recorded(1), "session-2": second } }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.partial, true);
  second = recorded(0.5);
  await pastFloor();
  const figure = await w.costs.threadCost("t1");
  assert.deepEqual([figure?.usd, figure?.partial], [1.5, false]);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a thread with no finished turn collects once for Codex and twice for Claude, not on every poll past the floor (fails if each poll past the floor collects)", async () => {
  // Bug: with no finished turn, every poll past the floor collected again, and a Codex turn still running was checked mid-turn.
  // Claude's usage lands while its turn runs, so an empty first read gets one more.
  for (const provider of ["claude-code", "codex"] as const) {
    // Each provider's round reads only its own field.
    const w = world({
      noTurn: true,
      provider,
      collect: async () => ({ buckets: [], results: { "session-1": UNRECORDED } }),
    });
    assert.equal(await w.costs.threadCost("t1"), null);
    await pastFloor();
    assert.equal(await w.costs.threadCost("t1"), null);
    await pastFloor();
    assert.equal(await w.costs.threadCost("t1"), null);
    assert.deepEqual(w.collectorRuns, provider === "codex" ? ["env-1"] : ["env-1", "env-1"]);
  }
});

test("a Claude thread with only an old cost: record is read once on a running box and saved under the new key (fails if the old key is written or treated as final)", async () => {
  // Guard: the upgrade path for every Claude thread.
  const w = world({ turnSeq: 8 });
  w.kv.set(OLD_KEY, { cost: FIGURE, seq: 7, checkedAt: OLD });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
  assert.deepEqual(w.kv.get(OLD_KEY), { cost: FIGURE, seq: 7, checkedAt: OLD });
  assert.equal((w.kv.get("cost2:t1") as { seq: string }).seq, "8");
});

test("a collector error does not count as one of a turn's rounds (fails if an error uses one up)", async () => {
  // Bug: a failed round used up one of the turn's rounds, so a few failures ended the checks early.
  let failing = false;
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: CODEX_FIGURE, seq: "7", checkedAt: OLD, runs: 12 },
    collect: async () => {
      if (failing) throw new Error("ssh failed");
      return { results: { "session-1": recorded(1) } };
    },
  });
  await w.costs.threadCost("t1"); // the turn's first round
  failing = true;
  for (let i = 0; i < 11; i++) {
    await pastFloor();
    await w.costs.threadCost("t1"); // fails
  }
  failing = false;
  await pastFloor();
  await w.costs.threadCost("t1"); // the turn's second completed round
  assert.equal(w.warnings.length, 11);
  assert.equal(w.collectorRuns.length, 13);
  // Eleven failures and two completed rounds: the turn still has rounds to run.
  await pastFloor();
  await w.costs.threadCost("t1");
  assert.equal(w.collectorRuns.length, 14);
});

test("a Claude round that returns a figure settles the turn (fails if a priced Claude round is read again)", async () => {
  // Guard: only an empty Claude round is read again; a partial Claude figure settles like a complete one.
  const w = world({
    turnSeq: 8,
    collect: async () => ({ buckets: [{ ...ONE_DOLLAR_BUCKET, model: "claude-unknown-9" }] }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.partial, true);
  await pastFloor();
  await w.costs.threadCost("t1");
  assert.deepEqual(w.collectorRuns, ["env-1"]);
});

test("a string seq equal to the stored one returns the stored figure without collecting", async () => {
  // Guard: bb's seq may be a non-numeric string, and the stored seq must match it as given.
  const w = world({ turnSeq: "abc", stored: { cost: FIGURE, seq: "abc", checkedAt: OLD, runs: 2 } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("forgetting a thread drops its stored figures under both keys (fails if an old record outlives its thread)", async () => {
  const w = world({ stored: { cost: FIGURE, seq: "7", checkedAt: OLD, runs: 1 } });
  w.kv.set(OLD_KEY, { cost: FIGURE, seq: 7, checkedAt: OLD });
  await w.costs.forget("t1");
  assert.equal(w.kv.has(KEY), false);
  assert.equal(w.kv.has(OLD_KEY), false);
});

test("two Codex turns ten minutes apart, recorded at 30 and 40 minutes, show $2 (fails if a figure settles the turn)", async () => {
  // Bug: a figure that grew settled the latest turn, so the second turn's usage, recorded later, never showed.
  let usage: unknown = UNRECORDED;
  const options: Parameters<typeof world>[0] = {
    turnSeq: 8,
    provider: "codex",
    collect: async () => ({ results: { "session-1": usage } }),
  };
  const w = world(options);
  const figure = await pollMinutely(w, 40, {
    10: () => (options.turnSeq = 9),
    30: () => (usage = recorded(1)),
    40: () => (usage = recorded(2)),
  });
  assert.equal(figure?.usd, 2);
});

test("a newer turn restarts the rounds, so a turn that ends late in an older turn's window is still read (fails if the older turn's rounds carry over)", async () => {
  // Bug: the first turn's window kept running for the second, so the second settled with no figure after an hour.
  let usage: unknown = UNRECORDED;
  const options: Parameters<typeof world>[0] = {
    turnSeq: 8,
    provider: "codex",
    collect: async () => ({ results: { "session-1": usage } }),
  };
  const w = world(options);
  const figure = await pollMinutely(w, 85, {
    50: () => (options.turnSeq = 9),
    80: () => (usage = recorded(1)),
  });
  assert.equal(figure?.usd, 1);
});

test("checks skipped while the box is stopped do not use up a turn's rounds (fails if they do)", async () => {
  // Bug: the hour ran on while the box was stopped, so a turn whose usage was recorded after the box came back was never read.
  let usage: unknown = UNRECORDED;
  const options: Parameters<typeof world>[0] = {
    turnSeq: 8,
    provider: "codex",
    collect: async () => ({ results: { "session-1": usage } }),
  };
  const w = world(options);
  const figure = await pollMinutely(w, 150, {
    2: () => (options.ona = "ENVIRONMENT_PHASE_STOPPED"),
    120: () => (options.ona = undefined),
    150: () => (usage = recorded(1)),
  });
  assert.equal(figure?.usd, 1);
});

test("a complete figure lower than the stored one replaces it (fails if the stored figure is kept)", async () => {
  // Bug: the higher stored figure was kept over a complete figure that was lower, so the complete total never showed.
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: { ...CODEX_FIGURE, usd: 3 }, seq: "7", checkedAt: OLD, runs: 12 },
    collect: async () => ({ results: { "session-1": recorded(2) } }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 2);
});

test("a complete figure after a higher partial figure replaces it (fails if the partial figure is kept)", async () => {
  // Bug: a partial figure kept its place over a later complete figure, so the complete total never showed.
  const w = world({
    turnSeq: 8,
    provider: "codex",
    sessions: ["session-1", "session-2"],
    stored: { cost: { ...CODEX_FIGURE, usd: 1.5, partial: true }, seq: "7", checkedAt: OLD, runs: 12 },
    collect: async () => ({ results: { "session-1": recorded(1.2), "session-2": recorded(0) } }),
  });
  const figure = await w.costs.threadCost("t1");
  assert.deepEqual([figure?.usd, figure?.partial], [1.2, false]);
});

test("a partial figure keeps a higher stored figure and replaces a lower one (fails if a partial figure always replaces it)", async () => {
  // Guard: only a complete figure replaces the stored one unconditionally; a partial figure must not lower it.
  let usage = recorded(1);
  const w = world({
    turnSeq: 8,
    provider: "codex",
    sessions: ["session-1", "session-2"],
    stored: { cost: { ...CODEX_FIGURE, usd: 2 }, seq: "7", checkedAt: OLD, runs: 12 },
    collect: async () => ({ results: { "session-1": usage, "session-2": UNRECORDED } }),
  });
  const first = await w.costs.threadCost("t1");
  assert.deepEqual([first?.usd, first?.partial], [2, false]); // the partial $1 is lower: the stored $2 stays
  usage = recorded(2.5);
  await pastFloor();
  const second = await w.costs.threadCost("t1");
  assert.deepEqual([second?.usd, second?.partial], [2.5, true]); // the partial $2.5 is higher: it replaces
});

// Bug: records written before the Codex fix settled $0.00 and were kept until the next turn (docs/ona-notes.md).
test("an old Codex record, $0.00 or above, gets fresh rounds on a running box (fails if an old settled $0.00 is kept, or the old record is treated as settled)", async () => {
  for (const usd of [0, 1]) {
    const w = world({
      turnSeq: 7,
      provider: "codex",
      collect: async () => ({ results: { "session-1": recorded(2) } }),
    });
    w.kv.set(OLD_KEY, { cost: { ...CODEX_FIGURE, usd }, seq: 7, checkedAt: OLD });
    assert.equal((await w.costs.threadCost("t1"))?.usd, 2);
    assert.deepEqual(w.collectorRuns, ["env-1"]);
    assert.equal((w.kv.get("cost2:t1") as { runs: number }).runs, 1);
  }
});

test("an old record on a box Ona says is stopped is never re-asked before the floor (fails if each poll lists Ona)", async () => {
  // A Claude record with no figure is settled at its turn (no listing); any other old record waits out the floor.
  for (const [provider, cost, listings] of [
    ["claude-code", null, 0],
    ["codex", { ...CODEX_FIGURE, usd: 0 }, 1],
    ["claude-code", CODEX_FIGURE, 1],
    ["codex", FIGURE, 1],
  ] as const) {
    const w = world({ ona: "ENVIRONMENT_PHASE_STOPPED", turnSeq: 8, provider });
    w.kv.set(OLD_KEY, { cost, seq: 8, checkedAt: OLD });
    for (let i = 0; i < 3; i++) {
      assert.equal(await w.costs.threadCost("t1"), null);
      await later(1);
    }
    assert.equal(w.listings.count, listings, `${provider} ${JSON.stringify(cost)}`);
  }
});

test("an old Claude record with no figure settled at this turn is not read on a running box (fails if it is read)", async () => {
  const w = world({ turnSeq: 8, collect: async () => ({ buckets: [] }) });
  w.kv.set(OLD_KEY, { cost: null, seq: 8, checkedAt: OLD });
  assert.equal(await w.costs.threadCost("t1"), null);
  await pastFloor();
  assert.equal(await w.costs.threadCost("t1"), null);
  assert.deepEqual(w.collectorRuns, []);
});

test("a Claude thread with a Codex figure under the old cost: key is priced, not settled (fails if the other provider's record settles the turn)", async () => {
  const w = world({ turnSeq: 8 });
  w.kv.set(OLD_KEY, { cost: CODEX_FIGURE, seq: 8, checkedAt: OLD });
  assert.deepEqual([(await w.costs.threadCost("t1"))?.usd, w.collectorRuns], [1, ["env-1"]]);
});
