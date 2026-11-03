// The provider's bootstrap waits, driven through `create` (adopt mode) and `resume` in the
// SDK's fake host with a fake `ona`, a fake command channel and a fake tunnel manager.
// setTimeout and Date are mocked, so each tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { OnaCli, OnaEnvironment } from "../src/ona.ts";
import { registerOnaProvider } from "../src/provider.ts";
import type { TunnelManager } from "../src/ssh.ts";
import { tick, useFakeClock } from "./fake-clock.ts";

useFakeClock();

const box = (phase: string): OnaEnvironment => ({
  id: "env-1",
  metadata: { name: "box" },
  status: { phase: `ENVIRONMENT_PHASE_${phase}` },
});

/**
 * `phases`: what each Ona lookup returns in turn (null is a box Ona no longer has).
 * `rootExits`: the `~/.bb-machines` script's exit codes in turn. Both repeat their last entry.
 * `preflightExit`: the prerequisites check's exit code. Every other command exits 0.
 * `tunnel`: the box's tunnel is already open, in this state.
 */
type Setup = {
  found: OnaEnvironment;
  phases?: (string | null)[];
  rootExits?: number[];
  rootOutput?: string;
  preflightExit?: number;
  tunnel?: "up" | "connecting";
};

/** The next entry in turn, the last one repeated. */
const next = <T>(list: T[]) => (list.length > 1 ? list.shift() : list[0]);

/** The provider in a fake host. `calls` logs Ona lookups and the root script; `tunnels`, tunnel opens and closes. */
function register({ found, phases = [], rootExits = [], rootOutput = "", preflightExit = 0, tunnel }: Setup) {
  const calls: string[] = [];
  const tunnels: string[] = [];
  const open = new Map(tunnel ? [[found.id, tunnel]] : []);
  const ona = {
    findEnvironment: async () => found,
    getEnvironmentIfExists: async (_id: string, signal: AbortSignal) => {
      // As the real CLI call would: a loop that probes past an abort fails instead of spinning.
      signal.throwIfAborted();
      const phase = next(phases);
      calls.push(`get ${phase}`);
      return phase === null || phase === undefined ? null : box(phase);
    },
    start: async () => void calls.push("start"),
  } as unknown as OnaCli;
  const executor: MachineExecutor = {
    async exec({ command, onOutput }) {
      if (command[2]?.startsWith("missing=")) {
        onOutput("missing: node");
        return { exitCode: preflightExit };
      }
      if (command[3] !== "bb-ona-root") return { exitCode: 0 };
      calls.push("root");
      onOutput(rootOutput);
      return { exitCode: next(rootExits)! };
    },
  };
  const host = createFakePluginHost({
    pluginId: "ona",
    machineBootstrap: { bootstrap: async () => ({ hostId: "host-1" }) },
  });
  registerOnaProvider(host.bb, {
    availability: async () => ({ status: "available" }),
    ona,
    sshBinary: "ssh",
    tunnels: {
      status: (envId: string) => open.get(envId) ?? "off",
      ensure(envId: string) {
        tunnels.push(`ensure ${envId}`);
        if (!open.has(envId)) open.set(envId, "connecting");
      },
      stop(envId: string) {
        tunnels.push(`stop ${envId}`);
        open.delete(envId);
      },
    } as unknown as TunnelManager,
    defaultProject: "",
    inactivityTimeout: "",
    codexSqliteHome: "",
    // Listing exit codes turns the `~/.bb-machines` step on.
    machineDataDir: rootExits.length ? "/local/bb" : "",
    waitForSharedHome: false,
    port: () => 1,
    markConnected: async () => {},
    releasing: new Set(),
    forgetBox: async () => {},
    executorFor: () => executor,
  });
  return { provider: host.harness.registrations.machineProviders.get("ona")!, calls, tunnels };
}

const lifecycle = () => ({ report: { step() {}, log() {} }, checkpoint: async () => {} });

/** `create` in adopt mode, started. */
function start(setup: Setup) {
  const { provider, ...rest } = register(setup);
  const controller = new AbortController();
  const created = provider.create({
    ...lifecycle(),
    inputs: { mode: "adopt", environment: "box" },
    key: "key-1",
    attempt: 1,
    signal: controller.signal,
  });
  // Settled either way; the test awaits `created` itself.
  created.catch(() => {});
  return { created, controller, ...rest };
}

/** `resume` of the adopted machine, started. */
function resume(setup: Setup) {
  const { provider, ...rest } = register(setup);
  const resumed = provider.resume!({
    ...lifecycle(),
    hostId: "host-1",
    resource: { envId: "env-1", envName: "box", adopted: true, key: "key-1" },
    signal: new AbortController().signal,
  });
  return { resumed, ...rest };
}

test("~/.bb-machines retries on exit 6 (fails if a real folder on a not-yet-mounted home is final)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [6, 6, 0] });
  await tick(10_000, 2);
  assert.equal((await created).status, "created");
  assert.deepEqual(calls, ["root", "root", "root"]);
});

test("~/.bb-machines throws at once on any other failure (fails if exit 5 is retried)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [5], rootOutput: "points elsewhere" });
  await assert.rejects(created, /Could not set up ~\/\.bb-machines: points elsewhere/);
  assert.deepEqual(calls, ["root"]);
});

test("~/.bb-machines exit 6 past the deadline throws with the script output (fails if it reports success)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [6], rootOutput: "a real folder\n" });
  await tick(10_000, 12);
  await assert.rejects(created, /Could not set up ~\/\.bb-machines: a real folder$/);
  assert.equal(calls.length, 12, "one try every 10s for 2 minutes");
});

test("a STARTING box that settles to STOPPING waits for the stop, then starts (fails if it starts a stopping box)", async () => {
  const { created, calls } = start({ found: box("STARTING"), phases: ["STARTING", "STOPPING", "STOPPING", "STOPPED"] });
  await tick(5_000, 3);
  assert.equal((await created).status, "created");
  assert.deepEqual(calls, ["get STARTING", "get STOPPING", "get STOPPING", "get STOPPED", "start"]);
});

test("a box that disappears while starting throws (fails if a missing box counts as settled)", async () => {
  const { created, calls } = start({ found: box("STARTING"), phases: ["STARTING", null] });
  // Past the 15-minute start wait, so a loop that keeps polling fails rather than hangs.
  await tick(5_000, 180);
  await assert.rejects(created, /disappeared while starting/);
  assert.deepEqual(calls, ["get STARTING", "get null"]);
});

test(
  "an abort during a wait rejects without another probe (fails if the wait sleeps out its interval)",
  { timeout: 1_000 },
  async () => {
    const { created, calls, controller } = start({ found: box("STARTING"), phases: ["STARTING"] });
    await tick(1_000);
    controller.abort(new Error("cancelled"));
    await assert.rejects(created, /cancelled/);
    assert.deepEqual(calls, ["get STARTING"]);
  },
);

// Bug: connect() opens the tunnel before the tunnel wait, preflight and bootstrap, so a resume or
// create that failed after it left the tunnel open, keeping awake a box bb doesn't show active (decision 0003).
test("a resume that fails at preflight closes the tunnel it opened and rethrows (fails if the tunnel stays open)", async () => {
  const { resumed, tunnels } = resume({ found: box("RUNNING"), phases: ["RUNNING"], preflightExit: 3 });
  await assert.rejects(resumed, /^Error: Devbox is missing bb prerequisites: missing: node$/);
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

test("a create that fails at preflight closes the tunnel it opened and rethrows (fails if the tunnel stays open)", async () => {
  const { created, tunnels } = start({ found: box("RUNNING"), preflightExit: 3 });
  await assert.rejects(created, /^Error: Devbox is missing bb prerequisites: missing: node$/);
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

// Bug: a failed adopt left an already-open tunnel up; bb's cleanup remove() closes it later anyway, so nothing
// keeps it for another machine on the box.
test("a failed adopt on a box with a tunnel up closes it", async () => {
  const { created, tunnels } = start({ found: box("RUNNING"), preflightExit: 3, tunnel: "up" });
  await assert.rejects(created, /^Error: Devbox is missing bb prerequisites: missing: node$/);
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

// Bug: the close keyed on "this call opened the tunnel", so a resume re-run after a stuck one found it
// open and left it open on failure, keeping awake a box bb doesn't show active (decision 0003).
test("a resume that fails with the box's tunnel already open, connecting or up, closes it", async () => {
  for (const tunnel of ["connecting", "up"] as const) {
    const { resumed, tunnels } = resume({ found: box("RUNNING"), phases: ["RUNNING"], preflightExit: 3, tunnel });
    await assert.rejects(resumed, /^Error: Devbox is missing bb prerequisites: missing: node$/);
    assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"], tunnel);
  }
});

// Guards decision 0003's cleanup: after a failed adopt, bb's remove() is what closes the box's tunnel.
test("remove of an adopted machine on a running box closes its tunnel", async () => {
  const { provider, tunnels } = register({ found: box("RUNNING"), phases: ["RUNNING"], tunnel: "up" });
  const removed = await provider.remove({
    report: { step() {}, log() {} },
    hostId: "host-1",
    resource: { envId: "env-1", envName: "box", adopted: true, key: "key-1" },
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "removed");
  assert.deepEqual(tunnels, ["stop env-1"]);
});
