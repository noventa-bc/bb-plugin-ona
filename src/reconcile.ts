// Keep bb's view of each devbox in step with Ona's when the box changes
// outside bb (Ona UI, `ona` CLI, auto-stop, restarts). Ona decides whether a
// box runs; bb holds the intent (active or suspended). `decide` maps both to
// one repair, and the README's "How bb and Ona stay in sync" documents every
// rule: change both together.
//
// Safety rules every action here keeps:
// 1. never wake compute: no start, no SSH unless Ona says RUNNING;
// 2. never stop compute: observed suspends skip the provider's stop;
// 3. never restart a live daemon: probe first (a restart kills running turns);
// 4. unknown is not gone: a failed or empty listing changes nothing;
// 5. one action per machine at a time, with cooldown and backoff.

export const GRACE_MS = 45_000;
export const STUCK_MS = 10 * 60_000;
export const COOLDOWN_MS = 5 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
export const GIVE_UP_AFTER = 3;

export interface MachineView {
  hostId: string;
  /** bb lifecycle phase: active, suspended, resuming, suspending, ... */
  phase: string;
  /** bb connection status: connected or disconnected. */
  status: string;
  /** When bb last heard from the daemon, epoch ms (null: never). */
  lastSeenAt: number | null;
  /** When the machine entered its current phase, epoch ms. */
  phaseSince: number;
  tunnel: "up" | "connecting" | "off";
  /** A thread is waiting for this machine right now. */
  threadWaiting: boolean;
}

/** What Ona says about the machine's environment. */
export type OnaView =
  | { kind: "unknown" }
  /** Absent from `streak` consecutive good listings. */
  | { kind: "missing"; streak: number; archived?: boolean }
  | { kind: "env"; phase: string };

export type Action =
  | "none"
  /** Mark suspended in bb without stopping anything (rule 2). */
  | "suspend-observed"
  /** Probe the daemon over SSH and restart it only if it's dead (rule 3). */
  | "heal-daemon"
  | "ensure-tunnel"
  /** Ask bb to re-run its own lifecycle step for a machine stuck mid-transition. */
  | "reconcile-stuck";

export interface Decision {
  action: Action;
  reason: string;
  /** After suspend-observed: a thread is waiting, so let bb resume (start) the box. */
  resumeAfter?: boolean;
}

const RUNNING = "ENVIRONMENT_PHASE_RUNNING";
const STOPPED = new Set(["ENVIRONMENT_PHASE_STOPPED", "ENVIRONMENT_PHASE_STOPPING"]);
const GONE = new Set(["ENVIRONMENT_PHASE_DELETED", "ENVIRONMENT_PHASE_DELETING"]);

const short = (phase: string) => phase.replace(/^ENVIRONMENT_PHASE_/, "").toLowerCase();

/** The one repair (if any) for a machine, given bb's and Ona's views. */
export function decide(machine: MachineView, ona: OnaView, now: number): Decision {
  const { phase } = machine;
  if (phase === "resuming" || phase === "suspending") {
    return now - machine.phaseSince >= STUCK_MS
      ? { action: "reconcile-stuck", reason: `${phase} for over ${Math.round(STUCK_MS / 60_000)} minutes` }
      : { action: "none", reason: `bb is ${phase}` };
  }
  // Suspended stays suspended until you use it, even if Ona runs the box.
  if (phase === "suspended") {
    return {
      action: "none",
      reason: ona.kind === "env" && ona.phase === RUNNING ? "suspended in bb, running in Ona" : "suspended",
    };
  }
  if (phase !== "active") return { action: "none", reason: `bb is ${phase}` };

  if (ona.kind === "unknown") return { action: "none", reason: "Ona state unknown" };
  if (ona.kind === "missing" || GONE.has(ona.phase)) {
    if (ona.kind === "missing" && ona.streak < 2)
      return { action: "none", reason: "not in Ona's list (checking again)" };
    return {
      action: "suspend-observed",
      reason:
        ona.kind === "missing" && ona.archived
          ? "the Ona environment is archived; unarchive it in Ona, or remove the machine with `bb machine remove`"
          : "the Ona environment is gone; remove the machine with `bb machine remove`",
    };
  }
  if (machine.status === "connected") return { action: "none", reason: "connected" };
  if (STOPPED.has(ona.phase)) {
    return {
      action: "suspend-observed",
      reason: `Ona ${short(ona.phase)} the box`,
      resumeAfter: machine.threadWaiting,
    };
  }
  if (ona.phase !== RUNNING) return { action: "none", reason: `Ona is ${short(ona.phase)}` };
  if (machine.tunnel === "off") return { action: "ensure-tunnel", reason: "running in Ona but no tunnel" };
  const disconnectedFor = machine.lastSeenAt === null ? Infinity : now - machine.lastSeenAt;
  if (machine.threadWaiting || disconnectedFor >= GRACE_MS) {
    return {
      action: "heal-daemon",
      reason: machine.threadWaiting
        ? "a thread is waiting and the daemon isn't connected"
        : "running in Ona but the daemon isn't connected",
    };
  }
  return { action: "none", reason: "disconnected briefly (waiting for it to come back)" };
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Key for a pass over every machine. */
export const ALL = "*";

/**
 * Debounces and coalesces requests for a reconcile pass. Each key (a host id
 * or ALL) keeps its earliest due time; due keys run together in one pass,
 * and only one pass runs at a time, so a burst of events costs one pass.
 */
export class PassScheduler {
  private readonly due = new Map<string, number>();
  private timer: unknown = null;
  private running = false;
  private stopped = false;

  private readonly run: (keys: Set<string>) => Promise<void>;
  private readonly clock: Clock;
  private readonly onError: (error: unknown) => void;

  /** A pass that throws is reported to `onError`; it never escapes as an unhandled rejection. */
  constructor(
    run: (keys: Set<string>) => Promise<void>,
    clock: Clock = systemClock,
    onError: (error: unknown) => void = () => {},
  ) {
    this.run = run;
    this.clock = clock;
    this.onError = onError;
  }

  schedule(key: string, delayMs: number): void {
    if (this.stopped) return;
    const at = this.clock.now() + delayMs;
    const current = this.due.get(key);
    if (current === undefined || at < current) this.due.set(key, at);
    this.arm();
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.due.clear();
  }

  private arm(): void {
    if (this.running || this.stopped) return;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.due.size === 0) return;
    const next = Math.min(...this.due.values());
    this.timer = this.clock.setTimeout(() => void this.fire(), Math.max(0, next - this.clock.now()));
  }

  private async fire(): Promise<void> {
    this.timer = null;
    const now = this.clock.now();
    const keys = new Set([...this.due].filter(([, at]) => at <= now).map(([key]) => key));
    for (const key of keys) this.due.delete(key);
    this.running = true;
    try {
      if (keys.size > 0) await this.run(keys);
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      this.arm();
    }
  }
}

export interface HostRecord {
  action: string;
  reason: string;
  at: number;
  error?: string;
  /** Consecutive failures; GIVE_UP_AFTER of them stop automatic retries. */
  failures: number;
  /** No automatic action before this time. */
  quietUntil: number;
}

/**
 * Rule 5: one action per machine at a time, a cooldown after each one,
 * exponential backoff after failures, and no more automatic retries after
 * GIVE_UP_AFTER failures in a row (`bb ona sync` forces one). Heavy actions
 * (SSH probes, daemon restarts) run at most `limit` at a time.
 */
export class HostGuard {
  private readonly busy = new Map<string, string>();
  /** The last action actually taken per machine; routine checks never overwrite it. */
  readonly records = new Map<string, HostRecord>();
  /** What the latest check concluded per machine, and since when. */
  readonly seen = new Map<string, { reason: string; since: number }>();
  private active = 0;
  private readonly queue: Array<() => void> = [];

  private readonly limit: number;
  private readonly clock: Pick<Clock, "now">;

  constructor(limit = 2, clock: Pick<Clock, "now"> = systemClock) {
    this.limit = limit;
    this.clock = clock;
  }

  /** The action in flight for a machine, if any. */
  busyWith(hostId: string): string | undefined {
    return this.busy.get(hostId);
  }

  /** Whether an automatic action may run now (not busy, not cooling down, not given up). */
  mayAct(hostId: string, force = false): boolean {
    if (this.busy.has(hostId)) return false;
    if (force) return true;
    const record = this.records.get(hostId);
    if (!record) return true;
    return record.failures < GIVE_UP_AFTER && this.clock.now() >= record.quietUntil;
  }

  /**
   * Run `fn` as the machine's one action; a string it returns is appended to
   * the recorded reason. Returns false (without running it)
   * when the machine is busy, cooling down or given up, unless forced.
   */
  async run(
    hostId: string,
    action: string,
    reason: string,
    fn: () => Promise<string | void>,
    options: { force?: boolean; heavy?: boolean; cooldown?: boolean } = {},
  ): Promise<boolean> {
    if (!this.mayAct(hostId, options.force)) return false;
    this.busy.set(hostId, action);
    const previous = this.records.get(hostId);
    try {
      if (options.heavy) await this.acquire();
      let outcome: string | void;
      try {
        outcome = await fn();
      } finally {
        if (options.heavy) this.release();
      }
      const now = this.clock.now();
      this.records.set(hostId, {
        action,
        reason: outcome ? `${reason}; ${outcome}` : reason,
        at: now,
        failures: 0,
        quietUntil: options.cooldown === false ? now : now + COOLDOWN_MS,
      });
    } catch (error) {
      const failures = (options.force ? 0 : (previous?.failures ?? 0)) + 1;
      const now = this.clock.now();
      this.records.set(hostId, {
        action,
        reason,
        at: now,
        error: error instanceof Error ? error.message : String(error),
        failures,
        quietUntil: now + Math.min(COOLDOWN_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
      });
      throw error;
    } finally {
      this.busy.delete(hostId);
    }
    return true;
  }

  /**
   * Record what a check concluded (for `bb ona status`). Kept apart from
   * `records`, so "connected" doesn't hide the repair that got it there.
   */
  note(hostId: string, reason: string): void {
    if (this.seen.get(hostId)?.reason === reason) return;
    this.seen.set(hostId, { reason, since: this.clock.now() });
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.queue.push(() => {
        this.active++;
        resolve();
      }),
    );
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

/**
 * Remote script for rule 3: exit 0 if a bb daemon process runs from one of
 * the given data folders, 1 if none does. Every other exit (SSH failure,
 * timeout) means "unknown" and must not trigger a restart.
 */
export const DAEMON_PROBE = [
  "me=$$; pp=$PPID; found=1",
  'root="$HOME/.bb-machines"',
  'for dir in "$root" "$(readlink -f "$root" 2>/dev/null)" "$@"; do',
  '  [ -n "$dir" ] || continue',
  // This shell, its parent and the ps/awk children carry the folder in their
  // own command lines; skip them.
  '  if ps -eo pid=,ppid=,args= | awk -v d="$dir/" -v me="$me" -v pp="$pp" \'$1!=me && $1!=pp && $2!=me && index($0, d) {f=1} END {exit !f}\'; then found=0; break; fi',
  "done",
  "exit $found",
].join("\n");
