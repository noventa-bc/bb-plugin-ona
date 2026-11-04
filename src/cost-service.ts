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
import { isRunning, type OnaSnapshot } from "./ona.ts";
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
  snapshot: Pick<OnaSnapshot, "refresh">;
}

/** One thread's record in bb's storage: the latest finished turn's seq, the figure, and the rounds run for that seq. */
interface StoredCost {
  cost: ThreadCost | null;
  seq: string;
  checkedAt: number;
  /** Completed rounds for `seq`. A record without it has none. */
  runs?: number;
}

// Codex records usage minutes after a turn (docs/ona-notes.md); 12 rounds at the 5-minute floor is about an hour.
const CODEX_ROUNDS = 12;

// Records under `cost:` predate the Codex usage lag (docs/ona-notes.md); their figures are shown
// (except a Codex $0.00) until a new round runs.
const costKey = (threadId: string) => `cost2:${threadId}`;
const oldCostKey = (threadId: string) => `cost:${threadId}`;

export function createThreadCost({ bb, runCollector, threadDevbox, snapshot }: CostDeps) {
  const costInFlight = new Map<string, Promise<ThreadCost | null>>();

  /** Drop a deleted thread's stored figures under both keys. */
  async function forget(threadId: string): Promise<void> {
    for (const key of [costKey(threadId), oldCostKey(threadId)]) {
      await bb.storage.kv.delete(key).catch((error: unknown) => {
        bb.log.warn(`thread cost for ${threadId}: could not drop it: ${errorText(error)}`);
      });
    }
  }

  /**
   * A figure kept under the old `cost:` key, as a record with no round run for the current turn.
   * A Codex $0.00 there may come from the usage lag (docs/ona-notes.md), so it is not used.
   */
  async function legacyCost(threadId: string): Promise<StoredCost | null> {
    const old = await bb.storage.kv.get<{ cost: ThreadCost | null; checkedAt: number }>(oldCostKey(threadId));
    const usable = old?.cost && (old.cost.provider === "claude-code" || old.cost.usd > 0);
    return usable ? { cost: old.cost, seq: "", checkedAt: old.checkedAt } : null;
  }

  /**
   * Spend so far for a devbox thread. Cached per thread and recomputed after a new turn
   * finishes: a Claude turn is recomputed once more on a later poll only when its first read priced nothing, and a Codex turn until
   * CODEX_ROUNDS rounds have run for it.
   * A box that isn't connected, or that a fresh Ona listing doesn't show running, is never
   * woken: its last known figure is returned instead.
   */
  async function threadCost(threadId: string): Promise<ThreadCost | null> {
    const devbox = await threadDevbox(threadId);
    if (!devbox) return null;
    const thread = await bb.sdk.threads.get({ threadId });
    const agentProvider = thread.providerId;
    if (agentProvider !== "codex" && agentProvider !== "claude-code") return null;
    const key = costKey(threadId);
    const stored = (await bb.storage.kv.get<StoredCost>(key)) ?? (await legacyCost(threadId));
    if (devbox.status !== "connected") return stored?.cost ?? null;
    // Recompute at most every 5 minutes, while the newest finished turn has rounds left. Rounds for a
    // finished turn keep running while a later turn is still working; once that later turn finishes,
    // it gets its own rounds. Each round is an SSH round trip, and for Codex a short-lived app-server
    // that talks to OpenAI and reads the box's Codex login.
    const [latest] = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    // bb's seq may be a non-numeric string, so it is compared as given, never as a number.
    // It is "0" until a turn has finished.
    const seq = String(latest?.seq ?? 0);
    // Claude gets a second round only when its first priced nothing. Codex gets CODEX_ROUNDS
    // for its usage lag. A thread with no finished turn has nothing to wait for, so it gets one.
    const rounds = latest ? (agentProvider === "codex" ? CODEX_ROUNDS : 2) : 1;
    const settled = stored?.seq === seq && (stored.runs ?? 0) >= rounds;
    if (stored && (settled || Date.now() - stored.checkedAt < 5 * 60_000)) return stored.cost;

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
          // Safety rule 1: bb's "connected" can lag a stop made in Ona, and SSH would start the box.
          // A failed listing throws into the catch below.
          const env = (await snapshot.refresh()).envs.find((e) => e.id === devbox.envId);
          if (!isRunning(env)) {
            // A stored record is marked checked, so polls skip Ona for 5 minutes.
            // With no record, each poll asks Ona again.
            if (stored) await bb.storage.kv.set(key, { ...stored, checkedAt: Date.now() });
            return stored?.cost ?? null;
          }
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
        // A new figure replaces the stored one, except a partial Codex figure (a session not recorded yet) that is lower.
        const codex = agentProvider === "codex";
        const best =
          cost && (!codex || !stored?.cost || !cost.partial || cost.usd >= stored.cost.usd)
            ? cost
            : (stored?.cost ?? null);
        // A Claude round that priced something settles the turn, as only an empty round is read again.
        const pricedClaude = !codex && cost;
        const runs = pricedClaude ? rounds : stored?.seq === seq ? (stored.runs ?? 0) + 1 : 1;
        await bb.storage.kv.set(key, { cost: best, seq, checkedAt: Date.now(), runs });
        return best;
      })().finally(() => costInFlight.delete(threadId));
      costInFlight.set(threadId, running);
    }
    try {
      return await running;
    } catch (error) {
      bb.log.warn(`thread cost for ${threadId}: ${errorText(error)}`);
      // A failed round counts as checked, so the 5-minute floor applies to the retry too; it is not one of the turn's rounds.
      await bb.storage.kv.set(key, {
        cost: stored?.cost ?? null,
        seq: stored?.seq ?? "",
        runs: stored?.runs ?? 0,
        checkedAt: Date.now(),
      });
      return stored?.cost ?? null;
    }
  }

  return { threadCost, forget };
}
