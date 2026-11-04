// Thin wrapper around the `ona` CLI. Every call shells out to the already
// authenticated CLI on the server machine; no Ona credentials pass through bb.
import { execFile, spawn } from "node:child_process";
import { z } from "zod";
import { keepAliveArgs, type KeepAliveChild } from "./keepalive.ts";
import { pollUntil } from "./time.ts";

const environmentSchema = z.object({
  id: z.string(),
  metadata: z
    .object({
      name: z.string().optional(),
      projectId: z.string().optional(),
      archivedAt: z.string().optional(),
    })
    .loose(),
  /** The phase Ona is driving the box to: RUNNING right after a start, before `status.phase` catches up. */
  spec: z.object({ desiredPhase: z.string().nullish() }).loose().nullish(),
  status: z
    .object({
      phase: z.string().optional(),
      content: z
        .object({
          contentLocationInMachine: z.string().optional(),
          git: z
            .object({
              branch: z.string().optional(),
              totalUnpushedCommits: z.union([z.number(), z.string()]).optional(),
            })
            .loose()
            .optional(),
        })
        .loose()
        .optional(),
      /** null while the box starts, and on a box without a dev container. */
      devcontainer: z.object({ phase: z.string().nullish() }).loose().nullish(),
      /** Ona's API documents a list; the CLI has shown null. */
      failureMessage: z.union([z.string(), z.array(z.string())]).nullish(),
    })
    .loose()
    .optional(),
});
export type OnaEnvironment = z.infer<typeof environmentSchema>;

const projectSchema = z.object({
  id: z.string(),
  metadata: z.object({ name: z.string().optional() }).loose(),
});

/**
 * The two ways `ona environment get` says an id doesn't exist (see
 * docs/ona-notes.md). Nothing broader: a proxy's "404 Not Found" is not this.
 */
const NOT_FOUND = /\bError: (not_found: environment not found$|no environment found matching ")/m;

/**
 * Ona's own `--timeout` (its default is 30s) for a call allowed `timeoutMs`.
 * The process gets `ONA_TIMEOUT_GRACE_MS` more, so a slow call ends with
 * Ona's message, not a kill.
 */
export function onaTimeoutArgs(timeoutMs: number): string[] {
  return ["--timeout", `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`];
}
export const ONA_TIMEOUT_GRACE_MS = 5_000;

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
        [...args, ...onaTimeoutArgs(timeoutMs)],
        { signal, timeout: timeoutMs + ONA_TIMEOUT_GRACE_MS, maxBuffer: 32 * 1024 * 1024 },
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

  /**
   * One environment by id, or null when Ona says it doesn't exist. Any other
   * failure (network, timeout, login) throws: unknown is not gone (rule 4).
   */
  async getEnvironmentIfExists(envId: string, signal?: AbortSignal): Promise<OnaEnvironment | null> {
    try {
      return await this.getEnvironment(envId, signal);
    } catch (error) {
      if (error instanceof Error && NOT_FOUND.test(error.message)) return null;
      throw error;
    }
  }

  /** Match by exact id, exact name, or unambiguous id prefix. For refs a user typed; use get for ids. */
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
   * Opens the box in the user's editor. Callers need not wait, but should log a
   * rejection. User-initiated only (Editor button, `bb ona open`), never from a
   * sync pass: it may wake a stopped box, which the user asked for (see
   * `docs/sync.md`, `ona environment open`).
   */
  async openEditor(envId: string): Promise<void> {
    await this.run(["environment", "open", envId], undefined, 10 * 60_000);
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

/** Safety rule 1's test (docs/sync.md): a box the listing lacks is not running. */
export function isRunning(env: OnaEnvironment | undefined): boolean {
  return env?.status?.phase === "ENVIRONMENT_PHASE_RUNNING";
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

/** Deleted or being deleted; `get` still returns such a box for a while. */
export function isDeleted(env: OnaEnvironment): boolean {
  const phase = env.status?.phase;
  return phase === "ENVIRONMENT_PHASE_DELETED" || phase === "ENVIRONMENT_PHASE_DELETING";
}

/**
 * Commits on the box that were never pushed, or null when there are none or
 * Ona doesn't say (older Ona, no git content): unknown must not block a remove.
 */
export function unpushedWork(env: OnaEnvironment): { branch?: string; count: number } | null {
  const git = env.status?.content?.git;
  const count = Number(git?.totalUnpushedCommits ?? 0);
  if (!(count > 0)) return null;
  return git?.branch ? { branch: git.branch, count } : { count };
}

export function isStopped(env: OnaEnvironment): boolean {
  const phase = env.status?.phase;
  return phase === "ENVIRONMENT_PHASE_STOPPED" || phase === "ENVIRONMENT_PHASE_DELETED";
}

type Readiness = { state: "ready" } | { state: "waiting"; reason: string } | { state: "failed"; message: string };

/** The first non-blank line, trimmed: one line of Ona's text for a progress line or an error. */
function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * Whether Ona says a box can take SSH. RUNNING is ready with its dev container
 * running or none at all, failed when Ona means to stop it (a desired phase
 * other than RUNNING) or the dev container failed, and waiting otherwise.
 * Deleted or deleting is failed. Stopped or stopping is waiting while Ona is
 * bringing it up (desired phase RUNNING), with an earlier start's failure as
 * the reason; otherwise it is failed with Ona's failure message or a desired
 * phase set to anything else, and waiting when Ona sends neither (older Ona).
 * Any other phase is waiting: a failure message there may be left from an
 * earlier start.
 */
export function readiness(env: OnaEnvironment): Readiness {
  const desired = env.spec?.desiredPhase;
  const phase = (env.status?.phase ?? "unknown").replace("ENVIRONMENT_PHASE_", "").toLowerCase();
  if (isRunning(env)) {
    if (desired && desired !== "ENVIRONMENT_PHASE_RUNNING")
      return { state: "failed", message: "Ona is stopping the box" };
    const container = env.status?.devcontainer?.phase;
    if (container === "PHASE_FAILED") return { state: "failed", message: "dev container failed" };
    if (!env.status?.devcontainer || container === "PHASE_RUNNING") return { state: "ready" };
    return { state: "waiting", reason: "dev container starting" };
  }
  if (isDeleted(env)) return { state: "failed", message: phase };
  if (isStopped(env) || phase === "stopping") {
    const failure = [env.status?.failureMessage ?? []].flat().map(firstLine).find(Boolean);
    if (desired === "ENVIRONMENT_PHASE_RUNNING") return { state: "waiting", reason: failure ?? "starting" };
    if (failure) return { state: "failed", message: failure };
    if (desired) return { state: "failed", message: phase };
    return { state: "waiting", reason: "starting" };
  }
  return { state: "waiting", reason: phase };
}

/**
 * Safety rule 1 for every connect: no SSH until `ona environment get`, asked
 * right before, says the box and its dev container run. A failed `get` is
 * unknown (decision 0005): keep asking, never SSH on it. Each new reason to
 * wait goes to `report` as the user's progress line.
 */
export async function waitForReady(
  ona: OnaCli,
  envId: string,
  name: string,
  report: { step(text: string): void },
  signal: AbortSignal,
): Promise<void> {
  let waiting = "";
  const wait = (reason: string) => {
    if (reason !== waiting) report.step(`Waiting for Ona: ${reason}`);
    waiting = reason;
    return false;
  };
  const ready = await pollUntil(
    async () => {
      let env: OnaEnvironment | null;
      try {
        env = await ona.getEnvironmentIfExists(envId, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        // One line only: the rest is Ona's stderr, more than the progress line needs (rule 7).
        if (error instanceof z.ZodError) return wait("Ona's answer could not be read");
        const message = error instanceof Error ? error.message : String(error);
        return wait(firstLine(message) ?? message);
      }
      if (!env) throw new Error(`Ona environment ${name} disappeared.`);
      const state = readiness(env);
      if (state.state === "failed") throw new Error(`Ona environment ${name} failed to start: ${state.message}`);
      return state.state === "ready" || wait(state.reason);
    },
    { deadlineMs: 15 * 60_000, intervalMs: 5_000, signal },
  );
  if (ready) return;
  throw new Error(`Ona did not report ${name} ready within 15 minutes: ${waiting}`);
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
 * recent view (the reconciler, status); anything about to SSH calls
 * `refresh()` instead (safety rule 1). Concurrent callers share a single CLI
 * call, so a pass over every box after the Mac wakes costs one list, not one
 * per box. Provider create/resume/suspend still ask Ona directly: they act on
 * what they read.
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

  /** A listing fetched after this call: a list already in flight may predate what the caller just changed or what Ona changed meanwhile. */
  async refresh(): Promise<OnaListing> {
    await this.inFlight?.catch(() => undefined);
    return this.get(-Infinity);
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
