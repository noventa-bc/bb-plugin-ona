// bb-plugin-ona — Ona environments as bb machines.
//
// Each bb machine is one Ona environment. bb's daemon runs inside the devbox
// and reaches this server through an SSH reverse tunnel, so the server stays
// on loopback and nothing goes through a third-party relay.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomFriendlyName } from "./src/names.ts";
import { isArchived, isRunning, isStopped, OnaCli, OnaSnapshot, sshHost, type OnaListing } from "./src/ona.ts";
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
import {
  lifecycleRefusal,
  machinesToRelease,
  parseDuration,
  RESUMED,
  SUSPENDED,
  type MachineActivity,
} from "./src/lifecycle.ts";
import {
  ALL,
  decide,
  GIVE_UP_AFTER,
  GRACE_MS,
  HostGuard,
  PassScheduler,
  type Decision,
  type MachineView,
  type OnaView,
} from "./src/reconcile.ts";
import {
  CLAUDE_COLLECTOR,
  claudeCost,
  CODEX_COLLECTOR,
  codexCost,
  providerSessions,
  type ClaudeUsageBucket,
} from "./src/cost.ts";
import { rpcContract, type Devbox, type ThreadCost } from "./src/rpc.ts";
import { runOnce, threadTerminalPlan, type ShellBackend, type ShellTarget } from "./src/shells.ts";
import { sshExecutor, TunnelManager } from "./src/ssh.ts";
import { hostIsBusy, parseProviderList, updatesToApply, type CliStatus } from "./src/updates.ts";

const TUNNELS_KEY = "tunnels";

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
        "With no thread activity for this long (e.g. 30m, 1h), bb closes its tunnel to the box and marks the machine suspended, so Ona's own inactivity timeout can stop it. The next message wakes it. Empty or 0 keeps every box connected.",
      default: "1h",
    },
    autoRepair: {
      type: "boolean",
      label: "Repair devboxes changed outside bb",
      description:
        "When a box is started, stopped, restarted or deleted outside bb (Ona UI, ona CLI), bring bb back in step: restart bb's daemon on a box that came back, and get unstuck machines moving. Off: only stopped or deleted boxes are marked suspended; `bb ona status` still reports the rest.",
      default: true,
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
  // One cached `ona environment list` for everything that can live with a
  // few seconds' staleness (see OnaSnapshot).
  const snapshot = new OnaSnapshot(() => ona.listEnvironments());
  const guard = new HostGuard();
  const scheduler = new PassScheduler(
    (keys) => reconcile(keys),
    undefined,
    (error) => bb.log.warn(`reconcile pass failed: ${errorText(error)}`),
  );
  /** Ona env id -> bb host id, refreshed on every pass. */
  const hostByEnv = new Map<string, string>();

  // Don't let tunnel reconnects wake environments Ona has stopped; a stop
  // noticed here is synced to bb right away (see reconcile).
  const tunnels = new TunnelManager(
    sshPath,
    port,
    () => proxy.port,
    bb.log,
    async (envId) => {
      const env = (await snapshot.get()).envs.find((e) => e.id === envId);
      const stopped = env !== undefined && isStopped(env);
      if (stopped) scheduler.schedule(hostByEnv.get(envId) ?? ALL, 0);
      // Connecting to a box that is still stopping would start it again.
      return env !== undefined && !stopped && env.status?.phase !== "ENVIRONMENT_PHASE_STOPPING";
    },
    // A tunnel that came back may lead to a box whose daemon died with it;
    // check once bb has had time to hear from the daemon.
    (envId) => scheduler.schedule(hostByEnv.get(envId) ?? ALL, 30_000),
  );

  const RELEASING_KEY = "releasing";
  const connectedAtKey = (envId: string) => `connectedAt:${envId}`;
  const pluginStartedAt = Date.now();

  async function rememberedTunnels(): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>(TUNNELS_KEY)) ?? [];
  }

  async function rememberTunnel(envId: string) {
    const current = await rememberedTunnels();
    if (!current.includes(envId)) await bb.storage.kv.set(TUNNELS_KEY, [...current, envId]);
  }

  const provider = registerOnaProvider(bb, {
    async availability() {
      const binary = findOnaBinary(onaPath);
      if (!binary) return { status: "setup-required", message: ONA_INSTALL_HINT };
      const login = await onaLogin(binary);
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
    rememberTunnel,
    async forgetTunnel(envId) {
      const current = await rememberedTunnels();
      await bb.storage.kv.set(
        TUNNELS_KEY,
        current.filter((id) => id !== envId),
      );
    },
    async markConnected(envId) {
      await bb.storage.kv.set(connectedAtKey(envId), Date.now());
    },
    async takeRelease(envId) {
      const current = (await bb.storage.kv.get<string[]>(RELEASING_KEY)) ?? [];
      if (!current.includes(envId)) return false;
      await bb.storage.kv.set(
        RELEASING_KEY,
        current.filter((id) => id !== envId),
      );
      return true;
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
    /** When bb last heard from the daemon. */
    lastSeenAt: number | null;
    /** Last change to the host record; stands in for "phase entered at". */
    updatedAt: number;
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
        lastSeenAt: host.lastSeenAt ?? null,
        updatedAt: host.updatedAt,
        resource: parsed.data,
      });
    }
    hostByEnv.clear();
    for (const row of rows) hostByEnv.set(row.resource.envId, row.hostId);
    return rows;
  }

  /**
   * Mark a machine suspended in bb without stopping its box (the provider's
   * suspend sees the flag in takeRelease). Used when Ona already stopped or
   * lost the box, and when an idle box is let go for Ona's own timeout.
   */
  async function suspendWithoutStop(row: Row): Promise<void> {
    const releasing = (await bb.storage.kv.get<string[]>(RELEASING_KEY)) ?? [];
    if (!releasing.includes(row.resource.envId))
      await bb.storage.kv.set(RELEASING_KEY, [...releasing, row.resource.envId]);
    try {
      const host = await bb.sdk.hosts.experimental_suspend({ hostId: row.hostId });
      const refusal = lifecycleRefusal(host.lifecycle, SUSPENDED);
      if (refusal) throw new Error(refusal);
    } catch (error) {
      // Don't leave the flag behind for a later user suspend, which should stop the box.
      await provider.takeRelease(row.resource.envId);
      throw error;
    }
  }

  /**
   * Let go of boxes with no thread activity for the idleDisconnect window.
   * The tunnel bb keeps open counts as activity to Ona, so without this no
   * box ever idles out while bb runs. The machine is marked suspended without
   * stopping the environment; Ona's own timeout stops it, and bb's resume
   * reconnects or restarts it when a thread needs it.
   */
  const idleMs = parseDuration(idleDisconnect);
  async function releaseIdleMachines(rows: Row[]): Promise<void> {
    if (idleMs <= 0) return;
    const candidates = rows.filter((row) => row.phase === "active" && guard.mayAct(row.hostId));
    const activity: MachineActivity[] = [];
    for (const row of candidates) {
      const threads = await bb.sdk.threads.list({ hostId: row.hostId });
      const connectedAt = (await bb.storage.kv.get<number>(connectedAtKey(row.resource.envId))) ?? pluginStartedAt;
      activity.push({
        hostId: row.hostId,
        phase: row.phase,
        threadStatuses: threads.map((thread) => (thread.queuedWork === "waiting" ? "pending" : thread.status)),
        lastActivityAt: Math.max(
          connectedAt,
          ...threads.map((thread) => Math.max(thread.updatedAt, thread.lastReadAt ?? 0)),
        ),
      });
    }
    for (const hostId of machinesToRelease(activity, Date.now(), idleMs)) {
      const row = candidates.find((r) => r.hostId === hostId)!;
      const reason = `idle for ${idleDisconnect}; Ona's own timeout will stop the box`;
      await guard
        .run(
          hostId,
          "release-idle",
          reason,
          async () => {
            bb.log.info(`${row.machine}: ${reason}; closing the tunnel`);
            await suspendWithoutStop(row);
          },
          { cooldown: false },
        )
        .catch((error) => {
          bb.log.warn(`${row.machine}: could not let go: ${errorText(error)}`);
        });
    }
  }

  /** Consecutive good listings each missing env was absent from (rule 4). */
  const missing = new Map<string, { streak: number; at: number; archived?: boolean }>();

  function onaView(envId: string, listing: OnaListing | null): OnaView {
    // An empty list is as likely a CLI/context problem as "no environments".
    if (!listing || listing.envs.length === 0) return { kind: "unknown" };
    const env = listing.envs.find((e) => e.id === envId);
    if (env) {
      missing.delete(envId);
      return { kind: "env", phase: env.status?.phase ?? "" };
    }
    const seen = missing.get(envId);
    const streak = seen?.at === listing.at ? seen.streak : (seen?.streak ?? 0) + 1;
    missing.set(envId, { streak, at: listing.at, archived: seen?.archived });
    return { kind: "missing", streak, archived: seen?.archived };
  }

  /**
   * Archived environments drop out of `ona environment list`. Before a box is
   * reported gone, ask Ona about it once. A failed lookup (a deleted box, or
   * Ona unreachable) keeps the "gone" report, as before this check existed.
   */
  async function checkArchived(envId: string): Promise<void> {
    const seen = missing.get(envId);
    if (!seen || seen.streak < 2 || seen.archived !== undefined) return;
    try {
      seen.archived = isArchived(await ona.getEnvironment(envId, AbortSignal.timeout(30_000)));
    } catch (error) {
      seen.archived = false;
      bb.log.info(`${envId}: couldn't ask Ona whether it is archived: ${errorText(error)}`);
    }
  }

  async function threadWaiting(hostId: string): Promise<boolean> {
    const threads = await bb.sdk.threads.list({ hostId });
    return threads.some(
      (thread) => thread.runtime.displayStatus === "waiting-for-host" || thread.queuedWork === "waiting",
    );
  }

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

  /** Carry out one decision under the machine's guard (rule 5). */
  async function act(row: Row, decision: Decision, force: boolean): Promise<void> {
    const { hostId, machine, resource } = row;
    const heavy = decision.action === "heal-daemon" || decision.action === "reconcile-stuck";
    await guard
      .run(
        hostId,
        decision.action,
        decision.reason,
        async () => {
          bb.log.info(`${machine}: ${decision.action} (${decision.reason})`);
          switch (decision.action) {
            case "suspend-observed":
              await suspendWithoutStop(row);
              if (!decision.resumeAfter) return;
              // A thread is waiting on it: that's you using the box, so let bb start it.
              try {
                const host = await bb.sdk.hosts.experimental_resume({ hostId });
                const refusal = lifecycleRefusal(host.lifecycle, RESUMED);
                return refusal
                  ? `couldn't resume it for a waiting thread (${refusal})`
                  : "resumed for a waiting thread";
              } catch (error) {
                return `bb will resume it on your next message (${errorText(error)})`;
              }
            case "ensure-tunnel":
              tunnels.ensure(resource.envId);
              await rememberTunnel(resource.envId);
              return;
            case "heal-daemon": {
              // Rule 1: SSH starts stopped boxes, so re-check Ona right before it.
              const env = (await snapshot.refresh()).envs.find((e) => e.id === resource.envId);
              if (!env || !isRunning(env)) return "Ona no longer reports it running; nothing done";
              // Rule 3: restarting a live daemon would kill running turns.
              const alive = await provider.daemonAlive(resource, AbortSignal.timeout(30_000));
              if (alive === true) return "daemon is running; not restarting";
              if (alive === null) return "couldn't check the daemon over SSH; not restarting";
              const report = { step: (text: string) => bb.log.info(`${machine}: ${text}`), log: () => {} };
              await provider.reconnect(resource, report, AbortSignal.timeout(15 * 60_000));
              return "daemon was down; restarted it";
            }
            case "reconcile-stuck": {
              const host = await bb.sdk.hosts.experimental_reconcile({ hostId });
              return `bb now shows it ${host.lifecycle.phase}${host.lifecycle.message ? ` (${host.lifecycle.message})` : ""}`;
            }
            case "none":
              return;
            default: {
              const unhandled: never = decision.action;
              throw new Error(`unhandled action ${unhandled}`);
            }
          }
        },
        { force, heavy, cooldown: heavy },
      )
      .catch((error) => {
        bb.log.warn(`${machine}: ${decision.action} failed: ${errorText(error)}`);
      });
  }

  /**
   * One reconcile pass over `keys` (host ids, or ALL). Decisions come from
   * `decide` (src/reconcile.ts); actions run in the background under the
   * guard unless `wait` is set (`bb ona sync`).
   */
  async function reconcile(keys: Set<string>, options: { force?: boolean; wait?: boolean } = {}): Promise<void> {
    try {
      const rows = await machines();
      const targets = keys.has(ALL) ? rows : rows.filter((row) => keys.has(row.hostId));
      if (targets.length === 0) return;
      // Host-specific passes come from events where someone may be waiting: keep them fresher.
      const listing = await snapshot.get(keys.has(ALL) ? undefined : 5_000).catch((error) => {
        bb.log.warn(`could not list Ona environments: ${errorText(error)}`);
        return null;
      });
      const now = Date.now();
      const actions: Promise<void>[] = [];
      for (const row of targets) {
        const view: MachineView = {
          hostId: row.hostId,
          phase: row.phase,
          status: row.status,
          lastSeenAt: row.lastSeenAt,
          phaseSince: row.updatedAt,
          tunnel: tunnels.status(row.resource.envId),
          threadWaiting:
            row.phase === "active" && row.status !== "connected"
              ? await threadWaiting(row.hostId).catch(() => false)
              : false,
        };
        let onaState = onaView(row.resource.envId, listing);
        if (onaState.kind === "missing" && onaState.streak >= 2 && onaState.archived === undefined) {
          await checkArchived(row.resource.envId);
          onaState = onaView(row.resource.envId, listing);
        }
        const decision = decide(view, onaState, now);
        // With autoRepair off, only observed stops and deletions reach bb.
        const skipped = !autoRepair && decision.action !== "none" && decision.action !== "suspend-observed";
        guard.note(
          row.hostId,
          skipped ? `${decision.reason} (would ${decision.action}; autoRepair is off)` : decision.reason,
        );
        if (decision.action === "none" || skipped) continue;
        actions.push(act(row, decision, options.force ?? false));
      }
      if (keys.has(ALL)) await releaseIdleMachines(rows);
      if (options.wait) await Promise.all(actions);
    } catch (error) {
      bb.log.warn(`reconcile failed: ${errorText(error)}`);
    }
  }

  /** The bb host a thread runs on, if it has one yet. */
  async function hostOfThread(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  }

  /**
   * React when it matters instead of waiting for the poll: a thread waiting
   * for an Ona machine, an Ona machine dropping off, or a realtime reconnect
   * (events may have been missed). Every other event is dropped at the first
   * check; thread events fire constantly while a turn streams.
   */
  function watchRealtime(): () => void {
    const unsubscribers: Array<() => void> = [];
    const onaHost = (hostId: string | undefined): hostId is string =>
      hostId !== undefined && [...hostByEnv.values()].includes(hostId);
    try {
      unsubscribers.push(
        bb.sdk.subscribe({
          event: "thread:changed",
          callback: (event) => {
            if (event.metadata?.statusChange?.runtime.displayStatus !== "waiting-for-host" || !event.id) return;
            void hostOfThread(event.id)
              .then((hostId) => {
                if (hostId && onaHost(hostId)) scheduler.schedule(hostId, 500);
              })
              .catch(() => {});
          },
        }),
        bb.sdk.subscribe({
          event: "host:changed",
          callback: (event) => {
            if (!onaHost(event.id)) return;
            // Give a dropped daemon the grace period to come back on its own first.
            if (event.changes.includes("host-disconnected")) scheduler.schedule(event.id, GRACE_MS + 1_000);
            else if (event.changes.includes("host-connected")) scheduler.schedule(event.id, 2_000);
          },
        }),
        bb.sdk.subscribe({
          event: "realtime:connection",
          callback: (event) => {
            if (event.reconnected) scheduler.schedule(ALL, 2_000);
          },
        }),
      );
    } catch (error) {
      bb.log.warn(`realtime events unavailable, relying on the 2-minute check: ${errorText(error)}`);
    }
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  bb.background.service("lifecycle-sync", {
    async start(signal) {
      scheduler.start();
      const unsubscribe = watchRealtime();
      // Backstop for anything the events miss.
      scheduler.schedule(ALL, 0);
      const timer = setInterval(() => scheduler.schedule(ALL, 0), 2 * 60_000);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      clearInterval(timer);
      unsubscribe();
      scheduler.stop();
    },
  });

  /** Resolve a bb machine name/id or an Ona environment name/id to an env id. */
  async function resolveEnvId(ref: string): Promise<string> {
    const row = (await machines()).find((r) =>
      [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref),
    );
    if (row) return row.resource.envId;
    const env = await ona.findEnvironment(ref);
    if (!env) throw new Error(`No bb machine or Ona environment matches "${ref}".`);
    return env.id;
  }

  async function findMachine(ref: string): Promise<Row | null> {
    return (
      (await machines()).find((r) => [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref)) ?? null
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

  /** Run a cost collector script on a devbox and parse the JSON line it prints. */
  async function runCollector(envId: string, script: string, ids: string[]): Promise<unknown> {
    // Login shell for the user's PATH (node, codex); Codex keeps bb's local SQLite home.
    const command = [
      "bash",
      "-lc",
      '[ -n "$1" ] && export CODEX_SQLITE_HOME="$1"; script="$2"; shift 2; exec node -e "$script" "$@"',
      "bb-ona-cost",
      codexSqliteHome,
      script,
      ...ids,
    ];
    let output = "";
    const { exitCode } = await sshExecutor(sshPath, envId, []).exec({
      command,
      stdin: "",
      timeoutMs: 90_000,
      signal: AbortSignal.timeout(95_000),
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    const line = output
      .split("\n")
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    if (exitCode !== 0 || !line)
      throw new Error(`cost collector failed (exit ${exitCode}): ${output.trim().slice(-300)}`);
    return JSON.parse(line);
  }

  const costInFlight = new Map<string, Promise<ThreadCost | null>>();

  /**
   * Spend so far for a devbox thread. Cached per thread and recomputed only
   * after a new turn finishes; a box that isn't connected is never woken,
   * its last known figure is returned instead.
   */
  async function threadCost(threadId: string): Promise<ThreadCost | null> {
    const devbox = await threadDevbox(threadId);
    if (!devbox) return null;
    const thread = await bb.sdk.threads.get({ threadId });
    const provider = thread.providerId;
    if (provider !== "codex" && provider !== "claude-code") return null;
    const key = `cost:${threadId}`;
    const stored = await bb.storage.kv.get<{ cost: ThreadCost | null; seq: number; checkedAt: number }>(key);
    if (devbox.status !== "connected") return stored?.cost ?? null;
    // Recompute once per finished turn, never mid-turn, and at most every 5
    // minutes: each check is an SSH round trip, and for Codex a short-lived
    // app-server that talks to OpenAI and reads the box's Codex login.
    const [latest] = await bb.sdk.threads.events.list({
      threadId,
      types: ["turn/completed"],
      order: "desc",
      limit: "1",
    });
    const seq = Number(latest?.seq ?? 0);
    if (stored && (stored.seq === seq || Date.now() - stored.checkedAt < 5 * 60_000)) return stored.cost;

    let running = costInFlight.get(threadId);
    if (!running) {
      running = (async () => {
        // bb pages events at most 100 at a time.
        const identity: Array<{ seq: number | string; data?: unknown }> = [];
        for (let afterSeq: string | undefined; ;) {
          const page = await bb.sdk.threads.events.list({
            threadId,
            types: ["thread/identity", "turn/started"],
            limit: "100",
            ...(afterSeq ? { afterSeq } : {}),
          });
          identity.push(...page);
          if (page.length < 100) break;
          afterSeq = String(page.at(-1)!.seq);
        }
        const sessions = providerSessions(identity);
        let cost: ThreadCost | null = null;
        if (sessions.length > 0) {
          if (provider === "codex") {
            const reply = (await runCollector(devbox.envId, CODEX_COLLECTOR, sessions)) as {
              results?: Parameters<typeof codexCost>[0];
              error?: string;
            };
            if (!reply.results) throw new Error(`Codex usage unavailable: ${reply.error ?? "no result"}`);
            const { usd, missing } = codexCost(reply.results);
            if (missing.length < sessions.length) {
              cost = { provider, usd, basis: "openai-estimate", partial: missing.length > 0, updatedAt: Date.now() };
            }
          } else {
            const reply = (await runCollector(devbox.envId, CLAUDE_COLLECTOR, sessions)) as {
              buckets: ClaudeUsageBucket[];
            };
            if (reply.buckets.length > 0) {
              const { usd, unknownModels } = claudeCost(reply.buckets);
              cost = { provider, usd, basis: "list-price", partial: unknownModels.length > 0, updatedAt: Date.now() };
            }
          }
        }
        // Keep the last good figure if this round had nothing to price.
        const result = cost ?? stored?.cost ?? null;
        await bb.storage.kv.set(key, { cost: result, seq, checkedAt: Date.now() });
        return result;
      })().finally(() => costInFlight.delete(threadId));
      costInFlight.set(threadId, running);
    }
    try {
      return await running;
    } catch (error) {
      bb.log.warn(`thread cost for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return stored?.cost ?? null;
    }
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
    thread_cost: async ({ threadId }) => ({ cost: await threadCost(threadId) }),
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
    const cli = [
      process.env.BB_CLI,
      join(bb.server.experimental_dataDir, "bin", "bb"),
      join(homedir(), ".bb", "bin", "bb"),
    ].find((path): path is string => Boolean(path) && existsSync(path!));
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
      if (options.ref && ![row.hostId, row.machine, row.resource.envId, row.resource.envName].includes(options.ref))
        continue;
      const name = row.resource.envName;
      if (row.status !== "connected") {
        lines.push(`${name}: skipped (${row.status})`);
        continue;
      }
      if (!options.force) {
        const listed = await bb.sdk.threads.list({ hostId: row.hostId });
        const threads = (
          Array.isArray(listed) ? listed : ((listed as { threads?: unknown[] }).threads ?? [])
        ) as Array<{ status: string }>;
        if (hostIsBusy(threads.map((thread) => thread.status))) {
          lines.push(`${name}: skipped (an agent is running; retry with --force)`);
          continue;
        }
      }
      const statuses = (await bb.sdk.hosts.providerCliStatus({ hostId: row.hostId })) as Record<string, CliStatus>;
      const pending = updatesToApply(statuses, wanted);
      if (pending.length === 0) {
        lines.push(
          `${name}: up to date (${wanted.map((p) => `${p} ${statuses[p]?.currentVersion ?? "not installed"}`).join(", ")})`,
        );
        continue;
      }
      for (const provider of pending) {
        const from = statuses[provider]?.currentVersion ?? "?";
        const to = statuses[provider]?.latestVersion ?? "latest";
        const events = await bb.sdk.hosts.installProviderCli({ hostId: row.hostId, provider, actionKind: "update" });
        const failed = events.find(
          (event) => event.type === "error" || (event.type === "completed" && event.exitCode !== 0),
        );
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
      step.id === "ssh-config"
        ? await run(resolveOna(), ["environment", "ssh-config"])
        : step.id === "access"
          ? await bbCli(["settings", "general", "defaultMachineAccess", "direct"])
          : step.id === "server-url"
            ? await bbCli(["settings", "general", "machineServerUrl", bb.server.loopbackBaseUrl.replace(/\/+$/, "")])
            : step.id === "git-credentials"
              ? await bbCli(["settings", "general", "machineGitCredentialsEnabled", "false"])
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
        blocked.length > 0
          ? "\nFix the ✗ items above, then run `bb ona setup` again."
          : changes.length > 0
            ? "\nRun `bb ona setup --yes` to apply the → changes."
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

  interface StatusRow {
    machine: string;
    hostId: string;
    bb: string;
    tunnel: string;
    ona: string;
    /** What the latest check concluded, and since when. */
    now: { reason: string; since: number } | null;
    /** The last action the plugin took (or the one in flight). */
    last: { action: string; reason: string; at: number; error?: string } | null;
    retry: string | null;
  }

  async function statusRows(ref?: string): Promise<StatusRow[]> {
    const rows = (await machines()).filter(
      (r) => !ref || [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref),
    );
    const listing = await snapshot.get().catch(() => snapshot.latest);
    return rows.map((row) => {
      const env = listing?.envs.find((e) => e.id === row.resource.envId);
      const record = guard.records.get(row.hostId);
      const busy = guard.busyWith(row.hostId);
      return {
        machine: row.machine,
        hostId: row.hostId,
        bb: row.phase === "active" ? row.status : row.phase,
        tunnel: tunnels.status(row.resource.envId),
        ona: !listing
          ? "unknown"
          : env
            ? (env.status?.phase ?? "?").replace(/^ENVIRONMENT_PHASE_/, "").toLowerCase()
            : missing.get(row.resource.envId)?.archived
              ? "archived"
              : "missing",
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
        retry:
          !record || record.failures === 0
            ? null
            : record.failures >= GIVE_UP_AFTER
              ? `gave up after ${record.failures} failures; run \`bb ona sync ${row.machine}\``
              : `retrying after ${new Date(record.quietUntil).toLocaleTimeString()}`,
      };
    });
  }

  function formatStatus(rows: StatusRow[]): string {
    const ago = (at: number) => {
      const s = Math.round((Date.now() - at) / 1000);
      return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
    };
    const listing = snapshot.latest;
    const header = snapshot.lastError
      ? `Ona CLI: ERROR ${snapshot.lastError.split("\n")[0]} (run \`ona login\`?)`
      : `Ona CLI: ok${listing ? `, listed ${ago(listing.at)}` : ""}${autoRepair ? "" : "  (autoRepair is off)"}`;
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
      return lines.join("\n");
    });
    return [header, ...lines].join("\n");
  }

  const usage = [
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
    "  bb ona reconnect <ref>        Reopen the tunnel and restart the bb daemon (applies new settings)",
    "  bb ona status [ref] [--json]  bb's view of each devbox next to Ona's, and what the plugin last did",
    "  bb ona sync [ref]             Re-check Ona now and repair (ignores cooldowns, keeps the safety rules)",
    "  bb ona update [ref] [--force] Apply pending Claude Code / Codex updates now (also runs weekdays 09:00)",
    "",
    "<ref> is a bb machine name/id or an Ona environment name/id.",
  ].join("\n");

  bb.cli.register({
    name: "ona",
    summary: "Ona devboxes as bb machines",
    commands: [
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
        summary: "Reopen the tunnel and restart the bb daemon",
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
            if (!valid.success)
              return { exitCode: 1, stderr: `Invalid name "${name}": ${valid.error.issues[0]?.message}` };
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
            const row = (await machines()).find((r) =>
              [r.hostId, r.machine, r.resource.envId, r.resource.envName].includes(ref),
            );
            if (!row) return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
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
            return { exitCode: 0, stdout: formatStatus(rows) };
          }
          case "sync": {
            const targets = ref ? [await findMachine(ref)] : await machines();
            if (targets.some((row) => row === null))
              return { exitCode: 1, stderr: `No Ona-backed bb machine matches "${ref}".` };
            await snapshot.refresh().catch(() => undefined);
            await reconcile(ref ? new Set(targets.map((row) => row!.hostId)) : new Set([ALL]), {
              force: true,
              wait: true,
            });
            return { exitCode: 0, stdout: formatStatus(await statusRows(ref)) };
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
