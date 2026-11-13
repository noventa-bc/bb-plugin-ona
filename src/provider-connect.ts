// The connect path of the "ona" provider: starts a box, waits for SSH, opens the tunnel, then connects bb's daemon.
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { isRunning, isStarting, metric, waitForReady, type OnaEnvironment } from "./ona.ts";
import type { OnaResource, PluginMachineProviderProgress, ProviderDeps } from "./provider.ts";
import { short, STOPPED } from "./reconcile.ts";
import { daemonEnv, pollSsh, shellQuote, sshCapture, sshCheck, sshExecutor } from "./ssh.ts";
import { pollUntil } from "./time.ts";

/** A connect whose box was closed after its mark: it opened no tunnel, so it closes none. */
class TunnelRefused extends Error {}

/** Ona can be slow to wake a dev container; give each SSH check this long. */
const CHECK_TIMEOUT_MS = 5 * 60_000;

/** Who asked for a wake: a waiting thread on an active machine (the sync pass), or `bb ona resume`. */
export type WakeVia = "wake-thread" | "wake-cmd";

/**
 * A connect call's start. ensureRunning sets `started` just before it calls Ona's start, so the call still knows it
 * started the box when that start or the connect throws. create sets `created` once Ona's createEnvironment returns,
 * so a create that fails before then reads `running`.
 */
export interface StartTrace {
  via: "create" | "resume" | WakeVia;
  started: boolean;
  created: boolean;
}

/** The connect path bound to one registration; provider.ts calls the functions it returns. */
export function connectHelpers(bb: BbPluginApi, deps: ProviderDeps) {
  const { ona, tunnels, executorFor = sshExecutor } = deps;
  // When the provider registered, which is when the plugin loaded: the start lines' `up` counts seconds from it.
  const loadedAt = Date.now();

  /**
   * Starts a stopped box, after Ona's own starts and stops finish. Resolves true when it called `ona.start`, and false
   * when no start was called (the box was running, or Ona started it during the waits). The waits share one 25-minute
   * deadline: a 15-minute start wait plus a 10-minute stop wait. A wait that runs out judges the box as the read that
   * began the wait showed it.
   */
  async function ensureRunning(
    env: OnaEnvironment,
    report: PluginMachineProviderProgress,
    signal: AbortSignal,
    trace: StartTrace,
  ) {
    // Ona's own starts and stops finish first, one wait at a time, each judged on the read it settles on: a box that
    // starts or stops again while it is waited for is waited for again, until the shared deadline.
    const deadline = Date.now() + 25 * 60_000;
    while (!isRunning(env) && (isStarting(env) || env.status?.phase === "ENVIRONMENT_PHASE_STOPPING")) {
      const verb = isStarting(env) ? "starting" : "stopping";
      const left = deadline - Date.now();
      if (left <= 0) break;
      report.step(`Waiting for Ona to finish ${verb} ${env.metadata.name ?? env.id}`);
      const settled = await pollUntil(
        async () => {
          const current = await ona.getEnvironmentIfExists(env.id, signal);
          if (!current) throw new Error(`Ona environment ${env.metadata.name ?? env.id} disappeared while ${verb}.`);
          const stillWaiting =
            verb === "starting" ? isStarting(current) : current.status?.phase === "ENVIRONMENT_PHASE_STOPPING";
          return stillWaiting ? undefined : current;
        },
        { deadlineMs: Math.min((verb === "starting" ? 15 : 10) * 60_000, left), intervalMs: 5_000, signal },
      );
      // A wait that runs out keeps the box as the read that began the wait showed it: judged below.
      if (!settled) break;
      env = settled;
    }
    if (isRunning(env)) return false;
    // Only a box the last read shows stopped or stopping is started (a stop wait that runs out still reaches the start,
    // which Ona refuses). A deleting, deleted or failed box is refused (docs/sync.md rule 1).
    const phase = env.status?.phase ?? "";
    if (!STOPPED.has(phase)) {
      throw new Error(`Ona shows ${env.metadata.name ?? env.id} ${short(phase || "unknown")}, so it was not started.`);
    }
    report.step(`Starting Ona environment ${env.metadata.name ?? env.id}`);
    // Logged before the call on purpose: a start that fails may still have started the box, so the line records
    // the attempt.
    bb.log.info(metric("start", { env: env.id, via: trace.via, up: Math.round((Date.now() - loadedAt) / 1000) }));
    trace.started = true;
    await ona.start(env.id, signal);
    return true;
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
    const probe = sshCheck(executor, 'mountpoint -q "$HOME"', signal, CHECK_TIMEOUT_MS);
    if (await probe()) return;
    report.step("Waiting for the shared home folder to be mounted");
    const hint =
      ". If your Ona environments don't share a home folder, turn off the plugin's `waitForSharedHome` setting; a changed setting applies after `bb plugin reload ona`.";
    await pollSsh(probe, "The devbox's home folder was not mounted", { minutes: 5, intervalMs: 5_000, signal, hint });
  }

  async function waitForTunnel(executor: MachineExecutor, signal: AbortSignal) {
    const url = `http://127.0.0.1:${deps.port()}/health`;
    const probe = sshCheck(executor, `curl -sf -o /dev/null --max-time 5 ${shellQuote(url)}`, signal, CHECK_TIMEOUT_MS);
    const what = "The devbox could not reach the bb server through the SSH tunnel";
    await pollSsh(probe, what, { minutes: 10, intervalMs: 3_000, signal, hint: ". Check `bb plugin logs ona`." });
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
    /** The box wasn't running when this began, so a start is under way (see `readiness`). */
    started = false,
    /** The tunnels' mark taken before the caller read the machine: a close after it refuses the tunnel. */
    since: number,
  ) {
    await waitForReady(ona, resource.envId, resource.envName, report, signal, started);
    // Safety rule 1 for every SSH command below: Ona is asked first, and the command runs only on a ready answer.
    const ssh = executorFor(deps.sshBinary, resource.envId, daemonEnv(deps.codexSqliteHome));
    const executor: MachineExecutor = {
      exec: async (request) => {
        await waitForReady(ona, resource.envId, resource.envName, report, request.signal);
        return ssh.exec(request);
      },
    };
    report.step("Waiting for the dev container to accept SSH");
    const sshUp = sshCheck(executor, "true", signal, CHECK_TIMEOUT_MS);
    await pollSsh(sshUp, "Could not SSH into the devbox", { minutes: 10, intervalMs: 5_000, signal });
    if (deps.waitForSharedHome) await waitForSharedHome(executor, report, signal);
    if (deps.codexSqliteHome) {
      const folder = deps.codexSqliteHome;
      const { exitCode, output } = await sshCapture(
        executor,
        `mkdir -p ${shellQuote(folder)}`,
        signal,
        CHECK_TIMEOUT_MS,
      );
      if (exitCode !== 0) {
        const why = output.trim().slice(-300) || `exit ${exitCode}`;
        throw new Error(`Could not create Codex's folder ${folder} (the \`codexSqliteHome\` setting): ${why}`);
      }
    }
    if (deps.machineDataDir) await ensureLocalMachineRoot(executor, deps.machineDataDir, report, signal);
    if (!tunnels.ensure(resource.envId, since)) {
      throw new TunnelRefused(
        `bb suspended or removed the machine on ${resource.envName} while it connected, so its tunnel stays closed.`,
      );
    }
    report.step("Opening SSH reverse tunnel to bb server");
    await waitForTunnel(executor, signal);
    await preflight(executor, report, signal);
    report.step("Installing and enrolling the bb daemon");
    return bb.experimental_machines.bootstrap({ key, executor, report, signal });
  }

  /**
   * connect() for a machine bb doesn't show active yet (create, resume). A wake that starts its box is the one
   * exception: bb shows the machine active, and a failed connect still closes the tunnel it opened.
   */
  async function connectOrClose(
    resource: OnaResource,
    report: PluginMachineProviderProgress,
    signal: AbortSignal,
    started: boolean,
    since: number,
  ) {
    try {
      return await connect(resource, resource.key, report, signal, started, since);
    } catch (error) {
      // A refused open left a newer flow's tunnel as it was; closing it would end that flow's tunnel.
      if (!(error instanceof TunnelRefused)) await disconnect(resource.envId);
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

  return { ensureRunning, connect, connectOrClose, disconnect };
}
