// One sync pass between bb and Ona, and the status it reports: which machines
// the plugin manages, what each needs (decide() in reconcile.ts), carrying
// that out under the guard, and letting idle boxes go, plus the bb events that
// schedule a pass (watchRealtime). server.ts wires them to bb's commands and
// the lifecycle-sync service; tests drive them with a fake of the bb calls below.
import type { BbPluginApi, PluginLogger } from "@get-bb/plugin-sdk";
import { errorText, isArchived, isRunning, metric, type OnaListing } from "./ona.ts";
import type { WakeVia } from "./provider-connect.ts";
import { PROVIDER_ID, resourceSchema, type OnaResource } from "./provider.ts";
import {
  lifecycleRefusal,
  machinesToRelease,
  parseDuration,
  settledLifecycle,
  SUSPENDED,
  suspendFailure,
  workspaceWork,
  type MachineActivity,
  type WorkspaceView,
} from "./lifecycle.ts";
import {
  ALL,
  decide,
  GRACE_MS,
  mismatch,
  NOTHING_DONE,
  trackMismatch,
  type Decision,
  type HostGuard,
  type MachineView,
  type Mismatch,
  type OnaView,
  type PassScheduler,
  shownRunning,
} from "./reconcile.ts";
import { createStatusRows } from "./status.ts";
import { liveThreads, threadStatuses, type LiveThreadsArgs, type ThreadState } from "./updates.ts";

export const connectedAtKey = (envId: string) => `connectedAt:${envId}`;

/** Drop the plugin's stored keys for one box; the provider's remove() calls it. */
export async function forgetBox(kv: { delete(key: string): Promise<void> }, envId: string): Promise<void> {
  await kv.delete(connectedAtKey(envId));
}

interface HostLifecycle {
  phase: string;
  message: string | null;
  suspendedAt?: number | null;
}
/** The bb host fields a pass reads. */
export interface BbHost {
  id: string;
  name: string;
  machineProviderId: string | null;
  status: string;
  lastSeenAt: number | null;
  updatedAt: number;
  lifecycle: HostLifecycle;
}
/** The thread fields a pass reads. */
export interface ThreadRecord extends ThreadState {
  id: string;
  updatedAt: number;
  lastReadAt?: number | null;
  runtime: { displayStatus: string };
}

/** The parts of bb's plugin API a sync pass uses; the real `bb` satisfies it. */
export interface SyncBb {
  sdk: {
    hosts: {
      list(args?: { includeCreating?: boolean }): Promise<readonly BbHost[]>;
      get(args: { hostId: string }): Promise<BbHost>;
      experimental_suspend(args: { hostId: string }): Promise<BbHost>;
      experimental_resume(args: { hostId: string }): Promise<BbHost>;
    };
    threads: { list(args: LiveThreadsArgs): Promise<readonly ThreadRecord[]> };
    environments: { list(args: { hostId: string }): Promise<readonly WorkspaceView[]> };
  };
  experimental_machines: { getResource(hostId: string): Promise<unknown> };
  storage: {
    kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<void> };
  };
  log: { info(message: string): void; warn(message: string): void };
}

export interface SyncDeps {
  bb: SyncBb;
  snapshot: {
    get(maxAgeMs?: number): Promise<OnaListing>;
    refresh(): Promise<OnaListing>;
    readonly latest: OnaListing | null;
    /** The last failed listing's message; null once a listing succeeds. An empty message is still a failure. */
    readonly lastError: string | null;
  };
  ona: {
    getEnvironmentIfExists(envId: string, signal?: AbortSignal): Promise<Parameters<typeof isArchived>[0] | null>;
  };
  guard: HostGuard;
  /** `mark` and `ensure`'s `since`: src/ssh.ts `TunnelManager`. */
  tunnels: {
    status(envId: string): "up" | "connecting" | "off";
    mark(): number;
    ensure(envId: string, since: number): boolean;
  };
  provider: {
    /** Boxes whose next suspend must not stop them; the provider's suspend consumes the entry. */
    releasing: Set<string>;
    daemonAlive(resource: OnaResource, signal: AbortSignal): Promise<boolean | null>;
    reconnect(
      resource: OnaResource,
      report: { step(text: string): void; log(text: string): void },
      signal: AbortSignal,
      since: number,
    ): Promise<unknown>;
    /** Starts a stopped box and connects bb's daemon (`provider.wake`); a waiting thread on an active machine asks for it. */
    wake(
      resource: OnaResource,
      report: { step(text: string): void; log(text: string): void },
      signal: AbortSignal,
      cause: WakeVia,
      since: number,
    ): Promise<boolean>;
  };
  keepAliveUntil(envId: string): number | null;
  /** Ona env id -> bb host id, refreshed on every pass; shared with the tunnels and events. */
  hostByEnv: Map<string, string>;
  autoRepair: boolean;
  idleDisconnect: string;
  pluginStartedAt: number;
  /** The plugin's lifetime (server.ts): a reload aborts it, which ends a wake or restart in flight. */
  signal: AbortSignal;
}

export interface Row {
  hostId: string;
  machine: string;
  status: string;
  /** bb lifecycle phase (active, suspended, resuming, ...). */
  phase: string;
  /** When bb last heard from the daemon. */
  lastSeenAt: number | null;
  resource: OnaResource;
}

/** A user's ref names a row by bb host id, bb machine name, Ona env id or Ona env name. */
export const matchesRef = (row: Row, ref: string) =>
  [row.hostId, row.machine, row.resource.envId, row.resource.envName].includes(ref);

/** rowForRef's refusal of a name two boxes share. */
export class AmbiguousRefError extends Error {}

/**
 * Host id first: another box's Ona env name can equal a host id (`bb ona rename` takes any valid name). Other
 * names must pick one box: two boxes sharing a name throw, listing them, so the caller refuses the command.
 */
export const rowForRef = (rows: readonly Row[], ref: string): Row | undefined => {
  const byHost = rows.find((r) => r.hostId === ref);
  if (byHost) return byHost;
  const matches = rows.filter((r) => matchesRef(r, ref));
  if (matches.length > 1)
    throw new AmbiguousRefError(
      `"${ref}" matches ${matches.length} devboxes: ${matches.map((r) => `${r.machine} (${r.hostId})`).join(", ")}. Use a host id.`,
    );
  return matches[0];
};

export type Sync = ReturnType<typeof createSync>;

export function createSync(deps: SyncDeps) {
  const { bb, snapshot, ona, guard, tunnels, provider, hostByEnv, autoRepair, idleDisconnect, signal } = deps;
  const pluginStartedAt = deps.pluginStartedAt;

  /** The row for one bb host: null unless it is an Ona machine whose stored resource parses. */
  async function rowOf(host: BbHost, listing: OnaListing | null): Promise<Row | null> {
    if (host.machineProviderId !== PROVIDER_ID) return null;
    const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(host.id));
    if (!parsed.success) return null;
    // A suspended machine reports "disconnected"; surface the suspension itself.
    const status = host.lifecycle.suspendedAt ? "suspended" : String(host.status);
    return {
      hostId: host.id,
      machine: host.name,
      status,
      phase: host.lifecycle.phase,
      lastSeenAt: host.lastSeenAt ?? null,
      resource: {
        ...parsed.data,
        envName: listing?.envs.find((env) => env.id === parsed.data.envId)?.metadata.name ?? parsed.data.envName,
      },
    };
  }

  /** `includeCreating` adds the hosts bb is still creating; that call leaves `hostByEnv` as it was. */
  async function machines(options?: { includeCreating?: boolean }): Promise<Row[]> {
    const hosts = await bb.sdk.hosts.list(options);
    // The stored resource keeps the name the box was created or adopted with; the last listing has the current one.
    const listing = snapshot.latest;
    const rows: Row[] = [];
    for (const host of hosts) {
      const row = await rowOf(host, listing);
      if (row) rows.push(row);
    }
    if (!options?.includeCreating) {
      hostByEnv.clear();
      for (const row of rows) hostByEnv.set(row.resource.envId, row.hostId);
    }
    return rows;
  }

  /**
   * The Ona machine for one bb host, by one lookup instead of a listing. Null where `machines()`
   * leaves the host out: unknown or destroyed (a 404, or an SDK error with the `not_found` code),
   * still being created (the list leaves those out unless `includeCreating` is set), or not an
   * Ona machine. It leaves `hostByEnv` to the listing, which every sync pass refreshes.
   */
  async function machineOfHost(hostId: string): Promise<Row | null> {
    let host: BbHost;
    try {
      host = await bb.sdk.hosts.get({ hostId });
    } catch (error) {
      const failure = error as { status?: unknown; code?: unknown } | null;
      if (failure?.status === 404 || failure?.code === "not_found") return null;
      throw error;
    }
    if (host.lifecycle.phase === "creating") return null;
    return rowOf(host, snapshot.latest);
  }

  /**
   * Mark a machine suspended in bb without stopping its box (the provider's
   * suspend sees the flag in `releasing`). Used when Ona already stopped or
   * lost the box, and when an idle box is let go for Ona's own timeout. Resolves
   * with bb's lifecycle once bb has settled the suspend.
   */
  async function suspendWithoutStop(row: Row): Promise<HostLifecycle> {
    provider.releasing.add(row.resource.envId);
    const posted = await bb.sdk.hosts.experimental_suspend({ hostId: row.hostId }).catch((error: unknown) => {
      // Don't leave the flag behind for a later user suspend, which should stop the box.
      provider.releasing.delete(row.resource.envId);
      throw error;
    });
    const lifecycle =
      posted.lifecycle.phase === "suspending"
        ? await settledLifecycle(() => bb.sdk.hosts.get({ hostId: row.hostId }))
        : posted.lifecycle;
    // The provider's suspend consumes the flag when bb reaches it, and a suspended machine has been through it. A failed
    // suspend (active) never reaches it, so the flag goes back here. The flag stays for every other outcome: a settle that
    // timed out or failed (it throws above), and any other phase, since bb may still run the provider's suspend (removing).
    if (lifecycle.phase === "active") provider.releasing.delete(row.resource.envId);
    return lifecycle;
  }

  /**
   * Let go of boxes with no thread activity for the idleDisconnect window.
   * The tunnel bb keeps open counts as activity to Ona, so without this no
   * box ever idles out while bb runs. The machine is marked suspended without
   * stopping the environment; Ona's own timeout stops it, and bb's resume
   * reconnects or restarts it when a thread needs it.
   */
  const idleMs = parseDuration(idleDisconnect);
  async function releaseIdleMachines(rows: Row[], actions: Promise<void>[], force: boolean): Promise<void> {
    if (idleMs <= 0) return;
    const now = Date.now();
    const candidates = rows.filter((row) => row.phase === "active" && guard.mayAct(row.hostId, force));
    const activity: MachineActivity[] = [];
    for (const row of candidates) {
      const threads = await liveThreads(bb.sdk.threads, row.hostId).catch((error: unknown) => {
        bb.log.info(`couldn't list threads on ${row.hostId}: ${errorText(error)}`);
        return null;
      });
      if (threads === null) continue;
      const connectedAt = (await bb.storage.kv.get<number>(connectedAtKey(row.resource.envId))) ?? pluginStartedAt;
      const work = await workspaces(row.hostId, now);
      activity.push({
        hostId: row.hostId,
        phase: row.phase,
        threadStatuses: threadStatuses(threads),
        lastActivityAt: Math.max(
          connectedAt,
          ...threads.map((thread) => Math.max(thread.updatedAt, thread.lastReadAt ?? 0)),
        ),
        // Letting the box go mid-hook leaves bb unable to recover the workspace; a retry needs the machine active in bb (docs/ona-notes.md).
        workspacesBlock: work === null || work.busy || work.needsRecovery > 0,
      });
    }
    for (const hostId of machinesToRelease(activity, now, idleMs)) {
      const row = candidates.find((r) => r.hostId === hostId)!;
      const reason = `idle for ${idleDisconnect}; Ona's own timeout will stop the box`;
      // Started, not awaited: one box's settle must not hold the next box's suspend or the pass (reconcile waits for `actions` only under `wait`).
      actions.push(
        guard
          .run(
            hostId,
            "release-idle",
            reason,
            async () => {
              bb.log.info(`${row.machine}: ${reason}; closing the tunnel`);
              const refusal = lifecycleRefusal(await suspendWithoutStop(row), SUSPENDED);
              if (refusal) throw new Error(refusal);
            },
            { cooldown: false, force },
          )
          .then(
            () => undefined,
            (error: unknown) => {
              bb.log.warn(`${row.machine}: could not let go: ${errorText(error)}`);
            },
          ),
      );
    }
  }

  /** Consecutive good listings each missing env was absent from (rule 4), and the phase a lookup by id found. */
  const missing = new Map<string, { streak: number; at: number; archived?: boolean; phase?: string }>();

  /**
   * Ona's view of one box. The listing leaves some boxes out (archived, another
   * `ona context`, a long list, shared with you), so a box missing from two
   * listings is looked up by id, which counts as a listing (decision 0005).
   * Only an id Ona says doesn't exist is gone. A failed lookup is unknown
   * (rule 4): nothing is settled and the next pass asks again.
   */
  async function onaView(envId: string, listing: OnaListing | null): Promise<OnaView> {
    // An empty list is as likely a CLI/context problem as "no environments".
    if (!listing || listing.envs.length === 0) return { kind: "unknown" };
    const env = listing.envs.find((e) => e.id === envId);
    if (env) {
      missing.delete(envId);
      return { kind: "env", phase: env.status?.phase ?? "" };
    }
    const seen = missing.get(envId);
    const streak = seen?.at === listing.at ? seen.streak : (seen?.streak ?? 0) + 1;
    const entry: { streak: number; at: number; archived?: boolean; phase?: string } = {
      streak,
      at: listing.at,
      archived: seen?.archived,
    };
    missing.set(envId, entry);
    if (streak < 2 || entry.archived !== undefined) return { kind: "missing", streak, archived: entry.archived };
    try {
      const found = await ona.getEnvironmentIfExists(envId, AbortSignal.timeout(30_000));
      if (found && !isArchived(found)) {
        entry.phase = found.status?.phase ?? "";
        return { kind: "env", phase: entry.phase };
      }
      entry.archived = found !== null;
      return { kind: "missing", streak, archived: entry.archived };
    } catch (error) {
      bb.log.info(`${envId}: couldn't look it up in Ona: ${errorText(error)}`);
      return { kind: "unknown" };
    }
  }

  /**
   * bb's workspace work on a machine; null when the lookup failed. The idle release holds a box on null; reconcile reads null as none; status shows it as unreadable.
   */
  async function workspaces(hostId: string, now: number): Promise<{ busy: boolean; needsRecovery: number } | null> {
    try {
      return workspaceWork(await bb.sdk.environments.list({ hostId }), now);
    } catch (error) {
      bb.log.info(`couldn't list workspaces on ${hostId}: ${errorText(error)}`);
      return null;
    }
  }

  async function threadWaiting(hostId: string): Promise<boolean> {
    const threads = await liveThreads(bb.sdk.threads, hostId);
    return threads.some(
      (thread) => thread.runtime.displayStatus === "waiting-for-host" || thread.queuedWork === "waiting",
    );
  }

  /** Carry out one decision under the machine's guard (rule 5). `since`: the tunnels' mark taken before the row was read. */
  async function act(row: Row, decision: Decision, force: boolean, since: number): Promise<void> {
    const { hostId, machine, resource } = row;
    const heavy = decision.action === "heal-daemon";
    const report = { step: (text: string) => bb.log.info(`${machine}: ${text}`), log: () => {} };
    // A thread waiting on a stopped box must not wait out what other passes left (docs/sync.md rule 3).
    await guard
      .run(
        hostId,
        decision.action,
        decision.reason,
        async () => {
          bb.log.info(`${machine}: ${decision.action} (${decision.reason})`);
          switch (decision.action) {
            case "suspend-observed": {
              const lifecycle = await suspendWithoutStop(row);
              // The wake below is decided on this read, which follows the close this suspend may have made.
              const readAt = tunnels.mark();
              const refusal = lifecycleRefusal(lifecycle, SUSPENDED);
              if (refusal) {
                if (!decision.resumeAfter || lifecycle.phase !== "active") throw new Error(suspendFailure(refusal));
                // bb's suspend failed (Ona stopped the box under a live turn) and left the machine active, where bb's
                // resume does nothing: the plugin wakes the box (decision 0002).
                // It gives up after 30 minutes; a plugin reload ends it sooner (docs/sync.md rule 1).
                const startCalled = await provider.wake(resource, report, signal, "wake-thread", readAt);
                return startCalled ? "started it for a waiting thread" : "reconnected it for a waiting thread";
              }
              if (!decision.resumeAfter) return;
              // A thread is waiting on it: that's you using the box, so let bb start it.
              // Thrown: a returned string is a success, and a success clears the thread's hold (docs/sync.md rule 3).
              // bb answers `resuming` and runs the resume detached; a failed one ends suspended, so only `active` is done.
              let resumed: HostLifecycle;
              try {
                const posted = (await bb.sdk.hosts.experimental_resume({ hostId })).lifecycle;
                resumed =
                  posted.phase === "resuming"
                    ? await settledLifecycle(() => bb.sdk.hosts.get({ hostId }), { waiting: "resuming", signal })
                    : posted;
              } catch (error) {
                // A timed-out call or settle may hide a resume bb still runs, so the error doesn't claim it failed.
                throw new Error(`couldn't confirm the resume for a waiting thread (${errorText(error)})`);
              }
              const resumeRefusal = lifecycleRefusal(resumed, ["active"]);
              if (resumeRefusal) throw new Error(`couldn't resume it for a waiting thread (${resumeRefusal})`);
              return "resumed for a waiting thread";
            }
            case "ensure-tunnel":
              // Rule 8: a refused open is not done.
              if (!tunnels.ensure(resource.envId, since))
                throw new Error("bb suspended or removed the machine after this pass read it; tunnel not reopened");
              return;
            case "heal-daemon": {
              // Rule 1: SSH starts stopped boxes, so ask Ona before the daemon check and again right before a restart.
              // Rule 4: a listing that fails or leaves the box out is unknown (null); before the daemon check nothing ran (NOTHING_DONE).
              const runningNow = async () => {
                try {
                  const env = (await snapshot.refresh()).envs.find((e) => e.id === resource.envId);
                  return env ? isRunning(env) : null;
                } catch (error) {
                  bb.log.warn(`${machine}: Ona couldn't be asked (${errorText(error)})`);
                  return null;
                }
              };
              const gone = "Ona no longer reports it running; nothing done";
              const running = await runningNow();
              if (running === null) return NOTHING_DONE;
              if (!running) return gone;
              // Rule 3: restarting a live daemon would kill running turns.
              const alive = await provider.daemonAlive(resource, AbortSignal.timeout(30_000));
              if (alive === true) return "daemon is running; not restarting";
              if (alive === null)
                return "couldn't tell whether the daemon runs (SSH or the process check on the box failed); not restarting";
              // The check can take 30 s, long enough for the box to be stopped in Ona.
              const stillRunning = await runningNow();
              // The check's SSH ran: a failed pass, so its backoff and the give-up apply (rule 5).
              if (stillRunning === null)
                throw new Error("Ona couldn't confirm the box running before the restart; not restarting");
              if (!stillRunning) return gone;
              // It gives up after 30 minutes; a plugin reload ends it sooner (docs/sync.md rule 1).
              await provider.reconnect(resource, report, signal, since);
              return "daemon was down; restarted it";
            }
            case "none":
              return;
            default: {
              const unhandled: never = decision.action;
              throw new Error(`unhandled action ${unhandled}`);
            }
          }
        },
        { force, heavy, cooldown: heavy, threadWaiting: decision.resumeAfter },
      )
      .catch((error: unknown) => {
        bb.log.warn(`${machine}: ${decision.action} failed: ${errorText(error)}`);
      });
  }

  /** Each machine's disagreement with Ona, carried from pass to pass for the `metric mismatch` line (src/reconcile.ts). */
  const mismatches = new Map<string, Mismatch>();

  /**
   * One reconcile pass over `keys` (host ids, or ALL). Decisions come from
   * `decide` (src/reconcile.ts); actions run in the background under the
   * guard unless `wait` is set (`bb ona sync`).
   */
  async function reconcile(keys: Set<string>, options: { force?: boolean; wait?: boolean } = {}): Promise<void> {
    try {
      // Before the read: bb may suspend or remove a machine after it answers, and that close must win.
      const since = tunnels.mark();
      const rows = await machines();
      // A machine bb no longer lists drops its disagreement, so a later one starts its own hold.
      for (const hostId of mismatches.keys()) if (!rows.some((row) => row.hostId === hostId)) mismatches.delete(hostId);
      const targets = keys.has(ALL) ? rows : rows.filter((row) => keys.has(row.hostId));
      if (targets.length === 0) return;
      // Host-specific passes come from events where someone may be waiting: keep them fresher.
      const listing = await snapshot.get(keys.has(ALL) ? undefined : 5_000).catch((error: unknown) => {
        bb.log.warn(`could not list Ona environments: ${errorText(error)}`);
        return null;
      });
      const now = Date.now();
      const actions: Promise<void>[] = [];
      for (const row of targets) {
        const view: MachineView = {
          hostId: row.hostId,
          phase: row.phase,
          status: row.status,
          lastSeenAt: row.lastSeenAt,
          tunnel: tunnels.status(row.resource.envId),
          threadWaiting:
            row.phase === "active" && row.status !== "connected"
              ? await threadWaiting(row.hostId).catch(() => false)
              : false,
          workspaceWaiting:
            row.phase === "active" && row.status !== "connected"
              ? ((await workspaces(row.hostId, now))?.busy ?? false)
              : false,
        };
        const onaState = await onaView(row.resource.envId, listing);
        const decision = decide(view, onaState, now);
        // A failed listing, or one listing that omits the box, is no reading of it (rule 4): the entry stays as it was.
        const unread = onaState.kind === "unknown" || (onaState.kind === "missing" && onaState.streak < 2);
        if (!unread) {
          const tracked = trackMismatch(mismatches.get(row.hostId), mismatch(view, onaState), now);
          if (tracked.entry) mismatches.set(row.hostId, tracked.entry);
          else mismatches.delete(row.hostId);
          if (tracked.log) bb.log.info(metric("mismatch", { host: row.machine, ...tracked.log }));
        }
        // With autoRepair off, only observed stops and deletions (and the resume a waiting thread asks for) reach bb; tunnels reopen after a reload, and idle releases run below.
        const skipped = !autoRepair && !["none", "suspend-observed", "ensure-tunnel"].includes(decision.action);
        const reason = skipped ? `${decision.reason} (would ${decision.action}; autoRepair is off)` : decision.reason;
        guard.note(row.hostId, reason);
        // A connection the pass can trust ends a hold, and clears a failing daemon repair's count (docs/sync.md rule 3).
        if (view.status === "connected" && view.tunnel === "up" && shownRunning(onaState)) guard.connected(row.hostId);
        if (decision.action === "none" || skipped) continue;
        actions.push(act(row, decision, options.force ?? false, since));
      }
      // A failed or empty listing is unknown (docs/sync.md rule 4): no idle release that pass.
      if (keys.has(ALL) && listing?.envs.length && snapshot.lastError === null)
        await releaseIdleMachines(rows, actions, options.force ?? false);
      if (options.wait) await Promise.all(actions);
    } catch (error) {
      bb.log.warn(`reconcile failed: ${errorText(error)}`);
    }
  }

  const statusRows = createStatusRows({
    bb,
    snapshot,
    machines,
    matchesRef,
    missing,
    guard,
    tunnels,
    workspaces,
    keepAliveUntil: deps.keepAliveUntil,
  });

  return { machines, machineOfHost, reconcile, statusRows, missing, suspendWithoutStop };
}

/** The parts of bb's plugin API the realtime events use; the real `bb` satisfies it. */
export interface RealtimeBb {
  sdk: Pick<BbPluginApi["sdk"], "subscribe"> & {
    threads: { get(args: { threadId: string }): Promise<{ environmentId: string | null }> };
    environments: { get(args: { environmentId: string }): Promise<{ hostId: string }> };
  };
  log: Pick<PluginLogger, "warn">;
}

export interface RealtimeDeps {
  bb: RealtimeBb;
  scheduler: Pick<PassScheduler, "schedule">;
  /** Ona env id -> bb host id, the same map the sync pass refreshes. */
  hostByEnv: ReadonlyMap<string, string>;
}

/**
 * React when it matters instead of waiting for the poll: a thread waiting
 * for an Ona machine, an Ona machine dropping off, or a realtime reconnect
 * (events may have been missed). Every other event is dropped at the first
 * check; thread events fire constantly while a turn streams.
 */
export function watchRealtime({ bb, scheduler, hostByEnv }: RealtimeDeps): () => void {
  /** The bb host a thread runs on, if it has one yet. */
  async function hostOfThread(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  }

  const unsubscribers: Array<() => void> = [];
  const onaHost = (hostId: string | undefined): hostId is string =>
    hostId !== undefined && [...hostByEnv.values()].includes(hostId);
  try {
    unsubscribers.push(
      bb.sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          if (event.metadata?.statusChange?.runtime.displayStatus !== "waiting-for-host" || !event.id) return;
          void hostOfThread(event.id)
            .then((hostId) => {
              if (hostId && onaHost(hostId)) scheduler.schedule(hostId, 500);
            })
            .catch(() => {});
        },
      }),
      bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (!onaHost(event.id)) return;
          // Give a dropped daemon the grace period to come back on its own first.
          if (event.changes.includes("host-disconnected")) scheduler.schedule(event.id, GRACE_MS + 1_000);
          else if (event.changes.includes("host-connected")) scheduler.schedule(event.id, 2_000);
        },
      }),
      bb.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.reconnected) scheduler.schedule(ALL, 2_000);
        },
      }),
    );
  } catch (error) {
    bb.log.warn(`realtime events unavailable, relying on the 2-minute check: ${errorText(error)}`);
  }
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
