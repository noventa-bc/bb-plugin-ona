import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { envNameForKey } from "../src/provider.ts";
import { daemonEnv, shellQuote, sshCapture, sshExecutor } from "../src/ssh.ts";

const fakeSsh = fileURLToPath(new URL("./fake-ssh.sh", import.meta.url));
const executor = sshExecutor(fakeSsh, "env-1");

test("shellQuote keeps safe words and quotes the rest", () => {
  assert.equal(shellQuote("node"), "node");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("executor preserves argv, streams output and pipes stdin", async () => {
  let output = "";
  const { exitCode } = await executor.exec({
    command: ["sh", "-c", "printf '%s|' \"$1\"; cat", "_", "two words; $(rm -rf nope)"],
    stdin: "secret-bundle",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onOutput: (chunk) => (output += chunk),
  });
  assert.equal(exitCode, 0);
  assert.equal(output, "two words; $(rm -rf nope)|secret-bundle");
});

test("executor reports nonzero exit codes", async () => {
  const result = await sshCapture(executor, "echo nope; exit 7", new AbortController().signal);
  assert.deepEqual(result, { exitCode: 7, output: "nope\n" });
});

test("executor enforces timeout and abort", async () => {
  await assert.rejects(
    executor.exec({
      command: ["sleep", "5"],
      stdin: "",
      timeoutMs: 200,
      signal: new AbortController().signal,
      onOutput() {},
    }),
    /timed out/,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("cancelled")), 100);
  await assert.rejects(
    executor.exec({ command: ["sleep", "5"], stdin: "", timeoutMs: 10_000, signal: controller.signal, onOutput() {} }),
    /cancelled/,
  );
});

test("environment names are stable per key", () => {
  assert.equal(envNameForKey("k1"), envNameForKey("k1"));
  assert.notEqual(envNameForKey("k1"), envNameForKey("k2"));
  assert.match(envNameForKey("k1"), /^[a-z]+-[a-z-]+-[0-9a-f]{4}$/);
});

test("daemon env keeps Codex SQLite off the shared home only when configured", () => {
  assert.deepEqual(daemonEnv(""), ["BB_INSTALL_SKIP_SERVICE=1"]);
  assert.deepEqual(daemonEnv("/workspaces/x"), ["BB_INSTALL_SKIP_SERVICE=1", "CODEX_SQLITE_HOME=/workspaces/x"]);
});
