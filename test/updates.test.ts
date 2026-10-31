import assert from "node:assert/strict";
import { test } from "node:test";
import { hostIsBusy, parseProviderList, threadStatuses, updatesToApply, type CliStatus } from "../src/updates.ts";

const status = (overrides: Partial<CliStatus>): CliStatus => ({
  installed: true,
  needsUpdate: false,
  installAction: null,
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  ...overrides,
});

test("only installed CLIs with a pending update are updated", () => {
  const statuses = {
    codex: status({ needsUpdate: true, installAction: { kind: "update" } }),
    "claude-code": status({}),
    pi: status({ installed: false, needsUpdate: true, installAction: { kind: "install" } }),
  };
  assert.deepEqual(updatesToApply(statuses, ["claude-code", "codex", "pi"]), ["codex"]);
});

test("a host with an agent turn in flight is busy", () => {
  assert.equal(hostIsBusy(["idle", "error"]), false);
  assert.equal(hostIsBusy(["idle", "active"]), true);
  assert.equal(hostIsBusy(threadStatuses([{ status: "idle", queuedWork: "waiting" }, { status: "idle" }])), true);
});

test("provider lists accept commas and spaces", () => {
  assert.deepEqual(parseProviderList(" claude-code, codex  codex "), ["claude-code", "codex"]);
});
