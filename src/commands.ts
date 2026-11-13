// The `bb ona` command: argument parsing, the usage and
// subcommand list, and the dispatch. server.ts builds the deps from its settings and services
// and registers it.
import type { BbPluginApi, PluginCliCommandInfo, PluginCliContext } from "@get-bb/plugin-sdk";
import { randomFriendlyName } from "./names.ts";
import { errorText, isRunning, metric, reasonOf, sshHost, type OnaCli, type OnaSnapshot } from "./ona.ts";
import { onaRef, type registerOnaProvider } from "./provider.ts";
import { ALL, type HostGuard } from "./reconcile.ts";
import { runOnce, type ShellBackend, type ShellTarget, type ThreadTerminalPlan } from "./shells.ts";
import type { TunnelManager } from "./ssh.ts";
import { formatStatus, type OnaHealth } from "./status.ts";
import type { Row, Sync } from "./sync.ts";
import { notActiveRefusal, notRunningInOna, resumeCommand } from "./wake.ts";

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
  "  bb ona shell <ref> -- <cmd…>  Run one command in the devbox checkout and print its output",
  "  bb ona rename <ref> [name]    Rename the Ona environment (random fun name if omitted) and its bb machine.",
  "                                Refused while bb shows its machine in a phase other than active.",
  "  bb ona reconnect <ref>        Reopen an active machine's tunnel and restart its bb daemon (gives up after 30 minutes)",
  "                                Refused unless bb shows the machine active and Ona shows its box running.",
  "  bb ona resume <ref>           Start a stopped box and reconnect bb's daemon (your action; a running box is only reconnected; gives up after 30 minutes)",
  "  bb ona status [ref] [--json]  bb's view of each devbox next to Ona's, its box facts, and what the plugin last did",
  "  bb ona sync [ref]             Re-check Ona now and repair (ignores cooldowns, backoff and the give-up, keeps the safety rules); waits up to 32 min for a resume bb answers `resuming`",
  "  bb ona move <thread-id> <ref>  Continue a thread in a new one on another devbox at the same path",
  "  bb ona update [ref] [--force] Apply pending updates of the CLIs in `autoUpdateProviders` now",
  "                                Also weekdays 09:00 when `autoUpdateClis` is on",
  "",
  "<ref> is a bb machine name/id or an Ona environment name/id; a name two devboxes share is refused by commands that act on one box (use a host id); `status` lists them all.",
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
  {
    name: "shell",
    summary: "Run one command in a devbox checkout",
    usage: "bb ona shell <ref> -- <command...>",
  },
  {
    name: "rename",
    summary:
      "Rename a devbox (random fun name if omitted); refused while bb shows its machine in a phase other than active",
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
    name: "resume",
    summary: "Start a stopped devbox and reconnect its bb daemon",
    usage: "bb ona resume <ref>",
  },
  {
    name: "status",
    summary: "Compare bb's and Ona's view of each devbox",
    usage: "bb ona status [ref] [--json]",
  },
  {
    name: "sync",
    summary: "Re-check Ona now and repair out-of-step devboxes; waits for a resume it starts",
    usage: "bb ona sync [ref]",
  },
  { name: "move", summary: "Continue a thread on another devbox, same path", usage: "bb ona move <thread-id> <ref>" },
] as const satisfies readonly PluginCliCommandInfo[];

type CommandName = (typeof commands)[number]["name"];

/** What the subcommands call: the services and functions server.ts sets up. */
export interface OnaCommandDeps {
  bb: BbPluginApi;
  ona: OnaCli;
  snapshot: OnaSnapshot;
  tunnels: TunnelManager;
  guard: HostGuard;
  provider: Pick<ReturnType<typeof registerOnaProvider>, "reconnect" | "wake">;
  shellBackend: ShellBackend;
  machines: Sync["machines"];
  reconcile: Sync["reconcile"];
  statusRows: Sync["statusRows"];
  defaultProject: string;
  findMachine(ref: string): Promise<Row | null>;
  resolveEnvId(ref: string): Promise<string>;
  /** src/move.ts */
  move(args: { threadId: string; hostId: string }): Promise<{ threadId: string }>;
  shellTarget(ref: string): Promise<ShellTarget>;
  openThreadTerminal(
    threadId: string,
    ref: string,
    size: { cols: number; rows: number },
  ): Promise<{ terminalId: string; via: ThreadTerminalPlan["via"] }>;
  setup(apply: boolean, keepGitCredentials: boolean): Promise<CliResult>;
  addMachine(inputs: Record<string, string>): Promise<string>;
  updateClis(options: { ref?: string; force?: boolean }): Promise<string[]>;
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
    provider,
    shellBackend,
    machines,
    reconcile,
    statusRows,
    defaultProject,
    findMachine,
    resolveEnvId,
    move,
    shellTarget,
    openThreadTerminal,
    setup,
    addMachine,
    updateClis,
    onaHealth,
  } = deps;
  return async function run(rawArgv: string[], ctx: PluginCliContext) {
    const { command, ref, newName, json, threadFlag, threadId, flags, commandArgv } = parseArgs(rawArgv);
    const subcommand = command ?? "help";
    // The switch is exhaustive over the listed names: a name without a case fails the lint (`switch-exhaustiveness-check`;
    // tsc accepts the gap), a case without a name fails the typecheck.
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
          // Read before the rename, creating hosts included: a retry finds a creating box by its name, so renaming it lets the retry create another.
          const before = (await machines({ includeCreating: true })).find((r) => r.resource.envId === envId);
          if (before && before.phase !== "active") return notActiveRefusal(before, "renamed");
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
                "Name an Ona project (`bb ona new <project>`) or set one: `bb plugin config ona set defaultProject <project>`, then `bb plugin reload ona`.",
            };
          }
          const valid = onaRef.safeParse(project);
          if (!valid.success)
            return { exitCode: 1, stderr: `Invalid project "${project}": ${valid.error.issues[0]?.message}` };
          return { exitCode: 0, stdout: await addMachine({ mode: "create", project }) };
        }
        case "reconnect": {
          if (!ref) break;
          bb.log.info(metric("cmd", { name: "reconnect" }));
          // Before the row is read: a suspend or remove after it refuses the tunnel (src/ssh.ts `mark`).
          const since = tunnels.mark();
          const row = await findMachine(ref);
          if (!row) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
          // A tunnel keeps the box awake, so none opens on a machine bb doesn't show active (decision 0003).
          if (row.phase !== "active") return notActiveRefusal(row);
          const steps: string[] = [];
          const report = { step: (text: string) => steps.push(text), log: () => {} };
          // Safety rule 1 (docs/sync.md): SSH starts a stopped box, so Ona is asked right before the connect.
          const listing = await snapshot.refresh().catch(() => null);
          if (!listing) {
            const reason = reasonOf(snapshot.lastError);
            return {
              exitCode: 1,
              stderr: `Can't ask Ona whether ${row.machine} is running (${reason}); not reconnected. Check \`ona login\` and try again.`,
            };
          }
          // bb may have changed while Ona was asked: any suspend, remove or replacement is seen here.
          const current = await findMachine(ref);
          if (!current) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
          if (current.hostId !== row.hostId)
            return {
              exitCode: 1,
              stderr: `${row.machine} changed while Ona was asked; run \`bb ona reconnect ${current.machine}\` again.`,
            };
          if (current.phase !== "active") return notActiveRefusal(current);
          const env = listing.envs.find((e) => e.id === row.resource.envId);
          if (!isRunning(env)) return { exitCode: 1, stderr: notRunningInOna(row.machine, env) };
          // guard.run is the busy check: it returns false, without running, while another action holds the machine.
          const busyRefusal = (): CliResult => ({
            exitCode: 1,
            stderr: `${row.machine} is busy (${guard.busyWith(row.hostId) ?? "another action"}); try again shortly or see \`bb ona status\`.`,
          });
          const ran = await guard.run(
            row.hostId,
            "reconnect",
            "requested with bb ona reconnect",
            async () => {
              await provider.reconnect(row.resource, report, ctx.signal ?? new AbortController().signal, since);
            },
            { force: true, cooldown: false },
          );
          if (!ran) return busyRefusal();
          return { exitCode: 0, stdout: [...steps, `Reconnected ${row.machine}`].join("\n") };
        }
        case "resume": {
          if (!ref) break;
          bb.log.info(metric("cmd", { name: "resume" }));
          // Awaited, so a refused or failed start reaches the catch below and exits 1 (as `reconnect` does).
          return await resumeCommand(
            { snapshot, findMachine, guard, provider },
            ref,
            ctx.signal ?? new AbortController().signal,
            // Before resumeCommand reads the row, as for reconnect.
            tunnels.mark(),
          );
        }
        case "status": {
          const rows = await statusRows(ref);
          if (json) return { exitCode: 0, stdout: JSON.stringify(rows) };
          return { exitCode: 0, stdout: formatStatus(rows, onaHealth()) };
        }
        case "sync": {
          bb.log.info(metric("cmd", { name: "sync" }));
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
        case "move": {
          // `ref` is the thread here and `newName` the devbox.
          if (!ref || !newName) break;
          const row = await findMachine(newName);
          if (!row) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${newName}".` };
          const moved = await move({ threadId: ref, hostId: row.hostId });
          return { exitCode: 0, stdout: `Started ${moved.threadId} on ${row.machine}; ${ref} stays as it is.` };
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
                stderr: `${ctx.signal?.aborted ? "Cancelled before the command finished; it may still be running on the box." : "Still running after 10 minutes."} Follow it with: bb terminal attach ${result.terminalId}`,
              };
            }
            if (result.exitCode === null)
              return {
                exitCode: 1,
                stdout: result.output,
                stderr: `bb reported no exit code for the command: it ended without one, or its result could not be read. See: bb terminal attach ${result.terminalId}`,
              };
            return { exitCode: result.exitCode, stdout: result.output };
          }
          return {
            exitCode: 1,
            stderr: `Usage: bb ona shell ${ref} -- <command...>   (for an interactive shell: bb ona ssh ${ref} --thread <thread-id>)`,
          };
        }
        case "update":
          return { exitCode: 0, stdout: (await updateClis({ ref, force: flags.has("--force") })).join("\n") };
      }
    } catch (error) {
      return { exitCode: 1, stderr: errorText(error) };
    }
    return { exitCode: 1, stderr: usage };
  };
}
