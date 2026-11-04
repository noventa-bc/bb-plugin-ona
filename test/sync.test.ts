import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceView } from "../src/lifecycle.ts";
import { ALL, GIVE_UP_AFTER, GRACE_MS } from "../src/reconcile.ts";
import {
  connectedAtKey,
  forgetBox,
  matchesRef,
  type Row,
  watchRealtime,
  type RealtimeBb,
  type ThreadRecord,
} from "../src/sync.ts";
import { enableFakeClock, resetFakeClock } from "./fake-clock.ts";
import { HOUR, NOW, idle, world } from "./sync-fakes.ts";

test("an idle box is released: bb suspends it without stopping the box, and the flag is used once", async () => {
  const { sync, calls, releasing } = world([idle("h1")]);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.equal(releasing.size, 0);
});

// Bug: bb left an archived thread "active", and the box was never released.
test("an idle box whose only active thread is archived is released without stopping the box", async () => {
  const archived: ThreadRecord = {
    id: "t1",
    status: "active",
    archivedAt: NOW - 2 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    runtime: { displayStatus: "active" },
  };
  const { sync, calls, releasing } = world([idle("h1", { threads: [archived] })]);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
  assert.equal(releasing.size, 0);
});

// Bug: bb lists hidden threads only when asked, so a box was let go under a workflow worker's turn.
test("an idle box whose only busy thread is hidden is not released", async () => {
  const worker: ThreadRecord = {
    id: "t1",
    status: "active",
    updatedAt: NOW - 2 * HOUR,
    runtime: { displayStatus: "active" },
  };
  const { sync, calls } = world([idle("h1", { hiddenThreads: [worker] })]);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, []);
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

test("an idle box isn't released while bb tears down or retries a workspace, or one needs recovery", async () => {
  const teardown = (status: string | null, retireAt: number | null = null): WorkspaceView => ({
    status: "ready",
    lifecycle: { phase: "teardown", retireAt, teardown: status ? { status } : null },
  });
  const workspaces = [teardown("running"), teardown(null), teardown("failed"), teardown("failed", Date.now() + 60_000)];
  for (const workspace of workspaces) {
    const { sync, calls } = world([idle("h1", { workspaces: [workspace] })]);
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(calls, [], JSON.stringify(workspace));
  }
});

// Bug: a teardown bb was still retrying counted as needing recovery, so a disconnected box waited out the grace instead of reconnecting for bb's retry.
test("a disconnected box reconnects at once for a teardown bb is still retrying", async () => {
  const retrying: WorkspaceView = {
    status: "error",
    lifecycle: { phase: "teardown", retireAt: Date.now() + 60_000, teardown: { status: "failed" } },
  };
  const { sync, calls } = world(
    [idle("h1", { status: "disconnected", lastSeenAt: Date.now() - 5_000, workspaces: [retrying] })],
    { daemonAlive: false },
  );
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, ["probe", "restart daemon"]);
  const [row] = await sync.statusRows();
  assert.equal(row!.needsRecovery, 0, "bb is still retrying it, so status doesn't call it needing recovery");
});

test("a disconnected box waits out the grace for a teardown whose retry is over a minute overdue", async () => {
  const overdue: WorkspaceView = {
    status: "error",
    lifecycle: { phase: "teardown", retireAt: Date.now() - 2 * 60_000, teardown: { status: "failed" } },
  };
  const { sync, calls } = world(
    [idle("h1", { status: "disconnected", lastSeenAt: Date.now() - 5_000, workspaces: [overdue] })],
    { daemonAlive: false },
  );
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(calls, []);
  const [row] = await sync.statusRows();
  assert.equal(row!.needsRecovery, 1);
});

// reconcile's workspaceWaiting check passes its pass clock, so a sibling's wait cannot move the cutoff.
test("a retry the pass judged busy stays busy after a sibling's wait moves the clock past its cutoff", async () => {
  enableFakeClock();
  try {
    const start = Date.now();
    const retrying: WorkspaceView = {
      status: "error",
      lifecycle: { phase: "teardown", retireAt: start - 40_000, teardown: { status: "failed" } },
    };
    // The fake clock starts at 0, so the default pluginStartedAt would sit in the future and disable the idle check.
    const { sync, calls } = world(
      [
        idle("a", { status: "disconnected", lastSeenAt: start - 5_000, listingMs: 30_000 }),
        idle("b", { status: "disconnected", lastSeenAt: start - 5_000, workspaces: [retrying] }),
      ],
      { daemonAlive: false, pluginStartedAt: start },
    );
    await sync.reconcile(new Set([ALL]), { wait: true });
    assert.deepEqual(calls, ["probe", "restart daemon"]);
  } finally {
    await resetFakeClock();
  }
});

// Bug: after `bb ona rename`, every line kept the name stored when the box was created.
test("rows carry the name Ona lists, not the one stored at creation", async () => {
  const { sync } = world([idle("h1", { name: "renamed" }), idle("h2")]);
  assert.equal((await sync.statusRows("renamed")).length, 1);
  assert.deepEqual(
    (await sync.machines()).map((row) => row.resource.envName),
    ["renamed", "box"],
  );
});

// Bug: an open thread header listed every bb host to find the one its thread runs on.
test("machineOfHost reads the one host it is asked for, not the list", async () => {
  const { sync, hostReads } = world([idle("h1"), idle("h2")]);
  const row = await sync.machineOfHost("h2");
  assert.equal(row?.hostId, "h2");
  assert.equal(row?.resource.envId, "env-h2");
  assert.deepEqual(hostReads, ["get h2"]);
});

test("machineOfHost is null for a host the list would leave out", async () => {
  const { sync, hosts } = world([idle("h1")]);
  assert.equal(await sync.machineOfHost("unknown"), null, "bb answers 404");
  hosts.get("h1")!.machineProviderId = null;
  assert.equal(await sync.machineOfHost("h1"), null, "not an Ona machine");
  hosts.get("h1")!.machineProviderId = "ona";
  hosts.get("h1")!.lifecycle.phase = "creating";
  assert.equal(await sync.machineOfHost("h1"), null, "still being created");
});

// An SDK error can carry the `not_found` code and no status (experimental_PluginRpcCallError); that host is gone too.
test("machineOfHost is null when the lookup error carries only the not_found code", async () => {
  const { sync } = world([idle("h1")], { hostGet: "not_found" });
  assert.equal(await sync.machineOfHost("h1"), null);
});

test("machineOfHost throws when the lookup fails for another reason", async () => {
  const { sync } = world([idle("h1")], { hostGet: "fail" });
  await assert.rejects(sync.machineOfHost("h1"), /bb is down/);
});

test("status reports workspaces that need recovery", async () => {
  const failed: WorkspaceView = {
    status: "error",
    lifecycle: { phase: "teardown", retireAt: null, teardown: { status: "failed" } },
  };
  const { sync } = world([idle("h1", { workspaces: [failed, failed] })]);
  const [row] = await sync.statusRows();
  assert.equal(row!.needsRecovery, 2);
});

test("status lists a busy thread with no update for over 6h", async () => {
  const stuck: ThreadRecord = {
    id: "t1",
    status: "starting",
    updatedAt: NOW - 9 * HOUR,
    runtime: { displayStatus: "starting" },
  };
  const { sync } = world([idle("h1", { threads: [stuck] })]);
  const [row] = await sync.statusRows();
  assert.deepEqual(row!.stuckThreads, [{ id: "t1", status: "starting", updatedAt: NOW - 9 * HOUR }]);
});

// A failed thread listing must not fail the whole status command.
test("status still lists a machine whose thread listing fails", async () => {
  const { sync } = world([idle("h1", { threads: "fail" })]);
  const [row] = await sync.statusRows();
  assert.deepEqual(row!.stuckThreads, []);
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
  const waiting: ThreadRecord = {
    id: "t1",
    status: "idle",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })]);
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1", "resume h1"]);
});

// Bug: a workflow step or side chat waiting for a box Ona stopped never resumed it (bb hides those threads).
test("Ona stopping a box with a hidden thread waiting: suspended without stopping, then resumed", async () => {
  const waiting: ThreadRecord = {
    id: "t1",
    status: "idle",
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls } = world([idle("h1", { ona: "STOPPED", status: "disconnected", hiddenThreads: [waiting] })]);
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1", "resume h1"]);
});

// Bug: an archived thread bb left "waiting-for-host" woke its stopped box on every pass.
test("Ona stopping a box whose only waiting thread is archived: suspended, not resumed", async () => {
  const waiting: ThreadRecord = {
    id: "t1",
    status: "idle",
    archivedAt: NOW - HOUR,
    updatedAt: NOW,
    runtime: { displayStatus: "waiting-for-host" },
  };
  const { sync, calls } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waiting] })]);
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["suspend h1"]);
});

test("the first pass after a reload reopens the tunnel of a running box bb still shows connected", async () => {
  const recent: ThreadRecord = { id: "t1", status: "idle", updatedAt: NOW, runtime: { displayStatus: "idle" } };
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

// A failed reconnect is a failure: no restart is reported, and it backs off.
test("a daemon restart that Ona fails is a failure: no restart reported, and it backs off", async () => {
  const { sync, calls, guard } = world([idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR })], {
    daemonAlive: false,
    reconnectFails: "Ona environment box is not ready: no capacity",
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const record = guard.records.get("h1")!;
  assert.equal(record.failures, 1);
  assert.match(record.error ?? "", /is not ready: no capacity/);
  assert.doesNotMatch(record.reason, /restarted/);
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["probe", "restart daemon"], "no second probe (SSH) while backing off");
});

test("a box stopped in Ona while its daemon is checked is not restarted", async () => {
  // Bug: the restart trusted the listing from before the check (up to 30 s of SSH), and its SSH would start the box.
  const { sync, calls } = world([idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR })], {
    daemonAlive: false,
    stopDuringProbe: true,
    cached: true,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["probe"]);
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

/** watchRealtime against a fake bb: thread t1 runs on Ona host h1, thread t2 on a non-Ona host. */
function realtime(options: { subscribeThrows?: boolean; hostByEnv?: Map<string, string> } = {}) {
  const scheduled: string[] = [];
  const warnings: string[] = [];
  const callbacks = new Map<string, (event: unknown) => void>();
  let unsubscribed = 0;
  const subscribe = ({ event, callback }: { event: string; callback: (event: never) => void }) => {
    if (options.subscribeThrows) throw new Error("no realtime");
    callbacks.set(event, callback as (event: unknown) => void);
    return () => void unsubscribed++;
  };
  const hostOfEnvironment: Record<string, string> = { e1: "h1", e2: "other" };
  const environmentOfThread: Record<string, string | null> = { t1: "e1", t2: "e2", t3: null };
  const bb: RealtimeBb = {
    sdk: {
      subscribe: subscribe as RealtimeBb["sdk"]["subscribe"],
      threads: { get: async ({ threadId }) => ({ environmentId: environmentOfThread[threadId] ?? null }) },
      environments: { get: async ({ environmentId }) => ({ hostId: hostOfEnvironment[environmentId]! }) },
    },
    log: { warn: (message) => void warnings.push(message) },
  };
  const unsubscribe = watchRealtime({
    bb,
    scheduler: { schedule: (key, delayMs) => void scheduled.push(`${key} ${delayMs}`) },
    hostByEnv: options.hostByEnv ?? new Map([["env-1", "h1"]]),
  });
  const fire = async (event: string, payload: unknown) => {
    callbacks.get(event)!(payload);
    // Let the thread -> host lookup settle.
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { scheduled, warnings, fire, unsubscribe, unsubscribed: () => unsubscribed };
}

const threadEvent = (id: string, displayStatus: string) => ({
  id,
  metadata: { statusChange: { runtime: { displayStatus } } },
});

test("a thread waiting for an Ona host schedules that host; other threads and statuses don't", async () => {
  const { scheduled, fire } = realtime();
  await fire("thread:changed", threadEvent("t1", "waiting-for-host"));
  assert.deepEqual(scheduled, ["h1 500"]);
  await fire("thread:changed", threadEvent("t1", "running"));
  await fire("thread:changed", threadEvent("t2", "waiting-for-host"));
  await fire("thread:changed", threadEvent("t3", "waiting-for-host"));
  assert.deepEqual(scheduled, ["h1 500"]);
});

test("an Ona host dropping off waits out the grace period; one coming back is checked soon", async () => {
  const { scheduled, fire } = realtime();
  await fire("host:changed", { id: "h1", changes: ["host-disconnected"] });
  await fire("host:changed", { id: "h1", changes: ["host-connected"] });
  await fire("host:changed", { id: "other", changes: ["host-disconnected"] });
  assert.deepEqual(scheduled, [`h1 ${GRACE_MS + 1_000}`, "h1 2000"]);
});

test("realtime reads the host map live, so a box adopted after start is watched", async () => {
  const hostByEnv = new Map<string, string>();
  const { scheduled, fire } = realtime({ hostByEnv });
  hostByEnv.set("env-1", "h1");
  await fire("host:changed", { id: "h1", changes: ["host-disconnected"] });
  assert.deepEqual(scheduled, [`h1 ${GRACE_MS + 1_000}`]);
});

test("a realtime reconnect checks every machine", async () => {
  const { scheduled, fire } = realtime();
  await fire("realtime:connection", { reconnected: false });
  await fire("realtime:connection", { reconnected: true });
  assert.deepEqual(scheduled, [`${ALL} 2000`]);
});

test("unsubscribe ends every subscription", () => {
  const { unsubscribe, unsubscribed } = realtime();
  unsubscribe();
  assert.equal(unsubscribed(), 3);
});

test("realtime that can't subscribe logs a warning and leaves a no-op unsubscribe", () => {
  const { warnings, unsubscribe } = realtime({ subscribeThrows: true });
  assert.match(warnings.join("\n"), /realtime events unavailable.*no realtime/);
  unsubscribe();
});
