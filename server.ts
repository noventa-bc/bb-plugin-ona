// bb-plugin-ona — Ona environments as bb machines.
//
// Each bb machine is one Ona environment. bb's daemon runs inside the devbox
// and reaches this server through an SSH reverse tunnel, so the server stays
// on loopback and nothing goes through a third-party relay.
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { KeepAlives } from "./src/keepalive.ts";
import { idleDisconnectSchema } from "./src/lifecycle.ts";
import { errorText, isRunning, isStopped, OnaCli, OnaSnapshot, sshHost } from "./src/ona.ts";
import {
  checkOnaLogin,
  createSetup,
  findOnaBinary,
  hasOnaSshConfig,
  ONA_INSTALL_HINT,
  run,
  type OnaLogin,
} from "./src/setup.ts";
import { PROVIDER_ID, registerOnaComposition, registerOnaProvider } from "./src/provider.ts";
import { startDaemonProxy } from "./src/proxy.ts";
import { commands, onaCommands } from "./src/commands.ts";
import { connectedAtKey, createSync, forgetBox, matchesRef, watchRealtime, type Row } from "./src/sync.ts";
import { ALL, HostGuard, PassScheduler } from "./src/reconcile.ts";
import { createThreadCost } from "./src/cost-service.ts";
import { createMove } from "./src/move.ts";
import { rpcContract, type Devbox } from "./src/rpc.ts";
import { threadTerminalPlan, type ShellBackend, type ShellTarget } from "./src/shells.ts";
import { TunnelManager } from "./src/ssh.ts";
import { createUpdateClis } from "./src/updates.ts";

/** Devbox folder settings end up in remote commands: plain absolute paths only. */
const devboxPath = z
  .string()
  .regex(/^(\/[A-Za-z0-9._-]+)*$/, "use an absolute path of letters, digits, '.', '_' or '-' (or leave empty)");

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
      description:
        "Auto-stop timeout passed to `ona environment create` (e.g. 3h). Adopted environments keep their own.",
      default: "3h",
    },
    idleDisconnect: {
      type: "string",
      label: "Let idle devboxes sleep after",
      description:
        "With no thread activity for this long (e.g. 30m, 1h, or 90 for minutes), bb closes its tunnel to the box and marks the machine suspended, so Ona's own inactivity timeout can stop it (exceptions in the README's How it works). The next message wakes it. Empty or 0 keeps every box connected.",
      default: "1h",
      experimental_schema: idleDisconnectSchema,
    },
    autoRepair: {
      type: "boolean",
      label: "Repair devboxes changed outside bb",
      description:
        "When a box is started, stopped, restarted or deleted outside bb (Ona UI, ona CLI), bring bb back in step: restart bb's daemon on a box that came back. Off: stopped or deleted boxes are still marked suspended, tunnels still reopen, idle boxes are still let go after `idleDisconnect`, and a waiting thread still resumes or starts a stopped box, as does bb's recovery after a restart; everything else is only reported by `bb ona status`.",
      default: true,
    },
    codexSqliteHome: {
      type: "string",
      label: "Codex SQLite home on devboxes",
      description:
        "CODEX_SQLITE_HOME for Codex launched by bb, on the devbox's local disk (a shared NFS ~/.codex corrupts SQLite WAL). Empty keeps Codex's default. A changed setting applies after `bb plugin reload ona`, and reaches a box on its next connect (`bb ona reconnect`, a resume or the daemon's restart).",
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
      description:
        "Weekdays at 09:00 (this Mac's time), apply pending updates for the CLIs below on connected Ona devboxes. Boxes with a running agent turn are skipped until the next run.",
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
    idleDisconnect,
    autoRepair,
    codexSqliteHome,
    machineDataDir,
    waitForSharedHome,
    autoUpdateClis,
    autoUpdateProviders,
  } = await settings.get();

  // Settings path first, then PATH and common install locations.
  const resolveOna = () => findOnaBinary(onaPath) ?? onaPath;
  const ona = new OnaCli(resolveOna);
  // `bb ona keep-alive` children, one per box. They end with the plugin.
  const keepAlives = new KeepAlives(
    (envId, ms) => ona.keepAlive(envId, ms),
    (envId, detail) => bb.log.warn(`keep-alive for ${envId} ended early: ${detail}`),
  );
  bb.onDispose(() => keepAlives.stopAll());
  const lifetime = new AbortController();
  // Fire and forget, as the editor may take a while; a failure goes to the log.
  const openEditor = (envId: string) =>
    void ona.openEditor(envId).catch((error: unknown) => bb.log.warn(`opening ${envId} failed: ${errorText(error)}`));

  // `ona whoami` is a network call; cache it so availability stays fast.
  let loginCache: { at: number; login: OnaLogin } | null = null;
  async function onaLogin(binary: string, fresh = false): Promise<OnaLogin> {
    if (!fresh && loginCache && Date.now() - loginCache.at < 5 * 60_000) return loginCache.login;
    const login = await checkOnaLogin(binary);
    // Ona out of reach says nothing about the login: keep the last good one.
    const kept = !login.ok && login.reason === "network" && loginCache?.login.ok ? loginCache.login : login;
    loginCache = { at: Date.now(), login: kept };
    return kept;
  }
  const port = () => Number(new URL(bb.server.loopbackBaseUrl).port);
  // Tunnels land on this daemon-only proxy, never on the bb server's port:
  // bb trusts loopback, so a raw tunnel would expose its whole API to devboxes.
  const proxy = await startDaemonProxy(() => new URL(bb.server.loopbackBaseUrl), bb.log);
  bb.onDispose(() => proxy.close());
  // One cached `ona environment list` for everything that can live with a
  // few seconds' staleness (see OnaSnapshot).
  // A good listing that shows a box not running ends its keep-alive; an empty
  // one is unknown (safety rule 4) and changes nothing.
  const snapshot = new OnaSnapshot(async () => {
    const envs = await ona.listEnvironments();
    if (envs.length > 0) {
      for (const envId of keepAlives.endNotRunning(envs.map((env) => ({ id: env.id, running: isRunning(env) })))) {
        bb.log.info(`keep-alive for ${envId} ended: Ona no longer lists the box as running`);
      }
    }
    return envs;
  });
  const guard = new HostGuard();
  const scheduler = new PassScheduler(
    (keys) => reconcile(keys),
    undefined,
    (error) => bb.log.warn(`reconcile pass failed: ${errorText(error)}`),
  );
  // Passes can be scheduled before the service starts (a tunnel coming up); a reload must not leave one armed.
  bb.onDispose(() => scheduler.stop());
  /** Ona env id -> bb host id, refreshed on every pass. */
  const hostByEnv = new Map<string, string>();

  // Safety rule 1: a tunnel (re)connects only when a listing fetched now says
  // RUNNING; a cached one can predate a stop made in Ona's UI. A box Ona shows
  // stopped gets a pass right away (see reconcile).
  const tunnels = new TunnelManager(
    sshPath,
    port,
    () => proxy.port,
    bb.log,
    async (envId) => {
      const env = (await snapshot.refresh()).envs.find((e) => e.id === envId);
      if (env && isStopped(env)) scheduler.schedule(hostByEnv.get(envId) ?? ALL, 0);
      return isRunning(env);
    },
    // A tunnel that came back may lead to a box whose daemon died with it;
    // check once bb has had time to hear from the daemon.
    (envId) => scheduler.schedule(hostByEnv.get(envId) ?? ALL, 30_000),
  );

  const pluginStartedAt = Date.now();
  // Older versions kept the idle-release flag in this key; it now lives in memory.
  void bb.storage.kv.delete("releasing").catch(() => {});
  // Older versions remembered open tunnels in this key; the first reconcile pass reopens them now.
  void bb.storage.kv.delete("tunnels").catch(() => {});

  const provider = registerOnaProvider(bb, {
    async availability() {
      const binary = findOnaBinary(onaPath);
      if (!binary) return { status: "setup-required", message: ONA_INSTALL_HINT };
      const login = await onaLogin(binary);
      if (!login.ok && login.reason === "network")
        return { status: "unavailable", message: `Ona could not be reached. (${login.message})` };
      if (!login.ok)
        return { status: "setup-required", message: `Ona CLI is not logged in: run \`ona login\`. (${login.message})` };
      if (!hasOnaSshConfig()) {
        return {
          status: "setup-required",
          message: "Run `ona environment ssh-config` so bb can reach Ona environments over SSH.",
        };
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
    async markConnected(envId) {
      await bb.storage.kv.set(connectedAtKey(envId), Date.now());
    },
    releasing: new Set(),
    forgetBox: (envId) => forgetBox(bb.storage.kv, envId),
  });

  registerOnaComposition(bb);

  const sync = createSync({
    bb,
    snapshot,
    ona,
    guard,
    tunnels,
    provider,
    keepAliveUntil: (envId) => keepAlives.until(envId),
    hostByEnv,
    autoRepair,
    idleDisconnect,
    pluginStartedAt,
  });
  const { machines, machineOfHost, reconcile, statusRows } = sync;

  bb.background.service("lifecycle-sync", {
    async start(signal) {
      scheduler.start();
      const unsubscribe = watchRealtime({ bb, scheduler, hostByEnv });
      // Backstop for anything the events miss.
      scheduler.schedule(ALL, 0);
      const timer = setInterval(() => scheduler.schedule(ALL, 0), 2 * 60_000);
      // No wake event in the SDK: a 15s tick that comes 60s+ late means the Mac slept.
      let lastTick = Date.now();
      const wakeTimer = setInterval(() => {
        const gap = Date.now() - lastTick;
        lastTick += gap;
        if (gap <= 60_000) return;
        bb.log.info(`woke after ${Math.round(gap / 1000)}s asleep, re-checking Ona`);
        void snapshot
          .refresh()
          .catch((error: unknown) => bb.log.warn(`Ona listing after wake failed: ${errorText(error)}`))
          .then(() => scheduler.schedule(ALL, 0));
      }, 15_000);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      clearInterval(timer);
      clearInterval(wakeTimer);
      unsubscribe();
      scheduler.stop();
    },
  });

  /** Resolve a bb machine name/id or an Ona environment name/id to an env id. */
  async function resolveEnvId(ref: string): Promise<string> {
    const row = await findMachine(ref);
    if (row) return row.resource.envId;
    const env = await ona.findEnvironment(ref);
    if (!env) throw new Error(`No bb machine or Ona environment matches "${ref}".`);
    return env.id;
  }

  async function findMachine(ref: string): Promise<Row | null> {
    return (await machines()).find((r) => matchesRef(r, ref)) ?? null;
  }

  function devboxOf(row: Row): Devbox {
    return {
      machine: row.machine,
      hostId: row.hostId,
      envId: row.resource.envId,
      envName: row.resource.envName,
      status: row.status,
      tunnel: tunnels.status(row.resource.envId),
      adopted: row.resource.adopted,
      sshCommand: `ssh ${sshHost(row.resource.envId)}`,
    };
  }

  async function devboxes(): Promise<Devbox[]> {
    return (await machines()).map(devboxOf);
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
    const env = await ona.getEnvironmentIfExists(row.resource.envId).catch(() => null);
    return {
      hostId: row.hostId,
      cwd: env?.status?.content?.contentLocationInMachine ?? null,
      boxName: row.resource.envName,
    };
  }

  /** The Ona devbox a workspace is on, if any. */
  async function workspaceDevbox(environmentId: string): Promise<Devbox | null> {
    const environment = await bb.sdk.environments.get({ environmentId });
    const row = await machineOfHost(environment.hostId);
    return row ? devboxOf(row) : null;
  }

  /** The Ona devbox a thread runs on, if any. */
  async function threadDevbox(threadId: string): Promise<Devbox | null> {
    const { environmentId } = await bb.sdk.threads.get({ threadId });
    return environmentId ? workspaceDevbox(environmentId) : null;
  }

  const costs = createThreadCost({ bb, runCollector: provider.runCollector, threadDevbox, snapshot });
  bb.events.on("thread.deleted", ({ thread }) => costs.forget(thread.id));

  /**
   * A new terminal in a thread's own terminal panel, connected to a devbox.
   * Thread terminals run on the thread's machine: from the Mac that means
   * `ssh` to the box; a thread already on that box just gets a shell there.
   */
  async function openThreadTerminal(threadId: string, ref: string, size: { cols: number; rows: number }) {
    const machineRows = await machines();
    const row = machineRows.find((r) => matchesRef(r, ref));
    if (!row) throw new Error(`No Ona-backed bb machine matches "${ref}". See \`bb ona list\`.`);
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) throw new Error("This thread has no environment yet; try again once it has started.");
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    const env = await ona.getEnvironmentIfExists(row.resource.envId).catch(() => null);
    const plan = threadTerminalPlan({
      threadHostId: environment.hostId,
      target: { hostId: row.hostId, envId: row.resource.envId, boxName: row.resource.envName },
      otherDevboxHostIds: machineRows.map((r) => r.hostId).filter((id) => id !== row.hostId),
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

  const move = createMove({ sdk: bb.sdk, machineOfHost });

  const updateClis = createUpdateClis({ bb, machines, autoUpdateProviders });
  if (autoUpdateClis) {
    bb.background.schedule("cli-updates", "0 9 * * 1-5", async () => {
      for (const line of await updateClis()) bb.log.info(`cli update: ${line}`);
    });
  }

  const setup = createSetup({
    server: bb.server,
    run,
    findOna: () => findOnaBinary(onaPath),
    onaPath,
    onaLogin,
    hasOnaSshConfig,
  });

  async function addMachine(inputs: Record<string, string>) {
    const host = await bb.sdk.hosts.experimental_create({ machineProviderId: PROVIDER_ID, inputs, wait: false });
    return [
      `Adding ${host.name} (${host.id}). This takes a few minutes.`,
      `Follow it with: bb machine show ${host.id}`,
    ].join("\n");
  }

  const onaHealth = () => ({
    lastError: snapshot.lastError,
    listedAt: snapshot.latest?.at ?? null,
    autoRepair,
  });

  // The `bb ona` CLI and the settings section's buttons (devbox_command) share this handler.
  const runOna = onaCommands({
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
    move,
    shellTarget,
    openThreadTerminal,
    setup,
    addMachine,
    updateClis,
    openEditor,
    onaHealth,
  });
  bb.rpc.register(rpcContract, {
    devboxes_list: async () => ({ devboxes: await devboxes() }),
    thread_devbox: async ({ threadId }) => {
      // bb creates a thread before its workspace; the app asks again every 15 s while the thread is shown.
      const { environmentId } = await bb.sdk.threads.get({ threadId });
      if (!environmentId) return { devbox: null, pending: true };
      return { devbox: await workspaceDevbox(environmentId) };
    },
    thread_cost: async ({ threadId }) => ({ cost: await costs.threadCost(threadId) }),
    // A refusal carries the message to the menu without bb recording a plugin crash, which a plain throw would be.
    thread_move: (input) =>
      move(input).catch((error: unknown) => {
        throw new experimental_PluginRpcRefusal({ code: "conflict", message: errorText(error) });
      }),
    devbox_open_editor: async ({ hostId }) => {
      const row = await findMachine(hostId);
      if (!row) return { opened: false };
      openEditor(row.resource.envId);
      return { opened: true };
    },
    // Ends with the plugin, not the page: the signal reaches the resume and reconnect cases (src/commands.ts), so a
    // Resume or Reconnect keeps running after the window closes and stops on a reload.
    devbox_command: ({ command, hostId, arg }) =>
      runOna(
        [command, hostId, arg].filter((part) => part !== undefined),
        { signal: lifetime.signal },
      ),
  });

  bb.cli.register({
    name: "ona",
    summary: "Ona devboxes as bb machines",
    commands: [...commands],
    run: runOna,
  });

  // The abort ends a Resume or Reconnect from the page; after stopAll, no tunnel starts for anyone.
  bb.onDispose(() => {
    lifetime.abort();
    tunnels.stopAll();
  });
}
