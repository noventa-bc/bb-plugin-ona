// Keep bb's view of each devbox in step with Ona's when the box changes
// outside bb (Ona UI, `ona` CLI, auto-stop, restarts). Ona decides whether a
// box runs; bb holds the intent (active or suspended). `decide` maps both to
// one repair, and `docs/sync.md` documents every
// rule: change both together.
//
// Safety rules every action here keeps:
// 1. never wake compute: no start, no SSH unless Ona says RUNNING, except the starts docs/sync.md rule 1 names;
// 2. never stop compute: observed suspends skip the provider's stop;
// 3. never restart a live daemon: probe first (a restart kills running turns);
// 4. unknown is not gone: a failed listing, or one without the box, is unknown, never gone;
// 5. one action per machine at a time, with cooldown, backoff and give-up.

export const GRACE_MS = 45_000;
export const COOLDOWN_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
export const GIVE_UP_AFTER = 3;
/** The idle release's action name (src/sync.ts): the one action `pastGiveUp` lets past another action's give-up (rule 5). */
export const RELEASE_IDLE = "release-idle";

export interface MachineView {
  hostId: string;
  /** bb lifecycle phase: active, suspended, resuming, suspending, ... */
  phase: string;
  /** bb connection status: connected or disconnected. */
  status: string;
  /** When bb last heard from the daemon, epoch ms (null: never). */
  lastSeenAt: number | null;
  tunnel: "up" | "connecting" | "off";
  /** A thread is waiting for this machine right now. */
  threadWaiting: boolean;
  /**
   * bb is setting up, tearing down, retrying or retiring a workspace and needs the daemon. Skips
   * the grace period like a waiting thread, but never resumes a stopped box.
   */
  workspaceWaiting?: boolean;
}

/** What Ona says about the machine's environment. */
export type OnaView =
  | { kind: "unknown" }
  /** Absent from `streak` consecutive good listings. */
  | { kind: "missing"; streak: number; archived?: boolean }
  | { kind: "env"; phase: string };

type Action =
  | "none"
  /** Mark suspended in bb without stopping anything (rule 2). */
  | "suspend-observed"
  /** Probe the daemon over SSH and restart it only if it's dead (rule 3). */
  | "heal-daemon"
  | "ensure-tunnel";

export interface Decision {
  action: Action;
  reason: string;
  /** After suspend-observed: a thread is waiting, so let bb resume (start) the box. */
  resumeAfter?: boolean;
}

const RUNNING = "ENVIRONMENT_PHASE_RUNNING";
/** Ona shows the environment running; a failed listing is unknown (rule 4). */
export const shownRunning = (ona: { kind: string; phase?: string }) => ona.kind === "env" && ona.phase === RUNNING;
export const STOPPED = new Set(["ENVIRONMENT_PHASE_STOPPED", "ENVIRONMENT_PHASE_STOPPING"]);
const GONE = new Set(["ENVIRONMENT_PHASE_DELETED", "ENVIRONMENT_PHASE_DELETING"]);

export const short = (phase: string) => phase.replace(/^ENVIRONMENT_PHASE_/, "").toLowerCase();

/** The one repair (if any) for a machine, given bb's and Ona's views. */
export function decide(machine: MachineView, ona: OnaView, now: number): Decision {
  const { phase } = machine;
  // Suspended stays suspended until you use it, even if Ona runs the box.
  if (phase === "suspended") {
    return {
      action: "none",
      reason: shownRunning(ona) ? "suspended in bb, running in Ona" : "suspended",
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
  // Before "connected": after a reload bb shows the host connected until it notices the old tunnel is gone.
  if (ona.phase === RUNNING && machine.tunnel === "off")
    return { action: "ensure-tunnel", reason: "running in Ona but no tunnel" };
  if (machine.status === "connected") return { action: "none", reason: "connected" };
  if (STOPPED.has(ona.phase)) {
    return {
      action: "suspend-observed",
      reason: `Ona ${short(ona.phase)} the box`,
      resumeAfter: machine.threadWaiting,
    };
  }
  if (ona.phase !== RUNNING) return { action: "none", reason: `Ona is ${short(ona.phase)}` };
  const disconnectedFor = machine.lastSeenAt === null ? Infinity : now - machine.lastSeenAt;
  if (machine.threadWaiting || machine.workspaceWaiting || disconnectedFor >= GRACE_MS) {
    return {
      action: "heal-daemon",
      reason: machine.threadWaiting
        ? "a thread is waiting and the daemon isn't connected"
        : machine.workspaceWaiting
          ? "bb is setting up, tearing down, retrying or retiring a workspace and the daemon isn't connected"
          : "running in Ona but the daemon isn't connected",
    };
  }
  return { action: "none", reason: "disconnected briefly (waiting for it to come back)" };
}

/** A disagreement between bb's view of a box and Ona's, as the `metric mismatch` line names it (src/sync.ts). */
type MismatchKind = "active-stopped" | "active-gone" | "disconnected-running";

/**
 * The disagreement between bb's view and Ona's, or null. It only observes: decide() still picks the repair. An unknown
 * Ona state (a failed listing) and a box missing from one listing are no disagreement yet; the caller leaves such a
 * machine's entry as it was (rule 4).
 */
export function mismatch(machine: MachineView, ona: OnaView): MismatchKind | null {
  if (ona.kind === "unknown") return null;
  if (machine.phase !== "active") return null;
  // Gone, as decide() reads it: missing from two good listings, which onaView in src/sync.ts reports only when a lookup
  // by id finds no live box. Or Ona says deleted.
  if (ona.kind === "missing") return ona.streak >= 2 ? "active-gone" : null;
  if (GONE.has(ona.phase)) return "active-gone";
  if (machine.status === "connected") return STOPPED.has(ona.phase) ? "active-stopped" : null;
  return machine.status === "disconnected" && ona.phase === RUNNING ? "disconnected-running" : null;
}

/** How long a disagreement must last before its `metric mismatch` line is written. */
const MISMATCH_HOLD_MS = 120_000;

/** A disagreement carried from one pass to the next; `logged` once its line is written, so each incident logs once. */
export interface Mismatch {
  kind: MismatchKind;
  /** The first pass that saw this kind. */
  since: number;
  logged: boolean;
}

/**
 * One pass's step for a machine's disagreement. `kind` is mismatch()'s, and null means no kind, which drops the entry.
 * `entry` is what the next pass keeps: a new one when the kind changes, the same one otherwise. `log` is set on the one
 * pass where the disagreement first holds MISMATCH_HOLD_MS. `passStart` is the clock when the pass started
 * (src/sync.ts); the hold and `secs` are counted between those starts.
 */
export function trackMismatch(
  entry: Mismatch | undefined,
  kind: MismatchKind | null,
  passStart: number,
): { entry?: Mismatch; log?: { kind: MismatchKind; secs: number } } {
  if (kind === null) return {};
  const current = entry?.kind === kind ? entry : { kind, since: passStart, logged: false };
  if (current.logged || passStart - current.since < MISMATCH_HOLD_MS) return { entry: current };
  return { entry: { ...current, logged: true }, log: { kind, secs: Math.round((passStart - current.since) / 1000) } };
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
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
  /** Failures in a row, or across a hold (docs/sync.md rule 3); GIVE_UP_AFTER of them stop automatic retries but the idle release (rule 5). */
  failures: number;
  /** No automatic action before this time. */
  quietUntil: number;
  /**
   * A thread's pass failed on this box, forced or not, and the hold has not ended since (`run` and `connected()`
   * below; the events are in docs/sync.md rule 3).
   */
  threadWaiting?: boolean;
}

/** What an action returns when it asked nothing (a listing that failed or left the box out, rule 4): `run` records nothing for it. */
export const NOTHING_DONE = "nothing done";

/**
 * The idle release goes past another action's give-up for three failed releases, but not past a held one: rule 3 owns
 * that record (docs/sync.md rule 5).
 */
const pastGiveUp = (record: HostRecord, action: string | undefined) =>
  action === RELEASE_IDLE &&
  record.failures >= GIVE_UP_AFTER &&
  record.failures < 2 * GIVE_UP_AFTER &&
  record.action !== RELEASE_IDLE &&
  !record.threadWaiting;

/** Safety rule 5: one action per machine at a time, with a cooldown, backoff and give-up (docs/sync.md rules 3 and 5). */
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

  /** Whether any machine has an action in flight. */
  anyBusy(): boolean {
    return this.busy.size > 0;
  }

  /** Whether an automatic `action` may run now (not busy, not cooling down, not given up but as `pastGiveUp` says). */
  mayAct(hostId: string, force = false, action?: string): boolean {
    if (this.busy.has(hostId)) return false;
    if (force) return true;
    const record = this.records.get(hostId);
    if (!record) return true;
    const gaveUp = record.failures >= GIVE_UP_AFTER && !pastGiveUp(record, action);
    return !gaveUp && this.clock.now() >= record.quietUntil;
  }

  /**
   * A machine bb shows connected with its tunnel up, on a box Ona shows running: connected() ends a hold, clearing its
   * count and quiet period, and clears a failing daemon repair's count and quiet period. A box with no count and no
   * hold keeps its success cooldown (docs/sync.md rules 3 and 5).
   */
  connected(hostId: string): void {
    const record = this.records.get(hostId);
    // decide() runs a daemon repair only while bb shows the box disconnected, so a connected box has outgrown its count.
    if (record && (record.threadWaiting || (record.failures > 0 && record.action === "heal-daemon"))) {
      this.records.set(hostId, { ...record, failures: 0, quietUntil: this.clock.now(), threadWaiting: undefined });
    }
  }

  /**
   * Run `fn` as the machine's one action; a string it returns is appended to
   * the recorded reason, and NOTHING_DONE records nothing (run still returns true). Returns false (without
   * running it) when the machine is busy, or cooling down or given up (but as `pastGiveUp` says) unless forced
   * (docs/sync.md rules 3 and 5).
   */
  async run(
    hostId: string,
    action: string,
    reason: string,
    fn: () => Promise<string | void>,
    options: { force?: boolean; heavy?: boolean; cooldown?: boolean; threadWaiting?: boolean } = {},
  ): Promise<boolean> {
    const flagged = this.records.get(hostId)?.threadWaiting === true;
    const force = options.force || (options.threadWaiting === true && !flagged);
    if (!this.mayAct(hostId, force, action)) return false;
    this.busy.set(hostId, action);
    try {
      if (options.heavy) await this.acquire();
      let outcome: string | void;
      try {
        outcome = await fn();
      } finally {
        if (options.heavy) this.release();
      }
      if (outcome === NOTHING_DONE) return true;
      const now = this.clock.now();
      const current = this.records.get(hostId);
      const held = !force && !options.threadWaiting && current?.threadWaiting === true;
      this.records.set(hostId, {
        action,
        reason: outcome ? `${reason}; ${outcome}` : reason,
        at: now,
        failures: held ? current.failures : 0,
        quietUntil: options.cooldown === false ? now : now + COOLDOWN_MS,
        threadWaiting: held ? true : undefined,
      });
    } catch (error) {
      const current = this.records.get(hostId);
      const failures = (force ? 0 : (current?.failures ?? 0)) + 1;
      const now = this.clock.now();
      const quietUntil = now + Math.min(COOLDOWN_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      // A failed release keeps the give-up it went past, so that action's recovery (connected()) still clears it.
      if (!force && current && pastGiveUp(current, action)) {
        this.records.set(hostId, { ...current, failures, quietUntil });
        throw error;
      }
      this.records.set(hostId, {
        action,
        reason,
        at: now,
        error: error instanceof Error ? error.message : String(error),
        failures,
        quietUntil,
        threadWaiting: options.threadWaiting || (!force && current?.threadWaiting === true) ? true : undefined,
      });
      throw error;
    } finally {
      this.busy.delete(hostId);
    }
    return true;
  }

  /**
   * Run `fn` as the machine's one action and record nothing: no cooldown, backoff or give-up applies or follows.
   * Returns the action that holds the machine instead, without running `fn`, when it is busy (docs/sync.md rule 5).
   */
  async hold(hostId: string, action: string, fn: () => Promise<void>): Promise<string | undefined> {
    const holder = this.busy.get(hostId);
    if (holder) return holder;
    this.busy.set(hostId, action);
    try {
      await fn();
    } finally {
      this.busy.delete(hostId);
    }
    return undefined;
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
 * Remote script for rule 3: exit 0 if a process's command line names a path
 * under ~/.bb-machines (as given and resolved through symlinks), under $1 (as
 * given and resolved), or under $2 (as given and resolved through symlinks; a
 * relative $2 is resolved against $HOME first); 1 if none does; and 2 if the
 * process listing fails or can't be trusted, or a folder path has a newline. The
 * caller treats any other exit, an SSH failure and a timeout as unknown, and
 * restarts nothing.
 */
export const DAEMON_PROBE = [
  "me=$$; pp=$PPID",
  // A ps that exits non-zero, even after printing part of its list, is unknown.
  "out=$(ps -e -o pid= -o ppid= -o args=) || exit 2",
  'root="$HOME/.bb-machines"',
  // A relative $2 is matched as given and resolved against $HOME, an absolute one as given.
  "case $2 in /*|'') l=$2 ;; *) l=$HOME/$2 ;; esac",
  // Each folder is matched as given and resolved: a daemon's command line carries the resolved path.
  'for dir in "$root" "$(readlink -f "$root" 2>/dev/null)" "$1" "$(readlink -f "$1" 2>/dev/null)" "$2" "$l" "$(readlink -f "$l" 2>/dev/null)"; do',
  '  [ -n "$dir" ] || continue',
  // A newline in a folder path can't be matched within one listing line: the answer is unknown.
  '  case $dir in *"',
  '"*) exit 2 ;; esac',
  // This shell is skipped by pid; its $(...) subshell, which carries this shell's argv, by ppid. awk starts after the listing, so it is never in it.
  // A listing without this shell under its parent is untrusted (ps ignores -o, or no awk): the answer is 2.
  `  export d="$dir/"; printf '%s\\n' "$out" | awk -v me="$me" -v pp="$pp" '$1==me && $2==pp {ok=1} $1!=me && $1!=pp && $2!=me && index($0, ENVIRON["d"]) {f=1} END {exit ok ? !f : 2}'`,
  "  case $? in 0) exit 0 ;; 1) ;; *) exit 2 ;; esac",
  "done",
  "exit 1",
].join("\n");
