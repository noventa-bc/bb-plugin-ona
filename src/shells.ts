// Devbox terminals: bb's own terminals, either in a thread's panel (ssh from
// the Mac, or a local shell when the thread is on the box) or one-off commands
// run through the devbox's bb daemon.
import { shellQuote } from "./ssh.ts";

export interface TerminalInfo {
  id: string;
  status: "starting" | "running" | "exited" | "disconnected";
  exitCode: number | null;
}

/** The slice of bb's SDK terminals the shell logic needs. */
export interface ShellBackend {
  /** null when bb no longer knows the terminal. */
  getTerminal(terminalId: string): Promise<TerminalInfo | null>;
  createTerminal(args: {
    hostId: string;
    cwd: string | null;
    title: string;
    cols: number;
    rows: number;
    argv?: string[];
  }): Promise<TerminalInfo>;
  /** Latest output of a terminal, decoded as UTF-8. */
  output(terminalId: string, tailBytes: number): Promise<string>;
}

export interface ShellTarget {
  hostId: string;
  /** Working directory on the devbox (the Ona checkout), or null for the shell's home. */
  cwd: string | null;
  boxName: string;
}

function isAlive(terminal: TerminalInfo | null): terminal is TerminalInfo {
  return terminal !== null && (terminal.status === "running" || terminal.status === "starting");
}

export interface ThreadTerminalPlan {
  via: "ssh" | "local";
  title: string;
  /** Command for the thread terminal; absent means the machine's own login shell. */
  argv?: string[];
}

/**
 * How to reach a devbox from a thread's terminal panel. Thread terminals run on
 * the thread's machine: a thread already on the box gets a plain shell there;
 * a thread on the Mac ssh-es in and lands in the box's checkout. Another
 * devbox has no Ona SSH config, so that combination is refused.
 */
export function threadTerminalPlan(args: {
  threadHostId: string;
  target: { hostId: string; envId: string; boxName: string };
  otherDevboxHostIds: string[];
  cwd: string | null;
  sshBinary: string;
  sshHost: string;
}): ThreadTerminalPlan {
  const { target } = args;
  if (args.threadHostId === target.hostId) {
    return { via: "local", title: `shell · ${target.boxName}` };
  }
  if (args.otherDevboxHostIds.includes(args.threadHostId)) {
    throw new Error(
      `This thread runs on another devbox, which can't ssh to ${target.boxName}. Open it from a thread on your Mac or on ${target.boxName}.`,
    );
  }
  const remote = args.cwd ? `cd ${shellQuote(args.cwd)} && exec "$SHELL" -l` : `exec "$SHELL" -l`;
  return { via: "ssh", title: `ssh · ${target.boxName}`, argv: [args.sshBinary, "-t", args.sshHost, remote] };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Run one command in a fresh terminal on the box and collect its output. */
export async function runOnce(
  backend: ShellBackend,
  target: ShellTarget,
  argv: string[],
  options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<{ terminalId: string; exitCode: number | null; output: string; timedOut: boolean }> {
  const terminal = await backend.createTerminal({
    hostId: target.hostId,
    cwd: target.cwd,
    title: `run · ${argv.join(" ").slice(0, 40)}`,
    cols: 200,
    rows: 50,
    argv,
  });
  const deadline = Date.now() + options.timeoutMs;
  let current: TerminalInfo | null = terminal;
  while (Date.now() < deadline && !options.signal?.aborted) {
    current = await backend.getTerminal(terminal.id);
    if (!isAlive(current)) break;
    await sleep(options.pollMs ?? 500, options.signal);
  }
  const timedOut = isAlive(current);
  const output = await backend.output(terminal.id, 64 * 1024).catch(() => "");
  return { terminalId: terminal.id, exitCode: current?.exitCode ?? null, output, timedOut };
}
