// The `bb ona` command: argument parsing, the keep-alive command's checks, the
// status text, the usage and subcommand list, and the dispatch. server.ts
// builds the deps from its settings and services and registers it.
import type { BbPluginApi, PluginCliCommandInfo, PluginCliContext } from "@get-bb/plugin-sdk";
import { clockTime, parseKeepAlive, type KeepAlives } from "./keepalive.ts";
import { randomFriendlyName } from "./names.ts";
import { isRunning, matchEnvironment, sshHost, type OnaCli, type OnaListing, type OnaSnapshot } from "./ona.ts";
import { onaRef, type registerOnaProvider } from "./provider.ts";
import { ALL, type HostGuard } from "./reconcile.ts";
import { runOnce, type ShellBackend, type ShellTarget, type ThreadTerminalPlan } from "./shells.ts";
import type { TunnelManager } from "./ssh.ts";
import type { Row, StatusRow, Sync } from "./sync.ts";

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

type HostPhase = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number]["lifecycle"]["phase"];

/** What to do about a machine `bb ona reconnect` refused. The switch covers every phase the SDK lists (lint checks it). */
function notActiveHint(phase: Exclude<HostPhase, "active">, machine: string): string {
  switch (phase) {
    // Which phases bb accepts a resume in: docs/ona-notes.md.
    case "suspended":
    case "suspending":
      return `Resume it with \`bb machine resume ${machine}\`.`;
    case "creating":
    case "resuming":
      break;
    case "removing":
    case "destroyed":
      return "It is gone or being removed.";
  }
  // Also a phase a newer bb adds: Row.phase is a string at runtime.
  return "Try again once bb shows it active.";
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
    const rowLines = [`${row.machine}  bb:${row.bb}  tunnel:${row.tunnel}  ona:${row.ona}`];
    if (row.now) rowLines.push(`  now: ${row.now.reason} (since ${ago(row.now.since)})`);
    if (row.last) {
      rowLines.push(
        `  last action: ${row.last.action}: ${row.last.reason} (${ago(row.last.at)})${row.last.error ? ` ERROR ${row.last.error}` : ""}`,
      );
    }
    if (row.retry) rowLines.push(`  ${row.retry}`);
    if (row.keepAliveUntil) rowLines.push(`  keep-alive until ${clockTime(row.keepAliveUntil)}`);
    if (row.needsRecovery > 0) {
      rowLines.push(
        `  ${row.needsRecovery} workspace(s) need recovery; bb won't suspend this machine, so the box stays awake. See \`bb environment list --host ${row.hostId}\``,
      );
    }
    for (const thread of row.stuckThreads) {
      rowLines.push(
        `  thread ${thread.id} is ${thread.status}, last updated ${ago(thread.updatedAt)}; it holds this box until it ends or is archived`,
      );
    }
    return rowLines.join("\n");
  });
  return [header, ...lines].join("\n");
}

export const usage = [
  "Usage:",
  "  bb ona setup [--yes]          Check prerequisites; with --yes apply SSH and bb settings",
  "                                (--keep-git-credentials keeps forwarding your GitHub login)",
  "  bb ona adopt <environment>    Add an existing Ona environment as a bb machine (never deleted by bb)",
  "  bb ona new [project]          Create a new Ona devbox (defaults to the defaultProject setting)",
  "  bb ona list [--json]          bb machines backed by Ona, with tunnel status",
  '  bb ona host <ref>             SSH host alias (use: ssh "$(bb ona host <ref>)")',
  "  bb ona ssh <ref>              Print the ssh command for a devbox",
  "  bb ona ssh <ref> --thread <id>  Open another terminal to the devbox in that thread's terminal panel",
  "  bb ona open <ref>             Open the devbox in your Ona editor",
  "  bb ona shell <ref> -- <cmd…>  Run one command in the devbox checkout and print its output",
  "  bb ona rename <ref> [name]    Rename the Ona environment (random fun name if omitted) and its bb machine",
  "  bb ona reconnect <ref>        Reopen an active machine's tunnel and restart its bb daemon (applies new settings)",
  "  bb ona status [ref] [--json]  bb's view of each devbox next to Ona's, and what the plugin last did",
  "  bb ona sync [ref]             Re-check Ona now and repair (ignores cooldowns, keeps the safety rules)",
  "  bb ona keep-alive <ref> <duration|off>  Keep a running devbox from Ona's inactivity timeout (at most 12h)",
  "  bb ona update [ref] [--force] Apply pending Claude Code / Codex updates now (also runs weekdays 09:00)",
  "",
  "<ref> is a bb machine name/id or an Ona environment name/id.",
].join("\n");

export const commands = [
  {
    name: "setup",
    summary: "Check prerequisites and apply one-time settings",
    usage: "bb ona setup [--yes] [--keep-git-credentials]",
  },
  { name: "adopt", summary: "Add an existing Ona environment", usage: "bb ona adopt <environment>" },
  { name: "new", summary: "Create a new Ona devbox", usage: "bb ona new [project]" },
  { name: "list", summary: "List Ona-backed machines", usage: "bb ona list [--json]" },
  { name: "host", summary: "Print a devbox's SSH host alias", usage: "bb ona host <ref>" },
  {
    name: "ssh",
    summary: "Print the ssh command, or open a devbox terminal in a thread",
    usage: "bb ona ssh <ref> [--thread <thread-id>]",
  },
  { name: "open", summary: "Open a devbox in your Ona editor", usage: "bb ona open <ref>" },
  {
    name: "shell",
    summary: "Run one command in a devbox checkout",
    usage: "bb ona shell <ref> -- <command...>",
  },
  {
    name: "rename",
    summary: "Rename a devbox (random fun name if omitted)",
    usage: "bb ona rename <ref> [name]",
  },
  {
    name: "update",
    summary: "Apply pending agent-CLI updates on devboxes",
    usage: "bb ona update [ref] [--force]",
  },
  {
    name: "reconnect",
    summary: "Reopen an active machine's tunnel and restart its bb daemon",
    usage: "bb ona reconnect <ref>",
  },
  {
    name: "status",
    summary: "Compare bb's and Ona's view of each devbox",
    usage: "bb ona status [ref] [--json]",
  },
  {
    name: "sync",
    summary: "Re-check Ona now and repair out-of-step devboxes",
    usage: "bb ona sync [ref]",
  },
  {
    name: "keep-alive",
    summary: "Keep a running devbox from Ona's inactivity timeout for a while",
    usage: "bb ona keep-alive <ref> <duration|off>",
  },
] as const satisfies readonly PluginCliCommandInfo[];

type CommandName = (typeof commands)[number]["name"];

/** What the subcommands call: the services and functions server.ts sets up. */
export interface OnaCommandDeps {
  bb: BbPluginApi;
  ona: OnaCli;
  snapshot: OnaSnapshot;
  tunnels: TunnelManager;
  guard: HostGuard;
  keepAlives: KeepAlives;
  provider: Pick<ReturnType<typeof registerOnaProvider>, "reconnect">;
  shellBackend: ShellBackend;
  machines: Sync["machines"];
  reconcile: Sync["reconcile"];
  statusRows: Sync["statusRows"];
  defaultProject: string;
  findMachine(ref: string): Promise<Row | null>;
  resolveEnvId(ref: string): Promise<string>;
  shellTarget(ref: string): Promise<ShellTarget>;
  openThreadTerminal(
    threadId: string,
    ref: string,
    size: { cols: number; rows: number },
  ): Promise<{ terminalId: string; via: ThreadTerminalPlan["via"] }>;
  setup(apply: boolean, keepGitCredentials: boolean): Promise<CliResult>;
  addMachine(inputs: Record<string, string>): Promise<string>;
  updateClis(options: { ref?: string; force?: boolean }): Promise<string[]>;
  openEditor(envId: string): void;
  onaHealth(): OnaHealth;
}

/** The `run` handler for `bb.cli.register`. */
export function onaCommands(deps: OnaCommandDeps) {
  const {
    bb,
    ona,
    snapshot,
    tunnels,
    guard,
    keepAlives,
    provider,
    shellBackend,
    machines,
    reconcile,
    statusRows,
    defaultProject,
    findMachine,
    resolveEnvId,
    shellTarget,
    openThreadTerminal,
    setup,
    addMachine,
    updateClis,
    openEditor,
    onaHealth,
  } = deps;
  return async function run(rawArgv: string[], ctx: PluginCliContext) {
    const { command, ref, newName, json, threadFlag, threadId, flags, commandArgv } = parseArgs(rawArgv);
    const subcommand = command ?? "help";
    // The switch is exhaustive over the listed names: a command added to one place and not the other fails the typecheck.
    if (subcommand !== "help" && !commands.some((c) => c.name === subcommand)) return { exitCode: 1, stderr: usage };
    try {
      switch (subcommand as CommandName | "help") {
        case "help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const rows = (await machines()).map((row) => ({
            ...row,
            tunnel: tunnels.status(row.resource.envId),
          }));
          if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
          if (rows.length === 0) return { exitCode: 0, stdout: "No Ona machines yet." };
          return {
            exitCode: 0,
            stdout: rows
              .map((r) =>
                [
                  r.machine,
                  r.hostId,
                  r.status,
                  `tunnel:${r.tunnel}`,
                  r.resource.envName,
                  r.resource.adopted ? "adopted" : "created",
                ].join("  "),
              )
              .join("\n"),
          };
        }
        case "host":
        case "ssh": {
          if (!ref) break;
          if (command === "ssh" && threadFlag) {
            if (!threadId) return { exitCode: 1, stderr: "Usage: bb ona ssh <ref> --thread <thread-id>" };
            const opened = await openThreadTerminal(threadId, ref, { cols: 120, rows: 32 });
            if (json) return { exitCode: 0, stdout: JSON.stringify(opened) };
            return {
              exitCode: 0,
              stdout: `Opened ${opened.terminalId} (${opened.via}) in thread ${threadId}. Attach: bb terminal attach ${opened.terminalId}`,
            };
          }
          const host = sshHost(await resolveEnvId(ref));
          return { exitCode: 0, stdout: command === "host" ? host : `ssh ${host}` };
        }
        case "rename": {
          if (!ref) break;
          const envId = await resolveEnvId(ref);
          const name = newName ?? randomFriendlyName();
          const valid = onaRef.safeParse(name);
          if (!valid.success)
            return { exitCode: 1, stderr: `Invalid name "${name}": ${valid.error.issues[0]?.message}` };
          await ona.rename(envId, name);
          await snapshot.refresh().catch(() => undefined);
          const row = (await machines()).find((r) => r.resource.envId === envId);
          if (row) await bb.sdk.hosts.update({ hostId: row.hostId, name: `ona:${name}` });
          return {
            exitCode: 0,
            stdout: `Renamed ${ref} -> ${name}${row ? ` (bb machine ona:${name})` : ""}`,
          };
        }
        case "setup":
          return await setup(flags.has("--yes"), flags.has("--keep-git-credentials"));
        case "adopt": {
          if (!ref) break;
          const valid = onaRef.safeParse(ref);
          if (!valid.success)
            return { exitCode: 1, stderr: `Invalid environment "${ref}": ${valid.error.issues[0]?.message}` };
          return { exitCode: 0, stdout: await addMachine({ mode: "adopt", environment: ref }) };
        }
        case "new": {
          const project = ref ?? defaultProject;
          if (!project) {
            return {
              exitCode: 1,
              stderr:
                "Name an Ona project (`bb ona new <project>`) or set one: bb plugin config ona set defaultProject <project>",
            };
          }
          const valid = onaRef.safeParse(project);
          if (!valid.success)
            return { exitCode: 1, stderr: `Invalid project "${project}": ${valid.error.issues[0]?.message}` };
          return { exitCode: 0, stdout: await addMachine({ mode: "create", project }) };
        }
        case "reconnect": {
          if (!ref) break;
          const row = await findMachine(ref);
          if (!row) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
          // A tunnel keeps the box awake, so none opens on a machine bb doesn't show active (decision 0003).
          if (row.phase !== "active") {
            const hint = notActiveHint(row.phase as Exclude<HostPhase, "active">, row.machine);
            return { exitCode: 1, stderr: `${row.machine} is ${row.phase} in bb, so it was not reconnected. ${hint}` };
          }
          const steps: string[] = [];
          const report = { step: (text: string) => steps.push(text), log: () => {} };
          const busy = guard.busyWith(row.hostId);
          if (busy)
            return {
              exitCode: 1,
              stderr: `${row.machine} is busy (${busy}); try again shortly or see \`bb ona status\`.`,
            };
          await guard.run(
            row.hostId,
            "reconnect",
            "requested with bb ona reconnect",
            async () => {
              await provider.reconnect(row.resource, report, ctx.signal ?? new AbortController().signal);
            },
            { force: true, cooldown: false },
          );
          return { exitCode: 0, stdout: [...steps, `Reconnected ${row.machine}`].join("\n") };
        }
        case "status": {
          const rows = await statusRows(ref);
          if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
          return { exitCode: 0, stdout: formatStatus(rows, onaHealth()) };
        }
        case "sync": {
          await snapshot.refresh().catch(() => undefined);
          const targets = ref ? [await findMachine(ref)] : await machines();
          if (targets.some((row) => row === null))
            return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
          await reconcile(ref ? new Set(targets.map((row) => row!.hostId)) : new Set([ALL]), {
            force: true,
            wait: true,
          });
          return { exitCode: 0, stdout: formatStatus(await statusRows(ref), onaHealth()) };
        }
        case "keep-alive": {
          if (!ref) break;
          return keepAliveCommand({ snapshot, findMachine, resolveEnvId, keepAlives }, ref, newName);
        }
        case "shell": {
          if (!ref) break;
          const target = await shellTarget(ref);
          if (commandArgv.length > 0) {
            const result = await runOnce(shellBackend, target, commandArgv, {
              timeoutMs: 10 * 60_000,
              signal: ctx.signal,
            });
            if (result.timedOut) {
              return {
                exitCode: 124,
                stdout: result.output,
                stderr: `Still running after 10 minutes. Follow it with: bb terminal attach ${result.terminalId}`,
              };
            }
            return { exitCode: result.exitCode ?? 1, stdout: result.output };
          }
          return {
            exitCode: 1,
            stderr: `Usage: bb ona shell ${ref} -- <command...>   (for an interactive shell: bb ona ssh ${ref} --thread <thread-id>)`,
          };
        }
        case "update":
          return { exitCode: 0, stdout: (await updateClis({ ref, force: flags.has("--force") })).join("\n") };
        case "open": {
          if (!ref) break;
          const envId = await resolveEnvId(ref);
          openEditor(envId);
          return { exitCode: 0, stdout: `Opening ${envId}` };
        }
      }
    } catch (error) {
      return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
    }
    return { exitCode: 1, stderr: usage };
  };
}
