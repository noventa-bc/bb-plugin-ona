// The "ona" machine provider: each bb machine is one Ona environment, either
// created for bb or adopted from an existing one.
import type { BbPluginApi, MachineBootstrapRequest, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { friendlyName } from "./names.ts";
import { isDeleted, isRunning, isStarting, isStopped, unpushedWork, type OnaCli, type OnaEnvironment } from "./ona.ts";
import { DAEMON_PROBE } from "./reconcile.ts";
import type { PluginMachineProviderAvailability } from "./setup.ts";
import { daemonEnv, shellQuote, sshCapture, sshExecutor, type TunnelManager } from "./ssh.ts";
import { pollUntil } from "./time.ts";

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
  /**
   * Legacy BB_DATA_DIR from 0.1.0 enrollments; new machines use ~/.bb-machines.
   * Trailing slashes are dropped: `mv` can't move "dir/" to "dir/.old-…".
   */
  dataDir: z
    .string()
    .transform((dir) => dir.replace(/\/+$/, ""))
    .optional(),
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
  /** Record that the box just (re)connected; the idle window starts here. */
  markConnected(envId: string): Promise<void>;
  /**
   * Boxes the plugin is letting go while idle: their next suspend (consumed
   * once) only closes the tunnel, and Ona's own inactivity timeout stops the box.
   */
  releasing: Set<string>;
  /** Drop the plugin's stored keys for a box whose machine is removed. */
  forgetBox(envId: string): Promise<void>;
  /** Opens the command channel to a box; `sshExecutor` unless a test passes a fake. */
  executorFor?: typeof sshExecutor;
}

/**
 * Run on an adopted box when its machine is removed: stops the processes that
 * run from the data folder of machine "$1" (bb's daemon) and moves the folder
 * aside, never deleting it. bb's installer refuses a folder that names another
 * machine, so a folder left in place blocks adopting the box again. "$2" is
 * the legacy `dataDir`, which bb's installer used as the data folder itself.
 * Exits 3 when no folder names the machine, and another non-zero code when the
 * move failed.
 */
export const MOVE_MACHINE_ASIDE = [
  'host="$1"; legacy="$2"',
  // An empty id would match a folder whose host-id file is empty.
  '[ -n "$host" ] || exit 2',
  // Without a working ps the stop loop sees no daemon, and the folder would move under a live one.
  "ps -e -o pid= -o args= >/dev/null || exit 4",
  'for id in "$HOME"/.bb-machines/*/host-id ${legacy:+"$legacy/host-id"}; do',
  '  [ -f "$id" ] && [ "$(cat "$id")" = "$host" ] || continue',
  '  data="${id%/host-id}"',
  // bb retries a remove whose later teardown step failed; the folder it moved still names the machine.
  '  case "${data##*/}" in *.old-[0-9]*T[0-9]*Z) moved=1; continue ;; esac',
  // A folder that holds other machines' data folders is never stopped or moved.
  '  for other in "$data"/*/host-id; do [ -f "$other" ] && continue 2; done',
  '  real=$(cd "$data" && pwd -P) || exit 1; export real; n=0',
  // bb 0.48.1 starts the daemon from the resolved path. The script never stops
  // itself: the path reaches awk through the environment, the legacy argument
  // has no trailing slash, and `cat` and `ls` have exited.
  // shortcut: a daemon started from a `bb-app` on the PATH has no folder in its
  // command line, so it keeps running while the folder moves; match its BB_DATA_DIR if a box shows one.
  `  while pids=$(ps -e -o pid= -o args= | awk 'index($0, ENVIRON["real"] "/") {print $1}') && [ -n "$pids" ]; do`,
  // Repeated so a supervisor's restart is caught too; forced after 10 s.
  '    n=$((n + 1)); [ "$n" -gt 10 ] && { kill -9 $pids 2>/dev/null; break; }',
  "    kill $pids 2>/dev/null; sleep 1",
  "  done",
  // bb's installer allows one data folder per machine, so the first match is the only one.
  '  mv "$data" "$data.old-$(date -u +%Y%m%dT%H%M%SZ)"; exit',
  "done",
  '[ -n "$moved" ] && exit 0',
  "exit 3",
].join("\n");

/** Deterministic Ona name for a creation key, so retries find the same environment. */
export function envNameForKey(key: string): string {
  return friendlyName(key);
}

export function registerOnaProvider(bb: BbPluginApi, deps: ProviderDeps) {
  const reconnect = (resource: OnaResource, report: PluginMachineProviderProgress, signal: AbortSignal) =>
    connect(resource, resource.key, report, signal);

  const { ona, tunnels, executorFor = sshExecutor } = deps;

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
      const settled = await pollUntil(
        async () => {
          const current = await ona.getEnvironmentIfExists(env.id, signal);
          if (!current) throw new Error(`Ona environment ${env.metadata.name ?? env.id} disappeared while starting.`);
          return isStarting(current) ? undefined : current;
        },
        { deadlineMs: 15 * 60_000, intervalMs: 5_000, signal },
      );
      if (settled && isRunning(settled)) return;
      if (settled) env = settled;
    }
    // Ona refuses to start an environment that is still stopping; let it finish first.
    if (env.status?.phase === "ENVIRONMENT_PHASE_STOPPING") {
      report.step(`Waiting for Ona to finish stopping ${env.metadata.name ?? env.id}`);
      await pollUntil(
        async () => {
          const current = await ona.getEnvironmentIfExists(env.id, signal);
          if (!current) throw new Error(`Ona environment ${env.metadata.name ?? env.id} disappeared while stopping.`);
          return current.status?.phase !== "ENVIRONMENT_PHASE_STOPPING";
        },
        { deadlineMs: 10 * 60_000, intervalMs: 5_000, signal },
      );
    }
    report.step(`Starting Ona environment ${env.metadata.name ?? env.id}`);
    await ona.start(env.id, signal);
  }

  async function waitForSsh(executor: MachineExecutor, report: PluginMachineProviderProgress, signal: AbortSignal) {
    report.step("Waiting for the dev container to accept SSH");
    let last = "";
    const reached = await pollUntil(
      async () => {
        try {
          const probe = await sshCapture(executor, "true", signal, CHECK_TIMEOUT_MS);
          if (probe.exitCode === 0) return true;
          last = probe.output.trim().split("\n").slice(-1)[0] ?? "";
        } catch (error) {
          if (signal.aborted) throw error;
          last = error instanceof Error ? error.message : String(error);
        }
        return false;
      },
      { deadlineMs: 10 * 60_000, intervalMs: 5_000, signal },
    );
    if (reached) return;
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
        .catch((error: unknown) => {
          if (signal.aborted) throw error;
          return false;
        });
    if (await probe()) return;
    report.step("Waiting for the shared home folder to be mounted");
    if (await pollUntil(probe, { deadlineMs: 5 * 60_000, intervalMs: 5_000, signal })) return;
    throw new Error(
      "The devbox's home folder was not mounted within 5 minutes. If your Ona environments don't share a home folder, turn off the plugin's waitForSharedHome setting.",
    );
  }

  async function waitForTunnel(executor: MachineExecutor, report: PluginMachineProviderProgress, signal: AbortSignal) {
    report.step("Opening SSH reverse tunnel to bb server");
    const url = `http://127.0.0.1:${deps.port()}/health`;
    const reached = await pollUntil(
      () =>
        sshCapture(executor, `curl -sf -o /dev/null --max-time 5 ${shellQuote(url)}`, signal, CHECK_TIMEOUT_MS)
          .then((probe) => probe.exitCode === 0)
          .catch((error: unknown) => {
            if (signal.aborted) throw error;
            return false;
          }),
      { deadlineMs: 10 * 60_000, intervalMs: 3_000, signal },
    );
    if (reached) return;
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
    const executor = executorFor(deps.sshBinary, resource.envId, daemonEnv(deps.codexSqliteHome));
    await waitForSsh(executor, report, signal);
    if (deps.waitForSharedHome) await waitForSharedHome(executor, report, signal);
    if (deps.codexSqliteHome) {
      await sshCapture(executor, `mkdir -p ${shellQuote(deps.codexSqliteHome)}`, signal, CHECK_TIMEOUT_MS);
    }
    if (deps.machineDataDir) await ensureLocalMachineRoot(executor, deps.machineDataDir, report, signal);
    tunnels.ensure(resource.envId);
    await deps.markConnected(resource.envId);
    await waitForTunnel(executor, report, signal);
    await preflight(executor, report, signal);
    report.step("Installing and enrolling the bb daemon");
    return bb.experimental_machines.bootstrap({ key, executor, report, signal });
  }

  /**
   * connect() for a machine bb doesn't show active yet (create, resume). An open
   * tunnel keeps the box awake (decision 0003), so a failure closes the box's tunnel.
   */
  async function connectOrClose(resource: OnaResource, report: PluginMachineProviderProgress, signal: AbortSignal) {
    try {
      return await connect(resource, resource.key, report, signal);
    } catch (error) {
      await disconnect(resource.envId);
      throw error;
    }
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
    let last = { exitCode: 6, output: "" };
    await pollUntil(
      async () => {
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
        last = { exitCode, output };
        return exitCode !== 6;
      },
      { deadlineMs: 2 * 60_000, intervalMs: 10_000, signal },
    );
    if (last.exitCode !== 0) {
      throw new Error(`Could not set up ~/.bb-machines: ${last.output.trim() || `exit ${last.exitCode}`}`);
    }
  }

  async function disconnect(envId: string) {
    tunnels.stop(envId);
  }

  /** The box's current name: the stored one goes stale after `bb ona rename`. */
  const nameOf = (env: OnaEnvironment, owned: OnaResource) => env.metadata.name ?? owned.envName;
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
      await connectOrClose(resource, report, signal);
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
        report.step(`Stopping Ona environment ${nameOf(env, owned)}`);
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
      // The stored name goes stale after `bb ona rename`; only a lifecycle hook can store the current one.
      const current = { ...owned, envName: nameOf(env, owned) };
      await checkpoint(current);
      // bootstrap with the creation key restarts the already-enrolled daemon.
      await connectOrClose(owned, report, signal);
      return { resource: current };
    },
    async remove({ resource, hostId, report, signal }) {
      const owned = resourceSchema.parse(resource);
      if (owned.adopted) {
        // A thrown lookup closes the tunnel before the error goes on; the keys stay for bb's retry.
        const env = await ona.getEnvironmentIfExists(owned.envId, signal).catch(async (error: unknown) => {
          await disconnect(owned.envId);
          throw error;
        });
        // The machine is still removed either way; a folder left behind only blocks adopting the box again.
        // Told through the plugin log: bb 0.48.1 writes `report.log` only to its server log.
        const byHand =
          `move aside the bb data folder whose host-id is ${hostId} ` +
          `(see "Adopting a box again after removing its machine" in the plugin's README)`;
        if (env && isRunning(env)) {
          const name = nameOf(env, owned);
          report.step(`Stopping the bb daemon on ${name} and moving its data folder aside (environment is kept)`);
          let output = "";
          // Values go in as positional args so nothing is interpolated into the script.
          const { exitCode } = await executorFor(deps.sshBinary, owned.envId)
            .exec({
              command: ["bash", "-c", MOVE_MACHINE_ASIDE, "bb-ona-remove", hostId, owned.dataDir ?? ""],
              stdin: "",
              timeoutMs: 120_000,
              signal,
              onOutput: (chunk) => {
                output += chunk;
              },
            })
            .catch((error: unknown) => {
              output += String(error);
              return { exitCode: -1 };
            });
          if (exitCode === 3) {
            bb.log.warn(
              `Found no bb data folder for machine ${hostId} on ${name}; nothing moved. If adopting it again fails, ${byHand}.`,
            );
          } else if (exitCode !== 0) {
            // -1: timed out or SSH failed, so the script may still have finished.
            const what = exitCode === -1 ? "May not have moved" : "Could not move";
            bb.log.warn(
              `${what} bb's data folder on ${name} aside (exit ${exitCode}: ${output.trim().slice(-300)}). ` +
                `Before adopting it again, ${byHand}.`,
            );
          }
        } else if (env && !isDeleted(env)) {
          bb.log.warn(
            `${nameOf(env, owned)} isn't running, so bb's data folder on it was left in place. ` +
              `Before adopting it again, start it and ${byHand}.`,
          );
        }
        // Last: a sync pass can reopen the tunnel while the move-aside runs, so it closes here, before the keys go.
        await disconnect(owned.envId);
        await deps.forgetBox(owned.envId);
        return { status: "removed" };
      }
      // `get` also returns boxes Ona already deleted or is deleting, which `list` hid.
      // The lookup runs first, so a refused remove keeps bb's state (the keys) for the retry.
      // Every path closes the tunnel: a refused remove, a thrown lookup, and the removal.
      const env = await ona.getEnvironmentIfExists(owned.envId, signal).catch(async (error: unknown) => {
        await disconnect(owned.envId);
        throw error;
      });
      const live = env && !isDeleted(env) ? env : null;
      const unpushed = live && unpushedWork(live);
      if (unpushed) {
        await disconnect(owned.envId);
        const where = unpushed.branch ? `on branch ${unpushed.branch}` : "on its current branch";
        return {
          status: "failed",
          message:
            `Not deleting Ona environment ${nameOf(live, owned)}: it has ${unpushed.count} unpushed commit(s) ${where}. ` +
            `Push them, or delete the box in Ona with \`ona environment delete ${owned.envId}\`, ` +
            "then run `bb machine retry-cleanup` again.",
        };
      }
      await disconnect(owned.envId);
      await deps.forgetBox(owned.envId);
      if (live) {
        report.step(`Deleting Ona environment ${nameOf(live, owned)}`);
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
    const { exitCode } = await executorFor(deps.sshBinary, resource.envId, [])
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

  /**
   * Run a cost collector script on a devbox and parse the JSON line it prints.
   * Only call it for a box a fresh Ona listing says is RUNNING (SSH starts stopped boxes).
   */
  async function runCollector(envId: string, script: string, ids: string[]): Promise<unknown> {
    // Login shell for the user's PATH (node, codex); Codex keeps bb's local SQLite home.
    const command = [
      "bash",
      "-lc",
      '[ -n "$1" ] && export CODEX_SQLITE_HOME="$1"; script="$2"; shift 2; exec node -e "$script" "$@"',
      "bb-ona-cost",
      deps.codexSqliteHome,
      script,
      ...ids,
    ];
    let output = "";
    const { exitCode } = await executorFor(deps.sshBinary, envId, []).exec({
      command,
      stdin: "",
      timeoutMs: 90_000,
      signal: AbortSignal.timeout(95_000),
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    const line = output
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (exitCode !== 0 || !line)
      throw new Error(`cost collector failed (exit ${exitCode}): ${output.trim().slice(-300)}`);
    return JSON.parse(line);
  }

  return { reconnect, daemonAlive, runCollector, releasing: deps.releasing };
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
