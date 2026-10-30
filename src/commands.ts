// `bb ona` command pieces that are worth testing on their own: argument
// parsing, the keep-alive command's checks, and the status text. server.ts
// registers the command and handles the rest, which are thin calls into src/.
import { clockTime, parseKeepAlive } from "./keepalive.ts";
import { isRunning, matchEnvironment, type OnaListing } from "./ona.ts";
import type { StatusRow } from "./sync.ts";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Split `bb ona` argv into the command, its positionals and flags. */
export function parseArgs(rawArgv: readonly string[]) {
  // Everything after a bare `--` is a command for `bb ona shell`.
  const dash = rawArgv.indexOf("--");
  const argv = dash === -1 ? rawArgv : rawArgv.slice(0, dash);
  const commandArgv = dash === -1 ? [] : rawArgv.slice(dash + 1);
  const json = argv.includes("--json");
  // `--thread <id>` takes a value; pull it out before reading positionals.
  const threadAt = argv.indexOf("--thread");
  const threadId = threadAt === -1 ? undefined : argv[threadAt + 1];
  const rest = threadAt === -1 ? argv : [...argv.slice(0, threadAt), ...argv.slice(threadAt + 2)];
  const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
  const [command, ref, newName] = rest.filter((arg) => !arg.startsWith("--"));
  return { command, ref, newName, json, threadFlag: threadAt !== -1, threadId, flags, commandArgv };
}

export interface KeepAliveDeps {
  snapshot: { refresh(): Promise<OnaListing>; readonly lastError: string | null };
  findMachine(ref: string): Promise<{ resource: { envId: string } } | null>;
  resolveEnvId(ref: string): Promise<string>;
  keepAlives: { start(envId: string, ms: number): number; stop(envId: string): boolean };
}

/** `bb ona keep-alive <ref> <duration|off>` (see src/keepalive.ts). */
export async function keepAliveCommand(
  deps: KeepAliveDeps,
  ref: string,
  value: string | undefined,
): Promise<CliResult> {
  const { snapshot, findMachine, resolveEnvId, keepAlives } = deps;
  const request = parseKeepAlive(value);
  if (request.kind === "invalid") {
    return { exitCode: 1, stderr: `${request.message}\nUsage: bb ona keep-alive <ref> <duration|off>` };
  }
  if (request.kind === "off") {
    // A box Ona no longer lists can still have a keep-alive under its id.
    const envId = await resolveEnvId(ref).catch(() => ref);
    return {
      exitCode: 0,
      stdout: keepAlives.stop(envId) ? `Ended the keep-alive for ${ref}.` : `${ref} had no keep-alive.`,
    };
  }
  // Safety rule 1: only a box a fresh listing says is RUNNING. The
  // keep-alive runs on this Mac through the ona CLI, never over SSH.
  const listing = await snapshot.refresh().catch(() => null);
  if (!listing) {
    return {
      exitCode: 1,
      stderr: `Can't ask Ona whether ${ref} is running (${snapshot.lastError ?? "no listing"}); nothing changed.`,
    };
  }
  const row = await findMachine(ref);
  const env = row ? listing.envs.find((e) => e.id === row.resource.envId) : matchEnvironment(listing.envs, ref);
  if (!env) return { exitCode: 1, stderr: `Ona lists no devbox matching "${ref}"; nothing changed.` };
  if (!isRunning(env)) {
    const phase = (env.status?.phase ?? "unknown").replace(/^ENVIRONMENT_PHASE_/, "").toLowerCase();
    return {
      exitCode: 1,
      stderr: `${ref} is ${phase} in Ona. keep-alive only holds a running box and never starts one.`,
    };
  }
  const until = keepAlives.start(env.id, request.ms);
  return {
    exitCode: 0,
    stdout: `Keeping ${ref} alive until ${clockTime(until)}. End it early with: bb ona keep-alive ${ref} off`,
  };
}

/** What the status header says about the ona CLI. */
export interface OnaHealth {
  lastError: string | null;
  /** When the last good listing was taken, epoch ms. */
  listedAt: number | null;
  autoRepair: boolean;
}

/** `bb ona status` as text. */
export function formatStatus(rows: StatusRow[], ona: OnaHealth, now = Date.now()): string {
  const ago = (at: number) => {
    const s = Math.round((now - at) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const header = ona.lastError
    ? `Ona CLI: ERROR ${ona.lastError.split("\n")[0]} (run \`ona login\`?)`
    : `Ona CLI: ok${ona.listedAt !== null ? `, listed ${ago(ona.listedAt)}` : ""}${ona.autoRepair ? "" : "  (autoRepair is off)"}`;
  if (rows.length === 0) return `${header}\nNo Ona machines yet.`;
  const lines = rows.map((row) => {
    const lines = [`${row.machine}  bb:${row.bb}  tunnel:${row.tunnel}  ona:${row.ona}`];
    if (row.now) lines.push(`  now: ${row.now.reason} (since ${ago(row.now.since)})`);
    if (row.last) {
      lines.push(
        `  last action: ${row.last.action}: ${row.last.reason} (${ago(row.last.at)})${row.last.error ? ` ERROR ${row.last.error}` : ""}`,
      );
    }
    if (row.retry) lines.push(`  ${row.retry}`);
    if (row.keepAliveUntil) lines.push(`  keep-alive until ${clockTime(row.keepAliveUntil)}`);
    if (row.needsRecovery > 0) {
      lines.push(
        `  ${row.needsRecovery} workspace(s) need recovery; bb won't suspend this machine, so the box stays awake. See \`bb environment list --host ${row.hostId}\``,
      );
    }
    return lines.join("\n");
  });
  return [header, ...lines].join("\n");
}
