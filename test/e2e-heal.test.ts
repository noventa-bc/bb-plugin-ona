// The real server.ts inside the SDK's fake bb host (test/e2e-host.ts), for
// the repairs that touch a box over SSH: the daemon heal after a box
// restarted outside bb (and the live-daemon refusal), a resume while Ona is
// still starting the box, and the `thread_cost` rpc. One story in file order:
// run the whole file.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLAUDE_PRICES } from "../src/cost.ts";
import type { OnaResource } from "../src/provider.ts";
import { GRACE_MS } from "../src/reconcile.ts";
import type { BbHost } from "../src/sync.ts";
import { ctx, local, startHost, type E2eHost } from "./e2e-host.ts";

let host: E2eHost["host"];
let provider: E2eHost["provider"];
let dir: string;
let patchBox: E2eHost["patchBox"];
let onaCalls: E2eHost["onaCalls"];
let close: E2eHost["close"];
let resource: OnaResource;
const bootstraps: string[] = [];
const hosts: BbHost[] = [];
const disconnectHost = () =>
  Object.assign(hosts[0]!, { status: "disconnected", lastSeenAt: Date.now() - GRACE_MS - 1_000 });
/** The process that stands in for a live bb daemon in the rule-3 test. */
let daemon: ChildProcess | undefined;
/** Kill the fake daemon and its sleep: the group, or the sleep would outlive its sh and hold the test process open. */
const stopDaemon = () => {
  try {
    if (daemon?.pid) process.kill(-daemon.pid);
  } catch {}
  daemon = undefined;
};

before(async () => {
  if (local.skip) return;
  ({ host, provider, dir, patchBox, onaCalls, close } = await startHost({
    machineBootstrap: {
      async bootstrap({ key }) {
        bootstraps.push(key);
        return { hostId: "host-1" };
      },
    },
    machineResource: async (hostId) => (hostId === "host-1" ? resource : null),
    sdk: {
      hosts: { list: async () => hosts },
      environments: { list: async () => [], get: async () => ({ hostId: "host-1" }) },
      threads: {
        list: async () => [],
        get: async ({ threadId }) =>
          threadId === "thread-1" ? { environmentId: "ws-1", providerId: "claude-code" } : {},
        events: {
          list: async ({ types }) =>
            types?.includes("turn/completed") ? [{ seq: 7 }] : [{ seq: 1, data: { providerThreadId: "s1" } }],
        },
      },
    },
  }));
});

after(async () => {
  stopDaemon();
  if (!local.skip) await close();
});

test("create a box and connect it", local, async () => {
  const result = await provider.create({
    ...ctx,
    inputs: { mode: "create", project: "Sample Web" },
    key: "key-1",
    attempt: 1,
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  resource = result.resource as OnaResource;
  hosts.push({
    id: "host-1",
    name: result.name,
    machineProviderId: "ona",
    status: "connected",
    lastSeenAt: Date.now(),
    updatedAt: Date.now(),
    lifecycle: { phase: "active", message: null, suspendedAt: null },
  });
  assert.deepEqual(bootstraps, ["key-1"]);
  onaCalls();
});

test("bb ona sync on a running box whose daemon is gone restarts the daemon without touching Ona", local, async () => {
  disconnectHost();
  const result = await host.harness.behavior.runCli(["sync"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /last action: heal-daemon: .*daemon was down; restarted it/);
  assert.deepEqual(bootstraps, ["key-1", "key-1"]);
  assert.deepEqual(onaCalls(), []);
});

test("bb ona sync leaves a live daemon alone (rule 3)", local, async () => {
  // DAEMON_PROBE looks for a process whose command line carries the box's data folder.
  // Two commands, or sh would exec the sleep alone and the folder would leave the argv.
  daemon = spawn("sh", ["-c", `sleep 60; : ${dir}/.bb-machines/x`], { stdio: "ignore", detached: true });
  disconnectHost();
  const result = await host.harness.behavior.runCli(["sync"]);
  stopDaemon();
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /last action: heal-daemon: .*daemon is running; not restarting/);
  assert.deepEqual(bootstraps, ["key-1", "key-1"]);
  assert.deepEqual(onaCalls(), []);
  hosts[0]!.status = "connected";
});

test("resume while Ona is already starting the box waits for it instead of starting it again", local, async () => {
  patchBox(resource.envId, { phase: "ENVIRONMENT_PHASE_STARTING" });
  // Ona finishes starting once resume reports that it is waiting, so the wait is really taken.
  const step = (text: string) => {
    if (text.startsWith("Waiting for Ona to finish starting"))
      patchBox(resource.envId, { phase: "ENVIRONMENT_PHASE_RUNNING" });
  };
  await provider.resume!({ ...ctx, report: { step, log() {} }, resource, hostId: "host-1" });
  const calls = onaCalls();
  assert.ok(calls.filter((call) => call === `environment get ${resource.envId}`).length >= 2, calls.join("\n"));
  assert.ok(!calls.some((call) => call.startsWith("environment start")), calls.join("\n"));
  assert.deepEqual(bootstraps, ["key-1", "key-1", "key-1"]);
});

test("thread_cost prices a Claude thread from the box's session files and caches it per turn", local, async () => {
  assert.deepEqual(await host.harness.behavior.callRpc("thread_cost", { threadId: "thread-0" }), { cost: null });
  // The collector runs over fake ssh with HOME=dir and reads ~/.claude/projects/*/<session>.jsonl.
  const project = join(dir, ".claude", "projects", "-workspaces-app");
  mkdirSync(project, { recursive: true });
  const usage = { input_tokens: 1_000, output_tokens: 500 };
  writeFileSync(
    join(project, "s1.jsonl"),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-4-6", usage } }),
  );
  const price = CLAUDE_PRICES["claude-opus-4-6"]!;
  const usd = (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
  const first = (await host.harness.behavior.callRpc("thread_cost", { threadId: "thread-1" })) as {
    cost: { updatedAt: number } & Record<string, unknown>;
  };
  const { updatedAt, ...cost } = first.cost;
  assert.deepEqual(cost, { provider: "claude-code", usd, basis: "list-price", partial: false });
  assert.ok(updatedAt > 0);
  // Same turn, so the stored figure is served without reading the box again.
  rmSync(join(project, "s1.jsonl"));
  assert.deepEqual(await host.harness.behavior.callRpc("thread_cost", { threadId: "thread-1" }), first);
});
