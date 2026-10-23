// Keep bb's view of a devbox in step with Ona's. Ona stops idle environments
// on its own; bb then only sees a disconnected "active" machine, offers no
// Resume and fails new threads. Marking those machines suspended lets bb show
// Resume and wake the box (through the provider's resume) when work arrives.
import { isStopped, type OnaEnvironment } from "./ona.ts";

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
