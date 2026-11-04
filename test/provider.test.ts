// The provider's bootstrap waits, driven through `create` (adopt mode) and `resume` in the
// SDK's fake host with a fake `ona`, a fake command channel and a fake tunnel manager.
// setTimeout and Date are mocked, so each tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
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

const adoptedResource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };

/**
 * `phases`: what each Ona lookup returns in turn: a phase, a box, null (a box Ona no longer has) or an Error
 * (the lookup throws). Without phases, every lookup returns `found`.
 * `lookupFails`: every Ona lookup throws.
 * `unpushed`: the box has unpushed commits, so a remove is refused.
 * `reopenDuringMove`: a tunnel opens while an adopted remove's move-aside script runs.
 * `rootExits`: the `~/.bb-machines` script's exit codes in turn. Both repeat their last entry.
 * `preflightExit`: the prerequisites check's exit code. Every other command exits 0.
 * `sshExits`: the SSH probe's exit codes in turn, the last one repeated (default 0).
 * `tunnel`: the box's tunnel is already open, in this state.
 */
type Setup = {
  found: OnaEnvironment;
  phases?: (string | OnaEnvironment | Error | null)[];
  lookupFails?: boolean;
  unpushed?: boolean;
  reopenDuringMove?: boolean;
  rootExits?: number[];
  rootOutput?: string;
  preflightExit?: number;
  sshExits?: number[];
  tunnel?: "up" | "connecting";
};

/** The next entry in turn, the last one repeated. */
const next = <T>(list: T[]) => (list.length > 1 ? list.shift() : list[0]);

/** The provider in a fake host. `calls` logs Ona lookups, starts, SSH probes and the root script; `tunnels`, tunnel opens and closes. */
function register({
  found,
  phases = [],
  lookupFails,
  unpushed,
  reopenDuringMove,
  rootExits = [],
  rootOutput = "",
  preflightExit = 0,
  sshExits = [0],
  tunnel,
}: Setup) {
  const calls: string[] = [];
  const tunnels: string[] = [];
  const open = new Map(tunnel ? [[found.id, tunnel]] : []);
  const forgotten: string[] = [];
  // As the tunnel manager does: an ensure on an open tunnel changes nothing.
  const ensure = (envId: string) => {
    tunnels.push(`ensure ${envId}`);
    if (!open.has(envId)) open.set(envId, "connecting");
  };
  const ona = {
    findEnvironment: async () => found,
    getEnvironmentIfExists: async (_id: string, signal: AbortSignal) => {
      // As the real CLI call would: a loop that probes past an abort fails instead of spinning.
      signal.throwIfAborted();
      if (lookupFails) throw new Error("Ona is unreachable");
      if (unpushed) {
        const git = { totalUnpushedCommits: 2, branch: "feat" };
        return { ...box("RUNNING"), status: { phase: "ENVIRONMENT_PHASE_RUNNING", content: { git } } };
      }
      const answer = phases.length ? next(phases)! : found;
      if (answer instanceof Error) {
        calls.push("get failed");
        throw answer;
      }
      const env = typeof answer === "string" ? box(answer) : answer;
      calls.push(`get ${env?.status?.phase?.replace("ENVIRONMENT_PHASE_", "") ?? null}`);
      return env;
    },
    start: async () => void calls.push("start"),
  } as unknown as OnaCli;
  const executor: MachineExecutor = {
    async exec({ command, onOutput }) {
      if (command[2] === "true") {
        calls.push("ssh");
        return { exitCode: next(sshExits)! };
      }
      if (command[2]?.startsWith("missing=")) {
        onOutput("missing: node");
        return { exitCode: preflightExit };
      }
      // The remove's move-aside script: a sync pass can open the tunnel while it runs.
      if (command[3] === "bb-ona-remove" && reopenDuringMove) ensure(found.id);
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
  const { reconnect } = registerOnaProvider(host.bb, {
    availability: async () => ({ status: "available" }),
    ona,
    sshBinary: "ssh",
    tunnels: {
      status: (envId: string) => open.get(envId) ?? "off",
      ensure,
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
    forgetBox: async (envId: string) => void forgotten.push(envId),
    executorFor: () => executor,
  });
  const provider = host.harness.registrations.machineProviders.get("ona")!;
  return { provider, reconnect, calls, tunnels, open, forgotten };
}

/** `steps` collects the progress lines the user sees. */
const lifecycle = (steps: string[] = []) => ({
  report: { step: (text: string) => void steps.push(text), log() {} },
  checkpoint: async () => {},
});

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
  const steps: string[] = [];
  const resumed = provider.resume!({
    ...lifecycle(steps),
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  // Settled either way; the test awaits `resumed` itself.
  resumed.catch(() => {});
  return { resumed, steps, ...rest };
}

test("~/.bb-machines retries on exit 6 (fails if a real folder on a not-yet-mounted home is final)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [6, 6, 0] });
  await tick(10_000, 2);
  assert.equal((await created).status, "created");
  assert.deepEqual(calls, ["get RUNNING", "ssh", "root", "root", "root"]);
});

test("~/.bb-machines throws at once on any other failure (fails if exit 5 is retried)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [5], rootOutput: "points elsewhere" });
  await assert.rejects(created, /Could not set up ~\/\.bb-machines: points elsewhere/);
  assert.deepEqual(calls, ["get RUNNING", "ssh", "root"]);
});

test("~/.bb-machines exit 6 past the deadline throws with the script output (fails if it reports success)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [6], rootOutput: "a real folder\n" });
  await tick(10_000, 12);
  await assert.rejects(created, /Could not set up ~\/\.bb-machines: a real folder$/);
  assert.equal(calls.filter((call) => call === "root").length, 12, "one try every 10s for 2 minutes");
});

test("a STARTING box that settles to STOPPING waits for the stop, then starts (fails if it starts a stopping box)", async () => {
  const { created, calls, tunnels } = start({
    found: box("STARTING"),
    phases: ["STARTING", "STOPPING", "STOPPING", "STOPPED", "RUNNING"],
  });
  await tick(5_000, 3);
  assert.equal((await created).status, "created");
  assert.deepEqual(calls, [
    "get STARTING",
    "get STOPPING",
    "get STOPPING",
    "get STOPPED",
    "start",
    "get RUNNING",
    "ssh",
  ]);
  assert.deepEqual(tunnels, ["ensure env-1"]);
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

/** A RUNNING box whose dev container is in `phase`; null is a box without a dev container. */
const running = (phase: string | null): OnaEnvironment => ({
  ...box("RUNNING"),
  status: { phase: "ENVIRONMENT_PHASE_RUNNING", devcontainer: phase === null ? null : { phase } },
});

// Bug: connect probed SSH every 5s as soon as Ona accepted the start, before Ona said the box and its
// dev container were up, and the user saw only "Waiting for the dev container to accept SSH".
test("a resume waits for Ona to report the box and its dev container running before any SSH", async () => {
  const { resumed, calls, steps } = resume({
    found: box("STOPPED"),
    phases: ["STOPPED", "STARTING", running("PHASE_CREATING"), running("PHASE_RUNNING")],
  });
  await tick(5_000, 2);
  await resumed;
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get RUNNING", "get RUNNING", "ssh"]);
  assert.deepEqual(steps.slice(1, 3), ["Waiting for Ona: starting", "Waiting for Ona: dev container starting"]);
});

// Bug: a box Ona reported failed was probed over SSH for 10 minutes, then failed without Ona's reason.
test("a resume fails at once with Ona's failure message, no SSH, and closes the tunnel", async () => {
  // A start that failed: Ona sets the message and the box is stopped again.
  const failing = {
    ...box("STOPPED"),
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] },
  };
  const { resumed, calls, tunnels } = resume({ found: box("STOPPED"), phases: ["STOPPED", "STARTING", failing] });
  // Past every deadline, so a wait that ignores the failure rejects with the wrong message instead of hanging.
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona environment box failed to start: no capacity$/);
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get STOPPED"]);
  assert.deepEqual(tunnels, ["stop env-1"]);
});

// Bug: a box stopped in Ona during the wait was probed over SSH, and Ona's SSH starts a stopped box (rule 1).
test("a resume fails without SSH when Ona reports the box stopped during the wait", async () => {
  const stopped = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_STOPPED" } };
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", "STARTING", stopped] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona environment box failed to start: stopped$/);
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get STOPPED"]);
});

// Ona can still show a box STOPPED right after `ona environment start` returns; older Ona sends no desired phase,
// and a failure message may be left from an earlier start.
test("a resume waits on a box Ona still shows stopped right after the start, then connects", async () => {
  const stopped = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const cases: [string, OnaEnvironment][] = [
    ["desired phase RUNNING", stopped],
    ["no desired phase", box("STOPPED")],
    ["an old failure", { ...stopped, status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] } }],
  ];
  for (const [name, waking] of cases) {
    const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", waking, "RUNNING"] });
    await tick(5_000, 1);
    await resumed;
    assert.deepEqual(calls, ["get STOPPED", "start", "get STOPPED", "get RUNNING", "ssh"], name);
  }
});

test("a resume that times out on a failing start names Ona's failure", async () => {
  const failing = {
    ...box("STOPPED"),
    spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" },
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] },
  };
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", failing] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona did not report box ready within 15 minutes: no capacity$/);
  assert.equal(calls.includes("ssh"), false);
});

// The stored name goes stale after `bb ona rename`.
test("a failed resume names the box by its current name in Ona", async () => {
  const renamed = { ...box("STOPPED"), metadata: { name: "renamed" } };
  const failing = { ...renamed, status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] } };
  const { resumed } = resume({ found: renamed, phases: [renamed, failing] });
  // Past every deadline, so a wait that ignores the failure rejects instead of hanging.
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona environment renamed failed to start: no capacity$/);
});

// Bug: a failed Ona lookup must mean unknown (decision 0005): no SSH until Ona answers RUNNING.
test("a resume makes no SSH while Ona can't be asked, then connects once it says RUNNING", async () => {
  const unreachable = new Error("Ona is unreachable");
  const { resumed, calls } = resume({
    found: box("STOPPED"),
    phases: ["STOPPED", unreachable, unreachable, "RUNNING"],
  });
  await tick(5_000, 2);
  await resumed;
  assert.deepEqual(calls, ["get STOPPED", "start", "get failed", "get failed", "get RUNNING", "ssh"]);
});

// The rest of Ona's stderr is more than the progress line needs (rule 7).
test("a failed lookup shows only the first line of Ona's error as progress", async () => {
  const unreachable = new Error("\n ona environment get failed: dial tcp: timeout \nsecond line\nthird line");
  const { resumed, steps } = resume({ found: box("STOPPED"), phases: ["STOPPED", unreachable, "RUNNING"] });
  await tick(5_000, 1);
  await resumed;
  assert.equal(steps[1], "Waiting for Ona: ona environment get failed: dial tcp: timeout");
});

// A ZodError's first line is "[".
test("an answer from Ona that can't be read shows a plain progress line", async () => {
  const unreadable = z.object({ id: z.string() }).safeParse({}).error!;
  const { resumed, steps } = resume({ found: box("STOPPED"), phases: ["STOPPED", unreadable, "RUNNING"] });
  await tick(5_000, 1);
  await resumed;
  assert.equal(steps[1], "Waiting for Ona: Ona's answer could not be read");
});

test("a resume while Ona can't be asked fails after 15 minutes without SSH", async () => {
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", new Error("Ona is unreachable")] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona did not report box ready within 15 minutes: Ona is unreachable$/);
  assert.equal(calls.includes("ssh"), false);
});

test("a box without a dev container connects once Ona says RUNNING", async () => {
  const { resumed, calls } = resume({ found: running(null), phases: [running(null)] });
  await resumed;
  assert.deepEqual(calls, ["get RUNNING", "get RUNNING", "ssh"]);
});

// Bug: the SSH wait retried for 10 minutes without asking Ona, so a box stopped meanwhile was woken (rule 1).
test("an SSH retry asks Ona first, and a box stopped since gets no second probe", async () => {
  const stopped = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const { resumed, calls } = resume({
    found: box("RUNNING"),
    phases: ["RUNNING", "RUNNING", stopped],
    sshExits: [255, 0],
  });
  await tick(5_000, 2);
  await assert.rejects(resumed, /^Error: Ona environment box is no longer ready: stopped$/);
  assert.deepEqual(calls, ["get RUNNING", "get RUNNING", "ssh", "get STOPPED"]);
});

// A box Ona's inactivity timeout stopped keeps desired phase RUNNING.
test("a reconnect to a box Ona idled out fails at once without SSH", async () => {
  const idled = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const { reconnect, calls } = register({ found: idled, phases: [idled] });
  const reconnected = reconnect(adoptedResource, lifecycle().report, new AbortController().signal);
  reconnected.catch(() => {});
  // Past every deadline, so a wait that treats the box as starting rejects with the wrong message instead of hanging.
  await tick(5_000, 180);
  await assert.rejects(reconnected, /^Error: Ona environment box failed to start: stopped$/);
  assert.deepEqual(calls, ["get STOPPED"]);
});

test("a resume of a box that idles out after the running check fails at once without SSH", async () => {
  const idled = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const { resumed, calls } = resume({ found: box("RUNNING"), phases: ["RUNNING", idled] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona environment box failed to start: stopped$/);
  assert.deepEqual(calls, ["get RUNNING", "get STOPPED"]);
});

// A heal's own 15-minute timeout can end the wait before the wait's deadline.
test("an aborted wait names the last reason it was waiting for", async () => {
  const { reconnect } = register({ found: box("RUNNING"), phases: [running("PHASE_CREATING")] });
  const controller = new AbortController();
  const reconnected = reconnect(adoptedResource, lifecycle().report, controller.signal);
  reconnected.catch(() => {});
  await tick(5_000, 2);
  controller.abort(new Error("The operation was aborted due to timeout"));
  await assert.rejects(
    reconnected,
    /^Error: Ona did not report box ready before the wait ended: dev container starting$/,
  );
});

test("a reconnect on a running box asks Ona exactly once before SSH", async () => {
  const { reconnect, calls } = register({ found: box("RUNNING") });
  await reconnect(adoptedResource, lifecycle().report, new AbortController().signal);
  assert.deepEqual(calls, ["get RUNNING", "ssh"]);
});

// The daemon heal in src/sync.ts calls this reconnect: test/sync.test.ts covers what the pass does when it rejects.
test("a reconnect waits for the dev container before SSH, and fails without SSH on a failed one", async () => {
  const waits = register({ found: box("RUNNING"), phases: [running("PHASE_CREATING"), running("PHASE_RUNNING")] });
  const reconnected = waits.reconnect(adoptedResource, lifecycle().report, new AbortController().signal);
  await tick(5_000, 1);
  await reconnected;
  assert.deepEqual(waits.calls, ["get RUNNING", "get RUNNING", "ssh"]);
  const fails = register({ found: box("RUNNING"), phases: [running("PHASE_FAILED")] });
  await assert.rejects(
    fails.reconnect(adoptedResource, lifecycle().report, new AbortController().signal),
    /^Error: Ona environment box failed to start: dev container failed$/,
  );
  assert.deepEqual(fails.calls, ["get RUNNING"]);
});

// The lookup-throws test below guards the order: the tunnel closes after the move-aside, and on a failed lookup.
test("remove of an adopted machine closes its tunnel", async () => {
  const { provider, tunnels } = register({ found: box("RUNNING"), phases: ["RUNNING"], tunnel: "up" });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "removed");
  assert.deepEqual(tunnels, ["stop env-1"]);
});

test("remove of an adopted machine whose Ona lookup throws still closes its tunnel", async () => {
  const { provider, tunnels, forgotten } = register({ found: box("RUNNING"), lookupFails: true, tunnel: "up" });
  await assert.rejects(
    provider.remove({
      report: lifecycle().report,
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    }),
    /Ona is unreachable/,
  );
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, [], "the keys stay for bb's retry");
});

test("remove of a bb-created machine whose Ona lookup throws still closes its tunnel", async () => {
  const { provider, tunnels, forgotten } = register({ found: box("RUNNING"), lookupFails: true, tunnel: "up" });
  await assert.rejects(
    provider.remove({
      report: lifecycle().report,
      hostId: "host-1",
      resource: { envId: "env-1", envName: "box", adopted: false, key: "key-1" },
      signal: new AbortController().signal,
    }),
    /Ona is unreachable/,
  );
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, [], "the keys stay for bb's retry");
});

test("remove of an adopted machine closes a tunnel that reopened during the move-aside", async () => {
  const { provider, open, tunnels } = register({
    found: box("RUNNING"),
    phases: ["RUNNING"],
    tunnel: "up",
    reopenDuringMove: true,
  });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.equal(open.get("env-1") ?? "off", "off");
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
  assert.equal(removed.status, "removed");
});

test("a refused remove of a bb-created machine closes its tunnel and keeps its keys", async () => {
  const { provider, tunnels, forgotten } = register({ found: box("RUNNING"), unpushed: true, tunnel: "up" });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: { envId: "env-1", envName: "box", adopted: false, key: "key-1" },
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "failed");
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, []);
});

// A relative legacy dataDir is kept: the scripts resolve it against $HOME on the box.
test("a relative legacy dataDir is kept and a trailing slash is stripped", () => {
  const resource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data" }).dataDir, "data");
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data/" }).dataDir, "data");
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "/srv/bb/" }).dataDir, "/srv/bb");
});
