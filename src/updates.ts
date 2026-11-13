// Which threads hold a box busy: read by the status page, the sync pass and the idle release.
/** Threads in these states have an agent turn in flight. */
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
