// bb-plugin-ona — Ona environments as bb machines.
//
// Each bb machine is one Ona environment. bb's daemon runs inside the devbox
// and reaches this server through an SSH reverse tunnel, so the server stays
// on loopback and nothing goes through a third-party relay.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { randomFriendlyName } from "./src/names.ts";
import { KeepAlives } from "./src/keepalive.ts";
import { isRunning, isStopped, OnaCli, OnaSnapshot, sshHost } from "./src/ona.ts";
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
import { onaRef, PROVIDER_ID, registerOnaComposition, registerOnaProvider } from "./src/provider.ts";
import { startDaemonProxy } from "./src/proxy.ts";
import { formatStatus, keepAliveCommand, parseArgs } from "./src/commands.ts";
import { connectedAtKey, createSync, forgetBox, RELEASING_KEY, type Row } from "./src/sync.ts";
import { ALL, GRACE_MS, HostGuard, PassScheduler } from "./src/reconcile.ts";
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
  // `bb ona keep-alive` children, one per box. They end with the plugin.
  const keepAlives = new KeepAlives(
    (envId, ms) => ona.keepAlive(envId, ms),
    (envId, detail) => bb.log.warn(`keep-alive for ${envId} ended early: ${detail}`),
  );
  bb.onDispose(() => keepAlives.stopAll());
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
    rememberTunnel,
    keepAliveUntil: (envId) => keepAlives.until(envId),
    hostByEnv,
    autoRepair,
    idleDisconnect,
    pluginStartedAt,
  });
  const { machines, reconcile, statusRows } = sync;

  // Reopen tunnels for active machines after a reload or server restart.
  bb.background.service("tunnels", {
    async start(signal) {
      for (const envId of await rememberedTunnels()) tunnels.ensure(envId);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      tunnels.stopAll();
    },
  });

  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    const env = await ona.getEnvironmentIfExists(row.resource.envId).catch(() => null);
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
  const costKey = (threadId: string) => `cost:${threadId}`;
  // A deleted thread's cost is never asked for again; drop it so the keys don't pile up.
  bb.events.on("thread.deleted", async ({ thread }) => {
    await bb.storage.kv.delete(costKey(thread.id)).catch((error: unknown) => {
      bb.log.warn(`thread cost for ${thread.id}: could not drop it: ${errorText(error)}`);
    });
  });

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
    const key = costKey(threadId);
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
    const env = await ona.getEnvironmentIfExists(row.resource.envId).catch(() => null);
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
      openEditor(row.resource.envId);
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
    return planSetup({
      onaBinary: binary,
      // Checked now, but a network failure keeps the last good login (see onaLogin).
      login: binary ? await onaLogin(binary, true) : null,
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

  const onaHealth = () => ({
    lastError: snapshot.lastError,
    listedAt: snapshot.latest?.at ?? null,
    autoRepair,
  });

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
    "  bb ona keep-alive <ref> <duration|off>  Keep a running devbox from Ona's inactivity timeout (at most 12h)",
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
      {
        name: "keep-alive",
        summary: "Keep a running devbox from Ona's inactivity timeout for a while",
        usage: "bb ona keep-alive <ref> <duration|off>",
      },
    ],
    async run(rawArgv, ctx) {
      const { command, ref, newName, json, threadFlag, threadId, flags, commandArgv } = parseArgs(rawArgv);
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
            return { exitCode: 0, stdout: formatStatus(rows, onaHealth()) };
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
    },
  });

  bb.onDispose(() => tunnels.stopAll());
}
