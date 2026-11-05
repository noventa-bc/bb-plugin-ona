// `bb ona resume <ref>` (decision 0002): asks the provider to start a stopped box and connect bb's daemon, for an active
// machine; a running box is only reconnected. It also holds the reconnect refusals that `bb ona reconnect` shares with it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CliResult } from "./commands.ts";
import { isRunning, isStarting, reasonOf, type OnaEnvironment, type OnaListing } from "./ona.ts";
import type { registerOnaProvider } from "./provider.ts";
import { short, STOPPED, type HostGuard } from "./reconcile.ts";
import type { Row } from "./sync.ts";

type HostPhase = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number]["lifecycle"]["phase"];

/** What to do about a machine `bb ona reconnect` refused. The switch covers every phase the SDK lists (lint checks it). */
function notActiveHint(phase: Exclude<HostPhase, "active">, machine: string): string {
  switch (phase) {
    // Which phases bb accepts a resume in: docs/ona-notes.md.
    case "suspended":
    case "suspending":
      return `Resume it with \`bb machine resume ${machine}\`.`;
    case "creating":
    case "resuming":
      break;
    case "removing":
    case "destroyed":
      return "It is gone or being removed.";
  }
  // Also a phase a newer bb adds: Row.phase is a string at runtime.
  return "Try again once bb shows it active.";
}

/** The refusal for a machine bb doesn't show active; `verb` says what the command was for. */
export function notActiveRefusal(row: Row, verb = "reconnected"): CliResult {
  const hint = notActiveHint(row.phase as Exclude<HostPhase, "active">, row.machine);
  return { exitCode: 1, stderr: `${row.machine} is ${row.phase} in bb, so it was not ${verb}. ${hint}` };
}

/** What `bb ona reconnect` says for a box Ona doesn't show running; `env` is undefined when Ona lists no such box. */
export function notRunningInOna(machine: string, env: OnaEnvironment | undefined): string {
  const check = `Check the box in Ona and \`bb ona status ${machine}\`.`;
  if (!env) return `${machine} is not listed in Ona, so it was not reconnected. ${check}`;
  const phase = env.status?.phase;
  const state = short(phase ?? "unknown");
  if (phase !== undefined && STOPPED.has(phase)) {
    return `${machine} is ${state} in Ona, so it was not reconnected. Once bb no longer shows it connected, \`bb ona sync ${machine}\` marks it suspended; then run \`bb machine resume ${machine}\`.`;
  }
  if (isStarting(env))
    return `${machine} is ${state} in Ona, so it was not reconnected. Try again once Ona shows it running.`;
  return `${machine} is ${state} in Ona, so it was not reconnected. ${check}`;
}

export interface ResumeDeps {
  snapshot: { refresh(): Promise<OnaListing>; readonly lastError: string | null };
  findMachine(ref: string): Promise<Row | null>;
  guard: HostGuard;
  provider: Pick<ReturnType<typeof registerOnaProvider>, "wake">;
}

/** `bb ona resume <ref>`: starts a stopped box and reconnects bb's daemon, or reconnects a running one (decision 0002). */
export async function resumeCommand(deps: ResumeDeps, ref: string, signal: AbortSignal): Promise<CliResult> {
  const { snapshot, findMachine, guard, provider } = deps;
  // Safety rule 1 (docs/sync.md): Ona is asked first; a box it can't be asked about is not touched.
  const listing = await snapshot.refresh().catch(() => null);
  if (!listing) {
    return {
      exitCode: 1,
      stderr: `Can't ask Ona whether ${ref} is running (${reasonOf(snapshot.lastError)}); not started. Check \`ona login\` and try again.`,
    };
  }
  const row = await findMachine(ref);
  if (!row) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
  // A tunnel keeps the box awake, so none opens on a machine bb doesn't show active (decision 0003).
  if (row.phase !== "active") return notActiveRefusal(row, "resumed");
  const env = listing.envs.find((e) => e.id === row.resource.envId);
  if (!env)
    return { exitCode: 1, stderr: `${row.machine} is not listed in Ona, so it was not resumed. Check the box in Ona.` };
  const steps: string[] = [];
  const report = { step: (text: string) => steps.push(text), log: () => {} };
  // guard.run is the busy check: it returns false, without running, while another action holds the machine.
  const ran = await guard.run(
    row.hostId,
    "resume",
    "requested with bb ona resume",
    async () => {
      await provider.wake(row.resource, report, signal);
    },
    { force: true, cooldown: false },
  );
  if (!ran) {
    return {
      exitCode: 1,
      stderr: `${row.machine} is busy (${guard.busyWith(row.hostId) ?? "another action"}); try again shortly or see \`bb ona status\`.`,
    };
  }
  const done = isRunning(env)
    ? `Reconnected ${row.machine}`
    : isStarting(env)
      ? `Waited for ${row.machine} to start and reconnected it`
      : `Started ${row.machine} and reconnected it`;
  return { exitCode: 0, stdout: [...steps, done].join("\n") };
}
