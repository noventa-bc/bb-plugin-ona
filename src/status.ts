// `bb ona status`: statusRows builds one row per Ona-backed machine from a sync pass's state (bb's view beside Ona's,
// the box facts and the last action), and formatStatus prints the rows as text.
import { clockTime } from "./keepalive.ts";
import { boxFacts, errorText, reasonOf, type BoxFacts } from "./ona.ts";
import { GIVE_UP_AFTER, type HostGuard } from "./reconcile.ts";
import type { Row, SyncBb, SyncDeps } from "./sync.ts";
import { liveThreads, stuckThreads } from "./updates.ts";

// Only the all-boxes pass (`bb ona sync` with no ref) runs an idle release; every other action needs its machine's pass.
const giveUpCommand = (action: string, machine: string) =>
  action === "release-idle" ? "bb ona sync" : `bb ona sync ${machine}`;

export interface StatusRow {
  machine: string;
  hostId: string;
  bb: string;
  tunnel: string;
  ona: string;
  /** What Ona's listing says about the box (`boxFacts`); null when the latest listing failed or doesn't list the box. */
  facts: BoxFacts | null;
  /** What the latest check concluded, and since when. */
  now: { reason: string; since: number } | null;
  /** The last action the plugin took (or the one in flight). */
  last: { action: string; reason: string; at: number; error?: string } | null;
  retry: string | null;
  /** When a `bb ona keep-alive` ends, epoch ms. */
  keepAliveUntil: number | null;
  /** Workspaces bb gave up on, or whose retry is over a minute late (see workspaceWork); null when bb's workspace list couldn't be read. */
  needsRecovery: number | null;
  /** Busy threads with no update for `STUCK_THREAD_MS`; they hold the box. Null when bb's thread list couldn't be read. */
  stuckThreads: { id: string; status: string; updatedAt: number }[] | null;
}

/** What the status header says about the ona CLI. */
export interface OnaHealth {
  lastError: string | null;
  /** When the last good listing was taken, epoch ms. */
  listedAt: number | null;
  autoRepair: boolean;
}

/** A duration in its largest whole unit: 10800000 ms is `3h`, 2700000 is `45m`, 90000 is `90s`. */
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
};

/** `bb ona status` as text. */
export function formatStatus(rows: StatusRow[], ona: OnaHealth, now = Date.now()): string {
  const ago = (at: number) => {
    // Ona's clock can run ahead of bb's, so a time after `now` reads as 0s ago.
    const s = Math.max(0, Math.round((now - at) / 1000));
    const m = Math.round(s / 60);
    return s < 60 ? `${s}s ago` : m < 60 ? `${m}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  /** The `box:` line: what Ona's listing says about the box. A part Ona doesn't give is left out. */
  const boxLine = (facts: BoxFacts): string | null => {
    const parts: string[] = [];
    if (facts.startedAt !== null) parts.push(`last started ${ago(facts.startedAt)}`);
    if (facts.idleTimeoutMs !== null)
      parts.push(`idle timeout ${facts.idleTimeoutMs === 0 ? "off" : duration(facts.idleTimeoutMs)}`);
    if (facts.activity) parts.push(`last activity ${facts.activity.source} ${ago(facts.activity.at)}`);
    if (facts.branch) parts.push(`branch ${facts.branch}${facts.unpushed > 0 ? ` (${facts.unpushed} unpushed)` : ""}`);
    else if (facts.unpushed > 0) parts.push(`${facts.unpushed} unpushed`);
    return parts.length > 0 ? `  box: ${parts.join(", ")}` : null;
  };
  const header =
    ona.lastError !== null
      ? `Ona CLI: ERROR ${reasonOf(ona.lastError)} (run \`ona login\`?)`
      : `Ona CLI: ok${ona.listedAt !== null ? `, listed ${ago(ona.listedAt)}` : ""}${ona.autoRepair ? "" : "  (autoRepair is off)"}`;
  if (rows.length === 0) return `${header}\nNo Ona machines yet.`;
  const lines = rows.map((row) => {
    const rowLines = [`${row.machine}  bb:${row.bb}  tunnel:${row.tunnel}  ona:${row.ona}`];
    if (row.ona === "unknown" && ona.lastError === null)
      rowLines.push("  Ona lists no environments; idle boxes are not released until it does");
    const box = row.facts ? boxLine(row.facts) : null;
    if (box) rowLines.push(box);
    if (row.now) rowLines.push(`  now: ${row.now.reason} (since ${ago(row.now.since)})`);
    if (row.last) {
      rowLines.push(
        `  last action: ${row.last.action}: ${row.last.reason} (${ago(row.last.at)})${row.last.error ? ` ERROR ${row.last.error}` : ""}`,
      );
    }
    if (row.retry) rowLines.push(`  ${row.retry}`);
    if (row.keepAliveUntil) rowLines.push(`  keep-alive until ${clockTime(row.keepAliveUntil)}`);
    if (row.needsRecovery === null || row.stuckThreads === null) {
      rowLines.push("  bb's workspace or thread list couldn't be read; an active box stays awake until it can");
    }
    if ((row.needsRecovery ?? 0) > 0) {
      rowLines.push(
        `  ${row.needsRecovery} workspace(s) may need recovery; an active box stays awake until they clear. See \`bb environment list --host ${row.hostId}\``,
      );
    }
    for (const thread of row.stuckThreads ?? []) {
      rowLines.push(
        `  thread ${thread.id} is ${thread.status}, last updated ${ago(thread.updatedAt)}; it holds this box until it ends or is archived`,
      );
    }
    return rowLines.join("\n");
  });
  return [header, ...lines].join("\n");
}

/** What statusRows reads from its sync pass; the values come in as deps because sync.ts imports this module. */
interface StatusRowsDeps {
  bb: { sdk: Pick<SyncBb["sdk"], "threads">; log: SyncBb["log"] };
  snapshot: SyncDeps["snapshot"];
  machines(): Promise<Row[]>;
  matchesRef(row: Row, ref: string): boolean;
  missing: ReadonlyMap<string, { phase?: string; archived?: boolean }>;
  guard: HostGuard;
  tunnels: SyncDeps["tunnels"];
  workspaces(hostId: string, now: number): Promise<{ needsRecovery: number } | null>;
  keepAliveUntil: SyncDeps["keepAliveUntil"];
}

/** The `statusRows(ref?)` of a sync pass: one row per Ona-backed machine, or only the machine `ref` names. */
export function createStatusRows(deps: StatusRowsDeps) {
  const { bb, snapshot, machines, matchesRef, missing, guard, tunnels, workspaces, keepAliveUntil } = deps;

  async function statusRows(ref?: string): Promise<StatusRow[]> {
    const listing = await snapshot.get().catch(() => snapshot.latest);
    const now = Date.now();
    // Once a listing fails, rows keep the last good phase but not its facts: the facts would look current.
    const listingOk = snapshot.lastError === null;
    const rows = (await machines()).filter((r) => !ref || matchesRef(r, ref));
    return Promise.all(
      rows.map(async (row) => {
        const env = listing?.envs.find((e) => e.id === row.resource.envId);
        const seen = missing.get(row.resource.envId);
        const phase = env ? (env.status?.phase ?? "?") : seen?.phase;
        const record = guard.records.get(row.hostId);
        const busy = guard.busyWith(row.hostId);
        const threads = await liveThreads(bb.sdk.threads, row.hostId).catch((error: unknown) => {
          bb.log.info(`couldn't list threads on ${row.hostId}: ${errorText(error)}`);
          return null;
        });
        const work = await workspaces(row.hostId, now);
        return {
          machine: row.machine,
          hostId: row.hostId,
          bb: row.phase === "active" ? row.status : row.phase,
          tunnel: tunnels.status(row.resource.envId),
          ona: !listing?.envs.length
            ? "unknown"
            : phase !== undefined
              ? (phase || "?").replace(/^ENVIRONMENT_PHASE_/, "").toLowerCase()
              : seen?.archived
                ? "archived"
                : "missing",
          facts: env && listingOk ? boxFacts(env) : null,
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
          // decide() acts only on an active machine, so no retry line for any other phase.
          retry:
            row.phase !== "active" || !record || record.failures === 0
              ? null
              : record.failures >= GIVE_UP_AFTER
                ? `gave up after ${record.failures} failures; run \`${giveUpCommand(record.action, row.machine)}\``
                : record.quietUntil > now
                  ? `retrying after ${new Date(record.quietUntil).toLocaleTimeString()}`
                  : null,
          keepAliveUntil: keepAliveUntil(row.resource.envId),
          needsRecovery: work?.needsRecovery ?? null,
          stuckThreads: threads === null ? null : stuckThreads(threads, now),
        };
      }),
    );
  }

  return statusRows;
}
