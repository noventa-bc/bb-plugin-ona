// Letting idle devboxes sleep: bb's tunnel counts as activity to Ona, so a
// box nobody uses is let go and Ona's own inactivity timeout stops it. Syncing
// changes made outside bb lives in reconcile.ts.
import { hostIsBusy } from "./updates.ts";

export interface MachineActivity {
  hostId: string;
  /** bb lifecycle phase: active, suspended, resuming, ... */
  phase: string;
  /** Statuses of the threads on this machine. */
  threadStatuses: readonly string[];
  /** Latest thread activity or (re)connect, epoch ms. */
  lastActivityAt: number;
}

/**
 * Host ids bb holds active although nothing has happened on them for
 * `idleMs`. Their tunnel is what keeps Ona from stopping the box, so they
 * are let go; bb resumes them when a thread needs them again.
 */
export function machinesToRelease(machines: readonly MachineActivity[], now: number, idleMs: number): string[] {
  if (idleMs <= 0) return [];
  return machines
    .filter(
      (machine) =>
        machine.phase === "active" && !hostIsBusy(machine.threadStatuses) && now - machine.lastActivityAt >= idleMs,
    )
    .map((machine) => machine.hostId);
}

/**
 * Why bb didn't take a suspend it accepted, or null if it did. bb can answer a
 * suspend request without suspending (for example while it blocks lifecycle
 * changes on a host after an interrupted environment hook).
 */
export function suspendRefusal(lifecycle: { phase: string; message: string | null } | undefined): string | null {
  if (!lifecycle || lifecycle.phase === "suspending" || lifecycle.phase === "suspended") return null;
  return `bb kept the machine ${lifecycle.phase}${lifecycle.message ? `: ${lifecycle.message}` : ""}`;
}

/** "30m", "2h", "45s" or bare minutes to ms; empty, "0" or unparseable is 0 (off). */
export function parseDuration(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$/i.exec(value);
  if (!match) return 0;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, "": 60_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | ""];
  return Math.round(Number(match[1]) * unit);
}
