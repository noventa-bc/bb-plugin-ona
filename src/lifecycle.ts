// Letting idle devboxes sleep: bb's tunnel counts as activity to Ona, so a
// box nobody uses is let go and Ona's own inactivity timeout stops it. Syncing
// changes made outside bb lives in reconcile.ts.
import { z } from "zod";
import { hostIsBusy } from "./threads.ts";
import { pollUntil } from "./time.ts";

/** bb's suspend drain gives up after 5 minutes (docs/ona-notes.md), so a suspend is settled well within this. */
const SETTLE_MS = 6 * 60_000;
/**
 * The provider's resume gives up after 30 minutes (CAP_MINUTES in provider.ts): the wait outlasts bb's first attempt by
 * 2 minutes.
 */
const RESUME_SETTLE_MS = 32 * 60_000;

export interface MachineActivity {
  hostId: string;
  /** bb lifecycle phase: active, suspended, resuming, ... */
  phase: string;
  /** Statuses of the threads on this machine. */
  threadStatuses: readonly string[];
  /** Latest thread activity, or the stamp that starts the idle window (create, resume, `bb ona resume`, `bb ona reconnect`), epoch ms. */
  lastActivityAt: number;
  /** bb is setting up or tearing down a workspace on it, retiring one, retrying a failed teardown, or one needs recovery, or its lookup failed. */
  workspacesBlock?: boolean;
}

/**
 * The parts of a bb environment (a thread's workspace) this file reads. `retireAt` is
 * bb's retry time for a failed teardown, or the end of a retiring workspace's grace;
 * docs/ona-notes.md has bb's timing.
 */
export interface WorkspaceView {
  status: string;
  lifecycle: { phase: string; retireAt: number | null; teardown: { status: string } | null };
}

/** A failed teardown more than this far past retireAt reads as needing recovery: it doesn't count as busy or hurry a heal, but still keeps an idle box awake. A cutoff, not a guarantee (docs/ona-notes.md has bb's sweep timing). */
const OVERDUE_MS = 60_000;

/**
 * What bb is doing with a machine's workspaces. `busy`: a setup or teardown is
 * under way, bb is retrying a failed teardown, or a workspace is retiring (bb's grace
 * before its teardown); letting the box go now would interrupt or block it.
 * `needsRecovery`: failed teardowns bb has given up on, or
 * whose retry is more than OVERDUE_MS overdue; the plugin won't let an active machine go
 * idle until they clear.
 */
export function workspaceWork(
  workspaces: readonly WorkspaceView[],
  now: number,
): { busy: boolean; needsRecovery: number } {
  let busy = false;
  let needsRecovery = 0;
  for (const workspace of workspaces) {
    if (workspace.status === "creating" || workspace.status === "provisioning") busy = true;
    // The grace ends in a teardown, which needs the machine active in bb (docs/ona-notes.md).
    if (workspace.lifecycle.phase === "retiring") busy = true;
    if (workspace.lifecycle.phase !== "teardown") continue;
    const { retireAt, teardown } = workspace.lifecycle;
    if (teardown?.status === "failed" && (retireAt === null || retireAt < now - OVERDUE_MS)) needsRecovery++;
    else busy = true;
  }
  return { busy, needsRecovery };
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
        machine.phase === "active" &&
        !hostIsBusy(machine.threadStatuses) &&
        !machine.workspacesBlock &&
        now - machine.lastActivityAt >= idleMs,
    )
    .map((machine) => machine.hostId);
}

/**
 * Why bb didn't take a lifecycle request it accepted, or null if the machine
 * is in one of the `expected` phases. bb can answer a suspend or resume
 * without acting on it (for example while it blocks lifecycle changes on a
 * host after an interrupted environment hook), so every such call checks this.
 */
export function lifecycleRefusal(
  lifecycle: { phase: string; message: string | null } | undefined,
  expected: readonly string[],
): string | null {
  if (!lifecycle || expected.includes(lifecycle.phase)) return null;
  return `bb kept the machine ${lifecycle.phase}${lifecycle.message ? `: ${lifecycle.message}` : ""}`;
}

/**
 * What a failed suspend says to the user. bb's "Host is not connected" means its suspend could not drain the daemon,
 * which Ona's stop took away: a turn is still open on the box, so bb needs the box back to settle it.
 */
export function suspendFailure(refusal: string): string {
  return refusal.includes("Host is not connected")
    ? "bb can't suspend it while a turn is still active on the box; it needs the box back to settle the turn"
    : refusal;
}

/**
 * bb answers a suspend or resume before it runs (202, phase `suspending` or `resuming`); a failed drain leaves the
 * machine active, a failed resume leaves it suspended (or suspending, when it began there). `read` is polled until bb
 * leaves the `waiting` phase, and the lifecycle it settles on is returned. A read that rejects is asked again; the poll
 * fails on a deadline with no settled phase, on `signal` aborting, or at once on a `read` that throws when called.
 */
export async function settledLifecycle(
  read: () => Promise<{ lifecycle: { phase: string; message: string | null } }>,
  options: { waiting?: "suspending" | "resuming"; intervalMs?: number; deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<{ phase: string; message: string | null }> {
  const waiting = options.waiting ?? "suspending";
  // The message of the last read, when that read failed: a read that answers clears it.
  const failure: { message?: string } = {};
  const settled = await pollUntil(
    async () => {
      // A read that throws when called is a bug, not bb being down, so it surfaces here; a read that rejects is asked again.
      const pending = read();
      try {
        const host = await pending;
        failure.message = undefined;
        return host.lifecycle.phase !== waiting ? host : undefined;
      } catch (error: unknown) {
        failure.message = (error instanceof Error ? error.message : String(error)) || "no detail";
        return undefined;
      }
    },
    {
      deadlineMs: options.deadlineMs ?? (waiting === "resuming" ? RESUME_SETTLE_MS : SETTLE_MS),
      intervalMs: options.intervalMs ?? 1_000,
      // Without a signal only the deadline ends the poll, and the caller reads that as bb still running it.
      signal: options.signal ?? new AbortController().signal,
    },
  );
  if (!settled) {
    throw new Error(
      failure.message === undefined
        ? `bb is still ${waiting} the machine`
        : `bb is still ${waiting} the machine, or could not be read: ${failure.message}`,
    );
  }
  return settled.lifecycle;
}

export const SUSPENDED = ["suspending", "suspended"] as const;

// No `g` flag: the schema calls `.test()` on it, which a global regex makes stateful.
const DURATION = /^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$/i;

/** "30m", "2h", "45s" or bare minutes to ms; empty, "0" or unparseable is 0 (off). */
export function parseDuration(value: string): number {
  const match = DURATION.exec(value);
  if (!match) return 0;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, "": 60_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | ""];
  return Math.round(Number(match[1]) * unit);
}

/** The idleDisconnect setting: a form parseDuration reads, or empty for off. parseDuration reads a typo as off, so the form refuses it. */
export const idleDisconnectSchema = z
  .string()
  .refine(
    (value) => value.trim() === "" || DURATION.test(value),
    "idleDisconnect: use 30m, 2h, 45s or 90 (bare minutes); empty or 0 keeps every box connected",
  );
