// The "ona" machine provider: each bb machine is one Ona environment, either
// created for bb or adopted from an existing one.
import type { BbPluginApi, MachineBootstrapRequest, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { friendlyName } from "./names.ts";
import { isDeleted, isRunning, isStarting, isStopped, unpushedWork, type OnaCli, type OnaEnvironment } from "./ona.ts";
import { DAEMON_PROBE } from "./reconcile.ts";
import type { PluginMachineProviderAvailability } from "./setup.ts";
import { daemonEnv, shellQuote, sshCapture, sshExecutor, type TunnelManager } from "./ssh.ts";

type PluginMachineProviderProgress = MachineBootstrapRequest["report"];

export const PROVIDER_ID = "ona";

/** Ona can be slow to wake a dev container; give each SSH check this long. */
const CHECK_TIMEOUT_MS = 5 * 60_000;

export const resourceSchema = z.object({
  envId: z.string(),
  envName: z.string(),
  adopted: z.boolean(),
  /** Creation key, reused for bootstrap recovery on resume. Not a secret. */
  key: z.string(),
  /** Legacy BB_DATA_DIR from 0.1.0 enrollments; new machines use ~/.bb-machines. */
  dataDir: z.string().optional(),
});
export type OnaResource = z.infer<typeof resourceSchema>;

/** Ona names/ids passed to the ona CLI: never option-like, no shell metacharacters. */
export const onaRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, "use letters, digits, '.', '_' or '-'");

// Inputs are persisted and readable by every plugin: references only, no secrets.
const inputsSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    mode: z.enum(["create", "adopt"]).default("create"),
    /** create: Ona project name or id. Falls back to the defaultProject setting. */
    project: onaRef.optional(),
    /** create: Ona environment class id (`ona environment list-classes`). */
    classId: onaRef.optional(),
    /** adopt: existing Ona environment name, id, or id prefix. */
    environment: onaRef.optional(),
  }),
);

export interface ProviderDeps {
  /** Prerequisite check backing the provider's availability in bb's Machines settings. */
  availability(): Promise<PluginMachineProviderAvailability>;
  ona: OnaCli;
  sshBinary: string;
  tunnels: TunnelManager;
  defaultProject: string;
  /** Applied only to environments this provider creates; adopted ones keep their own. */
  inactivityTimeout: string;
  /** Local-disk Codex SQLite home on the devbox; empty leaves Codex's default. */
  codexSqliteHome: string;
  /**
   * Local-disk folder that ~/.bb-machines points to on every devbox. bb only
   * restarts daemons whose data dir sits directly in (realpath of)
   * ~/.bb-machines, so a symlink keeps bb's layout while each devbox's data
   * stays on its own disk even when the home is shared over NFS. Empty
   * leaves ~/.bb-machines alone.
   */
  machineDataDir: string;
  /** Hold off starting anything until $HOME is a mount point (shared NFS home). */
  waitForSharedHome: boolean;
  port: () => number;
  rememberTunnel(envId: string): Promise<void>;
  forgetTunnel(envId: string): Promise<void>;
  /** Record that the box just (re)connected; the idle window starts here. */
  markConnected(envId: string): Promise<void>;
  /**
   * Boxes the plugin is letting go while idle: their next suspend (consumed
   * once) only closes the tunnel, and Ona's own inactivity timeout stops the box.
   */
  releasing: Set<string>;
  /** Drop the plugin's stored keys for a box whose machine is removed. */
  forgetBox(envId: string): Promise<void>;
}

/** Deterministic Ona name for a creation key, so retries find the same environment. */
export function envNameForKey(key: string): string {
  return friendlyName(key);
}

export function registerOnaProvider(bb: BbPluginApi, deps: ProviderDeps) {
  const reconnect = (resource: OnaResource, report: PluginMachineProviderProgress, signal: AbortSignal) =>
    connect(resource, resource.key, report, signal);

  const { ona, tunnels } = deps;

  async function requireEnv(ref: string, signal: AbortSignal): Promise<OnaEnvironment> {
    const env = await ona.findEnvironment(ref, signal);
    if (!env) throw new Error(`Ona environment "${ref}" not found. Run \`ona environment list\`.`);
    return env;
  }

  async function ensureRunning(env: OnaEnvironment, report: PluginMachineProviderProgress, signal: AbortSignal) {
    if (isRunning(env)) return;
    // Someone (Ona UI, CLI) is already starting it: wait instead of starting it again.
    if (isStarting(env)) {
      report.step(`Waiting for Ona to finish starting ${env.metadata.name ?? env.id}`);
      const deadline = Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        signal.throwIfAborted();
        const current = await ona.getEnvironmentIfExists(env.id, signal);
        if (!current) throw new Error(`Ona environment ${env.metadata.name ?? env.id} disappeared while starting.`);
        if (isRunning(current)) return;
        if (!isStarting(current)) {
          env = current;
          break;
        }
      }
    }
    // Ona refuses to start an environment that is still stopping; let it finish first.
    if (env.status?.phase === "ENVIRONMENT_PHASE_STOPPING") {
      report.step(`Waiting for Ona to finish stopping ${env.metadata.name ?? env.id}`);
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        signal.throwIfAborted();
        const current = await ona.getEnvironmentIfExists(env.id, signal);
        if (!current || current.status?.phase !== "ENVIRONMENT_PHASE_STOPPING") break;
      }
    }
    report.step(`Starting Ona environment ${env.metadata.name ?? env.id}`);
    await ona.start(env.id, signal);
  }

  async function waitForSsh(executor: MachineExecutor, report: PluginMachineProviderProgress, signal: AbortSignal) {
    report.step("Waiting for the dev container to accept SSH");
    const deadline = Date.now() + 10 * 60_000;
    let last = "";
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        const probe = await sshCapture(executor, "true", signal, CHECK_TIMEOUT_MS);
        if (probe.exitCode === 0) return;
        last = probe.output.trim().split("\n").slice(-1)[0] ?? "";
      } catch (error) {
        if (signal.aborted) throw error;
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Could not SSH into the devbox within 10 minutes: ${last}`);
  }

  /**
   * Right after Ona starts a devbox, SSH can work before the shared NFS home is
   * mounted. Anything started then (the bb daemon, Codex) writes to the
   * container's own home, which the mount later hides: Codex loses the thread's
   * rollout and can't resume it. Wait for $HOME to become a mount point.
   */
  async function waitForSharedHome(
    executor: MachineExecutor,
    report: PluginMachineProviderProgress,
    signal: AbortSignal,
  ) {
    const probe = () =>
      sshCapture(executor, 'mountpoint -q "$HOME"', signal, CHECK_TIMEOUT_MS)
        .then((result) => result.exitCode === 0)
        .catch((error) => {
          if (signal.aborted) throw error;
          return false;
        });
    if (await probe()) return;
    report.step("Waiting for the shared home folder to be mounted");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      signal.throwIfAborted();
      if (await probe()) return;
    }
    throw new Error(
      "The devbox's home folder was not mounted within 5 minutes. If your Ona environments don't share a home folder, turn off the plugin's waitForSharedHome setting.",
    );
  }

  async function waitForTunnel(executor: MachineExecutor, report: PluginMachineProviderProgress, signal: AbortSignal) {
    report.step("Opening SSH reverse tunnel to bb server");
    const url = `http://127.0.0.1:${deps.port()}/health`;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const probe = await sshCapture(
        executor,
        `curl -sf -o /dev/null --max-time 5 ${shellQuote(url)}`,
        signal,
        CHECK_TIMEOUT_MS,
      ).catch((error) => {
        if (signal.aborted) throw error;
        return { exitCode: 1, output: "" };
      });
      if (probe.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error(
      "The devbox could not reach the bb server through the SSH tunnel within 10 minutes. Check `bb plugin logs ona`.",
    );
  }

  async function preflight(executor: MachineExecutor, report: PluginMachineProviderProgress, signal: AbortSignal) {
    report.step("Checking devbox prerequisites (node, npm, curl)");
    const { exitCode, output } = await sshCapture(
      executor,
      [
        "missing=''",
        'for c in node npm curl git; do command -v $c >/dev/null || missing="$missing $c"; done',
        '[ -z "$missing" ] || { echo "missing:$missing"; exit 3; }',
        'node -e \'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:4)\' || { echo "node $(node -v) is older than 22.19"; exit 4; }',
      ].join("\n"),
      signal,
      CHECK_TIMEOUT_MS,
    );
    if (exitCode !== 0) {
      throw new Error(`Devbox is missing bb prerequisites: ${output.trim().slice(-300)}`);
    }
  }

  async function connect(
    resource: OnaResource,
    key: string,
    report: PluginMachineProviderProgress,
    signal: AbortSignal,
  ) {
    const executor = sshExecutor(deps.sshBinary, resource.envId, daemonEnv(deps.codexSqliteHome));
    await waitForSsh(executor, report, signal);
    if (deps.waitForSharedHome) await waitForSharedHome(executor, report, signal);
    if (deps.codexSqliteHome) {
      await sshCapture(executor, `mkdir -p ${shellQuote(deps.codexSqliteHome)}`, signal, CHECK_TIMEOUT_MS);
    }
    if (deps.machineDataDir) await ensureLocalMachineRoot(executor, deps.machineDataDir, report, signal);
    tunnels.ensure(resource.envId);
    await deps.rememberTunnel(resource.envId);
    await deps.markConnected(resource.envId);
    await waitForTunnel(executor, report, signal);
    await preflight(executor, report, signal);
    report.step("Installing and enrolling the bb daemon");
    return bb.experimental_machines.bootstrap({ key, executor, report, signal });
  }

  async function ensureLocalMachineRoot(
    executor: MachineExecutor,
    target: string,
    report: PluginMachineProviderProgress,
    signal: AbortSignal,
  ) {
    report.step(`Keeping bb's machine data on local disk (~/.bb-machines -> ${target})`);
    // Positional args: nothing from settings is interpolated into the script.
    const script = [
      'target="$1"; root="$HOME/.bb-machines"',
      'mkdir -p "$target" || exit 4',
      "for attempt in 1 2; do",
      '  if [ -L "$root" ]; then',
      '    [ "$(readlink "$root")" = "$target" ] && exit 0',
      '    echo "~/.bb-machines points to $(readlink "$root"), expected $target"; exit 5',
      "  fi",
      '  if [ -e "$root" ]; then',
      '    echo "~/.bb-machines is a real folder on the shared home. Move it aside (mv ~/.bb-machines ~/.bb-machines.shared) and retry."; exit 6',
      "  fi",
      '  ln -s "$target" "$root" 2>/dev/null || true',
      "done",
      "exit 7",
    ].join("\n");
    // Right after an Ona start the shared home may not be mounted yet, and the
    // container's own ~/.bb-machines shows through. Re-check for a while
    // before treating a real folder (exit 6) as the user's to move.
    const deadline = Date.now() + 2 * 60_000;
    for (;;) {
      let output = "";
      const { exitCode } = await executor.exec({
        command: ["bash", "-c", script, "bb-ona-root", target],
        stdin: "",
        timeoutMs: CHECK_TIMEOUT_MS,
        signal,
        onOutput: (chunk) => {
          output += chunk;
        },
      });
      if (exitCode === 0) return;
      if (exitCode !== 6 || Date.now() > deadline) {
        throw new Error(`Could not set up ~/.bb-machines: ${output.trim() || `exit ${exitCode}`}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      signal.throwIfAborted();
    }
  }

  async function disconnect(envId: string) {
    tunnels.stop(envId);
    await deps.forgetTunnel(envId);
  }

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "Ona devbox",
    description: "Run threads inside an Ona environment, new or existing, reached over Ona SSH.",
    icon: "Cloud",
    ephemeral: false,
    inputs: inputsSchema,
    availability: () => deps.availability(),
    validate({ inputs }) {
      if (inputs.mode === "adopt" && !inputs.environment) {
        return { action: "refuse", message: 'Adopt needs {"environment": "<name or id>"}.' };
      }
      if (inputs.mode === "create" && !inputs.project && !deps.defaultProject) {
        return {
          action: "refuse",
          message: 'Create needs {"project": "<Ona project>"} or the plugin\'s defaultProject setting.',
        };
      }
      return { action: "accept" };
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      let env: OnaEnvironment;
      let adopted: boolean;
      if (inputs.mode === "adopt") {
        env = await requireEnv(inputs.environment!, signal);
        adopted = true;
      } else {
        const name = envNameForKey(key);
        adopted = false;
        const existing = await ona.findEnvironment(name, signal);
        if (existing) {
          env = existing;
        } else {
          const projectRef = inputs.project ?? deps.defaultProject;
          report.step(`Creating Ona environment ${name} from project ${projectRef}`);
          const projectId = await ona.resolveProjectId(projectRef, signal);
          await ona.createEnvironment(
            { projectId, name, classId: inputs.classId, inactivityTimeout: deps.inactivityTimeout },
            signal,
          );
          env = await requireEnv(name, signal);
        }
      }
      const resource: OnaResource = {
        envId: env.id,
        envName: env.metadata.name ?? env.id,
        adopted,
        key,
      };
      await checkpoint(resource);
      await ensureRunning(env, report, signal);
      await connect(resource, key, report, signal);
      return { status: "created", name: `ona:${resource.envName}`, resource };
    },
    async reconcileCleanup({ key, report, signal }) {
      // Only environments this provider created carry the key-derived name;
      // adopted environments are never deleted.
      const env = await ona.findEnvironment(envNameForKey(key), signal);
      if (env) {
        report.step(`Deleting orphaned Ona environment ${env.metadata.name}`);
        await disconnect(env.id);
        await ona.delete(env.id, signal);
      }
      return { status: "removed" };
    },
    async suspend({ resource, report, signal }) {
      const owned = resourceSchema.parse(resource);
      await disconnect(owned.envId);
      // An idle box let go by the plugin keeps running until Ona's own timeout,
      // so an open Ona editor still keeps it alive.
      if (deps.releasing.delete(owned.envId)) return { resource };
      // Ona may have stopped it already (idle timeout); bb then only records the suspension.
      const env = await ona.getEnvironmentIfExists(owned.envId, signal);
      if (env && !isStopped(env)) {
        report.step(`Stopping Ona environment ${owned.envName}`);
        await ona.stop(owned.envId, signal);
      }
      return { resource };
    },
    async resume({ resource, checkpoint, report, signal }) {
      const owned = resourceSchema.parse(resource);
      // Drop a no-stop flag a failed suspend may have left; the next suspend is the user's.
      deps.releasing.delete(owned.envId);
      const env = await ona.getEnvironmentIfExists(owned.envId, signal);
      if (!env) throw new Error(`Ona environment "${owned.envId}" not found. Run \`ona environment list\`.`);
      await ensureRunning(env, report, signal);
      await checkpoint(resource);
      // bootstrap with the creation key restarts the already-enrolled daemon.
      await connect(owned, owned.key, report, signal);
      return { resource };
    },
    async remove({ resource, hostId, report, signal }) {
      const owned = resourceSchema.parse(resource);
      if (owned.adopted) {
        const env = await ona.getEnvironmentIfExists(owned.envId, signal);
        if (env && isRunning(env)) {
          report.step(`Stopping the bb daemon on ${owned.envName} (environment is kept)`);
          // The detached daemon and its supervisor both run from the data dir.
          // Pass values as positional args so nothing is interpolated into the script.
          const dataDir = owned.dataDir ?? "";
          const script = [
            'dir="${1:-$HOME/.bb-machines}"; host="$2"',
            'pkill -f -- "$dir/" || true',
            'for f in "$dir"/*/install-machine.sh "$dir"/install-machine.sh; do',
            '  [ -f "$f" ] && bash "$f" --uninstall --host-id "$host" || true',
            "done",
          ].join("\n");
          await sshExecutor(deps.sshBinary, owned.envId)
            .exec({
              command: ["bash", "-c", script, "bb-ona-remove", dataDir, hostId],
              stdin: "",
              timeoutMs: 120_000,
              signal,
              onOutput: () => {},
            })
            .catch(() => undefined);
        }
        await disconnect(owned.envId);
        await deps.forgetBox(owned.envId);
        return { status: "removed" };
      }
      // `get` also returns boxes Ona already deleted or is deleting, which `list` hid.
      // It runs first so a refused remove leaves the machine connected and its state kept.
      const env = await ona.getEnvironmentIfExists(owned.envId, signal);
      const live = env && !isDeleted(env) ? env : null;
      const unpushed = live && unpushedWork(live);
      if (unpushed) {
        const where = unpushed.branch ? `on branch ${unpushed.branch}` : "on its current branch";
        return {
          status: "failed",
          message:
            `Not deleting Ona environment ${owned.envName}: it has ${unpushed.count} unpushed commit(s) ${where}. ` +
            `Push them, or delete the box in Ona with \`ona environment delete ${owned.envId}\`, ` +
            "then run `bb machine retry-cleanup` again.",
        };
      }
      await disconnect(owned.envId);
      await deps.forgetBox(owned.envId);
      if (live) {
        report.step(`Deleting Ona environment ${owned.envName}`);
        await ona.delete(owned.envId, signal);
      }
      return { status: "removed" };
    },
  });

  /**
   * Whether bb's daemon runs on a box: true, false, or null when SSH couldn't
   * tell. Only call it for a box Ona reports RUNNING (SSH starts stopped boxes).
   */
  async function daemonAlive(resource: OnaResource, signal: AbortSignal): Promise<boolean | null> {
    const { exitCode } = await sshExecutor(deps.sshBinary, resource.envId, [])
      .exec({
        command: ["bash", "-c", DAEMON_PROBE, "bb-ona-probe", deps.machineDataDir, resource.dataDir ?? ""],
        stdin: "",
        timeoutMs: 15_000,
        signal,
        onOutput: () => {},
      })
      .catch(() => ({ exitCode: -1 }));
    return exitCode === 0 ? true : exitCode === 1 ? false : null;
  }

  return { reconnect, daemonAlive, releasing: deps.releasing };
}

export function registerOnaComposition(bb: BbPluginApi) {
  bb.experimental_environments.register({
    id: "ona-devbox",
    displayName: "New Ona devbox",
    description: "Create a fresh Ona environment and run the thread in a worktree there.",
    icon: "Cloud",
    machineProviderId: PROVIDER_ID,
    environmentProviderId: "git-worktree",
  });
}
