import { OnaSnapshot, type OnaEnvironment } from "../src/ona.ts";
import type { WorkspaceView } from "../src/lifecycle.ts";
import { HostGuard } from "../src/reconcile.ts";
import { createSync, type BbHost, type ThreadRecord } from "../src/sync.ts";
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
  listingMs?: number;
}

// A fake of the bb calls a sync pass makes (SyncBb), one Ona box per machine.
export function world(
  boxes: Box[],
  options: {
    refuse?: string;
    daemonAlive?: boolean | null;
    /** The daemon restart (the provider's reconnect) rejects with this message. */
    reconnectFails?: string;
    /** Ona lists every box STOPPED once the daemon check has run. */
    stopDuringProbe?: boolean;
    /** Keep a listing 15s fresh on a still clock, so only `refresh()` sees a change. */
    cached?: boolean;
    archived?: boolean | "not-found" | "fail";
    listing?: "fail" | "empty";
    /** bb's host lookup fails: with a plain error, or with only the SDK's `not_found` code (no status). */
    hostGet?: "fail" | "not_found";
    autoRepair?: boolean;
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
  const lifecycleCall =
    (name: string, phase: string) =>
    async ({ hostId }: { hostId: string }) => {
      calls.push(`${name} ${hostId}`);
      const host = hosts.get(hostId)!;
      host.lifecycle = options.refuse
        ? { ...host.lifecycle, message: options.refuse }
        : { ...host.lifecycle, phase, message: null };
      if (!options.refuse) host.updatedAt = Date.now();
      // Like the provider's suspend: a box without the no-stop flag gets stopped.
      const envId = byHost.get(hostId)!.envId;
      if (name === "suspend" && !options.refuse && !releasing.delete(envId)) calls.push(`stop ${envId}`);
      return host;
    };
  const envs = (): OnaEnvironment[] =>
    options.listing === "empty"
      ? []
      : boxes
          .filter((box) => box.ona !== null)
          .map((box) => ({
            id: box.envId,
            metadata: box.name ? { name: box.name } : {},
            status: { phase: `ENVIRONMENT_PHASE_${box.ona ?? "RUNNING"}` },
          }));
  const guard = new HostGuard();
  let tick = 0;
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
            return host;
          },
          experimental_suspend: lifecycleCall("suspend", "suspending"),
          experimental_resume: lifecycleCall("resume", "resuming"),
          experimental_reconcile: lifecycleCall("reconcile", "active"),
        },
        threads: {
          // Like bb: hidden threads only when asked, archived ones dropped when asked.
          list: async ({ hostId, includeHidden, archived }) => {
            const box = byHost.get(hostId);
            if (box?.listingMs) await tickClock(box.listingMs);
            const threads = box?.threads ?? [];
            if (threads === "fail") throw new Error("bb is down");
            return [...threads, ...(includeHidden ? (box?.hiddenThreads ?? []) : [])].filter(
              (thread) => archived !== false || thread.archivedAt == null,
            );
          },
        },
        environments: { list: async ({ hostId }) => byHost.get(hostId)?.workspaces ?? [] },
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
        if (options.listing === "fail") throw new Error("not logged in");
        return envs();
      },
      options.cached ? 15_000 : 0,
      options.cached ? () => tick : () => (tick += 60_000),
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
    },
    keepAliveUntil: () => null,
    hostByEnv: new Map(),
    autoRepair: options.autoRepair ?? true,
    idleDisconnect: "1h",
    pluginStartedAt: NOW - 2 * HOUR,
  });
  return { sync, calls, guard, kv, hosts, releasing, hostReads };
}

export const idle = (hostId: string, extra: Partial<Box> = {}): Box => ({ hostId, envId: `env-${hostId}`, ...extra });
