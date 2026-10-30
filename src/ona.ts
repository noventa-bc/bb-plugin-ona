// Thin wrapper around the `ona` CLI. Every call shells out to the already
// authenticated CLI on the server machine; no Ona credentials pass through bb.
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import { keepAliveArgs, type KeepAliveChild } from "./keepalive.ts";

const environmentSchema = z.object({
  id: z.string(),
  metadata: z
    .object({
      name: z.string().optional(),
      projectId: z.string().optional(),
      archivedAt: z.string().optional(),
    })
    .passthrough(),
  status: z
    .object({
      phase: z.string().optional(),
      content: z.object({ contentLocationInMachine: z.string().optional() }).passthrough().optional(),
    })
    .passthrough()
    .optional(),
});
export type OnaEnvironment = z.infer<typeof environmentSchema>;

const projectSchema = z.object({
  id: z.string(),
  metadata: z.object({ name: z.string().optional() }).passthrough(),
});

export class OnaCli {
  private readonly resolveBinary: () => string;

  /** Takes a resolver so a later-installed or relocated CLI is picked up. */
  constructor(binary: string | (() => string)) {
    this.resolveBinary = typeof binary === "string" ? () => binary : binary;
  }

  get binary(): string {
    return this.resolveBinary();
  }

  private run(args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        { signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim().split("\n").slice(-5).join("\n");
            reject(new Error(`ona ${args.slice(0, 2).join(" ")} failed: ${detail || error.message}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  async listEnvironments(signal?: AbortSignal): Promise<OnaEnvironment[]> {
    const out = await this.run(["environment", "list", "-o", "json"], signal);
    return z.array(environmentSchema).parse(JSON.parse(out || "[]"));
  }

  /** One environment by id, including archived ones, which `list` leaves out. */
  async getEnvironment(envId: string, signal?: AbortSignal): Promise<OnaEnvironment> {
    const out = await this.run(["environment", "get", envId, "-o", "json"], signal);
    // `get` takes several ids, so it may print an array.
    const parsed: unknown = JSON.parse(out);
    return environmentSchema.parse(Array.isArray(parsed) ? parsed[0] : parsed);
  }

  /** Match by exact id, exact name, or unambiguous id prefix. */
  async findEnvironment(ref: string, signal?: AbortSignal): Promise<OnaEnvironment | null> {
    return matchEnvironment(await this.listEnvironments(signal), ref);
  }

  async resolveProjectId(ref: string, signal?: AbortSignal): Promise<string> {
    const out = await this.run(["project", "list", "-o", "json"], signal);
    const projects = z.array(projectSchema).parse(JSON.parse(out || "[]"));
    const match =
      projects.find((p) => p.id === ref) ?? projects.find((p) => p.metadata.name?.toLowerCase() === ref.toLowerCase());
    if (!match) throw new Error(`No Ona project named or with id "${ref}". Run \`ona project list\`.`);
    return match.id;
  }

  async createEnvironment(
    args: { projectId: string; name: string; classId?: string; inactivityTimeout?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const argv = ["environment", "create", args.projectId, "--name", args.name];
    if (args.classId) argv.push("--class-id", args.classId);
    if (args.inactivityTimeout) argv.push("--inactivity-timeout", args.inactivityTimeout);
    await this.run(argv, signal, 30 * 60_000);
  }

  async rename(envId: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.run(["environment", "update", envId, "--name", name], signal);
  }

  async start(envId: string, signal?: AbortSignal): Promise<void> {
    await this.run(["environment", "start", envId], signal, 30 * 60_000);
  }

  async stop(envId: string, signal?: AbortSignal): Promise<void> {
    await this.run(["environment", "stop", envId], signal, 15 * 60_000);
  }

  async delete(envId: string, signal?: AbortSignal): Promise<void> {
    await this.run(["environment", "delete", envId], signal, 15 * 60_000);
  }

  /**
   * Runs `ona environment keep-alive` on this machine for `ms`. Caller must
   * have a fresh listing that says the box is RUNNING (safety rule 1).
   */
  keepAlive(envId: string, ms: number): KeepAliveChild {
    // Its own process group, so ending it also ends the `sleep` the CLI started.
    const child = spawn(this.binary, keepAliveArgs(envId, ms), { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });
    let exited: string | null = null;
    const listeners: Array<(detail: string) => void> = [];
    const finish = (detail: string) => {
      if (exited !== null) return;
      exited = detail;
      for (const listener of listeners) listener(detail);
    };
    child.on("error", (error) => finish(error.message));
    child.on("close", (code, signal) => {
      const tail = stderr.trim().split("\n").slice(-3).join("\n");
      finish(tail || (signal ? `killed by ${signal}` : `exit code ${code}`));
    });
    return {
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
      },
      onExit: (listener) => {
        if (exited !== null) listener(exited);
        else listeners.push(listener);
      },
    };
  }
}

/** Match by exact id, exact name, or unambiguous id prefix. */
export function matchEnvironment(envs: readonly OnaEnvironment[], ref: string): OnaEnvironment | null {
  const exact = envs.find((env) => env.id === ref || env.metadata.name === ref);
  if (exact) return exact;
  const prefixed = envs.filter((env) => env.id.startsWith(ref));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

export function isRunning(env: OnaEnvironment): boolean {
  return env.status?.phase === "ENVIRONMENT_PHASE_RUNNING";
}

/** On its way up (created, starting, ...): starting it again would fail. */
export function isStarting(env: OnaEnvironment): boolean {
  const phase = env.status?.phase;
  return (
    phase === "ENVIRONMENT_PHASE_CREATING" ||
    phase === "ENVIRONMENT_PHASE_STARTING" ||
    phase === "ENVIRONMENT_PHASE_PENDING"
  );
}

export function isArchived(env: OnaEnvironment): boolean {
  return Boolean(env.metadata.archivedAt);
}

export function isStopped(env: OnaEnvironment): boolean {
  const phase = env.status?.phase;
  return phase === "ENVIRONMENT_PHASE_STOPPED" || phase === "ENVIRONMENT_PHASE_DELETED";
}

/** Native SSH host alias written by `ona environment ssh-config`. */
export function sshHost(envId: string): string {
  return `${envId}.ona.environment`;
}

export interface OnaListing {
  envs: OnaEnvironment[];
  at: number;
}

/**
 * One cached `ona environment list` shared by everything that only needs a
 * recent view (tunnel reconnects, the reconciler, status). Concurrent callers
 * share a single CLI call, so a burst of reconnects after the Mac wakes costs
 * one list, not one per box. Provider create/resume/suspend still ask Ona
 * directly: they act on what they read.
 */
export class OnaSnapshot {
  private last: OnaListing | null = null;
  private inFlight: Promise<OnaListing> | null = null;
  /** Message of the last failed list, cleared by the next good one. */
  lastError: string | null = null;

  private readonly fetch: () => Promise<OnaEnvironment[]>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(fetch: () => Promise<OnaEnvironment[]>, ttlMs = 15_000, now: () => number = Date.now) {
    this.fetch = fetch;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** The last good listing, however old (for display). */
  get latest(): OnaListing | null {
    return this.last;
  }

  /** A listing fetched now (shared with any list already in flight). */
  refresh(): Promise<OnaListing> {
    return this.get(-1);
  }

  /** A listing at most `maxAgeMs` old; throws if Ona can't be asked. */
  get(maxAgeMs = this.ttlMs): Promise<OnaListing> {
    if (this.last && this.now() - this.last.at <= maxAgeMs) return Promise.resolve(this.last);
    this.inFlight ??= this.fetch()
      .then((envs) => {
        this.last = { envs, at: this.now() };
        this.lastError = null;
        return this.last;
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
