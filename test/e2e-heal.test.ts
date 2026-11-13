// The real server.ts inside the SDK's fake bb host (test/e2e-host.ts), for
// the repairs that touch a box over SSH: the daemon heal after a box
// restarted outside bb (and the live-daemon refusal), a resume while Ona is
// still starting the box, the `thread_cost` rpc, and the idle release of a
// box whose daemon keeps dropping. One story in file order:
// run the whole file.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLAUDE_PRICES } from "../src/cost.ts";
import type { OnaResource } from "../src/provider.ts";
import { GRACE_MS } from "../src/reconcile.ts";
import { connectedAtKey, type BbHost } from "../src/sync.ts";
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
      hosts: {
        list: async () => hosts,
        get: async ({ hostId }) => hosts.find((h) => h.id === hostId)!,
        // bb settles the suspend at once; the provider's suspend is bb's step, not the fake's.
        experimental_suspend: async ({ hostId }) => {
          const bbHost = hosts.find((h) => h.id === hostId)!;
          bbHost.lifecycle = { ...bbHost.lifecycle, phase: "suspended" };
          return bbHost;
        },
      },
      environments: { list: async () => [], get: async () => ({ hostId: "host-1" }) },
      threads: {
        list: async () => [],
        get: async ({ threadId }) =>
          threadId === "thread-1"
            ? { environmentId: "ws-1", providerId: "claude-code" }
            : threadId === "thread-2"
              ? { environmentId: null }
              : {},
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
  // Each `get` is a readiness check before SSH (rule 1); no start or stop.
  const calls = onaCalls();
  assert.ok(calls.length > 0 && calls.every((call) => call === "environment get env-1"), calls.join("\n"));
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

// Bug: a thread header listed every bb host to find the one its thread runs on.
test(
  "thread_devbox looks up only the thread's host: no hosts.list, one hosts.get, one thread read",
  local,
  async () => {
    const sdk = host.harness.inspection.sdk;
    const lists = sdk.callsTo("hosts.list").length;
    const gets = sdk.callsTo("hosts.get").length;
    const threadReads = sdk.callsTo("threads.get").length;
    const reply = (await host.harness.behavior.callRpc("thread_devbox", { threadId: "thread-1" })) as {
      devbox: { hostId: string } | null;
    };
    assert.equal(reply.devbox?.hostId, "host-1");
    assert.equal(sdk.callsTo("hosts.list").length - lists, 0);
    assert.equal(sdk.callsTo("hosts.get").length - gets, 1);
    assert.equal(sdk.callsTo("threads.get").length - threadReads, 1);
  },
);

test(
  "devboxes_list shows the connected devbox by its host (fails if the list is empty or a row loses its host or status)",
  local,
  async () => {
    const reply = (await host.harness.behavior.callRpc("devboxes_list", null)) as {
      devboxes: { hostId: string; status: string }[];
    };
    assert.deepEqual(
      reply.devboxes.map(({ hostId, status }) => ({ hostId, status })),
      [{ hostId: "host-1", status: "connected" }],
    );
  },
);

test(
  "thread_devbox answers null, from one thread read, for a thread bb has not given a workspace yet",
  local,
  async () => {
    const threadReads = host.harness.inspection.sdk.callsTo("threads.get").length;
    assert.deepEqual(await host.harness.behavior.callRpc("thread_devbox", { threadId: "thread-2" }), { devbox: null });
    assert.equal(host.harness.inspection.sdk.callsTo("threads.get").length - threadReads, 1);
  },
);

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

const twoHoursAgo = Date.now() - 2 * 3_600_000;

// Bug: connect stamped the idle clock, so each daemon heal restarted it and a box whose daemon kept dropping was never
// let go.
test("a daemon heal leaves the box's idle clock as it was (fails if the heal stamps it)", local, async () => {
  await host.bb.storage.kv.set(connectedAtKey(resource.envId), twoHoursAgo);
  disconnectHost();
  const result = await host.harness.behavior.runCli(["sync"]);
  assert.match(result.stdout ?? "", /last action: heal-daemon: .*daemon was down; restarted it/);
  assert.equal(await host.bb.storage.kv.get(connectedAtKey(resource.envId)), twoHoursAgo);
});

test(
  "the healed box, its idle clock still two hours old and no thread on it, is let go at the next pass",
  local,
  async () => {
    hosts[0]!.status = "connected";
    const result = await host.harness.behavior.runCli(["sync"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout ?? "", /last action: release-idle:/);
    assert.deepEqual(host.harness.inspection.sdk.callsTo("hosts.experimental_suspend"), [[{ hostId: "host-1" }]]);
  },
);
