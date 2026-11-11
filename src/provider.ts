// The "ona" machine provider: each bb machine is one Ona environment, either
// created for bb or adopted from an existing one.
import type { BbPluginApi, MachineBootstrapRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ONA_MACHINE_PROVIDER_ID, ONA_NAME_MESSAGE, ONA_NAME_PATTERN } from "./machine-inputs.ts";
import { envNameForKey } from "./names.ts";
import {
  gitKnown,
  isDeleted,
  isRunning,
  isStopped,
  metric,
  unpushedWork,
  type OnaCli,
  type OnaEnvironment,
} from "./ona.ts";
import { connectHelpers, type StartTrace, type WakeVia } from "./provider-connect.ts";
import { DAEMON_PROBE } from "./reconcile.ts";
import type { PluginMachineProviderAvailability } from "./setup.ts";
import { sshExecutor, type TunnelManager } from "./ssh.ts";
import { capped } from "./time.ts";

export type PluginMachineProviderProgress = MachineBootstrapRequest["report"];

export const PROVIDER_ID = ONA_MACHINE_PROVIDER_ID;

/**
 * A wake, a daemon restart and bb's resume give up after this long (docs/sync.md rule 1): above ensureRunning's 25
 * minutes.
 */
const CAP_MINUTES = 30;

export const resourceSchema = z.object({
  envId: z.string(),
  envName: z.string(),
  adopted: z.boolean(),
  /** Creation key, reused for bootstrap recovery on resume. Not a secret. */
  key: z.string(),
  /**
   * Legacy BB_DATA_DIR from 0.1.0 enrollments; new machines use ~/.bb-machines.
   * Trailing slashes are dropped: `mv` can't move "dir/" to "dir/.old-…".
   * A relative path is resolved against `$HOME` on the box.
   */
  dataDir: z
    .string()
    .transform((dir) => dir.replace(/\/+$/, ""))
    .optional(),
});
export type OnaResource = z.infer<typeof resourceSchema>;

/** Ona names/ids passed to the ona CLI: never option-like, no shell metacharacters. */
export const onaRef = z.string().regex(ONA_NAME_PATTERN, ONA_NAME_MESSAGE);

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
 * Run on an adopted box when its machine is removed: stops every process whose
 * command line names the data folder of machine "$1" (bb's daemon among them)
 * and moves the folder aside, never deleting it. bb's installer refuses a folder
 * that names another machine, so a folder left in place blocks adopting the box
 * again. "$2" is the legacy `dataDir`, which bb's installer used as the data
 * folder itself. Exits 2 for an empty machine id, 3 when no folder names the
 * machine, 4 when the processes couldn't be listed, didn't stop, or the folder
 * path has a newline (the folder stays), 5 when the folder is or holds the home
 * folder or the home folder can't be resolved (nothing is stopped or moved), and
 * 1 when the folder can't be entered or moved.
 */
export const MOVE_MACHINE_ASIDE = [
  'host="$1"; legacy="$2"',
  // A relative legacy dataDir is resolved against $HOME.
  `case $legacy in /*|'') ;; *) legacy="$HOME/$legacy" ;; esac`,
  // An empty id would match a folder whose host-id file is empty.
  '[ -n "$host" ] || exit 2',
  'for id in "$HOME"/.bb-machines/*/host-id ${legacy:+"$legacy/host-id"}; do',
  '  [ -f "$id" ] && [ "$(cat "$id")" = "$host" ] || continue',
  '  data="${id%/host-id}"',
  // bb retries a remove whose later teardown step failed; the folder it moved still names the machine.
  '  case "${data##*/}" in *.old-[0-9]*T[0-9]*Z) moved=1; continue ;; esac',
  // A folder that holds other machines' data folders is never stopped or moved.
  '  for other in "$data"/*/host-id; do [ -f "$other" ] && continue 2; done',
  '  real=$(cd "$data" && pwd -P) || exit 1; export real given="$data"; n=0',
  // The home folder, or a folder above it, is never a machine's data folder: it stays. An unresolvable HOME stops here too.
  '  home=$(cd "${HOME:?}" && pwd -P) || exit 5',
  '  case "$home/" in "${real%/}"/*) exit 5 ;; esac',
  // A newline in the path can't be matched within one listing line: the folder stays.
  '  case "$data$real" in *"',
  '"*) exit 4 ;; esac',
  // bb 0.48.1 starts the daemon from the resolved path; one started through ~/.bb-machines names the path as given.
  // Every process whose command line names the folder is stopped. The script never stops itself: its own shell,
  // its parent and its children are skipped by pid or ppid, whatever paths their command lines carry.
  // A ps that exits non-zero, even after printing part of its list, is unknown, and so is a listing
  // without this shell under its parent (ps ignores -o, or no awk): exit 4, and the folder stays.
  "  while :; do",
  "    out=$(ps -e -o pid= -o ppid= -o args=) || exit 4",
  `    pids=$(printf '%s\\n' "$out" | awk -v me="$$" -v pp="$PPID" '$1 == me && $2 == pp {ok=1} $1 != me && $1 != pp && $2 != me && (index($0, ENVIRON["real"] "/") || index($0, ENVIRON["given"] "/")) {print $1} END {exit !ok}') || exit 4`,
  '    [ -n "$pids" ] || break',
  // Each round lists the processes again: TERM in rounds 1-10, KILL in rounds 11-12, one second apart.
  // Still listed after round 12: exit 4, and the folder stays.
  '    n=$((n + 1)); [ "$n" -gt 12 ] && exit 4',
  '    if [ "$n" -gt 10 ]; then kill -9 $pids 2>/dev/null; else kill $pids 2>/dev/null; fi; sleep 1',
  "  done",
  // bb's installer allows one data folder per machine, so the first match is the only one.
  '  mv "$data" "$data.old-$(date -u +%Y%m%dT%H%M%SZ)"; exit',
  "done",
  '[ -n "$moved" ] && exit 0',
  // A HOME that is set but can't be entered hides ~/.bb-machines, so "no folder" would be a guess.
  '[ -z "${HOME:-}" ] || cd "$HOME" || exit 5',
  "exit 3",
].join("\n");

/** The refusal a remove or an orphan cleanup gives when a delete would lose work on the box; both paths say the same. */
function notDeletingMessage(
  name: string,
  envId: string,
  work: { branch?: string; count: number; files: number },
): string {
  const where = work.branch ? `on branch ${work.branch}` : "on its current branch";
  const found: string[] = [];
  if (work.count > 0) found.push(`${work.count} unpushed commit(s)`);
  if (work.files > 0) found.push(`${work.files} uncommitted file(s)`);
  return (
    `Not deleting Ona environment ${name}: it has ${found.join(" and ")} ${where}. ` +
    `Commit and push, or discard, the work, or delete the box in Ona with \`ona environment delete ${envId}\`, ` +
    "then run `bb machine retry-cleanup` again."
  );
}

/**
 * Runs one connect call and writes its `metric connected` line when the call ends, ok or not. `box` is stopped when the
 * call called Ona's start, which `trace.started` records.
 */
async function timedConnect<T>(
  bb: BbPluginApi,
  via: "create" | "resume" | "wake" | "reconnect",
  trace: { started: boolean },
  call: () => Promise<T>,
): Promise<T> {
  const began = Date.now();
  let ok = 0;
  try {
    const result = await call();
    ok = 1;
    return result;
  } finally {
    const box = trace.started ? "stopped" : "running";
    bb.log.info(metric("connected", { via, box, secs: Math.round((Date.now() - began) / 1000), ok }));
  }
}

export function registerOnaProvider(bb: BbPluginApi, deps: ProviderDeps) {
  const { ensureRunning, connect, connectOrClose, disconnect } = connectHelpers(bb, deps);
  const reconnect = (box: OnaResource, report: PluginMachineProviderProgress, signal: AbortSignal) =>
    timedConnect(bb, "reconnect", { started: false }, () =>
      capped(`reconnecting ${box.envName}`, CAP_MINUTES, signal, report, (s, r) => connect(box, box.key, r, s)),
    );

  const { ona, executorFor = sshExecutor } = deps;

  async function requireEnv(ref: string, signal: AbortSignal): Promise<OnaEnvironment> {
    const env = await ona.findEnvironment(ref, signal);
    if (!env) throw new Error(`Ona environment "${ref}" not found. Run \`ona environment list\`.`);
    return env;
  }

  /**
   * Starts a box Ona shows stopped (or waits for one that is starting or stopping) and connects bb's daemon: a
   * resume's start and connect, without bb's lifecycle. A waiting thread on an active machine asks for it (decision
   * 0002), and so does `bb ona resume`; the caller checks bb's phase, since a suspended machine is bb's resume's to
   * start. Ona's other phases (deleting, deleted, failed) are refused: the box is not started. Its no-stop flag goes
   * first: bb shows the machine active here, so no suspend of bb's can still reach the provider's stop. Resolves true
   * when it called `ona.start`, false when no start was called. It gives up after CAP_MINUTES. `cause` names the caller
   * on the start's metric line.
   */
  const wake = (resource: OnaResource, progress: PluginMachineProviderProgress, outer: AbortSignal, cause: WakeVia) => {
    const trace: StartTrace = { via: cause, started: false };
    return timedConnect(bb, "wake", trace, () =>
      capped(`waking ${resource.envName}`, CAP_MINUTES, outer, progress, async (signal, report) => {
        deps.releasing.delete(resource.envId);
        const env = await ona.getEnvironmentIfExists(resource.envId, signal);
        if (!env) throw new Error(`Ona environment "${resource.envId}" not found. Run \`ona environment list\`.`);
        const startCalled = await ensureRunning(env, report, signal, trace);
        // Only a box this wake started closes its tunnel on a failed connect; a box that was running, or that Ona started
        // during the waits, keeps the tunnel connect() left open.
        if (startCalled) await connectOrClose(resource, report, signal, true);
        else await connect(resource, resource.key, report, signal);
        return startCalled;
      }),
    );
  };

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
          message:
            'Create needs {"project": "<Ona project>"} or the plugin\'s `defaultProject` setting; a changed setting applies after `bb plugin reload ona`.',
        };
      }
      return { action: "accept" };
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      const trace: StartTrace = { via: "create", started: false };
      return timedConnect(bb, "create", trace, async () => {
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
        await ensureRunning(env, report, signal, trace);
        // Not running when this began: Ona can lag behind a start before it reports STARTING.
        await connectOrClose(resource, report, signal, !isRunning(env));
        return { status: "created", name: `ona:${resource.envName}`, resource };
      });
    },
    async reconcileCleanup({ key, report, signal }) {
      // Only environments this provider created carry the key-derived name;
      // adopted environments are never deleted.
      const env = await ona.findEnvironment(envNameForKey(key), signal);
      if (env) {
        // Same check as remove: a delete would lose the work on the box.
        const work = unpushedWork(env);
        if (work) {
          bb.log.info(metric("keep", { env: env.id, via: "cleanup", commits: work.count, files: work.files }));
          await disconnect(env.id);
          return { status: "failed", message: notDeletingMessage(env.metadata.name ?? env.id, env.id, work) };
        }
        report.step(`Deleting orphaned Ona environment ${env.metadata.name ?? env.id}`);
        await disconnect(env.id);
        bb.log.info(metric("delete", { env: env.id, via: "cleanup", git: gitKnown(env) ? "known" : "unknown" }));
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
    // bb's own resume: on Resume in bb, on bb's restart recovery and on a waiting thread's resume. It gives up after
    // CAP_MINUTES, since bb puts no deadline on it.
    async resume({ resource, checkpoint, report: progress, signal: outer }) {
      const trace: StartTrace = { via: "resume", started: false };
      return timedConnect(bb, "resume", trace, async () => {
        const owned = resourceSchema.parse(resource);
        return capped(`resuming ${owned.envName}`, CAP_MINUTES, outer, progress, async (signal, report) => {
          // Drop a no-stop flag a failed suspend may have left; the next suspend is the user's.
          deps.releasing.delete(owned.envId);
          const env = await ona.getEnvironmentIfExists(owned.envId, signal);
          if (!env) throw new Error(`Ona environment "${owned.envId}" not found. Run \`ona environment list\`.`);
          await ensureRunning(env, report, signal, trace);
          // The stored name goes stale after `bb ona rename`; only a lifecycle hook can store the current one.
          const current = { ...owned, envName: nameOf(env, owned) };
          await checkpoint(current);
          // bootstrap with the creation key starts, or re-enrolls, the daemon.
          await connectOrClose(current, report, signal, !isRunning(env));
          return { resource: current };
        });
      });
    },
    async remove({ resource, hostId, report, signal }) {
      const owned = resourceSchema.parse(resource);
      // A removal can leave a no-stop flag behind (a suspend bb settled as removing never reaches the provider's
      // suspend). bb awaits a suspend still running before it calls remove, so none reaches the stop step after this.
      deps.releasing.delete(owned.envId);
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
          } else if (exitCode === 5) {
            bb.log.warn(
              `Did not move bb's data folder for machine ${hostId} on ${name}: it is or holds the home folder, or the home folder couldn't be resolved; nothing was stopped or moved.${output.trim() ? ` The box said: ${output.trim().slice(-300)}` : ""}`,
            );
          } else if (exitCode !== 0) {
            // -1: timed out or SSH failed, so the script may still have finished.
            const what = exitCode === -1 ? "May not have moved" : "Could not move";
            const cause =
              exitCode === 4
                ? " The process listing couldn't be trusted, the folder path has a newline, or the daemon was still running after 12 rounds; it may be stopped or still running."
                : "";
            bb.log.warn(
              `${what} bb's data folder on ${name} aside (exit ${exitCode}: ${output.trim().slice(-300)}).${cause} ` +
                `Before adopting it again, ${byHand}.`,
            );
          }
        } else if (env && !isDeleted(env)) {
          bb.log.warn(
            `${nameOf(env, owned)} isn't running, so bb's data folder on it was left in place. ` +
              `Before adopting it again, start it and ${byHand}.`,
          );
        }
        // Closed after the move-aside and before the keys go.
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
      const work = live && unpushedWork(live);
      if (work) {
        bb.log.info(metric("keep", { env: owned.envId, via: "remove", commits: work.count, files: work.files }));
        await disconnect(owned.envId);
        return { status: "failed", message: notDeletingMessage(nameOf(live, owned), owned.envId, work) };
      }
      await disconnect(owned.envId);
      await deps.forgetBox(owned.envId);
      if (live) {
        report.step(`Deleting Ona environment ${nameOf(live, owned)}`);
        bb.log.info(metric("delete", { env: owned.envId, via: "remove", git: gitKnown(live) ? "known" : "unknown" }));
        await ona.delete(owned.envId, signal);
      }
      return { status: "removed" };
    },
  });

  /**
   * Whether bb's daemon runs on a box: true, false, or null when SSH or the
   * process check on the box couldn't tell. Only call it for a box Ona reports
   * RUNNING (SSH starts stopped boxes).
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

  return { reconnect, daemonAlive, runCollector, releasing: deps.releasing, wake };
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
