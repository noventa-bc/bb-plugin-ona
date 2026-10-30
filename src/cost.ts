// Per-thread spend for devbox threads. bb keeps token counts but no cost, so
// read the harnesses' own numbers on the box:
// - Codex: OpenAI's per-thread estimate (`account/usage/read` on the Codex
//   app-server), the figure behind Codex's `estimated-thread-cost`.
// - Claude Code: per-model token totals from its session files, priced here
//   at Anthropic list prices, as Claude Code itself does.

/** USD per million tokens. Cache writes are 1.25x (5m) / 2x (1h) input. */
interface ClaudePrice {
  input: number;
  output: number;
  cacheRead: number;
  /** Rates for requests whose prompt exceeds 100K tokens (Haiku 5.5). */
  long?: { input: number; output: number; cacheRead: number };
  /** Fast mode multiplier, where Anthropic publishes one. */
  fastMultiplier?: number;
}

const price = (input: number, output: number, cacheRead = input * 0.1): ClaudePrice => ({ input, output, cacheRead });

/**
 * Anthropic list prices (first-party API), checked 2026-10-23. Update when
 * Anthropic changes prices. Keys are model ids or id prefixes; the longest
 * matching key wins.
 */
export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-mythos-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50, 1),
  "claude-mythos-5": price(10, 50, 1),
  "claude-opus-5-5": { ...price(4, 20, 0.2), fastMultiplier: 2 },
  "claude-opus-5": { ...price(5, 25), fastMultiplier: 2 },
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-opus-4-5": price(5, 25),
  "claude-opus-4-1": price(15, 75),
  "claude-opus-4": price(15, 75),
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4": price(3, 15),
  "claude-haiku-5-5": { ...price(0.1, 0.5), long: { input: 0.5, output: 2.5, cacheRead: 0.05 } },
  "claude-haiku-4-5": price(1, 5),
};

export function claudePriceFor(model: string): ClaudePrice | null {
  const key = Object.keys(CLAUDE_PRICES)
    .filter(
      (candidate) => model === candidate || model.startsWith(`${candidate}-`) || model.startsWith(`${candidate}[`),
    )
    .sort((a, b) => b.length - a.length)[0];
  return key ? CLAUDE_PRICES[key]! : null;
}

/** Token totals for one model and pricing bucket, as the box collector reports them. */
export interface ClaudeUsageBucket {
  model: string;
  /** Prompt over 100K tokens (only priced differently on some models). */
  long: boolean;
  fast: boolean;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export function claudeCost(buckets: readonly ClaudeUsageBucket[]): { usd: number; unknownModels: string[] } {
  let usd = 0;
  const unknown = new Set<string>();
  for (const bucket of buckets) {
    const known = claudePriceFor(bucket.model);
    if (!known || (bucket.fast && !known.fastMultiplier)) {
      unknown.add(bucket.fast ? `${bucket.model} (fast)` : bucket.model);
      continue;
    }
    const rates = bucket.long && known.long ? known.long : known;
    const multiplier = bucket.fast ? known.fastMultiplier! : 1;
    usd +=
      (multiplier *
        (bucket.input * rates.input +
          bucket.output * rates.output +
          bucket.cacheWrite5m * rates.input * 1.25 +
          bucket.cacheWrite1h * rates.input * 2 +
          bucket.cacheRead * rates.cacheRead)) /
      1_000_000;
  }
  return { usd, unknownModels: [...unknown] };
}

/** Codex `account/usage/read` results per thread id; null when unavailable. */
export function codexCost(
  results: Record<string, { estimatedUsageUsdMicros?: number | null } | { error: string } | null>,
): { usd: number; missing: string[] } {
  let usd = 0;
  const missing: string[] = [];
  for (const [threadId, result] of Object.entries(results)) {
    const micros = result && "estimatedUsageUsdMicros" in result ? result.estimatedUsageUsdMicros : null;
    if (typeof micros === "number") usd += micros / 1_000_000;
    else missing.push(threadId);
  }
  return { usd, missing };
}

/** Distinct provider session ids in a bb thread's events, oldest first. */
export function providerSessions(events: ReadonlyArray<{ data?: unknown }>): string[] {
  const ids: string[] = [];
  for (const event of events) {
    const id = (event.data as { providerThreadId?: unknown } | undefined)?.providerThreadId;
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Scripts run with `node -e <script> <ids...>` on the devbox. They read only
// local session files or ask the box's own Codex; ids arrive as argv.

/** Sums Claude Code token usage per model/bucket from the sessions' JSONL files. */
export const CLAUDE_COLLECTOR = String.raw`
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const ids = process.argv.slice(1);
const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
const files = [];
let projects = [];
try { projects = fs.readdirSync(root); } catch {}
for (const project of projects) {
  for (const id of ids) {
    const main = path.join(root, project, id + ".jsonl");
    if (fs.existsSync(main)) files.push(main);
    const sub = path.join(root, project, id, "subagents");
    try { for (const f of fs.readdirSync(sub)) if (f.endsWith(".jsonl")) files.push(path.join(sub, f)); } catch {}
  }
}
const seen = new Set(), buckets = {};
for (const file of files) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const m = entry.message;
    if (entry.type !== "assistant" || !m || !m.usage || !m.model || m.model === "<synthetic>") continue;
    // One API response is written as several lines (one per content block) with the same usage.
    if (m.id) { if (seen.has(m.id)) continue; seen.add(m.id); }
    const u = m.usage, c = u.cache_creation || {};
    const write5 = c.ephemeral_5m_input_tokens, write1 = c.ephemeral_1h_input_tokens;
    const cacheWrite5m = write5 === undefined && write1 === undefined ? (u.cache_creation_input_tokens || 0) : (write5 || 0);
    const cacheWrite1h = write1 || 0;
    const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + cacheWrite5m + cacheWrite1h;
    const long = prompt > 100000, fast = u.speed === "fast";
    const key = m.model + "|" + long + "|" + fast;
    const t = buckets[key] ||= { model: m.model, long, fast, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheWrite5m += cacheWrite5m;
    t.cacheWrite1h += cacheWrite1h;
  }
}
console.log(JSON.stringify({ files: files.length, buckets: Object.values(buckets) }));
`;

/** Asks a short-lived Codex app-server for each thread's usage estimate. */
export const CODEX_COLLECTOR = String.raw`
const { spawn } = require("node:child_process");
const ids = process.argv.slice(1);
const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let buffer = "", nextId = 1;
const finish = (out) => { console.log(JSON.stringify(out)); child.kill(); process.exit(0); };
child.on("error", (error) => finish({ error: String(error) }));
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  }
});
const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
const call = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ id, method, params }); });
setTimeout(() => finish({ error: "timeout" }), 60000);
(async () => {
  const init = await call("initialize", { clientInfo: { name: "bb-ona", version: "0.1.0" } });
  if (init.error) return finish({ error: init.error.message || "initialize failed" });
  send({ method: "initialized" });
  const results = {};
  for (const id of ids) {
    const reply = await call("account/usage/read", { threadId: id });
    results[id] = reply.error ? { error: reply.error.message || "error" } : (reply.result && reply.result.threadUsage) || null;
  }
  finish({ results });
})();
`;
