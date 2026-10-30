// Prerequisite checks and one-time setup: find the ona CLI, confirm it is
// logged in, and plan/apply the SSH and bb settings the tunnel design needs.
import { execFile, type ExecFileException } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
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
  "Install the Ona CLI and log in (`ona login`), or set its path with `bb plugin config ona set onaPath <path>`. Then run `bb ona setup`.";

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
              detail: `Run \`ona login\`${input.login && !input.login.ok ? ` (${input.login.message})` : ""}`,
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
