// bb-plugin-ona — Ona environments as bb machines.
//
// Each bb machine is one Ona environment. bb's daemon runs inside the devbox
// and reaches this server through an SSH reverse tunnel, so the server stays
// on loopback and nothing goes through a third-party relay.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomFriendlyName } from "./src/names.ts";
import { isStopped, OnaCli, sshHost } from "./src/ona.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkOnaLogin,
  findOnaBinary,
  formatSteps,
  hasOnaSshConfig,
  ONA_INSTALL_HINT,
  planSetup,
  run,
  type GeneralSettings,
  type OnaLogin,
  type SetupStep,
} from "./src/setup.ts";
import {
  onaRef,
  PROVIDER_ID,
  registerOnaComposition,
  registerOnaProvider,
  resourceSchema,
  type OnaResource,
} from "./src/provider.ts";
import { startDaemonProxy } from "./src/proxy.ts";
import { machinesToSuspend } from "./src/lifecycle.ts";
import { rpcContract, type Devbox } from "./src/rpc.ts";
import { runOnce, threadTerminalPlan, type ShellBackend, type ShellTarget } from "./src/shells.ts";
import { TunnelManager } from "./src/ssh.ts";
import { hostIsBusy, parseProviderList, updatesToApply, type CliStatus } from "./src/updates.ts";

const TUNNELS_KEY = "tunnels";

/** Devbox folder settings end up in remote commands: plain absolute paths only. */
const devboxPath = z.string().regex(/^(\/[A-Za-z0-9._-]+)*$/, "use an absolute path of letters, digits, '.', '_' or '-' (or leave empty)");

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    onaPath: {
      type: "string",
      label: "ona CLI path",
      description: "Absolute path to the authenticated ona CLI.",
      default: "/opt/homebrew/bin/ona",
    },
    sshPath: {
      type: "string",
      label: "ssh path",
      default: "/usr/bin/ssh",
    },
    defaultProject: {
      type: "string",
      label: "Default Ona project",
      description: "Ona project name or id used when creating a devbox without one (e.g. my-app).",
      default: "",
    },
    inactivityTimeout: {
      type: "string",
      label: "Inactivity timeout for new devboxes",
      description: "Auto-stop timeout passed to `ona environment create` (e.g. 3h). Adopted environments keep their own.",
      default: "3h",
    },
    codexSqliteHome: {
      type: "string",
      label: "Codex SQLite home on devboxes",
      description:
        "CODEX_SQLITE_HOME for Codex launched by bb, on the devbox's local disk (a shared NFS ~/.codex corrupts SQLite WAL). Empty keeps Codex's default. Run `bb ona reconnect <machine>` after changing.",
      default: "/workspaces/.codex-sqlite-bb",
      experimental_schema: devboxPath,
    },
    machineDataDir: {
      type: "string",
      label: "Local folder for ~/.bb-machines on devboxes",
      description:
        "~/.bb-machines is symlinked here so each devbox keeps bb's machine data on its own disk even when the home is shared over NFS. Empty leaves ~/.bb-machines alone.",
      default: "/workspaces/.bb-machines",
      experimental_schema: devboxPath,
    },
    waitForSharedHome: {
      type: "boolean",
      label: "Wait for the shared home on devboxes",
      description:
        "After a devbox starts, wait until its home folder (shared over NFS) is mounted before starting bb's daemon and agents. Turn off if your Ona environments don't share a home folder.",
      default: true,
    },
    autoUpdateClis: {
      type: "boolean",
      label: "Auto-update agent CLIs on devboxes",
      description: "Weekdays at 09:00 (this Mac's time), apply pending updates for the CLIs below on connected Ona devboxes. Boxes with a running agent turn are skipped until the next run.",
      default: true,
    },
    autoUpdateProviders: {
      type: "string",
      label: "CLIs to auto-update",
      description: "bb provider ids, comma-separated. Only installed CLIs are updated; nothing new is installed.",
      default: "claude-code,codex",
    },
  });
  const {
    onaPath,
    sshPath,
    defaultProject,
    inactivityTimeout,
    codexSqliteHome,
    machineDataDir,
    waitForSharedHome,
    autoUpdateClis,
    autoUpdateProviders,
  } = await settings.get();

  // Settings path first, then PATH and common install locations.
  const resolveOna = () => findOnaBinary(onaPath) ?? onaPath;
  const ona = new OnaCli(resolveOna);

  // `ona whoami` is a network call; cache it so availability stays fast.
  let loginCache: { at: number; login: OnaLogin } | null = null;
  async function onaLogin(binary: string): Promise<OnaLogin> {
    if (loginCache && Date.now() - loginCache.at < 5 * 60_000) return loginCache.login;
    const login = await checkOnaLogin(binary);
    loginCache = { at: Date.now(), login };
    return login;
  }
  const port = () => Number(new URL(bb.server.loopbackBaseUrl).port);
  // Tunnels land on this daemon-only proxy, never on the bb server's port:
  // bb trusts loopback, so a raw tunnel would expose its whole API to devboxes.
  const proxy = await startDaemonProxy(() => new URL(bb.server.loopbackBaseUrl), bb.log);
  bb.onDispose(() => proxy.close());
  // Don't let tunnel reconnects wake environments Ona has stopped; a stop
  // noticed here is synced to bb right away (see syncStoppedMachines).
  const tunnels = new TunnelManager(sshPath, port, () => proxy.port, bb.log, async (envId) => {
    const env = await ona.findEnvironment(envId);
    const stopped = env !== null && isStopped(env);
    if (stopped) void syncStoppedMachines();
    return env !== null && !stopped;
  });

  async function rememberedTunnels(): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>(TUNNELS_KEY)) ?? [];
  }

  const provider = registerOnaProvider(bb, {
    async availability() {
      const binary = findOnaBinary(onaPath);
      if (!binary) return { status: "setup-required", message: ONA_INSTALL_HINT };
      const login = await onaLogin(binary);
      if (!login.ok) return { status: "setup-required", message: `Ona CLI is not logged in: run \`ona login\`. (${login.message})` };
      if (!hasOnaSshConfig()) {
        return { status: "setup-required", message: "Run `ona environment ssh-config` so bb can reach Ona environments over SSH." };
      }
      return { status: "available" };
    },
    ona,
    sshBinary: sshPath,
    tunnels,
    defaultProject,
    inactivityTimeout,
    codexSqliteHome,
    machineDataDir,
    waitForSharedHome,
    port,
    async rememberTunnel(envId) {
      const current = await rememberedTunnels();
      if (!current.includes(envId)) await bb.storage.kv.set(TUNNELS_KEY, [...current, envId]);
    },
    async forgetTunnel(envId) {
      const current = await rememberedTunnels();
      await bb.storage.kv.set(TUNNELS_KEY, current.filter((id) => id !== envId));
    },
  });

  registerOnaComposition(bb);

  // Reopen tunnels for active machines after a reload or server restart.
  bb.background.service("tunnels", {
    async start(signal) {
      for (const envId of await rememberedTunnels()) tunnels.ensure(envId);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      tunnels.stopAll();
    },
  });

  interface Row {
    hostId: string;
    machine: string;
    status: string;
    /** bb lifecycle phase (active, suspended, resuming, ...). */
    phase: string;
    resource: OnaResource;
  }

  async function machines(): Promise<Row[]> {
    const hosts = await bb.sdk.hosts.list();
    const rows: Row[] = [];
    for (const host of hosts) {
      if (host.machineProviderId !== PROVIDER_ID) continue;
      const parsed = resourceSchema.safeParse(await bb.experimental_machines.getResource(host.id));
      if (!parsed.success) continue;
      // A suspended machine reports "disconnected"; surface the suspension itself.
      const status = host.lifecycle?.suspendedAt ? "suspended" : String(host.status);
      rows.push({
        hostId: host.id,
        machine: host.name,
        status,
        phase: host.lifecycle?.phase ?? "active",
        resource: parsed.data,
      });
    }
    return rows;
  }

  /**
   * Mark machines suspended in bb when Ona stopped their environment (idle
   * timeout, Ona UI). bb then offers Resume and wakes the box when a thread
   * needs it, instead of failing against a dead daemon.
   */
  let syncing: Promise<void> | null = null;
  function syncStoppedMachines(): Promise<void> {
    syncing ??= (async () => {
      try {
        const rows = await machines();
        if (!rows.some((row) => row.phase === "active" && row.status !== "connected")) return;
        const envs = await ona.listEnvironments();
        const states = rows.map((row) => ({ hostId: row.hostId, envId: row.resource.envId, phase: row.phase, status: row.status }));
        for (const hostId of machinesToSuspend(states, envs)) {
          const row = rows.find((r) => r.hostId === hostId)!;
          bb.log.info(`${row.machine}: Ona stopped the environment; marking the machine suspended`);
          await bb.sdk.hosts.experimental_suspend({ hostId }).catch((error) => {
            bb.log.warn(`${row.machine}: could not mark suspended: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      } catch (error) {
        bb.log.warn(`stopped-machine sync failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  bb.background.service("lifecycle-sync", {
    async start(signal) {
      while (!signal.aborted) {
        await syncStoppedMachines();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2 * 60_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  });

  /** Resolve a bb machine name/id or an Ona environment name/id to an env id. */
  async function resolveEnvId(ref: string): Promise<string> {
    const row = (await machines()).find(
      (r) => [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref),
    );
    if (row) return row.resource.envId;
    const env = await ona.findEnvironment(ref);
    if (!env) throw new Error(`No bb machine or Ona environment matches "${ref}".`);
    return env.id;
  }

  async function findMachine(ref: string): Promise<Row | null> {
    return (
      (await machines()).find((r) => [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref)) ??
      null
    );
  }

  async function devboxes(): Promise<Devbox[]> {
    return (await machines()).map((row) => ({
      machine: row.machine,
      hostId: row.hostId,
      envId: row.resource.envId,
      envName: row.resource.envName,
      status: row.status,
      tunnel: tunnels.status(row.resource.envId),
      adopted: row.resource.adopted,
      sshCommand: `ssh ${sshHost(row.resource.envId)}`,
    }));
  }

  const shellBackend: ShellBackend = {
    async getTerminal(terminalId) {
      try {
        const terminal = await bb.sdk.terminals.get({ terminalId });
        return { id: terminal.id, status: terminal.status, exitCode: terminal.exitCode };
      } catch {
        return null;
      }
    },
    async createTerminal({ hostId, cwd, title, cols, rows, argv }) {
      const terminal = await bb.sdk.terminals.create({
        scope: { kind: "host_path", hostId, cwd },
        cols,
        rows,
        title,
        ...(argv ? { start: { mode: "argv" as const, argv } } : {}),
      });
      return { id: terminal.id, status: terminal.status, exitCode: terminal.exitCode };
    },
    async output(terminalId, tailBytes) {
      const result = await bb.sdk.terminals.output({ terminalId, tailBytes });
      return Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64"))).toString("utf8");
    },
  };

  /** A connected Ona machine plus its checkout path, for opening shells. */
  async function shellTarget(ref: string): Promise<ShellTarget> {
    const row = await findMachine(ref);
    if (!row) throw new Error(`No Ona-backed bb machine matches "${ref}". See \`bb ona list\`.`);
    if (row.status !== "connected") {
      throw new Error(`${row.machine} is ${row.status}. Start it with: bb machine resume ${row.machine}`);
    }
    const env = await ona.findEnvironment(row.resource.envId).catch(() => null);
    return {
      hostId: row.hostId,
      cwd: env?.status?.content?.contentLocationInMachine ?? null,
      boxName: row.resource.envName,
    };
  }

  /** The Ona devbox a thread runs on, if any. */
  async function threadDevbox(threadId: string): Promise<Devbox | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return (await devboxes()).find((box) => box.hostId === environment.hostId) ?? null;
  }

  /**
   * A new terminal in a thread's own terminal panel, connected to a devbox.
   * Thread terminals run on the thread's machine: from the Mac that means
   * `ssh` to the box; a thread already on that box just gets a shell there.
   */
  async function openThreadTerminal(threadId: string, ref: string, size: { cols: number; rows: number }) {
    const row = await findMachine(ref);
    if (!row) throw new Error(`No Ona-backed bb machine matches "${ref}". See \`bb ona list\`.`);
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no environment yet; try again once it has started.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const env = await ona.findEnvironment(row.resource.envId).catch(() => null);
    const plan = threadTerminalPlan({
      threadHostId: environment.hostId,
      target: { hostId: row.hostId, envId: row.resource.envId, boxName: row.resource.envName },
      otherDevboxHostIds: (await machines()).map((r) => r.hostId).filter((id) => id !== row.hostId),
      cwd: env?.status?.content?.contentLocationInMachine ?? null,
      sshBinary: sshPath,
      sshHost: sshHost(row.resource.envId),
    });
    const terminal = await bb.sdk.terminals.create({
      scope: { kind: "thread", threadId },
      ...size,
      title: plan.title,
      ...(plan.argv ? { start: { mode: "argv" as const, argv: plan.argv } } : {}),
    });
    return { terminalId: terminal.id, via: plan.via };
  }

  bb.rpc.register(rpcContract, {
    devboxes_list: async () => ({ devboxes: await devboxes() }),
    thread_devbox: async ({ threadId }) => ({ devbox: await threadDevbox(threadId) }),
    devbox_open_editor: async ({ hostId }) => {
      const row = await findMachine(hostId);
      if (!row) return { opened: false };
      const { execFile } = await import("node:child_process");
      execFile(resolveOna(), ["environment", "open", row.resource.envId]);
      return { opened: true };
    },
  });

  // bb's settings are changed through its own CLI, one key at a time, so
  // unrelated settings are never rewritten.
  function bbCli(args: string[]) {
    const env = { ...process.env, BB_SERVER_URL: bb.server.loopbackBaseUrl };
    const cli = [process.env.BB_CLI, join(bb.server.experimental_dataDir, "bin", "bb"), join(homedir(), ".bb", "bin", "bb")]
      .find((path): path is string => Boolean(path) && existsSync(path!));
    if (!cli) return Promise.resolve({ ok: false, stdout: "", stderr: "bb CLI not found" });
    // A `#!/usr/bin/env node` CLI needs a node runtime; PATH may have none, so
    // run it with the runtime hosting this plugin (Node, or bb's Electron).
    const shebang = readFileSync(cli, "utf8").slice(0, 120).split("\n")[0] ?? "";
    if (shebang.includes("node")) {
      return run(process.execPath, [cli, ...args], { timeoutMs: 60_000, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } });
    }
    return run(cli, args, { timeoutMs: 60_000, env });
  }

  /**
   * Apply pending agent-CLI updates on connected Ona devboxes. Returns one
   * line per box for the CLI and the plugin log.
   */
  async function updateClis(options: { ref?: string; force?: boolean } = {}): Promise<string[]> {
    const wanted = parseProviderList(autoUpdateProviders);
    const lines: string[] = [];
    for (const row of await machines()) {
      if (options.ref && ![row.hostId, row.machine, row.resource.envId, row.resource.envName].includes(options.ref)) continue;
      const name = row.resource.envName;
      if (row.status !== "connected") {
        lines.push(`${name}: skipped (${row.status})`);
        continue;
      }
      if (!options.force) {
        const listed = await bb.sdk.threads.list({ hostId: row.hostId });
        const threads = (Array.isArray(listed) ? listed : (listed as { threads?: unknown[] }).threads ?? []) as Array<{ status: string }>;
        if (hostIsBusy(threads.map((thread) => thread.status))) {
          lines.push(`${name}: skipped (an agent is running; retry with --force)`);
          continue;
        }
      }
      const statuses = (await bb.sdk.hosts.providerCliStatus({ hostId: row.hostId })) as Record<string, CliStatus>;
      const pending = updatesToApply(statuses, wanted);
      if (pending.length === 0) {
        lines.push(`${name}: up to date (${wanted.map((p) => `${p} ${statuses[p]?.currentVersion ?? "not installed"}`).join(", ")})`);
        continue;
      }
      for (const provider of pending) {
        const from = statuses[provider]?.currentVersion ?? "?";
        const to = statuses[provider]?.latestVersion ?? "latest";
        const events = await bb.sdk.hosts.installProviderCli({ hostId: row.hostId, provider, actionKind: "update" });
        const failed = events.find((event) => event.type === "error" || (event.type === "completed" && event.exitCode !== 0));
        lines.push(
          failed
            ? `${name}: ${provider} update failed (${"message" in failed ? failed.message : `exit ${"exitCode" in failed ? failed.exitCode : "?"}`})`
            : `${name}: ${provider} ${from} -> ${to}`,
        );
      }
    }
    return lines.length > 0 ? lines : ["No matching Ona devboxes."];
  }

  if (autoUpdateClis) {
    bb.background.schedule("cli-updates", "0 9 * * 1-5", async () => {
      for (const line of await updateClis()) bb.log.info(`cli update: ${line}`);
    });
  }

  async function readGeneralSettings(): Promise<GeneralSettings> {
    const result = await bbCli(["settings", "show", "--json"]);
    if (!result.ok) throw new Error(`Could not read bb settings: ${result.stderr.trim()}`);
    const parsed = JSON.parse(result.stdout) as { data?: unknown; generalSettings?: unknown };
    const root = (parsed.data ?? parsed) as { generalSettings?: Partial<GeneralSettings> };
    const general = root.generalSettings ?? {};
    return {
      defaultMachineAccess: general.defaultMachineAccess ?? null,
      machineServerUrl: general.machineServerUrl ?? null,
      machineGitCredentialsEnabled: general.machineGitCredentialsEnabled ?? true,
    };
  }

  async function planCurrentSetup(keepGitCredentials: boolean): Promise<SetupStep[]> {
    const binary = findOnaBinary(onaPath);
    loginCache = null;
    return planSetup({
      onaBinary: binary,
      login: binary ? await onaLogin(binary) : null,
      sshConfigured: hasOnaSshConfig(),
      settings: await readGeneralSettings(),
      serverUrl: bb.server.loopbackBaseUrl.replace(/\/+$/, ""),
      keepGitCredentials,
    });
  }

  async function applyStep(step: SetupStep): Promise<string | null> {
    const result =
      step.id === "ssh-config" ? await run(resolveOna(), ["environment", "ssh-config"])
      : step.id === "access" ? await bbCli(["settings", "general", "defaultMachineAccess", "direct"])
      : step.id === "server-url"
        ? await bbCli(["settings", "general", "machineServerUrl", bb.server.loopbackBaseUrl.replace(/\/+$/, "")])
      : step.id === "git-credentials" ? await bbCli(["settings", "general", "machineGitCredentialsEnabled", "false"])
      : null;
    if (result === null || result.ok) return null;
    return `${step.title}: ${result.stderr.trim().split("\n").slice(-1)[0]}`;
  }

  async function setup(apply: boolean, keepGitCredentials: boolean) {
    const before = await planCurrentSetup(keepGitCredentials);
    const changes = before.filter((step) => step.state === "change");
    const blocked = before.filter((step) => step.state === "blocked");
    if (!apply || changes.length === 0) {
      const footer =
        blocked.length > 0 ? "\nFix the ✗ items above, then run `bb ona setup` again."
        : changes.length > 0 ? "\nRun `bb ona setup --yes` to apply the → changes."
        : "\nAll set. Add a devbox with `bb ona adopt <environment>` or `bb ona new [project]`.";
      return { exitCode: blocked.length > 0 ? 1 : 0, stdout: formatSteps(before) + footer };
    }
    const errors: string[] = [];
    for (const step of changes) {
      const error = await applyStep(step);
      if (error) errors.push(error);
    }
    const after = await planCurrentSetup(keepGitCredentials);
    const done = after.every((step) => step.state === "ok");
    return {
      exitCode: done ? 0 : 1,
      stdout: `${formatSteps(after)}\n${done ? "\nAll set. Add a devbox with `bb ona adopt <environment>` or `bb ona new [project]`." : ""}`,
      ...(errors.length > 0 ? { stderr: errors.join("\n") } : {}),
    };
  }

  async function addMachine(inputs: Record<string, string>) {
    const host = await bb.sdk.hosts.experimental_create({ machineProviderId: PROVIDER_ID, inputs, wait: false });
    return [
      `Adding ${host.name} (${host.id}). This takes a few minutes.`,
      `Follow it with: bb machine show ${host.id}`,
    ].join("\n");
  }

  const usage = [
    "Usage:",
    "  bb ona setup [--yes]          Check prerequisites; with --yes apply SSH and bb settings",
    "                                (--keep-git-credentials keeps forwarding your GitHub login)",
    "  bb ona adopt <environment>    Add an existing Ona environment as a bb machine (never deleted by bb)",
    "  bb ona new [project]          Create a new Ona devbox (defaults to the defaultProject setting)",
    "  bb ona list [--json]          bb machines backed by Ona, with tunnel status",
    "  bb ona host <ref>             SSH host alias (use: ssh \"$(bb ona host <ref>)\")",
    "  bb ona ssh <ref>              Print the ssh command for a devbox",
    "  bb ona ssh <ref> --thread <id>  Open another terminal to the devbox in that thread's terminal panel",
    "  bb ona open <ref>             Open the devbox in your Ona editor",
    "  bb ona shell <ref> -- <cmd…>  Run one command in the devbox checkout and print its output",
    "  bb ona rename <ref> [name]    Rename the Ona environment (random fun name if omitted) and its bb machine",
    "  bb ona reconnect <ref>        Reopen the tunnel and restart the bb daemon (applies new settings)",
    "  bb ona update [ref] [--force] Apply pending Claude Code / Codex updates now (also runs weekdays 09:00)",
    "",
    "<ref> is a bb machine name/id or an Ona environment name/id.",
  ].join("\n");

  bb.cli.register({
    name: "ona",
    summary: "Ona devboxes as bb machines",
    commands: [
      { name: "setup", summary: "Check prerequisites and apply one-time settings", usage: "bb ona setup [--yes] [--keep-git-credentials]" },
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
        summary: "Reopen the tunnel and restart the bb daemon",
        usage: "bb ona reconnect <ref>",
      },
    ],
    async run(rawArgv, ctx) {
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
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
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
                  [r.machine, r.hostId, r.status, `tunnel:${r.tunnel}`, r.resource.envName,
                    r.resource.adopted ? "adopted" : "created"].join("  "),
                )
                .join("\n"),
            };
          }
          case "host":
          case "ssh": {
            if (!ref) break;
            if (command === "ssh" && threadAt !== -1) {
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
            if (!valid.success) return { exitCode: 1, stderr: `Invalid name "${name}": ${valid.error.issues[0]?.message}` };
            await ona.rename(envId, name);
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
            if (!valid.success) return { exitCode: 1, stderr: `Invalid environment "${ref}": ${valid.error.issues[0]?.message}` };
            return { exitCode: 0, stdout: await addMachine({ mode: "adopt", environment: ref }) };
          }
          case "new": {
            const project = ref ?? defaultProject;
            if (!project) {
              return { exitCode: 1, stderr: "Name an Ona project (`bb ona new <project>`) or set one: bb plugin config ona set defaultProject <project>" };
            }
            const valid = onaRef.safeParse(project);
            if (!valid.success) return { exitCode: 1, stderr: `Invalid project "${project}": ${valid.error.issues[0]?.message}` };
            return { exitCode: 0, stdout: await addMachine({ mode: "create", project }) };
          }
          case "reconnect": {
            if (!ref) break;
            const row = (await machines()).find(
              (r) => [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref),
            );
            if (!row) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
            const steps: string[] = [];
            const report = { step: (text: string) => steps.push(text), log: () => {} };
            await provider.reconnect(row.resource, report, ctx.signal ?? new AbortController().signal);
            return { exitCode: 0, stdout: [...steps, `Reconnected ${row.machine}`].join("\n") };
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
            const { execFile } = await import("node:child_process");
            execFile(onaPath, ["environment", "open", envId]);
            return { exitCode: 0, stdout: `Opening ${envId}` };
          }
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => tunnels.stopAll());
}
