import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeUsageBucket } from "../src/cost.ts";
import { createThreadCost } from "../src/cost-service.ts";
import type { Devbox, ThreadCost } from "../src/rpc.ts";

// A fake of the bb calls the cost check makes (CostBb): one thread on one devbox,
// whose newest finished turn is `turnSeq` (none with `noTurn`) and whose agent
// sessions are `sessions` (none with `noSession`), and a fresh Ona listing that
// shows the box in phase `ona` (RUNNING by default) or fails with it.

const KEY = "cost2:t1"; // the record the code reads and writes
const OLD_KEY = "cost:t1"; // the record key from before the Codex fix (docs/ona-notes.md)

const OLD = 0; // a checkedAt past the 5-minute floor
const FIGURE: ThreadCost = { provider: "claude-code", usd: 1, basis: "list-price", partial: false, updatedAt: OLD };
const CODEX_FIGURE: ThreadCost = {
  provider: "codex",
  usd: 1,
  basis: "openai-estimate",
  partial: false,
  updatedAt: OLD,
};
const ONE_DOLLAR_BUCKET: ClaudeUsageBucket = {
  model: "claude-opus-5-5",
  long: false,
  fast: false,
  input: 250_000, // $4 per million input tokens
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};
// Codex's account/usage/read answer: with groups once the usage is recorded, without them before.
const recorded = (usd: number) => ({ estimatedUsageUsdMicros: usd * 1_000_000, groups: [{}] });
const UNRECORDED = { estimatedUsageUsdMicros: 0, groups: [] };

interface Stored {
  cost: ThreadCost | null;
  seq: number | string;
  checkedAt: number;
  pendingSince?: number;
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

// Moves the stored check past the 5-minute floor, as if the next poll came later.
function pastFloor(w: ReturnType<typeof world>) {
  (w.kv.get(KEY) as { checkedAt: number }).checkedAt = OLD;
}

// Moves the stored times back, as if the next poll came `minutes` later.
function later(w: ReturnType<typeof world>, minutes: number) {
  const record = w.kv.get(KEY) as { checkedAt: number; pendingSince?: number };
  record.checkedAt -= minutes * 60_000;
  if (record.pendingSince !== undefined) record.pendingSince -= minutes * 60_000;
}

test("a box that is not connected returns the stored figure and is never collected from", async () => {
  const w = world({ status: "suspended", turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("bb says connected but a fresh Ona listing says stopped: the stored figure comes back, no collector runs, and the floor applies", async () => {
  // Bug: the collector trusted bb's "connected", which lags a stop made in Ona's UI, and Ona's SSH starts a stopped box.
  const w = world({ ona: "ENVIRONMENT_PHASE_STOPPED", turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
  // Bug: storing nothing paged events and listed Ona on every chip poll while bb kept the stopped box active.
  const kept = w.kv.get(KEY) as { cost: ThreadCost; seq: number; checkedAt: number };
  assert.deepEqual([kept.cost, kept.seq], [FIGURE, 7]);
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
    stored: { cost: FIGURE, seq: 7, checkedAt: OLD },
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
  const w = world({ turnSeq: 7, stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a new finished turn collects once for two callers at the same time, and stores the figure", async () => {
  // The total grew from $0.50 to $1, so the turn's figure settles at once.
  const w = world({ turnSeq: 8, stored: { cost: { ...FIGURE, usd: 0.5 }, seq: 7, checkedAt: OLD } });
  const [a, b] = await Promise.all([w.costs.threadCost("t1"), w.costs.threadCost("t1")]);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
  assert.equal(a?.usd, 1);
  assert.deepEqual(a, b);
  assert.equal((w.kv.get(KEY) as { seq: string }).seq, "8");
});

test("a figure checked less than 5 minutes ago is returned without collecting, even after a new turn", async () => {
  const w = world({ turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: Date.now() } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a collector error warns, returns the stored figure, and retries only after the floor", async () => {
  // Bug: a failed round stored nothing, so a failing collector was retried on every poll, once a minute.
  const w = world({
    turnSeq: 8,
    stored: { cost: FIGURE, seq: 7, checkedAt: OLD },
    collect: () => Promise.reject(new Error("ssh failed")),
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.warnings, ["thread cost for t1: ssh failed"]);
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
  pastFloor(w);
  await w.costs.threadCost("t1");
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a round with nothing to price keeps the last good figure and collects again after the floor", async () => {
  // Bug: the empty round stored the new turn's seq, so the seq check skipped every retry until the next turn.
  const w = world({
    turnSeq: 8,
    stored: { cost: FIGURE, seq: 7, checkedAt: OLD },
    collect: async () => ({ buckets: [] }),
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  pastFloor(w);
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a first round with nothing to price collects again after the floor", async () => {
  // Bug: the empty chip stayed empty for a whole turn although a retry would price it.
  let buckets: ClaudeUsageBucket[] = [];
  const w = world({ turnSeq: 8, collect: async () => ({ buckets }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  buckets = [ONE_DOLLAR_BUCKET];
  pastFloor(w);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("an empty round is retried on every poll past the floor until a round prices something (fails if a second empty round settles the turn)", async () => {
  // Bug: a second empty round settled the turn, but Codex records a turn's usage late (docs/ona-notes.md).
  let buckets: ClaudeUsageBucket[] = [];
  const w = world({ turnSeq: 8, collect: async () => ({ buckets }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  pastFloor(w);
  assert.equal(await w.costs.threadCost("t1"), null);
  pastFloor(w);
  assert.equal(await w.costs.threadCost("t1"), null);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1", "env-1"]);
  buckets = [ONE_DOLLAR_BUCKET];
  pastFloor(w);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1", "env-1", "env-1"]);
});

test("a Codex round where every session is missing is retried on every poll past the floor (fails if the second empty round settles it)", async () => {
  // Bug: two all-missing rounds settled the turn, but Codex records a turn's usage late (docs/ona-notes.md).
  const w = world({
    turnSeq: 8,
    provider: "codex",
    collect: async () => ({ results: { "session-1": { error: "no usage" } } }),
  });
  assert.equal(await w.costs.threadCost("t1"), null);
  pastFloor(w);
  assert.equal(await w.costs.threadCost("t1"), null);
  pastFloor(w);
  assert.equal(await w.costs.threadCost("t1"), null);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1", "env-1"]);
});

test("a Codex thread whose usage Codex has not recorded shows no figure, then its figure once recorded (fails if the $0 is shown)", async () => {
  // Bug: Codex answers $0 with no groups until it records the turn's usage, and that $0 was shown until the next turn.
  let usage: unknown = UNRECORDED;
  const w = world({ turnSeq: 8, provider: "codex", collect: async () => ({ results: { "session-1": usage } }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  usage = recorded(1);
  pastFloor(w);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
});

test("a later turn whose total has not grown is retried, then shows the new total once it grows (fails if a flat total settles the turn)", async () => {
  // Bug: a turn whose total had not grown settled at once, so the total Codex recorded later never showed.
  let usage = recorded(1);
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: CODEX_FIGURE, seq: 7, checkedAt: OLD },
    collect: async () => ({ results: { "session-1": usage } }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  later(w, 5);
  usage = recorded(3);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 3);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 3);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a thread whose total never grows settles 60 minutes after its first flat round, not at once (fails if a flat round settles the turn)", async () => {
  // Bug: a flat total settled the turn at once, so a total Codex records later never showed.
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: CODEX_FIGURE, seq: 7, checkedAt: OLD },
    collect: async () => ({ results: { "session-1": recorded(1) } }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  // Eleven more polls, each 5 minutes after the last: still inside the window.
  for (let i = 0; i < 11; i++) {
    later(w, 5);
    assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  }
  // The twelfth is 60 minutes after the first flat round: the turn settles.
  later(w, 5);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.equal((w.kv.get(KEY) as { seq: string }).seq, "8");
  assert.equal(w.collectorRuns.length, 13);
  // A poll after the window makes no collector run.
  later(w, 5);
  await w.costs.threadCost("t1");
  assert.equal(w.collectorRuns.length, 13);
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
  pastFloor(w);
  const figure = await w.costs.threadCost("t1");
  assert.deepEqual([figure?.usd, figure?.partial], [1.5, false]);
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a thread with no finished turn runs the collector once, not on every poll past the floor (fails if each poll past the floor collects)", async () => {
  // Bug: with no finished turn an empty round stayed unsettled, so every poll past the floor collected again.
  const w = world({ noTurn: true, collect: async () => ({ buckets: [] }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  pastFloor(w);
  assert.equal(await w.costs.threadCost("t1"), null);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
});

test("a collector error inside the retry window keeps the window (fails if the error restarts the 60 minutes)", async () => {
  // Bug: a failed round dropped the start of the window, so an error restarted the 60 minutes.
  let failing = false;
  const w = world({
    turnSeq: 8,
    provider: "codex",
    stored: { cost: CODEX_FIGURE, seq: 7, checkedAt: OLD },
    collect: async () => {
      if (failing) throw new Error("ssh failed");
      return { results: { "session-1": recorded(1) } };
    },
  });
  await w.costs.threadCost("t1"); // a flat total: the window opens
  later(w, 5);
  failing = true;
  await w.costs.threadCost("t1"); // the collector fails inside the window
  failing = false;
  later(w, 55); // 60 minutes after the first flat round
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.equal((w.kv.get(KEY) as { seq: string }).seq, "8");
  assert.deepEqual(w.warnings, ["thread cost for t1: ssh failed"]);
  assert.equal(w.collectorRuns.length, 3);
});

test("a Claude figure with an unpriced model settles at once and is not retried (fails if a partial Claude figure is retried)", async () => {
  // Guard: only a partial Codex figure waits for more usage; a partial Claude figure settles like any other.
  const w = world({
    turnSeq: 8,
    collect: async () => ({ buckets: [{ ...ONE_DOLLAR_BUCKET, model: "claude-unknown-9" }] }),
  });
  assert.equal((await w.costs.threadCost("t1"))?.partial, true);
  pastFloor(w);
  await w.costs.threadCost("t1");
  assert.deepEqual(w.collectorRuns, ["env-1"]);
});

test("a string seq equal to the stored one returns the stored figure without collecting", async () => {
  // Bug: Number("abc") is NaN, NaN never equals the stored seq, so every poll past the floor ran a collector.
  const w = world({ turnSeq: "abc", stored: { cost: FIGURE, seq: "abc", checkedAt: OLD } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a record under the old cost: key is ignored, so the thread is priced again (fails if an old settled $0.00 is kept)", async () => {
  // Bug: records written before the Codex fix settled $0.00 and were kept until the next turn (docs/ona-notes.md).
  const w = world({ turnSeq: 7 });
  w.kv.set(OLD_KEY, { cost: { ...FIGURE, usd: 0 }, seq: 7, checkedAt: OLD });
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
});

test("forgetting a thread drops its stored figures under both keys (fails if an old record outlives its thread)", async () => {
  const w = world({ stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  w.kv.set(OLD_KEY, { cost: FIGURE, seq: 7, checkedAt: OLD });
  await w.costs.forget("t1");
  assert.equal(w.kv.has(KEY), false);
  assert.equal(w.kv.has(OLD_KEY), false);
});
