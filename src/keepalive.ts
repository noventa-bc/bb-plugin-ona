// `bb ona keep-alive`: hold off Ona's inactivity timeout for a running box,
// only because the user asked (see decision 0004). The plugin runs
// `ona environment keep-alive -- sleep <s>` on this Mac, one per box; Ona's CLI
// sends activity signals while the sleep runs. No SSH.
import { parseDuration } from "./lifecycle.ts";

export const KEEP_ALIVE_MAX_MS = 12 * 3_600_000;

export type KeepAliveRequest = { kind: "off" } | { kind: "for"; ms: number } | { kind: "invalid"; message: string };

/** "off", or a duration ("90m", "2h", bare minutes) above 0 and at most 12h. */
export function parseKeepAlive(value: string | undefined): KeepAliveRequest {
  if (value === undefined || value.trim() === "") {
    return { kind: "invalid", message: "Give a duration (e.g. `2h`, `90m`, at most `12h`) or `off`." };
  }
  if (value.trim().toLowerCase() === "off") return { kind: "off" };
  const ms = parseDuration(value);
  if (ms <= 0) {
    return { kind: "invalid", message: `"${value}" is not a duration. Use e.g. \`2h\` or \`90m\` (at most \`12h\`).` };
  }
  if (ms > KEEP_ALIVE_MAX_MS) return { kind: "invalid", message: `"${value}" is longer than the 12h limit.` };
  return { kind: "for", ms };
}

/** argv for the ona CLI; every value is its own entry. */
export function keepAliveArgs(envId: string, ms: number): string[] {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return ["environment", "keep-alive", "--environment-id", envId, "-q", "--", "sleep", String(seconds)];
}

/** Local wall-clock time as HH:MM. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The part of a child process the registry needs. */
export interface KeepAliveChild {
  kill(): void;
  /** Calls `onExit` once when the process ends, for whatever reason. */
  onExit(onExit: (detail: string) => void): void;
}

/**
 * One keep-alive child per box. A new duration replaces the old child; `off`,
 * a listing that no longer shows the box running, and dispose end it.
 */
export class KeepAlives {
  private readonly running = new Map<string, { child: KeepAliveChild; until: number }>();
  private readonly spawn: (envId: string, ms: number) => KeepAliveChild;
  private readonly now: () => number;
  private readonly onEarlyExit: (envId: string, detail: string) => void;

  constructor(
    spawn: (envId: string, ms: number) => KeepAliveChild,
    onEarlyExit: (envId: string, detail: string) => void = () => {},
    now: () => number = Date.now,
  ) {
    this.spawn = spawn;
    this.onEarlyExit = onEarlyExit;
    this.now = now;
  }

  /** Starts (or replaces) the keep-alive for a box; returns when it ends. */
  start(envId: string, ms: number): number {
    this.stop(envId);
    const until = this.now() + ms;
    const child = this.spawn(envId, ms);
    const entry = { child, until };
    this.running.set(envId, entry);
    child.onExit((detail) => {
      // A replaced or stopped child exiting must not drop its successor.
      if (this.running.get(envId) !== entry) return;
      this.running.delete(envId);
      if (this.now() < until - 60_000) this.onEarlyExit(envId, detail);
    });
    return until;
  }

  /** Ends the keep-alive for a box; false if there was none. */
  stop(envId: string): boolean {
    const entry = this.running.get(envId);
    if (!entry) return false;
    this.running.delete(envId);
    entry.child.kill();
    return true;
  }

  /**
   * Ends the keep-alive of every listed box that isn't running; returns their
   * ids. A box missing from the listing is unknown, not stopped, and keeps it.
   */
  endNotRunning(listed: ReadonlyArray<{ id: string; running: boolean }>): string[] {
    const ended = listed.filter((env) => !env.running && this.running.has(env.id)).map((env) => env.id);
    for (const envId of ended) this.stop(envId);
    return ended;
  }

  stopAll(): void {
    for (const envId of [...this.running.keys()]) this.stop(envId);
  }

  until(envId: string): number | null {
    const entry = this.running.get(envId);
    return entry && entry.until > this.now() ? entry.until : null;
  }
}
