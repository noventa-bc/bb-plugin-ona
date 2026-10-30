import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { checkOnaLogin, findOnaBinary, planSetup } from "../src/setup.ts";

test("findOnaBinary prefers the configured path, then PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "ona-bin-"));
  const ona = join(dir, "ona");
  writeFileSync(ona, "#!/bin/sh\n");
  chmodSync(ona, 0o755);
  assert.equal(findOnaBinary(ona, ""), ona);
  assert.equal(findOnaBinary("/nope/ona", dir), ona);
  writeFileSync(join(dir, "not-exec"), "");
  assert.notEqual(findOnaBinary(join(dir, "not-exec"), ""), join(dir, "not-exec"));
});

const ready = {
  onaBinary: "/opt/homebrew/bin/ona",
  login: { ok: true as const, user: "Ada", org: "example.com" },
  sshConfigured: true,
  settings: {
    defaultMachineAccess: "direct",
    machineServerUrl: "http://127.0.0.1:38886",
    machineGitCredentialsEnabled: false,
  },
  serverUrl: "http://127.0.0.1:38886",
  keepGitCredentials: false,
};

test("planSetup reports nothing to do when configured", () => {
  assert.ok(planSetup(ready).every((step) => step.state === "ok"));
});

test("planSetup lists changes and blockers", () => {
  const steps = planSetup({
    ...ready,
    login: { ok: false, message: "not logged in", reason: "auth" },
    sshConfigured: false,
    settings: { defaultMachineAccess: "connect", machineServerUrl: null, machineGitCredentialsEnabled: true },
  });
  const state = Object.fromEntries(steps.map((step) => [step.id, step.state]));
  assert.deepEqual(state, {
    ona: "ok",
    login: "blocked",
    "ssh-config": "change",
    access: "change",
    "server-url": "change",
    "git-credentials": "change",
  });
});

test("planSetup blocks without the ona CLI and can keep git credentials", () => {
  const steps = planSetup({
    ...ready,
    onaBinary: null,
    login: null,
    keepGitCredentials: true,
    settings: { ...ready.settings, machineGitCredentialsEnabled: true },
  });
  assert.deepEqual(
    steps.map((step) => [step.id, step.state]),
    [
      ["ona", "blocked"],
      ["access", "ok"],
      ["server-url", "ok"],
    ],
  );
});

/** A fake `ona` whose `whoami` runs `body`; argv goes to `<dir>/argv`. Removed when the test ends. */
function fakeWhoami(t: TestContext, body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ona-whoami-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "ona");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/argv"\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test("checkOnaLogin reads the user and passes Ona's own --timeout", async (t) => {
  const { bin, dir } = fakeWhoami(t, `echo '{"name":"Ada","org":"example.com"}'`);
  assert.deepEqual(await checkOnaLogin(bin), { ok: true, user: "Ada", org: "example.com" });
  assert.equal(readFileSync(join(dir, "argv"), "utf8"), "whoami -o json --timeout 4s\n");
});

test("checkOnaLogin calls a rejected login an auth failure", async (t) => {
  for (const stderr of [
    "unauthenticated: please run ona login",
    "401 Unauthorized",
    "token expired",
    "session timed out, run `ona login`",
    "token expired: connection closed",
    "not logged in: request timed out",
  ]) {
    const { bin } = fakeWhoami(t, `echo '${stderr}' >&2; exit 1`);
    const login = await checkOnaLogin(bin);
    assert.equal(login.ok, false);
    assert.equal(!login.ok && login.reason, "auth", stderr);
  }
});

test("checkOnaLogin calls an unreachable Ona a network failure", async (t) => {
  for (const stderr of [
    "failed to authenticate: context deadline exceeded",
    "login request timed out",
    "dial tcp: lookup app.example.com: no such host",
    "connection refused",
    "tls: handshake failure",
    "network is unreachable",
  ]) {
    const { bin } = fakeWhoami(t, `echo '${stderr}' >&2; exit 1`);
    const login = await checkOnaLogin(bin);
    assert.equal(!login.ok && login.reason, "network", stderr);
  }
});

test("checkOnaLogin calls a whoami that never answers a network failure", async (t) => {
  const { bin } = fakeWhoami(t, "exec sleep 10");
  const started = Date.now();
  const login = await checkOnaLogin(bin, 200);
  assert.equal(!login.ok && login.reason, "network");
  assert.ok(Date.now() - started < 8_000);
});

test("checkOnaLogin calls a missing CLI or an unexplained failure unknown", async (t) => {
  const missing = await checkOnaLogin(join(tmpdir(), "no-such-dir-ona", "ona"));
  assert.equal(!missing.ok && missing.reason, "unknown");
  const { bin } = fakeWhoami(t, "echo 'something odd' >&2; exit 1");
  const odd = await checkOnaLogin(bin);
  assert.deepEqual(odd, { ok: false, message: "something odd", reason: "unknown" });
});

test("planSetup says Ona could not be reached instead of asking for a login", () => {
  const steps = planSetup({ ...ready, login: { ok: false, message: "connection refused", reason: "network" } });
  const login = steps.find((step) => step.id === "login")!;
  assert.equal(login.state, "blocked");
  assert.match(login.detail, /could not be reached/);
  assert.doesNotMatch(login.detail, /ona login/);
});
