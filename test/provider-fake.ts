// A fake host for the provider: the SDK's fake plugin host with a fake `ona`, a fake command channel and a fake
// tunnel manager. Shared by the provider test files.
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { OnaCli, OnaEnvironment } from "../src/ona.ts";
import { registerOnaProvider } from "../src/provider.ts";
import type { TunnelManager } from "../src/ssh.ts";

export const box = (phase: string): OnaEnvironment => ({
  id: "env-1",
  metadata: { name: "box" },
  status: { phase: `ENVIRONMENT_PHASE_${phase}` },
});

export const adoptedResource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };

/**
 * `phases`: what each Ona lookup returns in turn, the last one repeated: a phase, a box, null (a box Ona no
 * longer has) or an Error (the lookup throws). Without phases, every `getEnvironmentIfExists` lookup returns
 * `found`; `findEnvironment` returns it only when the ref is its name.
 * `lookupFails`: every Ona lookup throws.
 * `unpushed`: the box has unpushed commits, so a remove is refused.
 * `reopenDuringMove`: a tunnel opens while an adopted remove's move-aside script runs.
 * `rootExits`: the `~/.bb-machines` script's exit codes in turn, the last one repeated.
 * `preflightExit`: the prerequisites check's exit code. Every other command exits 0.
 * `sshExits`, `mountExits`, `curlExits`: the SSH, shared-home and tunnel probes' exit codes in turn, the last one
 * repeated (default 0). A failed SSH probe prints "refused". Listing `mountExits` turns the shared-home wait on.
 * `codexHome`: the Codex home is set, so connect runs its `mkdir`.
 * `tunnel`: the box's tunnel is already open, in this state.
 */
export type Setup = {
  found: OnaEnvironment;
  phases?: (string | OnaEnvironment | Error | null)[];
  lookupFails?: boolean;
  unpushed?: boolean;
  reopenDuringMove?: boolean;
  rootExits?: number[];
  rootOutput?: string;
  preflightExit?: number;
  sshExits?: number[];
  mountExits?: number[];
  curlExits?: number[];
  codexHome?: boolean;
  tunnel?: "up" | "connecting";
};

/** Each command as the gated executor runs it: after a `get` that says RUNNING. */
export const gated = (...commands: string[]) => commands.flatMap((command) => ["get RUNNING", command]);
/** What a default connect logs once Ona says ready. */
export const connectCalls = gated("ssh", "curl", "preflight", "bootstrap");

/** The next entry in turn, the last one repeated. */
const next = <T>(list: T[]) => (list.length > 1 ? list.shift() : list[0]);

/**
 * The provider in a fake host. `calls` logs Ona lookups, starts, stops, deletes and every SSH command connect runs;
 * `tunnels`, tunnel opens and closes.
 */
export function register({
  found,
  phases = [],
  lookupFails,
  unpushed,
  reopenDuringMove,
  rootExits = [],
  rootOutput = "",
  preflightExit = 0,
  sshExits = [0],
  mountExits = [],
  curlExits = [],
  codexHome,
  tunnel,
}: Setup) {
  const calls: string[] = [];
  const tunnels: string[] = [];
  const open = new Map(tunnel ? [[found.id, tunnel]] : []);
  const forgotten: string[] = [];
  const releasing = new Set<string>();
  // As the tunnel manager does: an ensure on an open tunnel changes nothing.
  const ensure = (envId: string) => {
    tunnels.push(`ensure ${envId}`);
    if (!open.has(envId)) open.set(envId, "connecting");
  };
  const ona = {
    // By name, as cleanup finds a created box by its key-derived name; an adopted box keeps its own.
    findEnvironment: async (ref: string) => (ref !== found.metadata.name ? null : found),
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
    stop: async (envId: string) => void calls.push(`stop ${envId}`),
    delete: async (envId: string) => void calls.push(`delete ${envId}`),
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
      if (command[3] === "bb-ona-remove" && reopenDuringMove) ensure(found.id);
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
      bootstrap: async ({ executor: channel, signal }) => {
        await channel.exec({ command: ["sh", "-c", "bootstrap"], stdin: "", timeoutMs: 1, signal, onOutput() {} });
        return { hostId: "host-1" };
      },
    },
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
    codexSqliteHome: codexHome ? "/local/codex" : "",
    // Listing exit codes turns the `~/.bb-machines` step on.
    machineDataDir: rootExits.length ? "/local/bb" : "",
    waitForSharedHome: mountExits.length > 0,
    port: () => 1,
    markConnected: async () => {},
    releasing,
    forgetBox: async (envId: string) => void forgotten.push(envId),
    executorFor: () => executor,
  });
  const provider = host.harness.registrations.machineProviders.get("ona")!;
  return { provider, reconnect, calls, tunnels, open, forgotten, releasing };
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
