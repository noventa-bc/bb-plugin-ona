// Keep agent CLIs (Claude Code, Codex) current on Ona devboxes: apply the
// updates bb already detects, never install a CLI that isn't there.

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

export function hostIsBusy(threadStatuses: readonly string[]): boolean {
  return threadStatuses.some((status) => BUSY_THREAD_STATES.has(status));
}

/** What `hostIsBusy` reads from bb's thread list: queued work waiting for the host counts as pending. */
export function threadStatuses(threads: readonly { status: string; queuedWork?: string | null }[]): string[] {
  return threads.map((thread) => (thread.queuedWork === "waiting" ? "pending" : thread.status));
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
