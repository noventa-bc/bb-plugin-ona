import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// The agent sandbox hides other processes from `ps`; tests that need to see them run in CI and outside the sandbox.
export const sandboxed = {
  skip: process.env.NONO_CAP_FILE ? "needs to see other processes, hidden in the agent sandbox" : false,
};

/**
 * Fake `ps` and `awk` bodies that a box's scripts must not trust: a tool that
 * fails, is missing, or ignores `-o`. The box-script tests run every one, so
 * the lists can't drift apart.
 */
export const brokenTools: [string, string][] = [
  ["ps", "exit 1"],
  ["ps", "exit 127"],
  ["awk", "exit 127"],
  // A ps that ignores -o and prints a table whose second column is STAT, never a number,
  // so it can't match the shell's parent pid.
  ["ps", "exec /bin/ps -e -o pid= -o stat= -o vsz= -o user= -o args="],
];

/** A `ps` body that prints its listing without `pid`'s line, then exits 1. */
export const partialPs = (pid: number) => `/bin/ps "$@" | grep -v -E "^ *${pid} "\nexit 1`;

/** Resolves once a process whose command line contains `token` is listed; throws after 5 s. */
export async function listed(token: string): Promise<void> {
  for (let tick = 0; tick < 100; tick++) {
    if (execFileSync("ps", ["-e", "-o", "args="]).toString().includes(token)) return;
    await delay(50);
  }
  throw new Error(`no process lists ${token}`);
}

/**
 * A stand-in process whose command line names `argvPath` and carries a unique
 * token. It is listed before this resolves, and killed when the test ends.
 */
export async function standIn(
  t: TestContext,
  argvPath: string,
  script = "setTimeout(() => {}, 10000)",
): Promise<ChildProcess> {
  const token = `stand-in-${randomUUID()}`;
  const child = spawn(process.execPath, ["-e", script, argvPath, token], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await listed(token);
  return child;
}
