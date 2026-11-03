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
  // A busybox ps without -o support prints a PID-first table. Its second column is STAT, never a number,
  // so it can't match the shell's parent pid.
  ["ps", "exec /bin/ps -e -o pid= -o stat= -o vsz= -o user= -o args="],
];

/** A `ps` body that prints its listing without `pid`'s line, then exits 1: a listing that stops early. */
export const partialPs = (pid: number) => `/bin/ps "$@" | grep -v -E "^ *${pid} "\nexit 1`;
