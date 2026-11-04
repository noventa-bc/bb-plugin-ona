// MOVE_MACHINE_ASIDE, the script that removing an adopted box runs over SSH,
// run locally with bash against a temporary home laid out as on a devbox.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { MOVE_MACHINE_ASIDE } from "../src/provider.ts";
import { DAEMON_PROBE } from "../src/reconcile.ts";
import { brokenTools, partialPs, sandboxed, standIn } from "./sandbox.ts";

// The stand-ins write their ready file after installing their signal handlers.
const SLEEPS = 'require("node:fs").writeFileSync(process.argv[3], ""); setTimeout(() => {}, 60000)';
const IGNORES_TERM =
  'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[3], ""); setTimeout(() => {}, 60000)';

/** Resolves once the ready file exists; throws after 5 s. */
async function ready(path: string): Promise<void> {
  for (let tick = 0; tick < 250 && !existsSync(path); tick++) await delay(20);
  if (!existsSync(path)) throw new Error(`${path} never appeared`);
}

/**
 * A home whose ~/.bb-machines links to a local-disk folder (as `machineDataDir`
 * sets it up) holding the data folders of machines host-1 and host-10. Each runs
 * a stand-in daemon running `script`, whose command line names the resolved
 * folder as bb's does, or the folder as reached through ~/.bb-machines with
 * `viaLink`. A `sleep` that takes 0.05 s sits beside any fake `ps` a test puts
 * first on PATH. Reaping a killed process before the next listing is a timing
 * assumption that the stop loop's 12 rounds absorb. `remove` runs the script and
 * returns its exit code, or null when a signal ends it.
 * `exitedWithin` waits up to 2 s for daemon i to exit.
 */
function devbox(t: TestContext, { script = SLEEPS, viaLink = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-remove-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const disk = join(home, "disk");
  const readyFiles: string[] = [];
  const daemons = ["host-1", "host-10"].map((hostId) => {
    const folder = join(disk, `server-${hostId}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "host-id"), `${hostId}\n`);
    const named = viaLink ? join(home, ".bb-machines", `server-${hostId}`) : realpathSync(folder);
    const readyFile = join(home, `ready-${hostId}`);
    readyFiles.push(readyFile);
    return spawn(process.execPath, ["-e", script, `${named}/npm/bin/bb-app`, "host-daemon", readyFile], {
      stdio: "ignore",
    });
  });
  t.after(() => daemons.forEach((daemon) => daemon.kill("SIGKILL")));
  symlinkSync(disk, join(home, ".bb-machines"));
  writeFileSync(join(home, "sleep"), "#!/bin/sh\n/bin/sleep 0.05\n", { mode: 0o755 });
  const started = Promise.all(readyFiles.map(ready));
  started.catch(() => {});
  const remove = async (hostId: string, legacy = "", path = process.env.PATH, cwd?: string): Promise<number | null> => {
    await started;
    return promisify(execFile)("/bin/bash", ["-c", MOVE_MACHINE_ASIDE, "bb-ona-remove", hostId, legacy], {
      cwd,
      env: { ...process.env, HOME: home, PATH: path },
    }).then(
      () => 0,
      (error: unknown) => (error as { code: number | null }).code,
    );
  };
  const running = (i: number) => daemons[i]!.exitCode === null && daemons[i]!.signalCode === null;
  const exitedWithin = async (i: number) => {
    for (let tick = 0; tick < 40 && running(i); tick++) await delay(50);
    return !running(i);
  };
  return { home, disk, remove, running, exitedWithin, pids: daemons.map((daemon) => daemon.pid!) };
}

// The stop loop matches the resolved folder; host-10 guards the "/" after the folder in the match,
// so removing host-1 leaves host-10's daemon running.
test("removing an adopted box stops its daemon and moves its data folder aside", sandboxed, async (t) => {
  const { disk, remove, running } = devbox(t);
  assert.equal(await remove("host-1"), 0);
  const [moved, other, ...rest] = readdirSync(disk).sort();
  assert.match(moved ?? "", /^server-host-1\.old-\d{8}T\d{6}Z$/);
  assert.equal(readFileSync(join(disk, moved!, "host-id"), "utf8"), "host-1\n", "the folder is moved, not deleted");
  assert.equal(other, "server-host-10");
  assert.deepEqual(rest, []);
  assert.equal(running(0), false, "the removed machine's daemon must be stopped");
  assert.equal(running(1), true, "another machine's daemon must keep running");
});

// Bug: bb retries a remove whose later teardown step failed, and the retry
// renamed <folder>.old-A to <folder>.old-A.old-B and then said it found nothing.
test("a retried remove leaves the folder it already moved alone and succeeds", sandboxed, async (t) => {
  const { disk, remove } = devbox(t);
  await remove("host-1");
  const moved = readdirSync(disk).sort();
  assert.equal(await remove("host-1"), 0);
  assert.deepEqual(readdirSync(disk).sort(), moved);
});

// Bug: a folder whose server host contains ".old" was taken for one already moved,
// so the folder stayed in place.
test("a folder whose server host contains .old is still moved aside", sandboxed, async (t) => {
  const { disk, remove } = devbox(t);
  renameSync(join(disk, "server-host-1"), join(disk, "bb.old-2.example.com-8443"));
  assert.equal(await remove("host-1"), 0);
  assert.match(readdirSync(disk).sort()[0] ?? "", /^bb\.old-2\.example\.com-8443\.old-\d{8}T\d{6}Z$/);
});

// The stop loop exits 4 and leaves the folder in place when ps or awk is missing, fails, or ignores -o.
for (const [tool, body] of brokenTools) {
  test(`a box whose ${tool} fails (${body}) moves nothing and exits 4`, sandboxed, async (t) => {
    const { home, disk, remove, running } = devbox(t);
    writeFileSync(join(home, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 4);
    assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
    assert.equal(running(0), true);
  });
}

// A ps that fails in a later round leaves the folder in place: its second listing prints part of
// its list, then exits 1.
test("a ps that fails during the stop loop leaves the folder and exits 4", sandboxed, async (t) => {
  const { home, disk, remove, pids } = devbox(t);
  writeFileSync(
    join(home, "ps"),
    `#!/bin/sh\nif [ -f "$HOME/ps-ran" ]; then\n${partialPs(pids[0]!)}\nfi\ntouch "$HOME/ps-ran"; exec /bin/ps "$@"\n`,
    { mode: 0o755 },
  );
  assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 4);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
});

// A ps that exits 1 is untrusted even when its listing still shows this shell: exit 4, the folder stays.
test("a ps that exits 1 after a listing without the daemon moves nothing and exits 4", sandboxed, async (t) => {
  const { home, disk, remove, running, pids } = devbox(t);
  writeFileSync(join(home, "ps"), `#!/bin/sh\n${partialPs(pids[0]!)}\n`, { mode: 0o755 });
  assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 4);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
  assert.equal(running(0), true);
});

// After the KILL rounds the loop lists again: a daemon the listing still shows keeps its folder (exit 4).
test("a daemon still listed after the forced kills keeps its folder and exits 4", sandboxed, async (t) => {
  const { home, disk, remove, exitedWithin } = devbox(t);
  // Pid 2147483646 is beyond the pid range, so no process has it: kill can't end it, and the listing keeps it.
  const folder = realpathSync(join(disk, "server-host-1"));
  writeFileSync(
    join(home, "ps"),
    `#!/bin/sh\n/bin/ps "$@"\necho "2147483646 1 ${folder}/npm/bin/bb-app host-daemon"\n`,
    { mode: 0o755 },
  );
  assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 4);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
  assert.equal(await exitedWithin(0), true, "the TERM round must stop the daemon the listing still shows");
});

// A daemon that ignores TERM is ended by the KILL rounds, and its folder moves only once the listing
// no longer shows it.
test("a daemon that ignores TERM is killed in the forced rounds and its folder moved aside", sandboxed, async (t) => {
  const { home, disk, remove, running, exitedWithin } = devbox(t, { script: IGNORES_TERM });
  assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 0);
  const [moved, other, ...rest] = readdirSync(disk).sort();
  assert.match(moved ?? "", /^server-host-1\.old-\d{8}T\d{6}Z$/);
  assert.equal(other, "server-host-10");
  assert.deepEqual(rest, []);
  assert.equal(await exitedWithin(0), true, "the KILL rounds must stop a daemon that ignores TERM");
  assert.equal(running(1), true, "another machine's daemon keeps running");
});

// A daemon whose command line names its folder through ~/.bb-machines is stopped before the folder moves.
test("a daemon run from the symlinked path is stopped and its folder moved aside", sandboxed, async (t) => {
  const { home, disk, remove, exitedWithin } = devbox(t, { viaLink: true });
  assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 0);
  assert.match(readdirSync(disk).sort()[0] ?? "", /^server-host-1\.old-\d{8}T\d{6}Z$/);
  assert.equal(await exitedWithin(0), true, "the daemon run from the symlinked path must be stopped");
});

// A host id that contains the folder path puts it in the script's own command line; the stop loop
// skips the script's shell and its subshells.
test("a host id that names the folder does not stop the script itself", sandboxed, async (t) => {
  const { home, remove } = devbox(t);
  const legacy = join(home, "legacy-9");
  mkdirSync(legacy);
  const real = realpathSync(legacy);
  writeFileSync(join(legacy, "host-id"), `${real}/x\n`);
  assert.equal(await remove(`${real}/x`, legacy), 0);
  assert.equal(existsSync(legacy), false, "the legacy folder is moved aside");
});

// A legacy folder whose path has a newline can't be matched within one listing line: exit 4, and the
// folder stays with its daemon running.
test("a legacy folder whose path has a newline stays in place", sandboxed, async (t) => {
  const { home, remove } = devbox(t);
  const legacy = join(home, "legacy\nnl");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "host-id"), "host-9\n");
  const daemon = await standIn(t, `${realpathSync(legacy)}/npm/bin/bb-app`);
  assert.equal(await remove("host-9", legacy), 4);
  assert.equal(existsSync(join(legacy, "host-id")), true, "the folder stays");
  assert.equal(daemon.exitCode === null && daemon.signalCode === null, true, "the daemon keeps running");
});

// A relative legacy dataDir resolves against $HOME, so the folder of the same name in the working folder is not matched.
test("a relative legacy folder never signals a process outside the machine folder", sandboxed, async (t) => {
  const { home, remove } = devbox(t);
  const cwd = join(home, "cwd");
  mkdirSync(join(cwd, "data"), { recursive: true });
  writeFileSync(join(cwd, "data", "host-id"), "host-r\n");
  const unrelated = await standIn(t, join(home, "other", "data", "unrelated"));
  assert.equal(await remove("host-r", "data", undefined, cwd), 3);
  assert.equal(existsSync(join(cwd, "data", "host-id")), true, "the relative folder stays");
  assert.equal(
    unrelated.exitCode === null && unrelated.signalCode === null,
    true,
    "the unrelated process keeps running",
  );
});

// A relative legacy dataDir resolves against $HOME, the SSH shell's folder: its daemon stops and its folder moves aside.
test("a relative legacy folder under HOME is moved aside and its daemon stopped", sandboxed, async (t) => {
  const { home, remove } = devbox(t);
  const legacy = join(home, "rel-legacy");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "host-id"), "host-rel\n");
  const daemon = await standIn(t, `${realpathSync(legacy)}/npm/bin/bb-app`);
  assert.equal(await remove("host-rel", "rel-legacy"), 0);
  assert.equal(existsSync(legacy), false, "the legacy folder is moved aside");
  const stopped = () => daemon.exitCode !== null || daemon.signalCode !== null;
  for (let tick = 0; tick < 40 && !stopped(); tick++) await delay(50);
  assert.equal(stopped(), true, "the daemon run from HOME must be stopped");
});

// The home folder is never a machine's data folder: a legacy dataDir of "." or of $HOME names it, so it stays.
test('a legacy dataDir of "." or $HOME leaves the home folder and its daemon in place', sandboxed, async (t) => {
  const { home, remove } = devbox(t);
  writeFileSync(join(home, "host-id"), "host-home\n");
  const daemon = await standIn(t, `${realpathSync(home)}/npm/bin/bb-app`);
  assert.equal(await remove("host-home", "."), 5);
  assert.equal(await remove("host-home", home), 5);
  assert.equal(existsSync(join(home, "host-id")), true, "the home folder stays");
  assert.equal(daemon.exitCode === null && daemon.signalCode === null, true, "the daemon keeps running");
});

// A folder above the home folder holds it, so it stays too.
test("a legacy dataDir above the home folder leaves it in place", sandboxed, async (t) => {
  const above = mkdtempSync(join(tmpdir(), "bb-ona-above-"));
  t.after(() => rmSync(above, { recursive: true, force: true }));
  const home = join(above, "home");
  mkdirSync(home);
  writeFileSync(join(above, "host-id"), "host-up\n");
  const code = await promisify(execFile)("/bin/bash", ["-c", MOVE_MACHINE_ASIDE, "bb-ona-remove", "host-up", ".."], {
    env: { ...process.env, HOME: home },
  }).then(
    () => 0,
    (error: unknown) => (error as { code: number | null }).code,
  );
  assert.equal(code, 5);
  assert.equal(
    existsSync(join(above, "host-id")) && existsSync(home),
    true,
    "the folder above and the home folder stay",
  );
});

/** A folder outside any test home, holding host-id "host-h", and a stand-in daemon run from it. */
async function legacyFolder(t: TestContext) {
  const parent = mkdtempSync(join(tmpdir(), "bb-ona-outside-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const folder = join(parent, "legacy");
  mkdirSync(folder);
  writeFileSync(join(folder, "host-id"), "host-h\n");
  const daemon = await standIn(t, `${realpathSync(folder)}/npm/bin/bb-app`);
  return { folder, daemon };
}

/** Runs the script for machine host-h on `legacy` under `env`; resolves to its exit code. */
function runScript(env: NodeJS.ProcessEnv, legacy: string): Promise<number | null> {
  return promisify(execFile)("/bin/bash", ["-c", MOVE_MACHINE_ASIDE, "bb-ona-remove", "host-h", legacy], { env }).then(
    () => 0,
    (error: unknown) => (error as { code: number | null }).code,
  );
}

/** Whether this user can enter `dir`. Root enters any folder whatever its mode. */
function canEnter(dir: string): boolean {
  try {
    accessSync(dir, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Without HOME the home folder can't be resolved, so the script exits before it stops or moves anything.
test("a legacy folder is kept and its daemon left running when HOME is unset", sandboxed, async (t) => {
  const { folder, daemon } = await legacyFolder(t);
  const env = { ...process.env };
  delete env.HOME;
  assert.equal(await runScript(env, folder), 5);
  assert.equal(existsSync(join(folder, "host-id")), true, "the folder stays");
  assert.equal(daemon.exitCode === null && daemon.signalCode === null, true, "the daemon keeps running");
});

// A HOME that can't be entered can't be resolved either: `cd` fails, and the guard must not read that as no home.
test("a legacy folder is kept and its daemon left running when HOME can't be entered", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-home-"));
  t.after(() => {
    chmodSync(home, 0o755);
    rmSync(home, { recursive: true, force: true });
  });
  chmodSync(home, 0o000);
  if (canEnter(home)) {
    t.skip("chmod has no effect for this user");
    return;
  }
  const { folder, daemon } = await legacyFolder(t);
  assert.equal(await runScript({ ...process.env, HOME: home }, folder), 5);
  assert.equal(existsSync(join(folder, "host-id")), true, "the folder stays");
  assert.equal(daemon.exitCode === null && daemon.signalCode === null, true, "the daemon keeps running");
});

// Bug: a remove that moved nothing said nothing, as if the folder had moved.
test("removing a machine whose data folder isn't on the box changes nothing and exits 3", sandboxed, async (t) => {
  const { disk, remove, running } = devbox(t);
  assert.equal(await remove("host-3"), 3);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
  assert.equal(running(0), true);
  assert.equal(running(1), true);
});

// Bug: an empty host id matched a folder whose host-id file is empty.
test("an empty host id moves nothing and exits 2", sandboxed, async (t) => {
  const { disk, remove } = devbox(t);
  mkdirSync(join(disk, "server-new"));
  writeFileSync(join(disk, "server-new", "host-id"), "");
  assert.equal(await remove(""), 2);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10", "server-new"]);
});

// Bug: a legacy data folder that also held other machines' data folders was
// moved with them, and their daemons stopped.
test("a legacy folder that holds other machines' data folders is left alone", sandboxed, async (t) => {
  const { disk, remove, running } = devbox(t);
  writeFileSync(join(disk, "host-id"), "host-3\n");
  assert.equal(await remove("host-3", disk), 3);
  assert.deepEqual(readdirSync(disk).sort(), ["host-id", "server-host-1", "server-host-10"]);
  assert.equal(running(0), true);
  assert.equal(running(1), true);
});

// The box scripts give ps one column per -o: busybox before 1.35 reads the rest of an -o argument as its header.
test("the box scripts give ps one column per -o", () => {
  for (const script of [MOVE_MACHINE_ASIDE, DAEMON_PROBE]) assert.doesNotMatch(script, /-\w*o \S+=,/);
});
