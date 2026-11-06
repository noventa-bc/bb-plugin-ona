// SSH transport into Ona environments: a MachineExecutor for bb's bootstrap
// and a reverse tunnel that lets the devbox's daemon reach this server at its
// own loopback address.
import { spawn } from "node:child_process";
import type { MachineExecutor, PluginLogger } from "@get-bb/plugin-sdk";
import { errorText, NotReadyError, sshHost } from "./ona.ts";
import { pollUntil, sleep } from "./time.ts";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Extra environment for every command, inherited by the detached bb daemon and
 * the agents it launches. Ona dev containers ship systemctl without a running
 * systemd, so bb's installer must run a detached daemon instead of a service.
 */
export function daemonEnv(codexSqliteHome: string): string[] {
  const env = ["BB_INSTALL_SKIP_SERVICE=1"];
  // ~/.codex can sit on a shared NFS home where SQLite WAL corrupts; keep
  // this instance's Codex state DB on local disk instead.
  if (codexSqliteHome) env.push(`CODEX_SQLITE_HOME=${codexSqliteHome}`);
  return env;
}

export function sshExecutor(sshBinary: string, envId: string, env: string[] = daemonEnv("")): MachineExecutor {
  return {
    exec({ command, stdin, timeoutMs, signal, onOutput }) {
      return new Promise((resolve, reject) => {
        // The remote shell re-parses the command line, so quote each argv item.
        const remote = ["env", ...env, ...command].map(shellQuote).join(" ");
        const child = spawn(sshBinary, [...SSH_OPTIONS, sshHost(envId), remote], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
        const onAbort = () => {
          child.kill("SIGKILL");
          finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", onOutput);
        child.stderr.setEncoding("utf8").on("data", onOutput);
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => finish(() => resolve({ exitCode: code ?? 255 })));
        // stdin may carry the enrollment bundle: write it, never log it.
        child.stdin.on("error", () => {});
        child.stdin.end(stdin);
      });
    },
  };
}

/** One SSH check for `pollUntil`: true once `script` exits 0. `last` says why the latest try failed. */
export function sshCheck(executor: MachineExecutor, script: string, signal: AbortSignal, timeoutMs: number) {
  const check = Object.assign(
    async () => {
      try {
        const { exitCode, output } = await sshCapture(executor, script, signal, timeoutMs);
        if (exitCode === 0) return true;
        check.last = output.trim().split("\n").slice(-1)[0] ?? "";
      } catch (error) {
        // Ona saying the box isn't ready ends the wait: it is not a failed try.
        if (signal.aborted || error instanceof NotReadyError) throw error;
        check.last = errorText(error);
      }
      return false;
    },
    { last: "" },
  );
  return check;
}

/**
 * Polls `check` until it passes. Past the deadline, or when the caller's own
 * signal ends the wait first, throws "`what` <when>: <last reason>`hint`".
 */
export async function pollSsh(
  check: ReturnType<typeof sshCheck>,
  what: string,
  options: { minutes: number; intervalMs: number; signal: AbortSignal; hint?: string },
) {
  const { minutes, intervalMs, signal, hint = "" } = options;
  const fail = (when: string) => new Error(`${what} ${when}${check.last ? `: ${check.last}` : ""}${hint}`);
  const reached = await pollUntil(check, { deadlineMs: minutes * 60_000, intervalMs, signal }).catch(
    (error: unknown) => {
      // Ona's own reason (the gate was waiting when the abort came) stays as it is.
      throw error instanceof NotReadyError || !(signal.aborted && check.last) ? error : fail("before the wait ended");
    },
  );
  if (!reached) throw fail(`within ${minutes} minutes`);
}

/** Run a short command and capture its output (for preflight and cleanup). */
export async function sshCapture(
  executor: MachineExecutor,
  script: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<{ exitCode: number; output: string }> {
  let output = "";
  const { exitCode } = await executor.exec({
    command: ["bash", "-lc", script],
    stdin: "",
    timeoutMs,
    signal,
    onOutput: (chunk) => {
      output += chunk;
    },
  });
  return { exitCode, output };
}

/**
 * Keeps one `ssh -N -R <remotePort>:127.0.0.1:<localPort>` per environment,
 * reconnecting with backoff. `localPort` must be the daemon-only proxy, never
 * the bb server itself (see proxy.ts).
 */
export class TunnelManager {
  private readonly tunnels = new Map<string, { controller: AbortController; connectedAt: number | null }>();
  /** Set once by stopAll and never reset: a reload builds a new manager. */
  private stopped = false;

  private readonly sshBinary: string;
  private readonly remotePort: () => number;
  private readonly localPort: () => number;
  private readonly log: PluginLogger;
  private readonly shouldConnect: (envId: string) => Promise<boolean>;
  private readonly onConnected: (envId: string) => void;

  /**
   * `shouldConnect` is asked before every (re)connect. Ona's SSH starts a
   * stopped environment on connect, so reconnecting blindly would undo Ona's
   * idle auto-stop; return true only when a fresh listing says RUNNING. A
   * false is asked again after 10 s, after 60 s from the 7th in a row; a throw
   * (Ona can't be asked) after 60 s.
   * `onConnected` runs each time a tunnel comes up.
   */
  constructor(
    sshBinary: string,
    remotePort: () => number,
    localPort: () => number,
    log: PluginLogger,
    shouldConnect: (envId: string) => Promise<boolean> = async () => true,
    onConnected: (envId: string) => void = () => {},
  ) {
    this.sshBinary = sshBinary;
    this.remotePort = remotePort;
    this.localPort = localPort;
    this.log = log;
    this.shouldConnect = shouldConnect;
    this.onConnected = onConnected;
  }

  ensure(envId: string): void {
    if (this.stopped || this.tunnels.has(envId)) return;
    const state = { controller: new AbortController(), connectedAt: null as number | null };
    this.tunnels.set(envId, state);
    void this.loop(envId, state);
  }

  stop(envId: string): void {
    this.tunnels.get(envId)?.controller.abort();
    this.tunnels.delete(envId);
  }

  /** Ends every tunnel; a later `ensure` starts none (the plugin is being disposed). */
  stopAll(): void {
    this.stopped = true;
    for (const envId of [...this.tunnels.keys()]) this.stop(envId);
  }

  status(envId: string): "up" | "connecting" | "off" {
    const state = this.tunnels.get(envId);
    if (!state) return "off";
    return state.connectedAt === null ? "connecting" : "up";
  }

  private async loop(envId: string, state: { controller: AbortController; connectedAt: number | null }) {
    const signal = state.controller.signal;
    let backoff = 1_000;
    let refusals = 0;
    while (!signal.aborted) {
      const connect = await this.shouldConnect(envId).catch(() => null);
      // stop() can run while the gate asks Ona; an ssh spawned after it would never be killed.
      if (this.tunnels.get(envId) !== state) return;
      if (!connect) {
        // Just after a resume Ona can say STARTING while SSH works; a refusal that lasts is a stopped or stuck box.
        await sleep(connect === null || ++refusals > 6 ? 60_000 : 10_000, signal);
        continue;
      }
      refusals = 0;
      const remotePort = this.remotePort();
      const localPort = this.localPort();
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const child = spawn(
          this.sshBinary,
          [
            ...SSH_OPTIONS,
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-R",
            `${remotePort}:127.0.0.1:${localPort}`,
            sshHost(envId),
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-2_000);
        });
        // ssh -N prints nothing on success; treat surviving a few seconds as connected.
        const connectedTimer = setTimeout(() => {
          state.connectedAt = Date.now();
          this.onConnected(envId);
        }, 3_000);
        const onAbort = () => child.kill("SIGTERM");
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
          stderr += String(error);
        });
        child.on("close", (code) => {
          clearTimeout(connectedTimer);
          signal.removeEventListener("abort", onAbort);
          state.connectedAt = null;
          if (!signal.aborted) {
            this.log.warn(`tunnel to ${envId} exited (${code}): ${stderr.trim().slice(-500)}`);
          }
          resolve();
        });
      });
      backoff = Date.now() - started > 60_000 ? 1_000 : Math.min(backoff * 2, 10_000);
      await sleep(backoff, signal);
    }
  }
}
