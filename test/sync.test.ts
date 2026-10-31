import assert from "node:assert/strict";
import { test } from "node:test";
import { OnaSnapshot, type OnaEnvironment } from "../src/ona.ts";
import type { WorkspaceView } from "../src/lifecycle.ts";
import { ALL, GIVE_UP_AFTER, HostGuard } from "../src/reconcile.ts";
import {
  connectedAtKey,
  createSync,
  forgetBox,
  matchesRef,
  type BbHost,
  type Row,
  type ThreadRecord,
} from "../src/sync.ts";

// A fake of the bb calls a sync pass makes (SyncBb), one Ona box per machine.
const HOUR = 3_600_000;
const NOW = Date.now();

interface Box {
  hostId: string;
  envId: string;
  phase?: string;
  status?: string;
  lastSeenAt?: number;
  threads?: ThreadRecord[];
  workspaces?: WorkspaceView[];
  ona?: string | null;
  tunnel?: "up" | "off";
}

function world(
  boxes: Box[],
  options: {
    refuse?: string;
    daemonAlive?: boolean | null;
    archived?: boolean | "not-found" | "fail";
    listing?: "fail" | "empty";
    autoRepair?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const kv = new Map<string, unknown>();
  const releasing = new Set<string>();
  const hosts = new Map<string, BbHost>(
    boxes.map((box) => [
      box.hostId,
      {
        id: box.hostId,
        name: `ona:${box.envId}`,
        machineProviderId: "ona",
        status: box.status ?? "connected",
        lastSeenAt: box.lastSeenAt ?? NOW,
        updatedAt: NOW - HOUR,
        lifecycle: { phase: box.phase ?? "active", message: null, suspendedAt: null },
      },
    ]),
  );
  const byHost = new Map(boxes.map((box) => [box.hostId, box]));
  const lifecycleCall =
    (name: string, phase: string) =>
    async ({ hostId }: { hostId: string }) => {
      calls.push(`${name} ${hostId}`);
      const host = hosts.get(hostId)!;
      host.lifecycle = options.refuse
        ? { ...host.lifecycle, message: options.refuse }
        : { ...host.lifecycle, phase, message: null };
      if (!options.refuse) host.updatedAt = Date.now();
      // Like the provider's suspend: a box without the no-stop flag gets stopped.
      const envId = byHost.get(hostId)!.envId;
      if (name === "suspend" && !options.refuse && !releasing.delete(envId)) calls.push(`stop ${envId}`);
      return host;
    };
  const envs = (): OnaEnvironment[] =>
    options.listing === "empty"
      ? []
      : boxes
          .filter((box) => box.ona !== null)
          .map((box) => ({
            id: box.envId,
            metadata: {},
            status: { phase: `ENVIRONMENT_PHASE_${box.ona ?? "RUNNING"}` },
          }));
  const guard = new HostGuard();
  let tick = 0;
  const sync = createSync({
    bb: {
      sdk: {
        hosts: {
          list: async () => [...hosts.values()],
          experimental_suspend: lifecycleCall("suspend", "suspending"),
          experimental_resume: lifecycleCall("resume", "resuming"),
          experimental_reconcile: lifecycleCall("reconcile", "active"),
        },
        threads: { list: async ({ hostId }) => byHost.get(hostId)?.threads ?? [] },
        environments: { list: async ({ hostId }) => byHost.get(hostId)?.workspaces ?? [] },
      },
      experimental_machines: {
        getResource: async (hostId) => ({ envId: byHost.get(hostId)!.envId, envName: "box", adopted: true, key: "k" }),
      },
      storage: {
        kv: {
          get: async <T>(key: string) => kv.get(key) as T | undefined,
          set: async (key: string, value: unknown) => void kv.set(key, value),
        },
      },
      log: { info: () => {}, warn: () => {} },
    },
    // No cache and a ticking clock: every pass gets its own listing.
    snapshot: new OnaSnapshot(
      async () => {
        if (options.listing === "fail") throw new Error("not logged in");
        return envs();
      },
      0,
      () => (tick += 60_000),
    ),
    ona: {
      getEnvironmentIfExists: async (envId) => {
        calls.push(`ona get ${envId}`);
        if (options.archived === "fail") throw new Error("timed out");
        if (options.archived === undefined || options.archived === "not-found") return null;
        return {
          id: envId,
          metadata: options.archived ? { archivedAt: "2026-10-01T00:00:00Z" } : {},
          status: { phase: "ENVIRONMENT_PHASE_RUNNING" },
        };
      },
    },
    guard,
    tunnels: {
      status: (envId) => boxes.find((box) => box.envId === envId)?.tunnel ?? "up",
      ensure: (envId) => void calls.push(`tunnel ${envId}`),
    },
    provider: {
      releasing,
      daemonAlive: async () => {
        calls.push("probe");
        return options.daemonAlive ?? true;
      },
      reconnect: async () => void calls.push("restart daemon"),
    },
    keepAliveUntil: () => null,
    hostByEnv: new Map(),
    autoRepair: options.autoRepair ?? true,
    idleDisconnect: "1h",
    pluginStartedAt: NOW - 2 * HOUR,
  });
  return { sync, calls, guard, kv, hosts, releasing };
}

const idle = (hostId: string, extra: Partial<Box> = {}): Box => ({ hostId, envId: `env-${hostId}`, ...extra });

test("an idle box is released: bb suspends it without stopping the box, and the flag is used once", async () => {
  const { sync, calls, releasing } = world([idle("h1")]);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.equal(releasing.size, 0);
});

test("bb accepting a suspend without acting on it is a failure, not a release", async () => {
  const { sync, calls, guard, releasing } = world([idle("h1")], { refuse: "Automatic cleanup is blocked" });
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  const record = guard.records.get("h1")!;
  assert.equal(record.failures, 1);
  assert.match(record.error ?? "", /bb kept the machine active: Automatic cleanup is blocked/);
  assert.equal(releasing.size, 0, "the no-stop flag doesn't outlive the failed suspend");
  assert.ok(GIVE_UP_AFTER > 1);
});

test("an idle box isn't released while bb tears down a workspace, or one needs recovery", async () => {
  const teardown = (status: string | null): WorkspaceView => ({
    status: "ready",
    lifecycle: { phase: "teardown", teardown: status ? { status } : null },
  });
  for (const workspace of [teardown("running"), teardown(null), teardown("failed")]) {
    const { sync, calls } = world([idle("h1", { workspaces: [workspace] })]);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(calls, [], JSON.stringify(workspace));
  }
});

test("status reports workspaces that need recovery", async () => {
  const failed: WorkspaceView = { status: "error", lifecycle: { phase: "teardown", teardown: { status: "failed" } } };
  const { sync } = world([idle("h1", { workspaces: [failed, failed] })]);
  const [row] = await sync.statusRows();
  assert.equal(row!.needsRecovery, 2);
});

test("a box missing from two listings is looked up once: archived or gone", async () => {
  for (const archived of [true, "not-found"] as const) {
    const { sync, calls, guard } = world([idle("h1", { ona: null, status: "disconnected" }), idle("h2")], {
      archived,
    });
    // Gone from two good listings in a row; a third pass must not look it up again.
    for (let pass = 0; pass < 3; pass++) await sync.reconcile(new Set(["h1"]), { wait: true, force: true });
    assert.equal(calls.filter((call) => call === "ona get env-h1").length, 1, `archived=${archived}`);
    assert.ok(calls.includes("suspend h1"));
    assert.match(guard.records.get("h1")!.reason, archived === true ? /archived/ : /gone/);
    const [row] = await sync.statusRows("h1");
    assert.equal(row!.ona, archived === true ? "archived" : "missing");
  }
});

test("a failed archived lookup is unknown: asked again next pass, not settled as gone", async () => {
  const { sync, calls } = world([idle("h1", { ona: null, status: "disconnected" }), idle("h2")], { archived: "fail" });
  for (let pass = 0; pass < 3; pass++) await sync.reconcile(new Set(["h1"]), { wait: true, force: true });
  assert.equal(calls.filter((call) => call === "ona get env-h1").length, 2, "passes 2 and 3 both ask");
  assert.ok(!calls.includes("suspend h1"));
});

test("a running box the listing misses but a lookup finds is not suspended", async () => {
  const { sync, calls } = world([idle("h1", { ona: null }), idle("h2")], { archived: false });
  for (let pass = 0; pass < 3; pass++) await sync.reconcile(new Set(["h1"]), { wait: true, force: true });
  assert.equal(calls.filter((call) => call === "ona get env-h1").length, 2, "passes 2 and 3 both ask");
  assert.ok(!calls.includes("suspend h1"));
  const [row] = await sync.statusRows("h1");
  assert.equal(row!.ona, "running");
});

test("Ona stopping a box with a thread waiting: suspended without stopping, then resumed", async () => {
  const waiting: ThreadRecord = { status: "idle", updatedAt: NOW, runtime: { displayStatus: "waiting-for-host" } };
  const { sync, calls } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })]);
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1", "resume h1"]);
});

test("the first pass after a reload reopens the tunnel of a running box bb still shows connected", async () => {
  const recent: ThreadRecord = { status: "idle", updatedAt: NOW, runtime: { displayStatus: "idle" } };
  // The reconciler is the only thing that reopens tunnels after a reload, so autoRepair off doesn't skip it.
  for (const autoRepair of [true, false]) {
    const { sync, calls } = world([idle("h1", { tunnel: "off", threads: [recent] })], { autoRepair });
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(calls, ["tunnel env-h1"], `autoRepair=${autoRepair}`);
  }
});

test("a failed or empty Ona listing changes nothing", async () => {
  for (const listing of ["fail", "empty"] as const) {
    const box = idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR, threads: [] });
    const { sync, calls } = world([box], { listing });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.deepEqual(calls, [], listing);
  }
});

test("a running box whose daemon dropped is probed, and restarted only if the daemon is gone", async () => {
  for (const daemonAlive of [true, false, null]) {
    const { sync, calls } = world([idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR })], { daemonAlive });
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.deepEqual(calls, daemonAlive === false ? ["probe", "restart daemon"] : ["probe"], String(daemonAlive));
  }
});

test("removing a machine drops its box's stored keys and leaves other boxes' alone", async () => {
  const kv = new Map<string, unknown>([
    [connectedAtKey("env-h1"), NOW],
    [connectedAtKey("env-h2"), NOW],
  ]);
  const store = { delete: async (key: string) => void kv.delete(key) };
  await forgetBox(store, "env-h1");
  assert.equal(kv.has(connectedAtKey("env-h1")), false);
  assert.equal(kv.get(connectedAtKey("env-h2")), NOW);
  await forgetBox(store, "env-h9");
  assert.equal(kv.size, 1, "an unknown box changes nothing");
});

test("a ref matches a row by host id, machine name, env id or env name, and nothing else", () => {
  const row = { hostId: "h1", machine: "box-one", resource: { envId: "env-1", envName: "one" } } as Row;
  for (const ref of ["h1", "box-one", "env-1", "one"]) assert.equal(matchesRef(row, ref), true, ref);
  assert.equal(matchesRef(row, "two"), false);
});
