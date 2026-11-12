// A sync pass against bb suspending or removing the machine it acts on: the tunnel a close ended stays closed. The
// passes run on the real tunnel manager, whose gate always says no, so no ssh ever runs.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { closeGivenUpTunnels, GIVE_UP_AFTER, HostGuard } from "../src/reconcile.ts";
import { TunnelManager } from "../src/ssh.ts";
import type { SyncDeps } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, tick } from "./fake-clock.ts";
import { HOUR, NOW, idle, waitingThread, world } from "./sync-fakes.ts";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function manager(t: TestContext) {
  const tunnels = new TunnelManager(
    "true",
    () => 1,
    () => 2,
    quiet,
    async () => false,
  );
  t.after(() => tunnels.stopAll()); // a tunnel loop left running would hold the process open
  return tunnels;
}

/** The provider's reconnect as far as the tunnel goes: connect's ensure. */
function reconnectVia(tunnels: TunnelManager): SyncDeps["provider"]["reconnect"] {
  return async (resource, _report, _signal, since) => {
    if (!tunnels.ensure(resource.envId, since)) throw new Error("closed while it connected");
  };
}

/** A box Ona shows running whose daemon bb has not seen for an hour: the pass restarts the daemon. */
const daemonDown = () => idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR });

// Bug: a pass that read the machine active before bb removed it reopened the tunnel remove() had closed, and no pass
// closed it again, since the machine was gone (R25).
test("a pass that read the machine active before bb removed it leaves the tunnel closed (fails if ensure-tunnel reopens a removed box's tunnel)", async (t) => {
  const tunnels = manager(t);
  const { sync, hostReads, guard } = world([idle("h1")], {
    tunnels,
    afterCall: (call) => call === "list" && tunnels.stop("env-h1"),
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(hostReads, ["list"]);
  assert.equal(tunnels.status("env-h1"), "off");
  // Rule 8: a refused open is not done, so the guard records a failure and backs off.
  assert.equal(guard.records.get("h1")?.failures, 1);
});

test("a daemon restart by a pass that read the machine active before bb removed it leaves the tunnel closed (fails if the heal's connect reopens a removed box's tunnel)", async (t) => {
  const tunnels = manager(t);
  tunnels.ensure("env-h1", tunnels.mark());
  const { sync, calls } = world([daemonDown()], {
    tunnels,
    daemonAlive: false,
    reconnect: reconnectVia(tunnels),
    afterCall: (call) => call === "probe" && tunnels.stop("env-h1"),
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, ["probe"]);
  assert.equal(tunnels.status("env-h1"), "off");
});

test("a waiting thread on a box Ona stopped is woken after bb's failed suspend closed its tunnel (fails if the wake's mark predates the suspend)", async (t) => {
  const tunnels = manager(t);
  let opened: boolean | undefined;
  const { sync } = world([idle("h1", { status: "disconnected", ona: "STOPPED", threads: [waitingThread()] })], {
    tunnels,
    // The provider's suspend closes the tunnel, then bb's suspend fails and leaves the machine active.
    afterCall: (call) => call === "suspend h1" && tunnels.stop("env-h1"),
    suspendSettles: { phase: "active", message: "Machine suspension failed" },
    wake: async (resource, _report, _signal, _cause, since) => {
      opened = tunnels.ensure(resource.envId, since);
      return true;
    },
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.equal(opened, true);
});

test("a waiting thread's wake whose machine bb suspends while it wakes opens no tunnel (fails if the sync wake passes no mark)", async (t) => {
  const tunnels = manager(t);
  let opened: boolean | undefined;
  const { sync } = world([idle("h1", { status: "disconnected", ona: "STOPPED", threads: [waitingThread()] })], {
    tunnels,
    suspendSettles: { phase: "active", message: "Machine suspension failed" },
    wake: async (resource, _report, _signal, _cause, since) => {
      tunnels.stop(resource.envId);
      opened = tunnels.ensure(resource.envId, since);
      return true;
    },
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.equal(opened, false);
});

// An open tunnel counts as activity to Ona, so a machine the guard gave up on kept its box running until the owner acted.
test("a give-up closes the box's tunnel and later passes keep it closed (fails if the give-up leaves the tunnel open, or a pass reopens it); a forced pass reopens it and its success ends the give-up (fails if a forced pass leaves it closed)", async (t) => {
  enableFakeClock();
  const tunnels = manager(t);
  try {
    tunnels.ensure("env-h1", tunnels.mark());
    const { sync, guard, logs } = world([idle("h1", { status: "disconnected", lastSeenAt: Date.now() - HOUR })], {
      tunnels,
      daemonAlive: false,
      reconnectFails: "daemon restart failed",
    });
    const pass = (force = false) => sync.reconcile(new Set(["h1"]), { wait: true, force });
    for (const minutes of [5, 10, 20]) {
      await pass();
      await tick(minutes * 60_000);
    }
    assert.equal(guard.records.get("h1")!.failures, GIVE_UP_AFTER);
    await pass();
    assert.equal(tunnels.status("env-h1"), "off");
    assert.ok(logs.some((line) => line.startsWith("ona:env-h1: gave up after")));
    await tick(HOUR);
    await pass();
    assert.equal(tunnels.status("env-h1"), "off");
    await pass(true);
    assert.notEqual(tunnels.status("env-h1"), "off");
    assert.equal(guard.records.get("h1")!.failures, 0);
    await pass();
    assert.notEqual(tunnels.status("env-h1"), "off");
  } finally {
    tunnels.stopAll();
    await resetFakeClock();
  }
});

test("a forced pass on a given-up machine leaves its open tunnel to the repair (fails if a forced pass closes it)", async (t) => {
  const tunnels = manager(t);
  tunnels.ensure("env-h1", tunnels.mark());
  const { sync, guard, calls } = world([daemonDown()], { tunnels });
  guard.records.set("h1", { action: "heal-daemon", reason: "r", at: NOW, failures: GIVE_UP_AFTER, quietUntil: NOW });
  await sync.reconcile(new Set(["h1"]), { wait: true, force: true });
  assert.deepEqual(calls, ["probe"]);
  assert.notEqual(tunnels.status("env-h1"), "off");
});

test("a give-up closes a box's tunnel only when every active machine on it is given up and none is acting (fails if one given-up machine closes a box another machine uses, or a busy machine's tunnel is closed)", async () => {
  const guard = new HostGuard();
  for (const hostId of ["h1", "h2", "h3"])
    guard.records.set(hostId, { action: "heal-daemon", reason: "r", at: 0, failures: GIVE_UP_AFTER, quietUntil: 0 });
  const row = (hostId: string, envId: string, phase = "active") => ({
    hostId,
    machine: hostId,
    phase,
    resource: { envId },
  });
  const open = new Set(["e1", "e2", "e3", "e4"]);
  const closed: string[] = [];
  const tunnels = {
    status: (envId: string) => (open.has(envId) ? "up" : "off"),
    stop: (envId: string) => void (open.delete(envId), closed.push(envId)),
  };
  let release = () => {};
  const busy = guard.hold("h3", "reconnect", () => new Promise<void>((resolve) => (release = resolve)));
  // e1: both machines given up. e2: h4 has no failures. e3: h3 is acting. e4: the other machine is suspended.
  const rows = [
    row("h1", "e1"),
    row("h2", "e1"),
    row("h1", "e2"),
    row("h4", "e2"),
    row("h3", "e3"),
    row("h2", "e4"),
    row("h4", "e4", "suspended"),
  ];
  closeGivenUpTunnels(rows, guard, tunnels, () => {});
  release();
  await busy;
  assert.deepEqual(closed, ["e1", "e4"]);
});
