import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_COLLECTOR, claudeCost, claudePriceFor, codexCost, providerSessions, type ClaudeUsageBucket } from "../src/cost.ts";

const bucket = (model: string, usage: Partial<ClaudeUsageBucket> = {}): ClaudeUsageBucket => ({
  model,
  long: false,
  fast: false,
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  ...usage,
});

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("Claude cost uses each model's input, output and cache rates", () => {
  const { usd, unknownModels } = claudeCost([
    // Opus 5.5: $4 in, $20 out, reads $0.20, 1h writes 2x input.
    bucket("claude-opus-5-5", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite1h: 1_000_000 }),
    // Sonnet 5.5: 5m writes 1.25x of $2.
    bucket("claude-sonnet-5-5", { cacheWrite5m: 1_000_000 }),
  ]);
  close(usd, 4 + 20 + 0.2 + 8 + 2.5);
  assert.deepEqual(unknownModels, []);
});

test("long prompts and fast mode use their own rates", () => {
  close(claudeCost([bucket("claude-haiku-5-5", { long: true, input: 1_000_000 })]).usd, 0.5);
  close(claudeCost([bucket("claude-opus-5-5", { fast: true, output: 1_000_000 })]).usd, 40);
});

test("unknown models and unpriced fast mode are reported, not guessed", () => {
  const { usd, unknownModels } = claudeCost([
    bucket("claude-unknown-9", { input: 1_000_000 }),
    bucket("claude-sonnet-5-5", { fast: true, input: 1_000_000 }),
  ]);
  assert.equal(usd, 0);
  assert.deepEqual(unknownModels, ["claude-unknown-9", "claude-sonnet-5-5 (fast)"]);
});

test("model ids match the most specific price entry", () => {
  assert.equal(claudePriceFor("claude-opus-5-5")?.input, 4);
  assert.equal(claudePriceFor("claude-opus-5")?.input, 5);
  assert.equal(claudePriceFor("claude-sonnet-5-5[1m]")?.input, 2);
  assert.equal(claudePriceFor("claude-opus-4-1-20250805")?.input, 15);
  assert.equal(claudePriceFor("gpt-6"), null);
});

test("Codex cost sums OpenAI's estimates and lists threads without one", () => {
  const { usd, missing } = codexCost({
    a: { estimatedUsageUsdMicros: 2_886_018 },
    b: { estimatedUsageUsdMicros: null },
    c: { error: "nope" },
  });
  close(usd, 2.886018);
  assert.deepEqual(missing, ["b", "c"]);
});

test("provider sessions are collected once each, in order", () => {
  const ids = providerSessions([
    { data: { providerThreadId: "s1" } },
    { data: {} },
    { data: { providerThreadId: "s2" } },
    { data: { providerThreadId: "s1" } },
  ]);
  assert.deepEqual(ids, ["s1", "s2"]);
});

test("the Claude collector counts each API response once, including subagents", () => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-cost-"));
  const project = join(home, "projects", "-workspaces-app");
  mkdirSync(join(project, "s1", "subagents"), { recursive: true });
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 } };
  const line = (id: string, model: string) => JSON.stringify({ type: "assistant", message: { id, model, usage } });
  // Two lines for one response (thinking + text blocks) and one more response.
  writeFileSync(join(project, "s1.jsonl"), [line("m1", "claude-opus-5-5"), line("m1", "claude-opus-5-5"), line("m2", "claude-opus-5-5"), "{bad json"].join("\n"));
  writeFileSync(join(project, "s1", "subagents", "agent-1.jsonl"), line("m3", "claude-haiku-5-5"));
  const out = execFileSync(process.execPath, ["-e", CLAUDE_COLLECTOR, "s1"], { env: { ...process.env, CLAUDE_CONFIG_DIR: home } }).toString();
  const { files, buckets } = JSON.parse(out) as { files: number; buckets: ClaudeUsageBucket[] };
  assert.equal(files, 2);
  const opus = buckets.find((b) => b.model === "claude-opus-5-5")!;
  assert.deepEqual({ input: opus.input, output: opus.output, cacheRead: opus.cacheRead, cacheWrite1h: opus.cacheWrite1h }, { input: 20, output: 10, cacheRead: 200, cacheWrite1h: 40 });
  assert.equal(buckets.find((b) => b.model === "claude-haiku-5-5")?.input, 10);
});
