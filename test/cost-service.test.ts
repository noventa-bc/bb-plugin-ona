import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeUsageBucket } from "../src/cost.ts";
import { createThreadCost } from "../src/cost-service.ts";
import type { Devbox, ThreadCost } from "../src/rpc.ts";

// A fake of the bb calls the cost check makes (CostBb): one Claude Code thread
// on one devbox, whose newest finished turn is `turnSeq`.

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
  turnSeq?: number;
  stored?: { cost: ThreadCost | null; seq: number; checkedAt: number };
  collect?: () => Promise<unknown>;
}) {
  const kv = new Map<string, unknown>(options.stored ? [["cost:t1", options.stored]] : []);
  const warnings: string[] = [];
  const collectorRuns: string[] = [];
  const box = { envId: "env-1", status: options.status ?? "connected" } as Devbox;
  const costs = createThreadCost({
    bb: {
      sdk: {
        threads: {
          get: async () => ({ providerId: "claude-code" }),
          events: {
            list: async ({ types }) =>
              types?.[0] === "turn/completed"
                ? [{ seq: options.turnSeq ?? 7 }]
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
  });
  return { costs, kv, warnings, collectorRuns };
}

test("a box that is not connected returns the stored figure and is never collected from", async () => {
  const w = world({ status: "suspended", turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
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
  assert.equal((w.kv.get("cost:t1") as { seq: number }).seq, 8);
});

test("a figure checked less than 5 minutes ago is returned without collecting, even after a new turn", async () => {
  const w = world({ turnSeq: 8, stored: { cost: FIGURE, seq: 7, checkedAt: Date.now() } });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.collectorRuns, []);
});

test("a collector error warns, returns the stored figure, and the next call collects again", async () => {
  const w = world({
    turnSeq: 8,
    stored: { cost: FIGURE, seq: 7, checkedAt: OLD },
    collect: () => Promise.reject(new Error("ssh failed")),
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  assert.deepEqual(w.warnings, ["thread cost for t1: ssh failed"]);
  await w.costs.threadCost("t1");
  assert.deepEqual(w.collectorRuns, ["env-1", "env-1"]);
});

test("a round with nothing to price keeps the last good figure", async () => {
  const w = world({
    turnSeq: 8,
    stored: { cost: FIGURE, seq: 7, checkedAt: OLD },
    collect: async () => ({ buckets: [] }),
  });
  assert.deepEqual(await w.costs.threadCost("t1"), FIGURE);
  const saved = w.kv.get("cost:t1") as { cost: ThreadCost; seq: number };
  assert.deepEqual([saved.cost, saved.seq], [FIGURE, 8]);
  assert.deepEqual(w.collectorRuns, ["env-1"]);
});

test("forgetting a thread drops its stored figure", async () => {
  const w = world({ stored: { cost: FIGURE, seq: 7, checkedAt: OLD } });
  await w.costs.forget("t1");
  assert.equal(w.kv.has("cost:t1"), false);
});
