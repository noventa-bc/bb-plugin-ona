import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DAEMON_PROBE } from "../src/reconcile.ts";
import { sandboxed, standIn } from "./sandbox.ts";

// A legacy data folder given through a symlink is matched through its resolved folder.
test("a symlinked legacy data folder finds a daemon run from its resolved folder", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, "real", "data");
  mkdirSync(data, { recursive: true });
  symlinkSync(join(home, "real"), join(home, "link"));
  await standIn(t, `${realpathSync(data)}/npm/bin/bb-app`);
  const env = { ...process.env, HOME: home };
  assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", "", join(home, "link", "data")], { env }).status, 0);
});

// Folder paths reach awk through the environment, so a backslash in one is matched as written.
test("a legacy folder whose path has a backslash still finds its daemon", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, "back\\tdata");
  mkdirSync(data, { recursive: true });
  await standIn(t, `${realpathSync(data)}/npm/bin/bb-app`);
  const env = { ...process.env, HOME: home };
  assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", "", data], { env }).status, 0);
});

/**
 * A home whose legacy folder "legacy" holds a stand-in daemon run from it, and a
 * working folder that is not the home. Returns the environment and working folder
 * to run the probe with.
 */
async function legacyDaemon(t: TestContext): Promise<{ env: NodeJS.ProcessEnv; cwd: string }> {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const legacy = join(home, "legacy");
  mkdirSync(join(legacy, "npm", "bin"), { recursive: true });
  await standIn(t, `${realpathSync(legacy)}/npm/bin/bb-app`);
  const cwd = join(home, "elsewhere");
  mkdirSync(cwd);
  return { env: { ...process.env, HOME: home }, cwd };
}

// A relative legacy dataDir is resolved against $HOME, the SSH shell's folder, not against the working folder.
test("a daemon probe resolves a relative legacy folder against HOME, from any working folder", sandboxed, async (t) => {
  const { env, cwd } = await legacyDaemon(t);
  assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", "", "./legacy"], { env, cwd }).status, 0);
});

// A daemon started from HOME names the relative legacy folder as given, so the probe matches that text too.
test("a daemon named as ./legacy/npm/bin/bb-app is found from HOME", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "legacy", "npm", "bin"), { recursive: true });
  await standIn(t, "./legacy/npm/bin/bb-app");
  const env = { ...process.env, HOME: home };
  assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", "", "./legacy"], { env, cwd: home }).status, 0);
});
