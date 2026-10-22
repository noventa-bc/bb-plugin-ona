// SSH transport into Ona environments: a MachineExecutor for bb's bootstrap
// and a reverse tunnel that lets the devbox's daemon reach this server at its
// own loopback address.
import { spawn } from "node:child_process";
import type { MachineExecutor, PluginLogger } from "@get-bb/plugin-sdk";
import { sshHost } from "./ona.ts";

const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
];

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
          finish(() => reject(signal.reason ?? new Error("aborted")));
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Keeps one `ssh -N -R <remotePort>:127.0.0.1:<localPort>` per environment,
 * reconnecting with backoff. `localPort` must be the daemon-only proxy, never
 * the bb server itself (see proxy.ts).
 */
export class TunnelManager {
  private readonly tunnels = new Map<string, { controller: AbortController; connectedAt: number | null }>();

  private readonly sshBinary: string;
  private readonly remotePort: () => number;
  private readonly localPort: () => number;
  private readonly log: PluginLogger;
  private readonly shouldConnect: (envId: string) => Promise<boolean>;

  /**
   * `shouldConnect` is asked before every (re)connect. Ona's SSH starts a
   * stopped environment on connect, so reconnecting blindly would undo Ona's
   * idle auto-stop; return false while the environment is stopped.
   */
  constructor(
    sshBinary: string,
    remotePort: () => number,
    localPort: () => number,
    log: PluginLogger,
    shouldConnect: (envId: string) => Promise<boolean> = async () => true,
  ) {
    this.sshBinary = sshBinary;
    this.remotePort = remotePort;
    this.localPort = localPort;
    this.log = log;
    this.shouldConnect = shouldConnect;
  }

  ensure(envId: string): void {
    if (this.tunnels.has(envId)) return;
    const state = { controller: new AbortController(), connectedAt: null as number | null };
    this.tunnels.set(envId, state);
    void this.loop(envId, state);
  }

  stop(envId: string): void {
    this.tunnels.get(envId)?.controller.abort();
    this.tunnels.delete(envId);
  }

  stopAll(): void {
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
    while (!signal.aborted) {
      if (!(await this.shouldConnect(envId).catch(() => true))) {
        await sleep(60_000, signal);
        continue;
      }
      const remotePort = this.remotePort();
      const localPort = this.localPort();
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const child = spawn(this.sshBinary, [
          ...SSH_OPTIONS,
          "-N",
          "-o", "ExitOnForwardFailure=yes",
          "-R", `${remotePort}:127.0.0.1:${localPort}`,
          sshHost(envId),
        ], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-2_000);
        });
        // ssh -N prints nothing on success; treat surviving a few seconds as connected.
        const connectedTimer = setTimeout(() => {
          state.connectedAt = Date.now();
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
      if (signal.aborted) break;
      backoff = Date.now() - started > 60_000 ? 1_000 : Math.min(backoff * 2, 10_000);
      await sleep(backoff, signal);
    }
  }
}
