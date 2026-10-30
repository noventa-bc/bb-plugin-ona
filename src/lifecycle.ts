// Keep bb's view of a devbox in step with Ona's. Ona stops idle environments
// on its own; bb then only sees a disconnected "active" machine, offers no
// Resume and fails new threads. Marking those machines suspended lets bb show
// Resume and wake the box (through the provider's resume) when work arrives.
import { isStopped, type OnaEnvironment } from "./ona.ts";
import { hostIsBusy } from "./updates.ts";

export interface MachineState {
  hostId: string;
  envId: string;
  /** bb lifecycle phase: active, suspended, resuming, ... */
  phase: string;
  /** bb connection status: connected, disconnected, ... */
  status: string;
}

/** Host ids bb still treats as active although Ona has stopped their environment. */
export function machinesToSuspend(machines: readonly MachineState[], envs: readonly OnaEnvironment[]): string[] {
  const byId = new Map(envs.map((env) => [env.id, env]));
  return machines
    .filter((machine) => {
      if (machine.phase !== "active" || machine.status === "connected") return false;
      const env = byId.get(machine.envId);
      // A deleted environment can't be resumed; leave that machine for the user to remove.
      return env !== undefined && isStopped(env) && env.status?.phase !== "ENVIRONMENT_PHASE_DELETED";
    })
    .map((machine) => machine.hostId);
}

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
    .filter((machine) => machine.phase === "active" && !hostIsBusy(machine.threadStatuses) && now - machine.lastActivityAt >= idleMs)
    .map((machine) => machine.hostId);
}

/** "30m", "2h", "45s" or bare minutes to ms; empty, "0" or unparseable is 0 (off). */
export function parseDuration(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$/i.exec(value);
  if (!match) return 0;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, "": 60_000 }[match[2]!.toLowerCase() as "s" | "m" | "h" | ""];
  return Math.round(Number(match[1]) * unit);
}
