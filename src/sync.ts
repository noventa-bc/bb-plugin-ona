// One sync pass between bb and Ona, and the status it reports: which machines
// the plugin manages, what each needs (decide() in reconcile.ts), carrying
// that out under the guard, and letting idle boxes go. server.ts wires it to
// bb's events and commands; tests drive it with a fake of the bb calls below.
import { isArchived, isRunning, type OnaListing } from "./ona.ts";
import { PROVIDER_ID, resourceSchema, type OnaResource } from "./provider.ts";
import {
  lifecycleRefusal,
  machinesToRelease,
  parseDuration,
  RESUMED,
  SUSPENDED,
  workspaceWork,
  type MachineActivity,
  type WorkspaceView,
} from "./lifecycle.ts";
import {
  ALL,
  decide,
  GIVE_UP_AFTER,
  type Decision,
  type HostGuard,
  type MachineView,
  type OnaView,
} from "./reconcile.ts";
import { threadStatuses } from "./updates.ts";

export const RELEASING_KEY = "releasing";
export const connectedAtKey = (envId: string) => `connectedAt:${envId}`;

/** Drop the plugin's stored keys for one box; the provider's remove() calls it. */
export async function forgetBox(
  kv: {
    get<T>(key: string): Promise<T | null | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  },
  envId: string,
): Promise<void> {
  await kv.delete(connectedAtKey(envId));
  const releasing = (await kv.get<string[]>(RELEASING_KEY)) ?? [];
  if (releasing.includes(envId))
    await kv.set(
      RELEASING_KEY,
      releasing.filter((id) => id !== envId),
    );
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
export interface ThreadRecord {
  status: string;
  queuedWork?: string | null;
  updatedAt: number;
  lastReadAt?: number | null;
  runtime: { displayStatus: string };
}

/** The parts of bb's plugin API a sync pass uses; the real `bb` satisfies it. */
export interface SyncBb {
  sdk: {
    hosts: {
      list(): Promise<readonly BbHost[]>;
      experimental_suspend(args: { hostId: string }): Promise<BbHost>;
      experimental_resume(args: { hostId: string }): Promise<BbHost>;
      experimental_reconcile(args: { hostId: string }): Promise<BbHost>;
    };
    threads: { list(args: { hostId: string }): Promise<readonly ThreadRecord[]> };
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
  };
  ona: {
    getEnvironmentIfExists(envId: string, signal?: AbortSignal): Promise<Parameters<typeof isArchived>[0] | null>;
  };
  guard: HostGuard;
  tunnels: { status(envId: string): "up" | "connecting" | "off"; ensure(envId: string): void };
  provider: {
    takeRelease(envId: string): Promise<boolean>;
    daemonAlive(resource: OnaResource, signal: AbortSignal): Promise<boolean | null>;
    reconnect(
      resource: OnaResource,
      report: { step(text: string): void; log(text: string): void },
      signal: AbortSignal,
    ): Promise<unknown>;
  };
  rememberTunnel(envId: string): Promise<void>;
  keepAliveUntil(envId: string): number | null;
  /** Ona env id -> bb host id, refreshed on every pass; shared with the tunnels and events. */
  hostByEnv: Map<string, string>;
  autoRepair: boolean;
  idleDisconnect: string;
  pluginStartedAt: number;
}

export interface Row {
  hostId: string;
  machine: string;
  status: string;
  /** bb lifecycle phase (active, suspended, resuming, ...). */
  phase: string;
  /** When bb last heard from the daemon. */
  lastSeenAt: number | null;
  /** Last change to the host record; stands in for "phase entered at". */
  updatedAt: number;
  resource: OnaResource;
}

/** A user's ref names a row by bb host id, bb machine name, Ona env id or Ona env name. */
export const matchesRef = (row: Row, ref: string) =>
  [row.hostId, row.machine, row.resource.envId, row.resource.envName].includes(ref);

export interface StatusRow {
  machine: string;
  hostId: string;
  bb: string;
  tunnel: string;
  ona: string;
  /** What the latest check concluded, and since when. */
  now: { reason: string; since: number } | null;
  /** The last action the plugin took (or the one in flight). */
  last: { action: string; reason: string; at: number; error?: string } | null;
  retry: string | null;
  /** When a `bb ona keep-alive` ends, epoch ms. */
  keepAliveUntil: number | null;
  /** Workspaces whose teardown failed for good; bb won't suspend the machine. */
  needsRecovery: number;
}

export type Sync = ReturnType<typeof createSync>;

export function createSync(deps: SyncDeps) {
  const { bb, snapshot, ona, guard, tunnels, provider, rememberTunnel, hostByEnv, autoRepair, idleDisconnect } = deps;
  const pluginStartedAt = deps.pluginStartedAt;
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  async function machines(): Promise<Row[]> {
    const hosts = await bb.sdk.hosts.list();
    const rows: Row[] = [];
    for (const host of hosts) {
      if (host.machineProviderId !== PROVIDER_ID) continue;
      const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(host.id));
      if (!parsed.success) continue;
      // A suspended machine reports "disconnected"; surface the suspension itself.
      const status = host.lifecycle?.suspendedAt ? "suspended" : String(host.status);
      rows.push({
        hostId: host.id,
        machine: host.name,
        status,
        phase: host.lifecycle?.phase ?? "active",
        lastSeenAt: host.lastSeenAt ?? null,
        updatedAt: host.updatedAt,
        resource: parsed.data,
      });
    }
    hostByEnv.clear();
    for (const row of rows) hostByEnv.set(row.resource.envId, row.hostId);
    return rows;
  }

  /**
   * Mark a machine suspended in bb without stopping its box (the provider's
   * suspend sees the flag in takeRelease). Used when Ona already stopped or
   * lost the box, and when an idle box is let go for Ona's own timeout.
   */
  async function suspendWithoutStop(row: Row): Promise<void> {
    const releasing = (await bb.storage.kv.get<string[]>(RELEASING_KEY)) ?? [];
    if (!releasing.includes(row.resource.envId))
      await bb.storage.kv.set(RELEASING_KEY, [...releasing, row.resource.envId]);
    try {
      const host = await bb.sdk.hosts.experimental_suspend({ hostId: row.hostId });
      const refusal = lifecycleRefusal(host.lifecycle, SUSPENDED);
      if (refusal) throw new Error(refusal);
    } catch (error) {
      // Don't leave the flag behind for a later user suspend, which should stop the box.
      await provider.takeRelease(row.resource.envId);
      throw error;
    }
  }

  /**
   * Let go of boxes with no thread activity for the idleDisconnect window.
   * The tunnel bb keeps open counts as activity to Ona, so without this no
   * box ever idles out while bb runs. The machine is marked suspended without
   * stopping the environment; Ona's own timeout stops it, and bb's resume
   * reconnects or restarts it when a thread needs it.
   */
  const idleMs = parseDuration(idleDisconnect);
  async function releaseIdleMachines(rows: Row[]): Promise<void> {
    if (idleMs <= 0) return;
    const candidates = rows.filter((row) => row.phase === "active" && guard.mayAct(row.hostId));
    const activity: MachineActivity[] = [];
    for (const row of candidates) {
      const threads = await bb.sdk.threads.list({ hostId: row.hostId });
      const connectedAt = (await bb.storage.kv.get<number>(connectedAtKey(row.resource.envId))) ?? pluginStartedAt;
      activity.push({
        hostId: row.hostId,
        phase: row.phase,
        threadStatuses: threadStatuses(threads),
        lastActivityAt: Math.max(
          connectedAt,
          ...threads.map((thread) => Math.max(thread.updatedAt, thread.lastReadAt ?? 0)),
        ),
        // Letting the box go mid-hook leaves bb unable to recover the workspace.
        workspacesBlock: await workspaces(row.hostId).then((work) => work.busy || work.needsRecovery > 0),
      });
    }
    for (const hostId of machinesToRelease(activity, Date.now(), idleMs)) {
      const row = candidates.find((r) => r.hostId === hostId)!;
      const reason = `idle for ${idleDisconnect}; Ona's own timeout will stop the box`;
      await guard
        .run(
          hostId,
          "release-idle",
          reason,
          async () => {
            bb.log.info(`${row.machine}: ${reason}; closing the tunnel`);
            await suspendWithoutStop(row);
          },
          { cooldown: false },
        )
        .catch((error) => {
          bb.log.warn(`${row.machine}: could not let go: ${errorText(error)}`);
        });
    }
  }

  /** Consecutive good listings each missing env was absent from (rule 4). */
  const missing = new Map<string, { streak: number; at: number; archived?: boolean }>();

  function onaView(envId: string, listing: OnaListing | null): OnaView {
    // An empty list is as likely a CLI/context problem as "no environments".
    if (!listing || listing.envs.length === 0) return { kind: "unknown" };
    const env = listing.envs.find((e) => e.id === envId);
    if (env) {
      missing.delete(envId);
      return { kind: "env", phase: env.status?.phase ?? "" };
    }
    const seen = missing.get(envId);
    const streak = seen?.at === listing.at ? seen.streak : (seen?.streak ?? 0) + 1;
    missing.set(envId, { streak, at: listing.at, archived: seen?.archived });
    return { kind: "missing", streak, archived: seen?.archived };
  }

  /**
   * Archived environments drop out of `ona environment list`. Before a box is
   * reported gone, ask Ona about it once. An id Ona says doesn't exist is
   * gone. A failed lookup is unknown (rule 4): nothing is settled and the next
   * pass asks again.
   */
  async function checkArchived(envId: string): Promise<void> {
    const seen = missing.get(envId);
    if (!seen || seen.streak < 2 || seen.archived !== undefined) return;
    try {
      const env = await ona.getEnvironmentIfExists(envId, AbortSignal.timeout(30_000));
      seen.archived = env !== null && isArchived(env);
    } catch (error) {
      bb.log.info(`${envId}: couldn't ask Ona whether it is archived: ${errorText(error)}`);
    }
  }

  /** bb's workspace work on a machine; a failed lookup counts as none (the behaviour before this check). */
  async function workspaces(hostId: string): Promise<{ busy: boolean; needsRecovery: number }> {
    try {
      return workspaceWork(await bb.sdk.environments.list({ hostId }));
    } catch (error) {
      bb.log.info(`couldn't list workspaces on ${hostId}: ${errorText(error)}`);
      return { busy: false, needsRecovery: 0 };
    }
  }

  async function threadWaiting(hostId: string): Promise<boolean> {
    const threads = await bb.sdk.threads.list({ hostId });
    return threads.some(
      (thread) => thread.runtime.displayStatus === "waiting-for-host" || thread.queuedWork === "waiting",
    );
  }

  /** Carry out one decision under the machine's guard (rule 5). */
  async function act(row: Row, decision: Decision, force: boolean): Promise<void> {
    const { hostId, machine, resource } = row;
    const heavy = decision.action === "heal-daemon" || decision.action === "reconcile-stuck";
    await guard
      .run(
        hostId,
        decision.action,
        decision.reason,
        async () => {
          bb.log.info(`${machine}: ${decision.action} (${decision.reason})`);
          switch (decision.action) {
            case "suspend-observed":
              await suspendWithoutStop(row);
              if (!decision.resumeAfter) return;
              // A thread is waiting on it: that's you using the box, so let bb start it.
              try {
                const host = await bb.sdk.hosts.experimental_resume({ hostId });
                const refusal = lifecycleRefusal(host.lifecycle, RESUMED);
                return refusal
                  ? `couldn't resume it for a waiting thread (${refusal})`
                  : "resumed for a waiting thread";
              } catch (error) {
                return `bb will resume it on your next message (${errorText(error)})`;
              }
            case "ensure-tunnel":
              tunnels.ensure(resource.envId);
              await rememberTunnel(resource.envId);
              return;
            case "heal-daemon": {
              // Rule 1: SSH starts stopped boxes, so re-check Ona right before it.
              const env = (await snapshot.refresh()).envs.find((e) => e.id === resource.envId);
              if (!env || !isRunning(env)) return "Ona no longer reports it running; nothing done";
              // Rule 3: restarting a live daemon would kill running turns.
              const alive = await provider.daemonAlive(resource, AbortSignal.timeout(30_000));
              if (alive === true) return "daemon is running; not restarting";
              if (alive === null) return "couldn't check the daemon over SSH; not restarting";
              const report = { step: (text: string) => bb.log.info(`${machine}: ${text}`), log: () => {} };
              await provider.reconnect(resource, report, AbortSignal.timeout(15 * 60_000));
              return "daemon was down; restarted it";
            }
            case "reconcile-stuck": {
              const host = await bb.sdk.hosts.experimental_reconcile({ hostId });
              return `bb now shows it ${host.lifecycle.phase}${host.lifecycle.message ? ` (${host.lifecycle.message})` : ""}`;
            }
            case "none":
              return;
            default: {
              const unhandled: never = decision.action;
              throw new Error(`unhandled action ${unhandled}`);
            }
          }
        },
        { force, heavy, cooldown: heavy },
      )
      .catch((error) => {
        bb.log.warn(`${machine}: ${decision.action} failed: ${errorText(error)}`);
      });
  }

  /**
   * One reconcile pass over `keys` (host ids, or ALL). Decisions come from
   * `decide` (src/reconcile.ts); actions run in the background under the
   * guard unless `wait` is set (`bb ona sync`).
   */
  async function reconcile(keys: Set<string>, options: { force?: boolean; wait?: boolean } = {}): Promise<void> {
    try {
      const rows = await machines();
      const targets = keys.has(ALL) ? rows : rows.filter((row) => keys.has(row.hostId));
      if (targets.length === 0) return;
      // Host-specific passes come from events where someone may be waiting: keep them fresher.
      const listing = await snapshot.get(keys.has(ALL) ? undefined : 5_000).catch((error) => {
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
          phaseSince: row.updatedAt,
          tunnel: tunnels.status(row.resource.envId),
          threadWaiting:
            row.phase === "active" && row.status !== "connected"
              ? await threadWaiting(row.hostId).catch(() => false)
              : false,
          workspaceWaiting:
            row.phase === "active" && row.status !== "connected" ? (await workspaces(row.hostId)).busy : false,
        };
        let onaState = onaView(row.resource.envId, listing);
        if (onaState.kind === "missing" && onaState.streak >= 2 && onaState.archived === undefined) {
          await checkArchived(row.resource.envId);
          onaState = onaView(row.resource.envId, listing);
        }
        const decision = decide(view, onaState, now);
        // With autoRepair off, only observed stops and deletions reach bb.
        const skipped = !autoRepair && decision.action !== "none" && decision.action !== "suspend-observed";
        guard.note(
          row.hostId,
          skipped ? `${decision.reason} (would ${decision.action}; autoRepair is off)` : decision.reason,
        );
        if (decision.action === "none" || skipped) continue;
        actions.push(act(row, decision, options.force ?? false));
      }
      if (keys.has(ALL)) await releaseIdleMachines(rows);
      if (options.wait) await Promise.all(actions);
    } catch (error) {
      bb.log.warn(`reconcile failed: ${errorText(error)}`);
    }
  }

  async function statusRows(ref?: string): Promise<StatusRow[]> {
    const rows = (await machines()).filter((r) => !ref || matchesRef(r, ref));
    const listing = await snapshot.get().catch(() => snapshot.latest);
    return Promise.all(
      rows.map(async (row) => {
        const env = listing?.envs.find((e) => e.id === row.resource.envId);
        const record = guard.records.get(row.hostId);
        const busy = guard.busyWith(row.hostId);
        return {
          machine: row.machine,
          hostId: row.hostId,
          bb: row.phase === "active" ? row.status : row.phase,
          tunnel: tunnels.status(row.resource.envId),
          ona: !listing
            ? "unknown"
            : env
              ? (env.status?.phase ?? "?").replace(/^ENVIRONMENT_PHASE_/, "").toLowerCase()
              : missing.get(row.resource.envId)?.archived
                ? "archived"
                : "missing",
          now: guard.seen.get(row.hostId) ?? null,
          last: busy
            ? { action: busy, reason: "in progress", at: Date.now() }
            : record
              ? {
                  action: record.action,
                  reason: record.reason,
                  at: record.at,
                  ...(record.error ? { error: record.error } : {}),
                }
              : null,
          retry:
            !record || record.failures === 0
              ? null
              : record.failures >= GIVE_UP_AFTER
                ? `gave up after ${record.failures} failures; run \`bb ona sync ${row.machine}\``
                : `retrying after ${new Date(record.quietUntil).toLocaleTimeString()}`,
          keepAliveUntil: deps.keepAliveUntil(row.resource.envId),
          needsRecovery: (await workspaces(row.hostId)).needsRecovery,
        };
      }),
    );
  }

  return { machines, reconcile, statusRows, missing, workspaces, suspendWithoutStop };
}
