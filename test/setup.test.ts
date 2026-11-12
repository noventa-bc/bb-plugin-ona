import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  cachedLogin,
  checkOnaLogin,
  createSetup,
  findOnaBinary,
  ONA_INSTALL_HINT,
  onaAvailability,
  planSetup,
  type GeneralSettings,
  type OnaLogin,
} from "../src/setup.ts";

test("findOnaBinary prefers the configured path, then PATH", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ona-bin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

const goodLogin: OnaLogin = { ok: true, user: "Ada", org: "example.com" };
const rejectedLogin: OnaLogin = { ok: false, message: "not logged in", reason: "auth" };
const unknownLogin: OnaLogin = { ok: false, message: "something odd", reason: "unknown" };
const unreachableLogin: OnaLogin = { ok: false, message: "connection refused", reason: "network" };

/** A login check that answers from `answers` in turn, the last one again; `calls.count` counts its runs. */
function loginChecks(...answers: OnaLogin[]) {
  const calls = { count: 0 };
  const check = async () => answers[Math.min(calls.count++, answers.length - 1)]!;
  return { check, calls };
}

test("cachedLogin keeps an answer for 5 minutes from the end of its check, and a hit does not move that window (fails if the clock is read before the check, a hit restarts the window, or the window is not exactly 5 minutes)", async () => {
  let now = 0;
  const calls = { count: 0 };
  // Each check takes a minute, so the window runs from its end.
  const check = async () => {
    calls.count += 1;
    now += 60_000;
    return goodLogin;
  };
  const login = cachedLogin(check, () => now);
  await login("ona");
  now = 60_000 + 5 * 60_000 - 1;
  assert.deepEqual(await login("ona"), goodLogin);
  assert.equal(calls.count, 1, "just inside 5 minutes");
  now = 60_000 + 5 * 60_000;
  assert.deepEqual(await login("ona"), goodLogin);
  assert.equal(calls.count, 2, "exactly 5 minutes");
});

test("cachedLogin keeps a good login through a fresh network failure, and the kept login's time is refreshed (fails if a network failure replaces the good login, the kept login keeps its old time, a fresh result is not stored, or fresh is ignored)", async () => {
  let now = 0;
  const { check, calls } = loginChecks(goodLogin, unreachableLogin);
  const login = cachedLogin(check, () => now);
  await login("ona");
  now = 60_000;
  assert.deepEqual(await login("ona", true), goodLogin);
  assert.equal(calls.count, 2);
  now = 330_000;
  assert.deepEqual(await login("ona"), goodLogin);
  assert.equal(calls.count, 2);
});

test("cachedLogin replaces a good login with a fresh failure that is not a network failure, and holds that failure for 5 minutes (fails if a failure with another reason keeps the good login, a fresh result or a failure is not stored, fresh is ignored, or a failure is held for less than 5 minutes)", async () => {
  for (const failure of [rejectedLogin, unknownLogin]) {
    let now = 0;
    const { check, calls } = loginChecks(goodLogin, failure);
    const login = cachedLogin(check, () => now);
    await login("ona");
    now = 60_000;
    assert.deepEqual(await login("ona", true), failure, failure.reason);
    now = 60_000 + 5 * 60_000 - 1;
    assert.deepEqual(await login("ona"), failure, failure.reason);
    assert.equal(calls.count, 2, failure.reason);
    now = 60_000 + 5 * 60_000;
    assert.deepEqual(await login("ona"), failure, failure.reason);
    assert.equal(calls.count, 3, failure.reason);
  }
});

test("cachedLogin returns a network failure when no login came before it (fails if the kept login is read before it exists)", async () => {
  const { check } = loginChecks(unreachableLogin);
  assert.deepEqual(await cachedLogin(check)("ona"), unreachableLogin);
});

test("cachedLogin returns a new network failure over an earlier failed login (fails if a network failure keeps an earlier failure)", async () => {
  let now = 0;
  const { check } = loginChecks(rejectedLogin, unreachableLogin);
  const login = cachedLogin(check, () => now);
  await login("ona");
  now += 5 * 60_000;
  assert.deepEqual(await login("ona"), unreachableLogin);
});

test("planSetup says Ona could not be reached instead of asking for a login", () => {
  const steps = planSetup({ ...ready, login: { ok: false, message: "connection refused", reason: "network" } });
  const login = steps.find((step) => step.id === "login")!;
  assert.equal(login.state, "blocked");
  assert.match(login.detail, /could not be reached/);
  assert.doesNotMatch(login.detail, /ona login/);
});

const sshMissing = () => false;
const sshPresent = () => true;

test("onaAvailability asks for the ona CLI when none was found (fails if the message or status changes)", () => {
  assert.deepEqual(onaAvailability(null, sshMissing), { status: "setup-required", message: ONA_INSTALL_HINT });
});

test("onaAvailability shows Ona as unavailable when it cannot be reached (fails if that is shown as a setup step)", () => {
  assert.deepEqual(onaAvailability({ ok: false, message: "connection refused", reason: "network" }, sshMissing), {
    status: "unavailable",
    message: "Ona could not be reached. (connection refused)",
  });
});

test("onaAvailability asks for ona login after any other failed login (fails if one failure reason is shown another way)", () => {
  for (const reason of ["auth", "unknown"] as const) {
    assert.deepEqual(
      onaAvailability({ ok: false, message: "not logged in", reason }, sshMissing),
      { status: "setup-required", message: "Ona CLI is not logged in: run `ona login`. (not logged in)" },
      reason,
    );
  }
});

test("onaAvailability asks for the ssh config after a good login (fails if a missing ssh config passes)", () => {
  assert.deepEqual(onaAvailability(ready.login, sshMissing), {
    status: "setup-required",
    message: "Run `ona environment ssh-config` so bb can reach Ona environments over SSH.",
  });
});

test("onaAvailability is available after a good login with the ssh config (fails if a complete setup is refused)", () => {
  assert.deepEqual(onaAvailability(ready.login, sshPresent), { status: "available" });
});

const neverRead = () => assert.fail("ssh config read before a good login");

test("the ssh config is not read without a good login (fails if the check runs before the login result)", () => {
  onaAvailability(null, neverRead);
  onaAvailability({ ok: false, message: "connection refused", reason: "network" }, neverRead);
  onaAvailability({ ok: false, message: "not logged in", reason: "auth" }, neverRead);
});

/**
 * `bb ona setup` against a fake bb CLI and ona: `run` keeps bb's settings in
 * memory and never spawns. A bb CLI file exists only so setup finds one.
 */
function setupWorld(
  t: TestContext,
  start: Partial<GeneralSettings>,
  options: { failing?: string; onaMissing?: boolean; bbCli?: string } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-data-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, "bin"));
  const cliPath = join(dataDir, "bin", "bb");
  writeFileSync(cliPath, options.bbCli ?? "#!/bin/sh\n");
  const settings: GeneralSettings = { ...ready.settings, ...start };
  let sshConfigured = true;
  const calls: string[] = [];
  const runs: Array<{ binary: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const setup = createSetup({
    server: { loopbackBaseUrl: "http://127.0.0.1:38886/", experimental_dataDir: dataDir },
    findOna: () => (options.onaMissing ? null : "/bin/ona"),
    onaPath: "ona",
    onaLogin: async () => ready.login,
    hasOnaSshConfig: () => sshConfigured,
    run: async (binary, args, runOptions) => {
      runs.push({ binary, args, env: runOptions?.env });
      const call = [binary, ...args].join(" ");
      const ok = { ok: true, stdout: "", stderr: "", error: null };
      if (call.endsWith("settings show --json"))
        return { ...ok, stdout: JSON.stringify({ data: { generalSettings: settings } }) };
      calls.push(call.replace(/^.* (settings|environment) /, "$1 "));
      if (options.failing && call.includes(options.failing)) return { ...ok, ok: false, stderr: "first line\nrefused" };
      if (call.endsWith("environment ssh-config")) sshConfigured = true;
      const [key, value] = args.slice(-2) as [keyof GeneralSettings, string];
      if (args.includes("general")) Object.assign(settings, { [key]: value === "false" ? false : value });
      return ok;
    },
  });
  return { setup, calls, runs, cliPath, setSsh: (value: boolean) => (sshConfigured = value) };
}

test("setup without --yes shows the plan with a footer for blocked, changes and all set", async (t) => {
  const done = setupWorld(t, {});
  const ok = await done.setup(false, false);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /All set\./);

  const changes = setupWorld(t, { defaultMachineAccess: "connect" });
  const planned = await changes.setup(false, false);
  assert.equal(planned.exitCode, 0);
  assert.match(planned.stdout, /→ Default machine access: connect -> direct/);
  assert.match(planned.stdout, /Run `bb ona setup --yes`/);
  assert.deepEqual(changes.calls, [], "a plan changes nothing");

  const blocked = setupWorld(t, {}, { onaMissing: true });
  const stuck = await blocked.setup(false, false);
  assert.equal(stuck.exitCode, 1);
  assert.match(stuck.stdout, /✗ Ona CLI/);
  assert.match(stuck.stdout, /Fix the ✗ items above/);
});

test("setup --yes applies only the → steps, then re-plans", async (t) => {
  const world = setupWorld(t, { defaultMachineAccess: "connect", machineServerUrl: null });
  world.setSsh(false);
  const result = await world.setup(true, false);
  assert.deepEqual(world.calls, [
    "environment ssh-config",
    "settings general defaultMachineAccess direct",
    "settings general machineServerUrl http://127.0.0.1:38886",
  ]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /All set\./);
  assert.equal(result.stderr, undefined);
});

test("setup --yes reports the last line of a failed step and exits 1", async (t) => {
  const world = setupWorld(t, { defaultMachineAccess: "connect" }, { failing: "defaultMachineAccess" });
  const result = await world.setup(true, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "Default machine access: refused");
  assert.match(result.stdout, /→ Default machine access/);
});

test("setup runs a node bb CLI with the plugin's own runtime", async (t) => {
  const world = setupWorld(t, {}, { bbCli: "#!/usr/bin/env node\n" });
  await world.setup(false, false);
  const [first] = world.runs;
  assert.equal(first?.binary, process.execPath);
  assert.equal(first?.args[0], world.cliPath);
  assert.equal(first?.env?.ELECTRON_RUN_AS_NODE, "1");
});

test("setup --yes turns machine git credentials off unless kept", async (t) => {
  const world = setupWorld(t, { machineGitCredentialsEnabled: true });
  await world.setup(true, false);
  assert.deepEqual(world.calls, ["settings general machineGitCredentialsEnabled false"]);
});
