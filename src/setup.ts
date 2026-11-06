// Prerequisite checks and one-time setup: find the ona CLI, confirm it is
// logged in, and plan/apply the SSH and bb settings the tunnel design needs.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { execFile, type ExecFileException } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { onaTimeoutArgs } from "./ona.ts";

const COMMON_ONA_LOCATIONS = [
  "/opt/homebrew/bin/ona",
  "/usr/local/bin/ona",
  join(homedir(), ".local", "bin", "ona"),
  join(homedir(), "bin", "ona"),
  join(homedir(), "go", "bin", "ona"),
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Configured path first, then PATH, then common install locations. */
export function findOnaBinary(configured: string, pathEnv = process.env.PATH ?? ""): string | null {
  const fromPath = pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "ona"));
  const candidates = [configured, ...fromPath, ...COMMON_ONA_LOCATIONS].filter(Boolean);
  return candidates.find(isExecutable) ?? null;
}

export function hasOnaSshConfig(): boolean {
  const ssh = join(homedir(), ".ssh");
  return [join(ssh, "gitpod", "config"), join(ssh, "ona", "config")].some((file) => existsSync(file));
}

export function run(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; error: ExecFileException | null }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: options.timeoutMs ?? 60_000, env: options.env, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: stderr || (error?.message ?? ""), error }),
    );
  });
}

/** Why `ona whoami` failed: a rejected login, Ona out of reach, or something else. */
export type OnaLoginFailure = "auth" | "network" | "unknown";

export type OnaLogin =
  { ok: true; user: string; org: string } | { ok: false; message: string; reason: OnaLoginFailure };

// Includes Ona telling the user to run `ona login`, and an expired token.
const STRONG_AUTH_ERROR = /unauthenticated|unauthorized|\b401\b|not logged in|ona login|token expired|expired token/i;
const NETWORK_ERROR = /connection|dial|timeout|timed out|deadline|unreachable|no such host|tls/i;
const WEAK_AUTH_ERROR = /login|token/i;

/**
 * Strong auth markers, then network words, then weak auth words. So "session
 * timed out, run `ona login`" is auth, while "failed to authenticate: context
 * deadline exceeded" is network: it has no strong marker, and the deadline
 * means Ona was not reached.
 */
export function classifyLoginFailure(error: ExecFileException | null, stderr: string): OnaLoginFailure {
  if (error?.code === "ENOENT" || error?.code === "EACCES") return "unknown";
  if (error?.killed) return "network";
  if (STRONG_AUTH_ERROR.test(stderr)) return "auth";
  if (NETWORK_ERROR.test(stderr)) return "network";
  if (WEAK_AUTH_ERROR.test(stderr)) return "auth";
  return "unknown";
}

export async function checkOnaLogin(binary: string, timeoutMs = 4_000): Promise<OnaLogin> {
  // A short grace: availability waits on this call.
  const result = await run(binary, ["whoami", "-o", "json", ...onaTimeoutArgs(timeoutMs)], {
    timeoutMs: timeoutMs + 1_000,
  });
  if (!result.ok) {
    return {
      ok: false,
      message: result.stderr.trim().split("\n").slice(-1)[0] || "ona whoami failed",
      reason: classifyLoginFailure(result.error, result.stderr),
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as
      Array<{ name?: string; org?: string }> | { name?: string; org?: string };
    const me = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!me?.name) return { ok: false, message: "ona whoami returned no user", reason: "unknown" };
    return { ok: true, user: me.name, org: me.org ?? "" };
  } catch {
    return { ok: false, message: "could not parse ona whoami output", reason: "unknown" };
  }
}

export type PluginMachineProviderAvailability =
  { status: "available" } | { status: "setup-required"; message: string } | { status: "unavailable"; message: string };

export const ONA_INSTALL_HINT =
  "Install the Ona CLI and log in (`ona login`), or set its path with `bb plugin config ona set onaPath <path>`, then `bb plugin reload ona`. Then run `bb ona setup`.";

export interface GeneralSettings {
  defaultMachineAccess: string | null;
  machineServerUrl: string | null;
  machineGitCredentialsEnabled: boolean;
}

export interface SetupStep {
  id: "ona" | "login" | "ssh-config" | "access" | "server-url" | "git-credentials";
  title: string;
  /** ok: nothing to do; change: setup will apply it; blocked: needs the user. */
  state: "ok" | "change" | "blocked";
  detail: string;
}

/** Pure planning from observed state, so it can be tested without bb or ona. */
export function planSetup(input: {
  onaBinary: string | null;
  login: OnaLogin | null;
  sshConfigured: boolean;
  settings: GeneralSettings;
  serverUrl: string;
  keepGitCredentials: boolean;
}): SetupStep[] {
  const steps: SetupStep[] = [];
  steps.push(
    input.onaBinary
      ? { id: "ona", title: "Ona CLI", state: "ok", detail: input.onaBinary }
      : { id: "ona", title: "Ona CLI", state: "blocked", detail: ONA_INSTALL_HINT },
  );
  if (input.onaBinary) {
    steps.push(
      input.login?.ok
        ? { id: "login", title: "Ona login", state: "ok", detail: `${input.login.user} (${input.login.org})` }
        : input.login?.reason === "network"
          ? {
              id: "login",
              title: "Ona login",
              state: "blocked",
              detail: `Ona could not be reached (${input.login.message})`,
            }
          : {
              id: "login",
              title: "Ona login",
              state: "blocked",
              detail: `Run \`ona login\`${input.login ? ` (${input.login.message})` : ""}`,
            },
    );
    steps.push(
      input.sshConfigured
        ? { id: "ssh-config", title: "Ona SSH config", state: "ok", detail: "present in ~/.ssh" }
        : {
            id: "ssh-config",
            title: "Ona SSH config",
            state: "change",
            detail: "run `ona environment ssh-config` (adds an Include line to ~/.ssh/config)",
          },
    );
  }
  const { settings } = input;
  steps.push(
    settings.defaultMachineAccess === "direct"
      ? { id: "access", title: "Default machine access", state: "ok", detail: "direct" }
      : {
          id: "access",
          title: "Default machine access",
          state: "change",
          detail: `${settings.defaultMachineAccess ?? "(unset)"} -> direct (applies to all remote bb machines)`,
        },
  );
  steps.push(
    settings.machineServerUrl === input.serverUrl
      ? { id: "server-url", title: "Machine server URL", state: "ok", detail: input.serverUrl }
      : {
          id: "server-url",
          title: "Machine server URL",
          state: "change",
          detail: `${settings.machineServerUrl ?? "(unset)"} -> ${input.serverUrl} (the tunnel end on each devbox)`,
        },
  );
  if (!input.keepGitCredentials) {
    steps.push(
      settings.machineGitCredentialsEnabled
        ? {
            id: "git-credentials",
            title: "Forward Mac GitHub login to machines",
            state: "change",
            detail: "on -> off (Ona already gives devboxes git access; keep with --keep-git-credentials)",
          }
        : { id: "git-credentials", title: "Forward Mac GitHub login to machines", state: "ok", detail: "off" },
    );
  }
  return steps;
}

export function formatSteps(steps: SetupStep[]): string {
  const mark = { ok: "✓", change: "→", blocked: "✗" } as const;
  return steps.map((step) => `${mark[step.state]} ${step.title}: ${step.detail}`).join("\n");
}

export interface SetupDeps {
  server: Pick<BbPluginApi["server"], "loopbackBaseUrl" | "experimental_dataDir">;
  run: typeof run;
  /** The ona CLI if found (`findOnaBinary` with the settings path). */
  findOna(): string | null;
  /** The `onaPath` setting, run as is when the CLI is not found. */
  onaPath: string;
  onaLogin(binary: string, fresh?: boolean): Promise<OnaLogin>;
  hasOnaSshConfig(): boolean;
}

/** `bb ona setup`: show the plan, or apply its "change" steps and show the result. */
// `run` and `hasOnaSshConfig` are renamed: the module's own functions have those names.
export function createSetup({
  server,
  run: runCommand,
  findOna,
  onaPath,
  onaLogin,
  hasOnaSshConfig: sshConfigExists,
}: SetupDeps) {
  const resolveOna = () => findOna() ?? onaPath;

  // bb's settings are changed through its own CLI, one key at a time, so
  // unrelated settings are never rewritten.
  function bbCli(args: string[]) {
    const env = { ...process.env, BB_SERVER_URL: server.loopbackBaseUrl };
    const cli = [
      process.env.BB_CLI,
      join(server.experimental_dataDir, "bin", "bb"),
      join(homedir(), ".bb", "bin", "bb"),
    ].find((path): path is string => Boolean(path) && existsSync(path!));
    if (!cli) return Promise.resolve({ ok: false, stdout: "", stderr: "bb CLI not found" });
    // A `#!/usr/bin/env node` CLI needs a node runtime; PATH may have none, so
    // run it with the runtime hosting this plugin (Node, or bb's Electron).
    const shebang = readFileSync(cli, "utf8").slice(0, 120).split("\n")[0] ?? "";
    if (shebang.includes("node")) {
      return runCommand(process.execPath, [cli, ...args], {
        timeoutMs: 60_000,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
    return runCommand(cli, args, { timeoutMs: 60_000, env });
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
    const binary = findOna();
    return planSetup({
      onaBinary: binary,
      // Checked now, but a network failure keeps the last good login (see onaLogin).
      login: binary ? await onaLogin(binary, true) : null,
      sshConfigured: sshConfigExists(),
      settings: await readGeneralSettings(),
      serverUrl: server.loopbackBaseUrl.replace(/\/+$/, ""),
      keepGitCredentials,
    });
  }

  async function applyStep(step: SetupStep): Promise<string | null> {
    const result =
      step.id === "ssh-config"
        ? await runCommand(resolveOna(), ["environment", "ssh-config"])
        : step.id === "access"
          ? await bbCli(["settings", "general", "defaultMachineAccess", "direct"])
          : step.id === "server-url"
            ? await bbCli(["settings", "general", "machineServerUrl", server.loopbackBaseUrl.replace(/\/+$/, "")])
            : step.id === "git-credentials"
              ? await bbCli(["settings", "general", "machineGitCredentialsEnabled", "false"])
              : null;
    if (result === null || result.ok) return null;
    return `${step.title}: ${result.stderr.trim().split("\n").slice(-1)[0]}`;
  }

  return async function setup(apply: boolean, keepGitCredentials: boolean) {
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
  };
}
