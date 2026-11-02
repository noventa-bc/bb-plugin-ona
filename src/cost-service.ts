// A devbox thread's spend so far: which bb events say a new turn finished, when
// to run a cost collector on the box, and the per-thread figure kept in bb's
// storage. server.ts wires it to bb; tests drive it with a fake of the calls below.
import type { BbPluginApi, PluginKvStorage, PluginLogger } from "@get-bb/plugin-sdk";
import {
  CLAUDE_COLLECTOR,
  claudeCost,
  CODEX_COLLECTOR,
  codexCost,
  providerSessions,
  type ClaudeUsageBucket,
} from "./cost.ts";
import type { Devbox, ThreadCost } from "./rpc.ts";
import { errorText } from "./sync.ts";

/** The parts of bb's plugin API the cost check uses; the real `bb` satisfies it. */
export interface CostBb {
  sdk: {
    threads: {
      get(args: { threadId: string }): Promise<{ providerId: string }>;
      events: {
        list(
          args: Parameters<BbPluginApi["sdk"]["threads"]["events"]["list"]>[0],
        ): Promise<ReadonlyArray<{ seq: number | string; data?: unknown }>>;
      };
    };
  };
  storage: { kv: Pick<PluginKvStorage, "get" | "set" | "delete"> };
  log: Pick<PluginLogger, "warn">;
}

export interface CostDeps {
  bb: CostBb;
  /** Runs a collector script on a running box; the provider's runCollector(). */
  runCollector(envId: string, script: string, ids: string[]): Promise<unknown>;
  threadDevbox(threadId: string): Promise<Devbox | null>;
}

const costKey = (threadId: string) => `cost:${threadId}`;
export function createThreadCost({ bb, runCollector, threadDevbox }: CostDeps) {
  const costInFlight = new Map<string, Promise<ThreadCost | null>>();

  /** Drop a deleted thread's stored figure so the keys don't pile up. */
  async function forget(threadId: string): Promise<void> {
    await bb.storage.kv.delete(costKey(threadId)).catch((error: unknown) => {
      bb.log.warn(`thread cost for ${threadId}: could not drop it: ${errorText(error)}`);
    });
  }

  /**
   * Spend so far for a devbox thread. Cached per thread and recomputed only
   * after a new turn finishes; a box that isn't connected is never woken,
   * its last known figure is returned instead.
   */
  async function threadCost(threadId: string): Promise<ThreadCost | null> {
    const devbox = await threadDevbox(threadId);
    if (!devbox) return null;
    const thread = await bb.sdk.threads.get({ threadId });
    const agentProvider = thread.providerId;
    if (agentProvider !== "codex" && agentProvider !== "claude-code") return null;
    const key = costKey(threadId);
    // Older records hold `seq` as a number; it is compared as a string.
    const stored = await bb.storage.kv.get<{ cost: ThreadCost | null; seq: number | string; checkedAt: number }>(key);
    if (devbox.status !== "connected") return stored?.cost ?? null;
    // Recompute once per finished turn, never mid-turn, and at most every 5
    // minutes: each check is an SSH round trip, and for Codex a short-lived
    // app-server that talks to OpenAI and reads the box's Codex login.
    const [latest] = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    // bb's seq may be a non-numeric string, so it is compared as given, never as a number.
    const seq = String(latest?.seq ?? 0);
    if (stored && (String(stored.seq) === seq || Date.now() - stored.checkedAt < 5 * 60_000)) return stored.cost;

    let running = costInFlight.get(threadId);
    if (!running) {
      running = (async () => {
        // bb pages events at most 100 at a time.
        const identity: Array<{ seq: number | string; data?: unknown }> = [];
        for (let afterSeq: string | undefined; ;) {
          const page = await bb.sdk.threads.events.list({
            threadId,
            types: ["thread/identity", "turn/started"],
            limit: "100",
            ...(afterSeq ? { afterSeq } : {}),
          });
          identity.push(...page);
          if (page.length < 100) break;
          afterSeq = String(page.at(-1)!.seq);
        }
        const sessions = providerSessions(identity);
        let cost: ThreadCost | null = null;
        if (sessions.length > 0) {
          if (agentProvider === "codex") {
            const reply = (await runCollector(devbox.envId, CODEX_COLLECTOR, sessions)) as {
              results?: Parameters<typeof codexCost>[0];
              error?: string;
            };
            if (!reply.results) throw new Error(`Codex usage unavailable: ${reply.error ?? "no result"}`);
            const { usd, missing } = codexCost(reply.results);
            if (missing.length < sessions.length) {
              cost = {
                provider: agentProvider,
                usd,
                basis: "openai-estimate",
                partial: missing.length > 0,
                updatedAt: Date.now(),
              };
            }
          } else {
            const reply = (await runCollector(devbox.envId, CLAUDE_COLLECTOR, sessions)) as {
              buckets: ClaudeUsageBucket[];
            };
            if (reply.buckets.length > 0) {
              const { usd, unknownModels } = claudeCost(reply.buckets);
              cost = {
                provider: agentProvider,
                usd,
                basis: "list-price",
                partial: unknownModels.length > 0,
                updatedAt: Date.now(),
              };
            }
          }
        }
        // Keep the last good figure if this round had nothing to price. An empty
        // round stores no seq, so the next poll past the 5-minute floor tries this
        // turn once more; a second empty round settles it until the next turn.
        const result = cost ?? stored?.cost ?? null;
        await bb.storage.kv.set(key, {
          cost: result,
          seq: cost || stored?.seq === "" ? seq : "",
          checkedAt: Date.now(),
        });
        return result;
      })().finally(() => costInFlight.delete(threadId));
      costInFlight.set(threadId, running);
    }
    try {
      return await running;
    } catch (error) {
      bb.log.warn(`thread cost for ${threadId}: ${errorText(error)}`);
      // A failed round counts as checked, so the 5-minute floor applies to the retry too.
      await bb.storage.kv.set(key, { cost: stored?.cost ?? null, seq: stored?.seq ?? "", checkedAt: Date.now() });
      return stored?.cost ?? null;
    }
  }

  return { threadCost, forget };
}
