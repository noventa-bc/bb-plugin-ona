// Keep agent CLIs (Claude Code, Codex) current on Ona devboxes: apply the
// updates bb already detects, never install a CLI that isn't there.
// server.ts schedules updateClis; tests drive it with a fake of the bb calls below.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HostGuard } from "./reconcile.ts";
import type { Row } from "./sync.ts";
import { pollUntil } from "./time.ts";

export interface CliStatus {
  installed: boolean;
  needsUpdate: boolean;
  installAction: { kind: "install" | "update" } | null;
  currentVersion: string | null;
  latestVersion: string | null;
}

/** Providers (in `wanted` order) that are installed and have an update waiting. */
export function updatesToApply(statuses: Record<string, CliStatus>, wanted: readonly string[]): string[] {
  return wanted.filter((provider) => {
    const status = statuses[provider];
    return status !== undefined && status.installed && status.needsUpdate && status.installAction?.kind === "update";
  });
}

/** Threads in these states have an agent turn in flight; don't swap its CLI underneath it. */
const BUSY_THREAD_STATES = new Set(["active", "starting", "stopping", "pending"]);

export function hostIsBusy(statuses: readonly string[]): boolean {
  return statuses.some((status) => BUSY_THREAD_STATES.has(status));
}

export interface ThreadState {
  status: string;
  queuedWork?: string | null;
  archivedAt?: number | null;
}

/** The listing every reader asks bb for (see `liveThreads`). */
export type LiveThreadsArgs = { hostId: string; includeHidden: true; archived: false };

/**
 * The threads that hold or wake a box, for every reader. bb lists hidden threads (workflow workers,
 * side chats) only when asked, and they run on the box too; an archived one never counts, since bb
 * can leave it stuck "active".
 */
export function liveThreads<T extends ThreadState>(
  threads: { list(args: LiveThreadsArgs): Promise<readonly T[]> },
  hostId: string,
): Promise<readonly T[]> {
  return threads.list({ hostId, includeHidden: true, archived: false });
}

/** What `hostIsBusy` reads from bb's thread list: queued work waiting for the host counts as pending. */
export function threadStatuses(threads: readonly ThreadState[]): string[] {
  return threads.map((thread) => (thread.queuedWork === "waiting" ? "pending" : thread.status));
}

/** How long a busy thread goes without an update before `bb ona status` flags it. */
export const STUCK_THREAD_MS = 6 * 3_600_000;

/** Busy threads with no update for `STUCK_THREAD_MS`: they hold the box until they end. */
export function stuckThreads(threads: readonly (ThreadState & { id: string; updatedAt: number })[], now: number) {
  return threads
    .map((thread) => ({ id: thread.id, status: threadStatuses([thread])[0]!, updatedAt: thread.updatedAt }))
    .filter((thread) => hostIsBusy([thread.status]) && now - thread.updatedAt > STUCK_THREAD_MS);
}

export function parseProviderList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

type Hosts = BbPluginApi["sdk"]["hosts"];

/** The parts of bb's plugin API a CLI update uses; the real `bb` satisfies it. */
export interface UpdatesBb {
  sdk: {
    threads: { list(args: LiveThreadsArgs): Promise<readonly ThreadState[]> };
    hosts: {
      providerCliStatus(args: { hostId: string }): Promise<unknown>;
      installProviderCli(args: Parameters<Hosts["installProviderCli"]>[0]): ReturnType<Hosts["installProviderCli"]>;
    };
  };
}

export interface UpdatesDeps {
  bb: UpdatesBb;
  machines(): Promise<Row[]>;
  /** The `autoUpdateProviders` setting. */
  autoUpdateProviders: string;
  /** src/sync.ts; passed in because sync.ts imports this module. */
  rowForRef(rows: readonly Row[], ref: string): Row | undefined;
  guard: HostGuard;
  /** Ends a wait for an install the SDK gave up on (the plugin's lifetime). */
  signal: AbortSignal;
}

/** bb's limit on one CLI install; `docs/ona-notes.md` has the value. */
export const BB_INSTALL_LIMIT_MS = 15 * 60_000;
export const INSTALL_POLL_MS = 15_000;

export function createUpdateClis({ bb, machines, autoUpdateProviders, rowForRef, guard, signal }: UpdatesDeps) {
  /**
   * Apply pending agent-CLI updates on connected Ona devboxes. Returns one
   * line per box for the CLI and the plugin log.
   */
  return async function updateClis(options: { ref?: string; force?: boolean } = {}): Promise<string[]> {
    const wanted = parseProviderList(autoUpdateProviders);
    const lines: string[] = [];
    const rows = await machines();
    for (const row of options.ref ? [rowForRef(rows, options.ref)] : rows) {
      if (!row) continue;
      const name = row.resource.envName;
      if (row.status !== "connected") {
        lines.push(`${name}: skipped (${row.status})`);
        continue;
      }
      const holder = await guard.hold(row.hostId, "update-cli", async () => {
        if (!options.force) {
          if (hostIsBusy(threadStatuses(await liveThreads(bb.sdk.threads, row.hostId)))) {
            lines.push(`${name}: skipped (an agent is running; retry with --force)`);
            return;
          }
        }
        const statuses = (await bb.sdk.hosts.providerCliStatus({ hostId: row.hostId })) as Record<string, CliStatus>;
        const pending = updatesToApply(statuses, wanted);
        if (pending.length === 0) {
          lines.push(
            `${name}: up to date (${wanted.map((p) => `${p} ${statuses[p]?.currentVersion ?? "not installed"}`).join(", ")})`,
          );
          return;
        }
        for (const cli of pending) {
          const from = statuses[cli]?.currentVersion ?? "?";
          const to = statuses[cli]?.latestVersion ?? "latest";
          let events: Awaited<ReturnType<Hosts["installProviderCli"]>>;
          try {
            events = await bb.sdk.hosts.installProviderCli({ hostId: row.hostId, provider: cli, actionKind: "update" });
          } catch (error) {
            // The SDK gives up while bb goes on installing (docs/ona-notes.md): keep the turn until bb is done.
            if (!(error instanceof Error && error.name === "BbRequestTimeoutError")) throw error;
            const done = await pollUntil(
              async () => {
                try {
                  const now = (await bb.sdk.hosts.providerCliStatus({ hostId: row.hostId })) as Record<
                    string,
                    CliStatus
                  >;
                  const status = now[cli];
                  return status?.installed === true && status.needsUpdate === false;
                } catch {
                  return false; // a failed read is asked again; only the deadline or the plugin's abort ends the wait
                }
              },
              { deadlineMs: BB_INSTALL_LIMIT_MS, intervalMs: INSTALL_POLL_MS, signal },
            );
            lines.push(
              done
                ? `${name}: ${cli} ${from} -> ${to} (bb finished after the request timed out)`
                : `${name}: ${cli} update not confirmed after 15 min`,
            );
            continue;
          }
          const failed = events.find(
            (event) => event.type === "error" || (event.type === "completed" && event.exitCode !== 0),
          );
          lines.push(
            failed
              ? `${name}: ${cli} update failed (${"message" in failed ? failed.message : `exit ${"exitCode" in failed ? failed.exitCode : "?"}`})`
              : `${name}: ${cli} ${from} -> ${to}`,
          );
        }
      });
      if (holder) lines.push(`${name}: skipped (${holder} in progress)`);
    }
    return lines.length > 0 ? lines : ["No matching Ona devboxes."];
  };
}
