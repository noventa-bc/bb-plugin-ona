// The real server.ts inside the SDK's fake bb host (test/e2e-host.ts), for
// what a sync pass and the `bb ona` commands do to a box: the idle release and
// the observed stop (neither may stop the box), keep-alive, reconnect, rename,
// update, sync by the Ona name and the thread event. One story in file order: run the whole file.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { OnaResource } from "../src/provider.ts";
import { connectedAtKey, type BbHost, type ThreadRecord } from "../src/sync.ts";
import { ctx, local, startHost, type E2eHost } from "./e2e-host.ts";

const HOUR = 3_600_000;
const STOPPED = "ENVIRONMENT_PHASE_STOPPED";
const RUNNING = "ENVIRONMENT_PHASE_RUNNING";

let host: E2eHost["host"];
let provider: E2eHost["provider"];
let log: string;
let envs: E2eHost["envs"];
let state: E2eHost["state"];
let patchBox: E2eHost["patchBox"];
let onaCalls: E2eHost["onaCalls"];
let close: E2eHost["close"];
let resource: OnaResource;
const hosts: BbHost[] = [];
const threads: ThreadRecord[] = [];
const bootstraps: string[] = [];
const suspends = () => host.harness.inspection.sdk.callsTo("hosts.experimental_suspend");

function cli(currentVersion: string, latestVersion: string) {
  const needsUpdate = currentVersion !== latestVersion;
  return { installed: true, currentVersion, latestVersion, needsUpdate, installAction: { kind: "update" } };
}

before(async () => {
  if (local.skip) return;
  ({ host, provider, log, envs, state, patchBox, onaCalls, close } = await startHost({
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
        // bb accepts the suspend and moves the host on; the provider's suspend is bb's next step, not the fake's.
        experimental_suspend: async ({ hostId }) => {
          const bbHost = hosts.find((h) => h.id === hostId)!;
          bbHost.lifecycle = { ...bbHost.lifecycle, phase: "suspending" };
          return bbHost;
        },
        update: async ({ hostId, name }) =>
          Object.assign(
            hosts.find((h) => h.id === hostId)!,
            { name },
          ),
        // Claude Code has an update pending, Codex is current.
        providerCliStatus: async () => ({
          "claude-code": cli("1.0.0", "1.1.0"),
          codex: cli("0.5.0", "0.5.0"),
        }),
        installProviderCli: async () => [{ type: "completed", exitCode: 0 }],
      },
      threads: { list: async () => threads },
      environments: { list: async () => [] },
    },
  }));
});

after(async () => {
  if (!local.skip) await close();
});

test("create a box and connect it; bb ona list --json shows the machine", local, async () => {
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
  onaCalls();
  const list = await host.harness.behavior.runCli(["list", "--json"]);
  assert.equal(list.exitCode, 0, list.stderr);
  const rows = JSON.parse(list.stdout ?? "") as {
    hostId: string;
    phase: string;
    tunnel: string;
    resource: OnaResource;
  }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hostId, "host-1");
  assert.equal(rows[0]!.phase, "active");
  assert.match(rows[0]!.tunnel, /^(up|connecting)$/);
  assert.deepEqual(rows[0]!.resource, resource);
});

test("bb ona sync lets an idle box go: bb suspends the machine and the box is not stopped", local, async () => {
  // Connected and last active two hours ago, past the default idleDisconnect of 1h.
  await host.bb.storage.kv.set(connectedAtKey(resource.envId), Date.now() - 2 * HOUR);
  threads.push({ id: "t1", status: "idle", updatedAt: Date.now() - 2 * HOUR, runtime: { displayStatus: "idle" } });
  const result = await host.harness.behavior.runCli(["sync"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(suspends(), [[{ hostId: "host-1" }]]);
  assert.match(result.stdout ?? "", /^ona:\S+  bb:suspending  tunnel:(up|connecting)  ona:running$/m);
  assert.match(result.stdout ?? "", /last action: release-idle:/);
  assert.deepEqual(onaCalls(), []);
  // bb's next step after accepting the suspend: the provider's suspend only closes the tunnel.
  await provider.suspend!({ ...ctx, resource, hostId: "host-1" });
  assert.deepEqual(onaCalls(), []);
  assert.equal(envs()[0]!.status.phase, RUNNING);
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:off/);
});

test("bb ona sync on a box Ona stopped marks the machine suspended and touches nothing in Ona", local, async () => {
  patchBox(resource.envId, { phase: STOPPED });
  // bb, as after the released machine was resumed by a message and then lost the box to Ona's timeout.
  Object.assign(hosts[0]!, {
    status: "disconnected",
    lifecycle: { phase: "active", message: null, suspendedAt: null },
  });
  threads[0]!.updatedAt = Date.now();
  const result = await host.harness.behavior.runCli(["sync"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(suspends().slice(-1), [[{ hostId: "host-1" }]]);
  assert.match(result.stdout ?? "", /^ona:\S+  bb:suspending  tunnel:off  ona:stopped$/m);
  assert.match(result.stdout ?? "", /last action: suspend-observed:/);
  assert.deepEqual(onaCalls(), []);
  // bb's next step: the provider's suspend sees the no-stop flag and leaves the stopped box alone.
  await provider.suspend!({ ...ctx, resource, hostId: "host-1" });
  assert.deepEqual(onaCalls(), []);
});

test("bb ona keep-alive refuses a stopped box, holds a running one and ends on `off`", local, async () => {
  const ref = resource.envId;
  const refused = await host.harness.behavior.runCli(["keep-alive", ref, "1m"]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", new RegExp(`^${ref} is stopped in Ona\\. keep-alive only holds a running box`));
  patchBox(resource.envId, { phase: RUNNING });
  const started = await host.harness.behavior.runCli(["keep-alive", ref, "1m"]);
  assert.equal(started.exitCode, 0, started.stderr);
  assert.match(started.stdout ?? "", new RegExp(`^Keeping ${ref} alive until \\d\\d:\\d\\d\\.`));
  // Wait until the fake `ona` is running so `off` has a process to end.
  for (let i = 0; i < 40 && !readFileSync(log, "utf8").includes("keep-alive"); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.match((await host.harness.behavior.runCli(["status"])).stdout ?? "", /^  keep-alive until \d\d:\d\d$/m);
  const ended = await host.harness.behavior.runCli(["keep-alive", ref, "off"]);
  assert.equal(ended.stdout, `Ended the keep-alive for ${ref}.`);
  assert.doesNotMatch((await host.harness.behavior.runCli(["status"])).stdout ?? "", /keep-alive until/);
  // The `sleep 60` the fake `ona` ran dies with its process group on `off`; a second `off` finds nothing.
  assert.equal((await host.harness.behavior.runCli(["keep-alive", ref, "off"])).stdout, `${ref} had no keep-alive.`);
  assert.deepEqual(onaCalls(), [`environment keep-alive --environment-id ${ref} -q -- sleep 60`]);
});

test("bb ona reconnect bootstraps the daemon again (fails if it skips the bootstrap or calls Ona)", local, async () => {
  bootstraps.length = 0;
  const result = await host.harness.behavior.runCli(["reconnect", resource.envId]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(
    result.stdout?.endsWith(`Installing and enrolling the bb daemon\nReconnected ona:${resource.envName}`),
    result.stdout,
  );
  assert.deepEqual(bootstraps, ["key-1"]);
  assert.deepEqual(onaCalls(), []);
});

test("bb ona rename renames the box in Ona and its bb machine (fails if bb keeps the old name)", local, async () => {
  const result = await host.harness.behavior.runCli(["rename", resource.envId, "new-name"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, `Renamed ${resource.envId} -> new-name (bb machine ona:new-name)`);
  assert.deepEqual(onaCalls(), [`environment update ${resource.envId} --name new-name`]);
  assert.equal(envs()[0]!.metadata.name, "new-name");
  assert.deepEqual(host.harness.inspection.sdk.callsTo("hosts.update"), [[{ hostId: "host-1", name: "ona:new-name" }]]);
});

test("bb ona update installs only the pending CLI (fails if a current CLI is reinstalled)", local, async () => {
  Object.assign(hosts[0]!, { status: "connected", lifecycle: { phase: "active", message: null, suspendedAt: null } });
  const result = await host.harness.behavior.runCli(["update"]);
  assert.equal(result.exitCode, 0, result.stderr);
  // The box was renamed in the test above.
  assert.equal(result.stdout, "new-name: claude-code 1.0.0 -> 1.1.0");
  assert.deepEqual(host.harness.inspection.sdk.callsTo("hosts.installProviderCli"), [
    [{ hostId: "host-1", provider: "claude-code", actionKind: "update" }],
  ]);
  assert.deepEqual(onaCalls(), []);
});

// Bug: `bb ona sync <name>` looked the name up before refreshing the listing, so a box renamed in Ona was "not found".
test("bb ona sync finds a box by the name it was given in Ona, not through bb", local, async () => {
  writeFileSync(
    state,
    JSON.stringify(
      envs().map((e) => (e.id === resource.envId ? { ...e, metadata: { ...e.metadata, name: "ona-named" } } : e)),
    ),
  );
  const result = await host.harness.behavior.runCli(["sync", "ona-named"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /^ona:new-name /m);
});

test("thread.deleted drops the thread's stored cost", local, async () => {
  await host.bb.storage.kv.set("cost2:thread-1", { cost: null, seq: "1", checkedAt: Date.now(), runs: 1 });
  await host.bb.storage.kv.set("cost:thread-1", { cost: null, seq: 1, checkedAt: Date.now() });
  const { errors } = await host.harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "thread-1" }),
  });
  assert.deepEqual(errors, []);
  assert.equal((await host.bb.storage.kv.get("cost2:thread-1")) ?? null, null);
  assert.equal((await host.bb.storage.kv.get("cost:thread-1")) ?? null, null);
});
