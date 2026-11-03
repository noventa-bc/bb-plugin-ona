import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeUsageBucket } from "../src/cost.ts";
import { createThreadCost } from "../src/cost-service.ts";
import type { Devbox, ThreadCost } from "../src/rpc.ts";

// A fake of the bb calls the cost check makes (CostBb): one Claude Code thread
// on one devbox, whose newest finished turn is `turnSeq` and whose agent
// session is `session-1` (none with `noSession`), and a fresh Ona listing that
// shows the box in phase `ona` (RUNNING by default) or fails with it.

const OLD = 0; // a checkedAt past the 5-minute floor
const FIGURE: ThreadCost = { provider: "claude-code", usd: 1, basis: "list-price", partial: false, updatedAt: OLD };
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

function world(options: {
  status?: string;
  turnSeq?: number | string;
  stored?: { cost: ThreadCost | null; seq: number | string; checkedAt: number };
  collect?: () => Promise<unknown>;
  provider?: "claude-code" | "codex";
  ona?: string | Error;
  noSession?: boolean;
}) {
  const kv = new Map<string, unknown>(options.stored ? [["cost:t1", options.stored]] : []);
  const warnings: string[] = [];
  const collectorRuns: string[] = [];
  const listings = { count: 0 };
  const box = { envId: "env-1", status: options.status ?? "connected" } as Devbox;
  const costs = createThreadCost({
    bb: {
      sdk: {
        threads: {
          get: async () => ({ providerId: options.provider ?? "claude-code" }),
          events: {
            list: async ({ types }) =>
              types?.[0] === "turn/completed"
                ? [{ seq: options.turnSeq ?? 7 }]
                : options.noSession
                  ? []
                  : [{ seq: 1, data: { providerThreadId: "session-1" } }],
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
  const kept = w.kv.get("cost:t1") as { cost: ThreadCost; seq: number; checkedAt: number };
  assert.deepEqual([kept.cost, kept.seq], [FIGURE, 7]);
  assert.ok(kept.checkedAt > OLD);
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.equal(w.listings.count, 1);
  // With nothing stored there is nothing to keep: a record with no seq would settle the turn's first real round.
  const empty = world({ ona: "ENVIRONMENT_PHASE_STOPPED", turnSeq: 8 });
  assert.equal(await empty.costs.threadCost("t1"), null);
  assert.equal(empty.kv.has("cost:t1"), false);
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
  const w = world({ turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  const [a, b] = await Promise.all([w.costs.threadCost("t1"), w.costs.threadCost("t1")]);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
  assert.equal(a?.usd, 1);
  assert.deepEqual(a, b);
  assert.equal((w.kv.get("cost:t1") as { seq: string }).seq, "8");
});

test("a figure checked less than 5 minutes ago is returned without collecting, even after a new turn", async () => {
  const w = world({ turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: Date.now() } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

// Moves the stored check past the 5-minute floor, as if the next poll came later.
function pastFloor(w: ReturnType<typeof world>) {
  (w.kv.get("cost:t1") as { checkedAt: number }).checkedAt = OLD;
}

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
  // Bug: a second empty round settled the turn, but Codex can take about 30 minutes to record a turn's usage (checked 2026-11-03).
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
  // Bug: two all-missing rounds settled the turn, but Codex can take about 30 minutes to record a turn's usage (checked 2026-11-03).
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
  let usage: unknown = { estimatedUsageUsdMicros: 0, groups: [] };
  const w = world({ turnSeq: 8, provider: "codex", collect: async () => ({ results: { "session-1": usage } }) });
  assert.equal(await w.costs.threadCost("t1"), null);
  usage = { estimatedUsageUsdMicros: 1_000_000, groups: [{}] };
  pastFloor(w);
  assert.equal((await w.costs.threadCost("t1"))?.usd, 1);
});

test("a string seq equal to the stored one returns the stored figure without collecting", async () => {
  // Bug: Number("abc") is NaN, NaN never equals the stored seq, so every poll past the floor ran a collector.
  const w = world({ turnSeq: "abc", stored: { cost: FIGURE, seq: "abc", checkedAt: OLD } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("forgetting a thread drops its stored figure", async () => {
  const w = world({ stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  await w.costs.forget("t1");
  assert.equal(w.kv.has("cost:t1"), false);
});
