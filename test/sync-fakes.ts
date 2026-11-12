import { OnaSnapshot, type OnaEnvironment } from "../src/ona.ts";
import type { WorkspaceView } from "../src/lifecycle.ts";
import { HostGuard } from "../src/reconcile.ts";
import { createSync, type BbHost, type SyncDeps, type ThreadRecord } from "../src/sync.ts";
import { tick as tickClock } from "./fake-clock.ts";

export const HOUR = 3_600_000;
export const NOW = Date.now();
/** The `metric mismatch` line a pass writes for the stopped box `idle("h1")`; its machine name is `ona:env-h1`. */
export const MISMATCH_LINE = "metric mismatch host=ona:env-h1 kind=active-stopped secs=120";

interface Box {
  hostId: string;
  envId: string;
  phase?: string;
  status?: string;
  lastSeenAt?: number;
  threads?: ThreadRecord[] | "fail";
  /** Threads bb lists only when asked for hidden ones (workflow workers, side chats). */
  hiddenThreads?: ThreadRecord[];
  /** The name Ona lists, when it differs from the stored one. */
  name?: string;
  workspaces?: WorkspaceView[];
  ona?: string | null;
  tunnel?: "up" | "off";
  /** Moves the mocked clock this far when the box's threads are listed, as a slow sibling would. */
  threadsMs?: number;
  /** Ona's listing fields beyond the phase: start time, timeout, activity signal, git (read by `boxFacts`). */
  listed?: Partial<OnaEnvironment>;
}

// A fake of the bb calls a sync pass makes (SyncBb), one Ona box per machine.
export function world(
  boxes: Box[],
  options: {
    refuse?: string;
    /** bb refuses only the resume: it answers with this message and the machine's phase unchanged. */
    resumeRefuses?: string;
    /** bb's resume call rejects with this message: an error, not a refusal on the host. */
    resumeThrows?: string;
    /** What an accepted resume settles on, instead of active: bb's failed resume leaves the machine suspended. */
    resumeSettles?: { phase: string; message: string | null };
    daemonAlive?: boolean | null;
    pluginStartedAt?: number;
    /** The daemon restart (the provider's reconnect) rejects with this message. */
    reconnectFails?: string;
    /** The provider's reconnect (the daemon restart); the default records it and honours `reconnectFails`. */
    reconnect?: SyncDeps["provider"]["reconnect"];
    /** The plugin's lifetime signal (server.ts `lifetime`), aborted when the plugin reloads. */
    signal?: AbortSignal;
    /** Ona lists every box STOPPED once the daemon check has run. */
    stopDuringProbe?: boolean;
    /** Ona lists every box STOPPED from the repair's own read (`refresh()`) on; the pass's read came before it. */
    stopBeforeRefresh?: boolean;
    /** Keep a listing 15s fresh, so only `refresh()` sees a change; the clock is the mocked Date when enabled. */
    cached?: boolean;
    archived?: boolean | "not-found" | "fail";
    listing?: "fail" | "empty";
    /** Listings after this many good ones throw, as when Ona goes down after a good list. */
    listingFailsAfter?: number;
    /** Moves the mocked clock this far when Ona's listing is fetched, as a slow listing would. */
    listingMs?: number;
    /** The message a failing listing throws; "" counts as a failure too. */
    listingError?: string;
    /** The repair's own listing read (`refresh()`) throws while this returns true; the pass's read still works. */
    refreshFails?: () => boolean;
    /** The repair's own read comes back without any box. */
    refreshEmpty?: () => boolean;
    /** The host whose workspace list throws. */
    workspacesFail?: string;
    /** bb's host lookup fails: with a plain error, or with only the SDK's `not_found` code (no status). */
    hostGet?: "fail" | "not_found";
    autoRepair?: boolean;
    /** The provider's wake (start and connect), as a waiting thread on an active machine asks for; the default records it. */
    wake?: SyncDeps["provider"]["wake"];
    /** What an accepted suspend settles on, instead of suspended: bb can settle a suspend as `removing`, for one. */
    suspendSettles?: { phase: string; message: string | null };
    /** The held host's suspend reads as suspending until `until` (a call such as "suspend h2") has been posted, or three reads pass. */
    holdSettle?: { hostId: string; until: string };
    /** The tunnel manager; the default records each ensure and never refuses one. */
    tunnels?: SyncDeps["tunnels"];
    /** Runs after bb answers a host listing ("list") or a lifecycle call ("suspend h1"), and during the daemon check
     * ("probe"), as a close landing then would. */
    afterCall?: (call: string) => void;
  } = {},
) {
  const calls: string[] = [];
  /** Host reads bb served: "list", or "get <hostId>". */
  const hostReads: string[] = [];
  const kv = new Map<string, unknown>();
  const releasing = new Set<string>();
  /** Lines the pass logs with bb.log.info, in order. */
  const logs: string[] = [];
  const hosts = new Map<string, BbHost>(
    boxes.map((box) => [
      box.hostId,
      {
        id: box.hostId,
        name: `ona:${box.envId}`,
        machineProviderId: "ona",
        status: box.status ?? "connected",
        lastSeenAt: box.lastSeenAt ?? NOW,
        updatedAt: NOW - HOUR,
        lifecycle: { phase: box.phase ?? "active", message: null, suspendedAt: null },
      },
    ]),
  );
  const byHost = new Map(boxes.map((box) => [box.hostId, box]));
  /** Suspends bb accepted and has not settled; the provider's suspend runs when bb settles one (hosts.get). */
  const pendingSuspends = new Set<string>();
  /** Settle reads of the held host so far (`holdSettle`). */
  let holdReads = 0;
  const lifecycleCall =
    (name: string, answered: string, settled: string) =>
    async ({ hostId }: { hostId: string }) => {
      calls.push(`${name} ${hostId}`);
      if (name === "resume" && options.resumeThrows) throw new Error(options.resumeThrows);
      const host = hosts.get(hostId)!;
      const refusal = (name === "resume" && options.resumeRefuses) || options.refuse;
      const settles = name === "suspend" ? options.suspendSettles : options.resumeSettles;
      if (settles) host.lifecycle = { ...host.lifecycle, ...settles };
      else
        host.lifecycle = refusal
          ? { ...host.lifecycle, message: refusal }
          : { ...host.lifecycle, phase: settled, message: null };
      if (!options.refuse) host.updatedAt = Date.now();
      if (name === "suspend" && !options.refuse) pendingSuspends.add(hostId);
      options.afterCall?.(`${name} ${hostId}`);
      // bb answers a suspend or resume it takes before it runs; hosts.get shows the phase it settles on.
      if (name === "resume" && refusal && !settles) return host;
      return { ...host, lifecycle: { ...host.lifecycle, phase: answered } };
    };
  const envs = (): OnaEnvironment[] =>
    options.listing === "empty"
      ? []
      : boxes
          .filter((box) => box.ona !== null)
          .map((box) => ({
            id: box.envId,
            metadata: { ...(box.name ? { name: box.name } : {}), ...box.listed?.metadata },
            spec: box.listed?.spec,
            status: { phase: `ENVIRONMENT_PHASE_${box.ona ?? "RUNNING"}`, ...box.listed?.status },
          }));
  const guard = new HostGuard();
  let tick = 0;
  let listingsServed = 0;
  // No cache and a ticking clock (unless `cached`): every pass gets its own listing.
  const listing = new OnaSnapshot(
    async () => {
      if (options.listing === "fail" || listingsServed >= (options.listingFailsAfter ?? Infinity))
        throw new Error(options.listingError ?? "not logged in");
      if (options.listingMs) await tickClock(options.listingMs);
      listingsServed++;
      return envs();
    },
    options.cached ? 15_000 : 0,
    options.cached ? () => Date.now() : () => (tick += 60_000),
  );
  // The repair's own read (`refresh`) can fail while the pass's read works (docs/sync.md rule 4).
  const refreshListing = listing.refresh.bind(listing);
  listing.refresh = async () => {
    if (options.refreshFails?.()) throw new Error("not logged in");
    if (options.stopBeforeRefresh) for (const box of boxes) box.ona = "STOPPED";
    const result = await refreshListing();
    return options.refreshEmpty?.() ? { ...result, envs: [] } : result;
  };
  const hostByEnv = new Map<string, string>();
  const sync = createSync({
    bb: {
      sdk: {
        hosts: {
          // Like bb's list: a creating host is left out unless `includeCreating` is set.
          list: async (args?: { includeCreating?: boolean }) => {
            hostReads.push("list");
            const listed = [...hosts.values()].filter(
              (host) => args?.includeCreating || host.lifecycle.phase !== "creating",
            );
            options.afterCall?.("list");
            return listed;
          },
          get: async ({ hostId }) => {
            hostReads.push(`get ${hostId}`);
            if (options.hostGet === "fail") throw new Error("bb is down");
            if (options.hostGet === "not_found")
              throw Object.assign(new Error("Host not found"), { code: "not_found" });
            const host = hosts.get(hostId);
            // bb answers 404 for a host it doesn't know, and for one it has destroyed.
            if (!host) throw Object.assign(new Error("Host not found"), { status: 404 });
            // The held host answers suspending until its `until` call has been posted, for three reads at most.
            const holding = options.holdSettle?.hostId === hostId && !calls.includes(options.holdSettle.until);
            if (holding && holdReads < 3) {
              holdReads++;
              return { ...host, lifecycle: { ...host.lifecycle, phase: "suspending" } };
            }
            // bb runs the provider's suspend as it settles an accepted suspend: a box whose no-stop flag is gone is stopped then.
            if (pendingSuspends.delete(hostId) && host.lifecycle.phase === "suspended") {
              const envId = byHost.get(hostId)!.envId;
              if (!releasing.delete(envId)) calls.push(`stop ${envId}`);
            }
            if (options.holdSettle?.hostId === hostId) calls.push(`settled ${hostId}`);
            return host;
          },
          experimental_suspend: lifecycleCall("suspend", "suspending", "suspended"),
          experimental_resume: lifecycleCall("resume", "resuming", "active"),
        },
        threads: {
          // Like bb: hidden threads only when asked, archived ones dropped when asked.
          list: async ({ hostId, includeHidden, archived }) => {
            const box = byHost.get(hostId);
            if (box?.threadsMs) await tickClock(box.threadsMs);
            const threads = box?.threads ?? [];
            if (threads === "fail") throw new Error("bb is down");
            return [...threads, ...(includeHidden ? (box?.hiddenThreads ?? []) : [])].filter(
              (thread) => archived !== false || thread.archivedAt == null,
            );
          },
        },
        environments: {
          list: async ({ hostId }) => {
            if (options.workspacesFail === hostId) throw new Error("bb is down");
            return byHost.get(hostId)?.workspaces ?? [];
          },
        },
      },
      experimental_machines: {
        getResource: async (hostId) => ({ envId: byHost.get(hostId)!.envId, envName: "box", adopted: true, key: "k" }),
      },
      storage: {
        kv: {
          get: async <T>(key: string) => kv.get(key) as T | undefined,
          set: async (key: string, value: unknown) => void kv.set(key, value),
        },
      },
      log: { info: (message) => void logs.push(message), warn: () => {} },
    },
    snapshot: listing,
    ona: {
      getEnvironmentIfExists: async (envId) => {
        calls.push(`ona get ${envId}`);
        if (options.archived === "fail") throw new Error("timed out");
        if (options.archived === undefined || options.archived === "not-found") return null;
        return {
          id: envId,
          metadata: options.archived ? { archivedAt: "2026-10-01T00:00:00Z" } : {},
          status: { phase: "ENVIRONMENT_PHASE_RUNNING" },
        };
      },
    },
    guard,
    tunnels: options.tunnels ?? {
      status: (envId) => boxes.find((box) => box.envId === envId)?.tunnel ?? "up",
      mark: () => 0,
      ensure: (envId) => {
        calls.push(`tunnel ${envId}`);
        return true;
      },
    },
    provider: {
      releasing,
      daemonAlive: async () => {
        calls.push("probe");
        if (options.stopDuringProbe) for (const box of boxes) box.ona = "STOPPED";
        options.afterCall?.("probe");
        // Bug: `options.daemonAlive ?? true` turned an unknown (null) answer into true.
        return options.daemonAlive === undefined ? true : options.daemonAlive;
      },
      reconnect:
        options.reconnect ??
        (async () => {
          calls.push("restart daemon");
          if (options.reconnectFails) throw new Error(options.reconnectFails);
        }),
      wake:
        options.wake ??
        (async (resource) => {
          calls.push(`wake ${resource.envId}`);
          return false;
        }),
    },
    keepAliveUntil: () => null,
    hostByEnv,
    autoRepair: options.autoRepair ?? true,
    idleDisconnect: "1h",
    pluginStartedAt: options.pluginStartedAt ?? NOW - 2 * HOUR,
    signal: options.signal ?? new AbortController().signal,
  });
  return { sync, calls, guard, kv, hosts, releasing, hostReads, hostByEnv, logs };
}

export const idle = (hostId: string, extra: Partial<Box> = {}): Box => ({ hostId, envId: `env-${hostId}`, ...extra });

/** A thread bb lists as waiting for its host. */
export const waitingThread = (): ThreadRecord => ({
  id: "t1",
  status: "active",
  updatedAt: NOW,
  runtime: { displayStatus: "waiting-for-host" },
});
