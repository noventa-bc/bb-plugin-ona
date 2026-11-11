// A sync pass against bb suspending or removing the machine it acts on: the tunnel a close ended stays closed. The
// passes run on the real tunnel manager, whose gate always says no, so no ssh ever runs.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { TunnelManager } from "../src/ssh.ts";
import type { SyncDeps } from "../src/sync.ts";
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
