// A fake host for the provider: the SDK's fake plugin host with a fake `ona`, a fake command channel and a fake
// tunnel manager. Shared by the provider test files.
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { OnaCli, OnaEnvironment } from "../src/ona.ts";
import { registerOnaProvider, type OnaResource, type PluginMachineProviderProgress } from "../src/provider.ts";
import type { WakeVia } from "../src/provider-connect.ts";
import type { TunnelManager } from "../src/ssh.ts";
import { tick } from "./fake-clock.ts";

export const box = (phase: string): OnaEnvironment => ({
  id: "env-1",
  metadata: { name: "box" },
  status: { phase: `ENVIRONMENT_PHASE_${phase}` },
});

export const adoptedResource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };

/**
 * `phases`: what `getEnvironmentIfExists` returns for `found`'s id, in turn, the last one repeated: a phase, a box,
 * null (a box Ona no longer has) or an Error (the lookup throws). Without phases it returns `found`; any other id
 * gets null. `findEnvironment` finds `found` only by its name.
 * `lookupFails`: `findEnvironment` throws, and so does `getEnvironmentIfExists` for `found`'s id.
 * `unpushed`: the box has unpushed commits, so a remove is refused.
 * `uncommitted`: the box has uncommitted files and no unpushed commits, so a remove is refused.
 * `reopenDuringMove`: a tunnel opens while an adopted remove's move-aside script runs.
 * `moveAside`: the move-aside script exits with this code, or throws this error (default 0).
 * `rootExits`: the `~/.bb-machines` script's exit codes in turn, the last one repeated.
 * `preflightExit`: the prerequisites check's exit code. Every other command exits 0 unless an option here says
 * otherwise.
 * `sshExits`, `mountExits`, `curlExits`: the SSH, shared-home and tunnel probes' exit codes in turn, the last one
 * repeated (default 0). A failed SSH probe prints "refused". Listing `mountExits` turns the shared-home wait on.
 * `codexHome`: the Codex home is set, so connect runs its `mkdir`.
 * `tunnel`: the box's tunnel is already open, in this state.
 * `hangs`: this call never finishes on its own. Once its signal aborts, a start rejects with a plain Error whose
 * message is "The operation was aborted", as Node's `execFile` words a killed child, and whose cause is the signal's
 * reason; a bootstrap rejects with the signal's reason itself, as bb's bootstrap rethrows it.
 * `unlisted`: Ona lists `found` only once `createEnvironment` runs, as for a box a create makes.
 * `startTakes`: Ona's start takes this many milliseconds on the fake clock, so the test enables `useFakeClock`.
 * `deleteFails`: Ona's delete rejects, after the call is logged in `calls`.
 * `createFails`: Ona's createEnvironment rejects, after the call is logged in `calls`, and makes no box.
 */
export type Setup = {
  found: OnaEnvironment;
  phases?: (string | OnaEnvironment | Error | null)[];
  lookupFails?: boolean;
  unpushed?: boolean;
  uncommitted?: boolean;
  reopenDuringMove?: boolean;
  moveAside?: number | Error;
  rootExits?: number[];
  rootOutput?: string;
  preflightExit?: number;
  sshExits?: number[];
  mountExits?: number[];
  curlExits?: number[];
  codexHome?: boolean;
  tunnel?: "up" | "connecting";
  hangs?: "start" | "bootstrap";
  unlisted?: boolean;
  startTakes?: number;
  deleteFails?: boolean;
  createFails?: boolean;
};

/** Each command as the gated executor runs it: after a `get` that says RUNNING. */
export const gated = (...commands: string[]) => commands.flatMap((command) => ["get RUNNING", command]);
/** What a default connect logs once Ona says ready. */
export const connectCalls = gated("ssh", "curl", "preflight", "bootstrap");

/** Settles only when `signal` aborts, rejecting as `execFile` does. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error("The operation was aborted", { cause: signal.reason })), {
      once: true,
    }),
  );

/** The next entry in turn, the last one repeated. */
const next = <T>(list: T[]) => (list.length > 1 ? list.shift() : list[0]);

/**
 * The provider in a fake host. `calls` logs the `get` lookups by id that reach Ona, starts, stops, deletes, the
 * remove's move-aside and every SSH command connect runs; `tunnels`, the ensure and stop calls; `logs`, the host's log;
 * `moves`, each move-aside's box, positional args, and whether the box's keys were still kept when it ran; `connected`,
 * the boxes markConnected ran for; `mark`, `ensure` and `stop`, the tunnel manager's, as another flow opens or bb's
 * suspend or remove closes a box.
 */
export function register({
  found,
  phases = [],
  lookupFails,
  unpushed,
  uncommitted,
  reopenDuringMove,
  moveAside = 0,
  rootExits = [],
  rootOutput = "",
  preflightExit = 0,
  sshExits = [0],
  mountExits = [],
  curlExits = [],
  codexHome,
  tunnel,
  hangs,
  unlisted,
  startTakes,
  deleteFails,
  createFails,
}: Setup) {
  const calls: string[] = [];
  const tunnels: string[] = [];
  const open = new Map(tunnel ? [[found.id, tunnel]] : []);
  const forgotten: string[] = [];
  const releasing = new Set<string>();
  const moves: { envId: string; args: string[]; keysKept: boolean }[] = [];
  // The box the latest executor was made for: the provider makes one right before each exec.
  let target = "";
  let listed = !unlisted;
  const connected: string[] = [];
  // As the tunnel manager does: an ensure on an open tunnel changes nothing, and one whose mark is older than the box's
  // last stop opens nothing.
  let stops = 0;
  const stoppedAt = new Map<string, number>();
  const mark = () => stops;
  const ensure = (envId: string, since: number) => {
    tunnels.push(`ensure ${envId}`);
    if ((stoppedAt.get(envId) ?? 0) > since) return false;
    if (!open.has(envId)) open.set(envId, "connecting");
    return true;
  };
  const stop = (envId: string) => {
    tunnels.push(`stop ${envId}`);
    stoppedAt.set(envId, ++stops);
    open.delete(envId);
  };
  const ona = {
    // By name, as cleanup finds a created box by its key-derived name; an adopted box keeps its own.
    findEnvironment: async (ref: string) => {
      if (lookupFails) throw new Error("Ona is unreachable");
      return ref !== found.metadata.name || !listed ? null : found;
    },
    resolveProjectId: async () => "project-1",
    createEnvironment: async () => {
      calls.push("create");
      if (createFails) throw new Error("Ona refused the create");
      listed = true;
    },
    getEnvironmentIfExists: async (id: string, signal: AbortSignal) => {
      if (id !== found.id) return null;
      // As the real CLI call would: a loop that probes past an abort fails instead of spinning.
      signal.throwIfAborted();
      if (lookupFails) {
        calls.push("get failed");
        throw new Error("Ona is unreachable");
      }
      if (unpushed || uncommitted) {
        const git = {
          totalUnpushedCommits: unpushed ? 2 : 0,
          totalChangedFiles: uncommitted ? 1 : 0,
          branch: "feat",
        };
        calls.push("get RUNNING");
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
    start: async (_envId: string, signal: AbortSignal) => {
      calls.push("start");
      if (startTakes) await tick(startTakes);
      if (hangs === "start") await untilAborted(signal);
    },
    stop: async (envId: string) => void calls.push(`stop ${envId}`),
    delete: async (envId: string) => {
      calls.push(`delete ${envId}`);
      if (deleteFails) throw new Error("Ona delete failed");
    },
  } as unknown as OnaCli;
  const executor: MachineExecutor = {
    async exec({ command, onOutput }) {
      const probes: [string, string, number[]][] = [
        ["true", "ssh", sshExits],
        ["mountpoint", "mount", mountExits],
        ["mkdir", "mkdir", []],
        ["curl", "curl", curlExits],
        ["bootstrap", "bootstrap", []],
      ];
      const probe = probes.find(([script]) => command[2]?.startsWith(script));
      if (probe) {
        calls.push(probe[1]);
        const exitCode = next(probe[2]) ?? 0;
        // As the real probes: only the SSH probe prints why; `mountpoint -q` and `curl -sf` fail silently.
        if (exitCode !== 0 && probe[1] === "ssh") onOutput("refused");
        return { exitCode };
      }
      if (command[2]?.startsWith("missing=")) {
        calls.push("preflight");
        onOutput("missing: node");
        return { exitCode: preflightExit };
      }
      // The remove's move-aside script: a sync pass can open the tunnel while it runs.
      if (command[3] === "bb-ona-remove") {
        calls.push("move-aside");
        moves.push({ envId: target, args: command.slice(4), keysKept: forgotten.length === 0 });
        if (reopenDuringMove) ensure(found.id, mark());
        if (moveAside instanceof Error) throw moveAside;
        return { exitCode: moveAside };
      }
      if (command[3] !== "bb-ona-root") return { exitCode: 0 };
      calls.push("root");
      onOutput(rootOutput);
      return { exitCode: next(rootExits)! };
    },
  };
  const host = createFakePluginHost({
    pluginId: "ona",
    // As bb's bootstrap does: one command through the provider's executor.
    machineBootstrap: {
      bootstrap: async ({ executor: channel, signal, report }) => {
        await channel.exec({ command: ["sh", "-c", "bootstrap"], stdin: "", timeoutMs: 1, signal, onOutput() {} });
        // bb 0.49.0 reports this step for an enrolled machine, then waits for the installer and the connection.
        report.step("Starting enrolled machine");
        if (hangs === "bootstrap") await untilAborted(signal).catch(() => signal.throwIfAborted());
        return { hostId: "host-1" };
      },
    },
  });
  const { reconnect: reconnectWithMark, wake: wakeWithCause } = registerOnaProvider(host.bb, {
    availability: async () => ({ status: "available" }),
    ona,
    sshBinary: "ssh",
    tunnels: {
      status: (envId: string) => open.get(envId) ?? "off",
      mark,
      ensure,
      stop,
    } as unknown as TunnelManager,
    defaultProject: "",
    inactivityTimeout: "",
    codexSqliteHome: codexHome ? "/local/codex" : "",
    // Listing exit codes turns the `~/.bb-machines` step on.
    machineDataDir: rootExits.length ? "/local/bb" : "",
    waitForSharedHome: mountExits.length > 0,
    port: () => 1,
    markConnected: async (envId: string) => void connected.push(envId),
    releasing,
    forgetBox: async (envId: string) => void forgotten.push(envId),
    executorFor: (_ssh, envId) => {
      target = envId;
      return executor;
    },
  });
  // Most tests read neither a start's cause nor a mark: a waiting thread's cause and a mark taken at registration are
  // the defaults here.
  const wake = (
    resource: OnaResource,
    progress: PluginMachineProviderProgress,
    outer: AbortSignal,
    cause: WakeVia = "wake-thread",
    since = 0,
  ) => wakeWithCause(resource, progress, outer, cause, since);
  const reconnect = (resource: OnaResource, report: PluginMachineProviderProgress, signal: AbortSignal, since = 0) =>
    reconnectWithMark(resource, report, signal, since);
  const provider = host.harness.registrations.machineProviders.get("ona")!;
  return {
    provider,
    reconnect,
    wake,
    calls,
    tunnels,
    open,
    connected,
    mark,
    ensure,
    stop,
    forgotten,
    releasing,
    moves,
    logs: host.harness.logEntries,
  };
}

/** `steps` collects the progress lines the user sees. */
export const lifecycle = (steps: string[] = []) => ({
  report: { step: (text: string) => void steps.push(text), log() {} },
  checkpoint: async () => {},
});

/** `create` in adopt mode, started. */
export function start(setup: Setup) {
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
export function resume(setup: Setup) {
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

/** A RUNNING box whose dev container is in `phase`; null is a box without a dev container. */
export const running = (phase: string | null): OnaEnvironment => ({
  ...box("RUNNING"),
  status: { phase: "ENVIRONMENT_PHASE_RUNNING", devcontainer: phase === null ? null : { phase } },
});
