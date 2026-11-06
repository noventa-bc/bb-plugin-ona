import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxFacts } from "../src/ona.ts";
import { formatStatus, type StatusRow } from "../src/status.ts";

const row = (overrides: Partial<StatusRow> = {}): StatusRow => ({
  machine: "ona:brave-otter",
  hostId: "host_1",
  bb: "connected",
  tunnel: "up",
  ona: "running",
  now: null,
  last: null,
  retry: null,
  keepAliveUntil: null,
  needsRecovery: 0,
  stuckThreads: [],
  facts: null,
  ...overrides,
});
const NOW = 1_000_000_000;
const NO_FACTS: BoxFacts = { startedAt: null, idleTimeoutMs: null, activity: null, branch: null, unpushed: 0 };
const HEALTHY = { lastError: null, listedAt: NOW, autoRepair: true };

test("status text: header for a healthy, failing or unrepaired CLI", () => {
  const healthy = { lastError: null, listedAt: NOW - 8_000, autoRepair: true };
  assert.equal(formatStatus([], healthy, NOW), "Ona CLI: ok, listed 8s ago\nNo Ona machines yet.");
  assert.match(formatStatus([], { ...healthy, autoRepair: false }, NOW), /\(autoRepair is off\)/);
  assert.match(
    formatStatus([], { lastError: "not logged in\nmore", listedAt: null, autoRepair: true }, NOW),
    /^Ona CLI: ERROR not logged in \(run `ona login`\?\)/,
  );
});

// Bug: an empty CLI error showed the CLI as ok, and one that starts with a newline printed no reason.
test("status header names the first non-blank line of the CLI error, or no listing", () => {
  for (const [lastError, reason] of [
    ["", "no listing"],
    ["\nnot logged in", "not logged in"],
    ["  not logged in", "not logged in"],
  ] as const) {
    assert.equal(
      formatStatus([], { lastError, listedAt: null, autoRepair: true }, NOW).split("\n")[0],
      `Ona CLI: ERROR ${reason} (run \`ona login\`?)`,
      JSON.stringify(lastError),
    );
  }
});

test("status text: one block per machine with what the plugin saw, did and is waiting on", () => {
  const text = formatStatus(
    [
      row({
        now: { reason: "connected", since: NOW - 120_000 },
        last: {
          action: "release-idle",
          reason: "idle for 1h",
          at: NOW - 3 * 3_600_000,
          error: "bb kept the machine active",
        },
        retry: "retrying after 10:00:00",
        needsRecovery: 2,
      }),
    ],
    { lastError: null, listedAt: NOW, autoRepair: true },
    NOW,
  );
  const lines = text.split("\n");
  assert.equal(lines[1], "ona:brave-otter  bb:connected  tunnel:up  ona:running");
  assert.equal(lines[2], "  now: connected (since 2m ago)");
  assert.equal(lines[3], "  last action: release-idle: idle for 1h (3h ago) ERROR bb kept the machine active");
  assert.equal(lines[4], "  retrying after 10:00:00");
  assert.match(
    lines[5]!,
    /^  2 workspace\(s\) may need recovery; an active box stays awake until they clear\. See .*bb environment list --host host_1/,
  );
});

test("status explains an unknown box only when the Ona listing is empty, not when the CLI failed", () => {
  const empty = formatStatus([row({ ona: "unknown" })], HEALTHY, NOW);
  assert.match(empty, /Ona lists no environments; idle boxes are not released until it does/);
  const failed = formatStatus([row({ ona: "unknown" })], { ...HEALTHY, lastError: "not logged in" }, NOW);
  assert.doesNotMatch(failed, /lists no environments/);
});

test("status says when bb's workspace or thread list can't be read, and says nothing for zero", () => {
  assert.match(
    formatStatus([row({ needsRecovery: null })], HEALTHY, NOW),
    /bb's workspace or thread list couldn't be read; an active box stays awake until it can/,
  );
  assert.doesNotMatch(formatStatus([row({ needsRecovery: 0 })], HEALTHY, NOW), /couldn't be read|may need recovery/);
});

test("status prints both lines when bb's thread list fails while workspaces need recovery", () => {
  const text = formatStatus([row({ needsRecovery: 2, stuckThreads: null })], HEALTHY, NOW);
  assert.match(text, /couldn't be read; an active box stays awake until it can/);
  assert.match(text, /2 workspace\(s\) may need recovery/);
});

// Bug: a box held awake by a thread bb left "active" gave the owner no reason in status.
test("status text names a busy thread with no update for over 6h", () => {
  const text = formatStatus(
    [row({ stuckThreads: [{ id: "thr_1", status: "active", updatedAt: NOW - 9 * 3_600_000 }] })],
    { lastError: null, listedAt: NOW, autoRepair: true },
    NOW,
  );
  assert.equal(
    text.split("\n")[2],
    "  thread thr_1 is active, last updated 9h ago; it holds this box until it ends or is archived",
  );
});

// The box line: what Ona's listing says about the box, in the order the owner reads it.
test("status text: a box line gives the start, idle timeout, last activity, branch and unpushed commits", () => {
  const facts: BoxFacts = {
    startedAt: NOW - 3_600_000,
    idleTimeoutMs: 3 * 3_600_000,
    activity: { source: "SSH connections", at: NOW - 12 * 60_000 },
    branch: "main",
    unpushed: 2,
  };
  assert.equal(
    formatStatus([row({ facts })], HEALTHY, NOW).split("\n")[2],
    "  box: last started 1h ago, idle timeout 3h, last activity SSH connections 12m ago, branch main (2 unpushed)",
  );
});

// A box line names only facts Ona gave: none given means no line at all.
test("status text: a box line leaves out each fact Ona doesn't give, and no line when it gives none", () => {
  const status = (facts: BoxFacts | null) => formatStatus([row({ facts })], HEALTHY, NOW);
  assert.doesNotMatch(status(null), /box:/, "no listing for the box");
  assert.doesNotMatch(status(NO_FACTS), /box:/, "Ona gave none of the facts");
  assert.equal(
    status({ ...NO_FACTS, branch: "main" }).split("\n")[2],
    "  box: branch main",
    "a branch alone, zero unpushed not printed",
  );
  assert.equal(status({ ...NO_FACTS, unpushed: 2 }).split("\n")[2], "  box: 2 unpushed", "unpushed commits, no branch");
});

// The timeout reads in its largest whole unit (3h, 45m, 90s); 0 is Ona's auto-stop turned off.
test("status text: an idle timeout reads in whole hours, minutes or seconds, and off at 0", () => {
  for (const [idleTimeoutMs, span] of [
    [3 * 3_600_000, "3h"],
    [2_700_000, "45m"],
    [90_000, "90s"],
    [0, "off"],
  ] as const) {
    const text = formatStatus([row({ facts: { ...NO_FACTS, idleTimeoutMs } })], HEALTHY, NOW);
    assert.equal(text.split("\n")[2], `  box: idle timeout ${span}`);
  }
});

// Ona's clock can run ahead of bb's, so a time after `now` reads as 0s ago, not a negative age.
test("status text: a time ahead of bb's clock reads as 0s ago", () => {
  const facts = { ...NO_FACTS, startedAt: NOW + 3_000 };
  assert.equal(formatStatus([row({ facts })], HEALTHY, NOW).split("\n")[2], "  box: last started 0s ago");
});

// Minutes are rounded before the unit is picked, so 3570 s is 1h, not 60m.
test("status text: an age just under an hour reads in minutes up to 59m, then 1h", () => {
  const ok = (listedMsAgo: number) =>
    formatStatus([], { lastError: null, listedAt: NOW - listedMsAgo, autoRepair: true }, NOW).split("\n")[0];
  assert.equal(ok(3_570_000), "Ona CLI: ok, listed 1h ago");
  assert.equal(ok(3_569_000), "Ona CLI: ok, listed 59m ago");
});

// The box line sits under the row line, before `now` and `last action`.
test("status text: the box line sits under the row, before now and last action", () => {
  const text = formatStatus(
    [
      row({
        facts: { ...NO_FACTS, branch: "main" },
        now: { reason: "connected", since: NOW - 120_000 },
        last: { action: "release-idle", reason: "idle for 1h", at: NOW - 3_600_000 },
      }),
    ],
    HEALTHY,
    NOW,
  );
  assert.match(text, /\n  box: branch main\n  now: connected \(since 2m ago\)\n  last action: /);
});
