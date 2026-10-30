import assert from "node:assert/strict";
import { test } from "node:test";
import { runOnce, threadTerminalPlan, type ShellBackend, type TerminalInfo } from "../src/shells.ts";

function fakeBackend(terminals: Record<string, TerminalInfo> = {}) {
  const created: Array<Parameters<ShellBackend["createTerminal"]>[0]> = [];
  let next = 1;
  const backend: ShellBackend = {
    async getTerminal(id) {
      return terminals[id] ?? null;
    },
    async createTerminal(args) {
      created.push(args);
      const terminal: TerminalInfo = { id: `t${next++}`, status: "running", exitCode: null };
      terminals[terminal.id] = terminal;
      return terminal;
    },
    async output() {
      return "hello\n";
    },
  };
  return { backend, created, terminals };
}

const target = { hostId: "host_1", cwd: "/workspaces/app", boxName: "rapid-mango" };

const box = { hostId: "host_box", envId: "env-1", boxName: "rapid-mango" };
const planArgs = {
  target: box,
  otherDevboxHostIds: ["host_other_box"],
  cwd: "/workspaces/my app",
  sshBinary: "/usr/bin/ssh",
  sshHost: "env-1.ona.environment",
};

test("a thread on the Mac gets an ssh terminal that lands in the checkout", () => {
  const plan = threadTerminalPlan({ ...planArgs, threadHostId: "host_mac" });
  assert.equal(plan.via, "ssh");
  assert.equal(plan.title, "ssh · rapid-mango");
  assert.deepEqual(plan.argv, ["/usr/bin/ssh", "-t", "env-1.ona.environment", `cd '/workspaces/my app' && exec "$SHELL" -l`]);
});

test("a thread already on the devbox gets a plain shell there", () => {
  const plan = threadTerminalPlan({ ...planArgs, threadHostId: "host_box" });
  assert.deepEqual(plan, { via: "local", title: "shell · rapid-mango" });
});

test("a thread on another devbox is refused", () => {
  assert.throws(() => threadTerminalPlan({ ...planArgs, threadHostId: "host_other_box" }), /another devbox/);
});

test("without a known checkout the ssh terminal starts in the home dir", () => {
  const plan = threadTerminalPlan({ ...planArgs, cwd: null, threadHostId: "host_mac" });
  assert.equal(plan.argv?.[3], `exec "$SHELL" -l`);
});

test("runOnce waits for the command and returns its output and exit code", async () => {
  const { backend, terminals, created } = fakeBackend();
  setTimeout(() => {
    terminals.t1!.status = "exited";
    terminals.t1!.exitCode = 3;
  }, 30);
  const result = await runOnce(backend, target, ["uname", "-n"], { timeoutMs: 2_000, pollMs: 10 });
  assert.deepEqual(created[0]!.argv, ["uname", "-n"]);
  assert.deepEqual(result, { terminalId: "t1", exitCode: 3, output: "hello\n", timedOut: false });
});

test("runOnce reports a timeout without waiting forever", async () => {
  const { backend } = fakeBackend();
  const result = await runOnce(backend, target, ["sleep", "100"], { timeoutMs: 50, pollMs: 10 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});
