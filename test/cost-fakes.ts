import type { ClaudeUsageBucket } from "../src/cost.ts";
import type { ThreadCost } from "../src/rpc.ts";

export const OLD = -60 * 60_000; // an hour before the fake clock's zero, so past the 5-minute floor
export const CODEX_FIGURE: ThreadCost = {
  provider: "codex",
  usd: 1,
  basis: "openai-estimate",
  partial: false,
  updatedAt: OLD,
};
export const ONE_DOLLAR_BUCKET: ClaudeUsageBucket = {
  model: "claude-opus-5-5",
  long: false,
  fast: false,
  input: 250_000, // $4 per million input tokens
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
};
