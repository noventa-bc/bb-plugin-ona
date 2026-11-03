// The provider's bootstrap waits, driven through `create` (adopt mode) in the SDK's fake
// host with a fake `ona` and a fake command channel. setTimeout and Date are mocked, so
// each tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { OnaCli, OnaEnvironment } from "../src/ona.ts";
import { registerOnaProvider, resourceSchema } from "../src/provider.ts";
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
 * `rootExits`: the `~/.bb-machines` script's exit codes in turn; every other command exits 0.
 * Both repeat their last entry.
 */
type Setup = { found: OnaEnvironment; phases?: (string | null)[]; rootExits?: number[]; rootOutput?: string };

/** The next entry in turn, the last one repeated. */
const next = <T>(list: T[]) => (list.length > 1 ? list.shift() : list[0]);

function start({ found, phases = [], rootExits = [], rootOutput = "" }: Setup) {
  const calls: string[] = [];
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
    tunnels: { ensure() {}, stop() {} } as unknown as TunnelManager,
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
  const controller = new AbortController();
  const created = host.harness.registrations.machineProviders.get("ona")!.create({
    inputs: { mode: "adopt", environment: "box" },
    key: "key-1",
    attempt: 1,
    report: { step() {}, log() {} },
    signal: controller.signal,
    checkpoint: async () => {},
  });
  // Settled either way; the test awaits `created` itself.
  created.catch(() => {});
  return { created, calls, controller };
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

// A legacy dataDir that is not absolute is read as absent, so the scripts never match it.
test("a relative legacy dataDir is dropped and a trailing slash is stripped", () => {
  const resource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data" }).dataDir, undefined);
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "/srv/bb/" }).dataDir, "/srv/bb");
});
