import { OnaSnapshot, type OnaEnvironment } from "../src/ona.ts";
import type { WorkspaceView } from "../src/lifecycle.ts";
import { HostGuard } from "../src/reconcile.ts";
import { createSync, type BbHost, type SyncDeps, type ThreadRecord } from "../src/sync.ts";
import { tick as tickClock } from "./fake-clock.ts";

export const HOUR = 3_600_000;
export const NOW = Date.now();

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
    daemonAlive?: boolean | null;
    pluginStartedAt?: number;
    /** The daemon restart (the provider's reconnect) rejects with this message. */
    reconnectFails?: string;
    /** Ona lists every box STOPPED once the daemon check has run. */
    stopDuringProbe?: boolean;
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
  } = {},
) {
  const calls: string[] = [];
  /** Host reads bb served: "list", or "get <hostId>". */
  const hostReads: string[] = [];
  const kv = new Map<string, unknown>();
  const releasing = new Set<string>();
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
    (name: string, phase: string) =>
    async ({ hostId }: { hostId: string }) => {
      calls.push(`${name} ${hostId}`);
      const host = hosts.get(hostId)!;
      if (name === "suspend" && options.suspendSettles) {
        host.lifecycle = { ...host.lifecycle, ...options.suspendSettles };
      } else {
        host.lifecycle = options.refuse
          ? { ...host.lifecycle, message: options.refuse }
          : { ...host.lifecycle, phase, message: null };
      }
      if (!options.refuse) host.updatedAt = Date.now();
      if (name === "suspend" && !options.refuse) pendingSuspends.add(hostId);
      // bb answers a suspend before it runs (still suspending); hosts.get shows the phase it settles on.
      return name === "suspend" ? { ...host, lifecycle: { ...host.lifecycle, phase: "suspending" } } : host;
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
  const sync = createSync({
    bb: {
      sdk: {
        hosts: {
          list: async () => {
            hostReads.push("list");
            return [...hosts.values()];
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
          experimental_suspend: lifecycleCall("suspend", "suspended"),
          experimental_resume: lifecycleCall("resume", "resuming"),
          experimental_reconcile: lifecycleCall("reconcile", "active"),
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
      log: { info: () => {}, warn: () => {} },
    },
    // No cache and a ticking clock (unless `cached`): every pass gets its own listing.
    snapshot: new OnaSnapshot(
      async () => {
        if (options.listing === "fail" || listingsServed >= (options.listingFailsAfter ?? Infinity))
          throw new Error(options.listingError ?? "not logged in");
        if (options.listingMs) await tickClock(options.listingMs);
        listingsServed++;
        return envs();
      },
      options.cached ? 15_000 : 0,
      options.cached ? () => Date.now() : () => (tick += 60_000),
    ),
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
    tunnels: {
      status: (envId) => boxes.find((box) => box.envId === envId)?.tunnel ?? "up",
      ensure: (envId) => void calls.push(`tunnel ${envId}`),
    },
    provider: {
      releasing,
      daemonAlive: async () => {
        calls.push("probe");
        if (options.stopDuringProbe) for (const box of boxes) box.ona = "STOPPED";
        return options.daemonAlive ?? true;
      },
      reconnect: async () => {
        calls.push("restart daemon");
        if (options.reconnectFails) throw new Error(options.reconnectFails);
      },
      wake:
        options.wake ??
        (async (resource) => {
          calls.push(`wake ${resource.envId}`);
          return false;
        }),
    },
    keepAliveUntil: () => null,
    hostByEnv: new Map(),
    autoRepair: options.autoRepair ?? true,
    idleDisconnect: "1h",
    pluginStartedAt: options.pluginStartedAt ?? NOW - 2 * HOUR,
  });
  return { sync, calls, guard, kv, hosts, releasing, hostReads };
}

export const idle = (hostId: string, extra: Partial<Box> = {}): Box => ({ hostId, envId: `env-${hostId}`, ...extra });
