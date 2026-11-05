import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { OnaSnapshot, type OnaEnvironment } from "../src/ona.ts";
import {
  ALL,
  COOLDOWN_MS,
  DAEMON_PROBE,
  decide,
  GIVE_UP_AFTER,
  GRACE_MS,
  HostGuard,
  PassScheduler,
  STUCK_MS,
  type Clock,
  type MachineView,
  type OnaView,
} from "../src/reconcile.ts";
import { brokenTools, partialPs, sandboxed, standIn } from "./sandbox.ts";

const NOW = 10_000_000;
const machine = (overrides: Partial<MachineView> = {}): MachineView => ({
  hostId: "h1",
  phase: "active",
  status: "disconnected",
  lastSeenAt: NOW - 5 * 60_000,
  phaseSince: NOW - 60 * 60_000,
  tunnel: "up",
  threadWaiting: false,
  ...overrides,
});
const ona = (phase: string): OnaView => ({ kind: "env", phase: `ENVIRONMENT_PHASE_${phase}` });

// --- decide: one test per rule (docs/sync.md) ---

test("R1: running in Ona, active but disconnected past the grace period -> heal the daemon", () => {
  assert.equal(decide(machine(), ona("RUNNING"), NOW).action, "heal-daemon");
});

test("R1: a brief disconnect waits out the grace period, unless a thread is waiting", () => {
  const brief = machine({ lastSeenAt: NOW - GRACE_MS + 1_000 });
  assert.equal(decide(brief, ona("RUNNING"), NOW).action, "none");
  assert.equal(decide({ ...brief, threadWaiting: true }, ona("RUNNING"), NOW).action, "heal-daemon");
});

test("R1: bb working on a workspace skips the grace period, but never resumes a stopped box", () => {
  const brief = machine({ lastSeenAt: NOW - GRACE_MS + 1_000, workspaceWaiting: true });
  assert.equal(decide(brief, ona("RUNNING"), NOW).action, "heal-daemon");
  assert.match(decide(brief, ona("RUNNING"), NOW).reason, /retrying or retiring a workspace/);
  assert.equal(decide(brief, ona("STOPPED"), NOW).resumeAfter, false);
});

test("R1: the grace period is 45 s: a box disconnected for 45 s is healed, one for 44.999 s is not", () => {
  assert.equal(decide(machine({ lastSeenAt: NOW - 45_000 }), ona("RUNNING"), NOW).action, "heal-daemon");
  assert.equal(decide(machine({ lastSeenAt: NOW - 44_999 }), ona("RUNNING"), NOW).action, "none");
});

test("R1: running in Ona with no tunnel -> open the tunnel, even while bb still shows it connected", () => {
  assert.equal(decide(machine({ tunnel: "off" }), ona("RUNNING"), NOW).action, "ensure-tunnel");
  // Right after a reload: the old tunnel is gone but bb hasn't seen the daemon drop yet.
  assert.equal(decide(machine({ status: "connected", tunnel: "off" }), ona("RUNNING"), NOW).action, "ensure-tunnel");
  assert.equal(decide(machine({ status: "connected", tunnel: "off" }), ona("STOPPED"), NOW).action, "none");
});

test("connected machines are left alone", () => {
  assert.equal(decide(machine({ status: "connected" }), ona("RUNNING"), NOW).action, "none");
  assert.equal(decide(machine({ status: "connected" }), ona("STOPPED"), NOW).action, "none");
});

test("R2: stopped or stopping in Ona while bb shows active -> suspend without stopping", () => {
  assert.equal(decide(machine(), ona("STOPPED"), NOW).action, "suspend-observed");
  assert.equal(decide(machine(), ona("STOPPING"), NOW).action, "suspend-observed");
  assert.equal(decide(machine(), ona("STOPPED"), NOW).resumeAfter, false);
  assert.equal(decide(machine({ threadWaiting: true }), ona("STOPPED"), NOW).resumeAfter, true);
});

test("R3: deleted, or missing from two good listings -> suspend and report it gone", () => {
  assert.equal(decide(machine(), ona("DELETED"), NOW).action, "suspend-observed");
  assert.match(decide(machine(), ona("DELETED"), NOW).reason, /gone/);
  assert.equal(decide(machine(), { kind: "missing", streak: 1 }, NOW).action, "none");
  assert.equal(decide(machine(), { kind: "missing", streak: 2 }, NOW).action, "suspend-observed");
});

test("R3: a box Ona is deleting is suspended and reported gone, like a deleted one", () => {
  const decision = decide(machine(), ona("DELETING"), NOW);
  assert.equal(decision.action, "suspend-observed");
  assert.match(decision.reason, /gone/);
});

test("R3: an archived box is suspended and reported archived, not gone", () => {
  const decision = decide(machine(), { kind: "missing", streak: 2, archived: true }, NOW);
  assert.equal(decision.action, "suspend-observed");
  assert.match(decision.reason, /archived/);
  assert.doesNotMatch(decision.reason, /gone/);
  assert.match(decide(machine(), { kind: "missing", streak: 2, archived: false }, NOW).reason, /gone/);
});

test("R4: suspended in bb stays suspended even when Ona runs the box", () => {
  const decision = decide(machine({ phase: "suspended" }), ona("RUNNING"), NOW);
  assert.equal(decision.action, "none");
  assert.match(decision.reason, /running in Ona/);
});

test("R5: resuming or suspending for too long -> ask bb to reconcile", () => {
  assert.equal(
    decide(machine({ phase: "resuming", phaseSince: NOW - STUCK_MS }), ona("RUNNING"), NOW).action,
    "reconcile-stuck",
  );
  assert.equal(decide(machine({ phase: "suspending", phaseSince: NOW - 60_000 }), ona("RUNNING"), NOW).action, "none");
});

test("rule 4: unknown Ona state changes nothing", () => {
  for (const phase of ["active", "suspended"]) {
    assert.equal(decide(machine({ phase }), { kind: "unknown" }, NOW).action, "none");
  }
});

test("rule 1: nothing is done to a box Ona is starting or in any phase other than running", () => {
  for (const phase of ["STARTING", "CREATING", "PENDING", "UPDATING"]) {
    assert.equal(decide(machine(), ona(phase), NOW).action, "none");
  }
});

test("creating and removing machines are bb's business", () => {
  for (const phase of ["creating", "removing", "destroyed"]) {
    assert.equal(decide(machine({ phase }), ona("STOPPED"), NOW).action, "none");
  }
});

// --- scheduler and guard, on a fake clock ---

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  async function advance(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
    // Let the pass's promise chain settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  return { clock, advance };
}

test("scheduler coalesces a burst into one pass with the earliest due time", async () => {
  const { clock, advance } = fakeClock();
  const passes: string[][] = [];
  const scheduler = new PassScheduler(async (keys) => void passes.push([...keys].sort()), clock);
  scheduler.schedule("h1", 2_000);
  scheduler.schedule("h1", 2_000);
  scheduler.schedule("h2", 1_000);
  scheduler.schedule("h1", 500);
  await advance(999);
  assert.deepEqual(passes, [["h1"]]);
  await advance(1);
  assert.deepEqual(passes, [["h1"], ["h2"]]);
  scheduler.schedule(ALL, 0);
  await advance(0);
  assert.deepEqual(passes.at(-1), [ALL]);
});

test("scheduler runs one pass at a time and stops cleanly", async () => {
  const { clock, advance } = fakeClock();
  let release!: () => void;
  let running = 0;
  let maxRunning = 0;
  const scheduler = new PassScheduler(async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise<void>((resolve) => (release = resolve));
    running--;
  }, clock);
  scheduler.schedule("h1", 0);
  await advance(0);
  scheduler.schedule("h2", 0);
  await advance(10);
  assert.equal(maxRunning, 1);
  release();
  await advance(0);
  await advance(0);
  release();
  scheduler.stop();
  scheduler.schedule("h3", 0);
  await advance(10);
  assert.equal(maxRunning, 1);
});

test("scheduler reports a failing pass and keeps scheduling", async () => {
  const { clock, advance } = fakeClock();
  const errors: unknown[] = [];
  const passes: string[][] = [];
  const scheduler = new PassScheduler(
    async (keys) => {
      passes.push([...keys]);
      if (keys.has("h1")) throw new Error("boom");
    },
    clock,
    (error) => errors.push(error),
  );
  scheduler.schedule("h1", 0);
  await advance(0);
  assert.match(String(errors[0]), /boom/);
  scheduler.schedule("h2", 0);
  await advance(0);
  assert.deepEqual(passes, [["h1"], ["h2"]]);
});

test("guard: one action per machine, cooldown after it", async () => {
  const { clock, advance } = fakeClock();
  const guard = new HostGuard(2, clock);
  let finish!: () => void;
  const first = guard.run("h1", "heal-daemon", "r", () => new Promise<void>((resolve) => (finish = resolve)), {
    cooldown: true,
  });
  await advance(0);
  assert.equal(guard.busyWith("h1"), "heal-daemon");
  assert.equal(await guard.run("h1", "heal-daemon", "r", async () => {}), false);
  finish();
  assert.equal(await first, true);
  assert.equal(guard.mayAct("h1"), false);
  await advance(COOLDOWN_MS);
  assert.equal(guard.mayAct("h1"), true);
});

test("guard: failures back off and give up, a forced run still goes", async () => {
  const { clock, advance } = fakeClock();
  const guard = new HostGuard(2, clock);
  const fail = async () => {
    throw new Error("boom");
  };
  for (let i = 1; i <= GIVE_UP_AFTER; i++) {
    await assert.rejects(guard.run("h1", "heal-daemon", "r", fail));
    assert.equal(guard.records.get("h1")?.failures, i);
    await advance(COOLDOWN_MS * 2 ** (i - 1));
  }
  assert.equal(guard.mayAct("h1"), false, "gave up");
  assert.equal(await guard.run("h1", "heal-daemon", "r", async () => "ok", { force: true }), true);
  assert.equal(guard.records.get("h1")?.failures, 0);
  assert.match(guard.records.get("h1")!.reason, /ok/);
});

test("guard: routine checks don't hide the last action, and keep their own 'since'", async () => {
  const { clock, advance } = fakeClock();
  const guard = new HostGuard(2, clock);
  await guard.run("h1", "heal-daemon", "daemon not connected", async () => "restarted it");
  await advance(1_000);
  guard.note("h1", "connected");
  await advance(60_000);
  guard.note("h1", "connected");
  assert.equal(guard.records.get("h1")?.action, "heal-daemon");
  assert.match(guard.records.get("h1")!.reason, /restarted it/);
  assert.deepEqual(guard.seen.get("h1"), { reason: "connected", since: 1_000 });
  guard.note("h1", "disconnected briefly");
  assert.equal(guard.seen.get("h1")?.since, 61_000);
});

test("guard: heavy actions run at most `limit` at a time", async () => {
  const guard = new HostGuard(2);
  let running = 0;
  let maxRunning = 0;
  const work = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
  };
  await Promise.all(["a", "b", "c", "d"].map((host) => guard.run(host, "heal-daemon", "r", work, { heavy: true })));
  assert.equal(maxRunning, 2);
});

// --- shared Ona snapshot ---

test("snapshot shares one list between concurrent callers and caches it", async () => {
  let calls = 0;
  let now = 0;
  const envs: OnaEnvironment[] = [{ id: "e1", metadata: {}, status: { phase: "ENVIRONMENT_PHASE_RUNNING" } }];
  const snapshot = new OnaSnapshot(
    async () => {
      calls++;
      return envs;
    },
    15_000,
    () => now,
  );
  await Promise.all([snapshot.get(), snapshot.get(), snapshot.get()]);
  assert.equal(calls, 1);
  now += 10_000;
  await snapshot.get();
  assert.equal(calls, 1);
  now += 10_000;
  await snapshot.get();
  assert.equal(calls, 2);
  await snapshot.refresh();
  assert.equal(calls, 3);
  // Bug: refresh() returned the cache once the wall clock stepped back, so an SSH caller could act on an old listing.
  now -= 60_000;
  await snapshot.refresh();
  assert.equal(calls, 4);
});

// Bug: `bb ona rename` refreshed into a list that started before the rename and cached the old name.
test("snapshot refresh during a list in flight fetches again after it", async () => {
  let name = "old";
  const snapshot = new OnaSnapshot(async () => [
    { id: "e1", metadata: { name }, status: { phase: "ENVIRONMENT_PHASE_RUNNING" } },
  ]);
  const inFlight = snapshot.get();
  name = "new";
  const refreshed = await snapshot.refresh();
  assert.equal((await inFlight).envs[0]!.metadata.name, "old");
  assert.equal(refreshed.envs[0]!.metadata.name, "new");
});

test("snapshot keeps the last good list and reports the error", async () => {
  let fail = false;
  const snapshot = new OnaSnapshot(async () => {
    if (fail) throw new Error("not logged in");
    return [];
  });
  await snapshot.get();
  fail = true;
  await assert.rejects(snapshot.refresh(), /not logged in/);
  assert.equal(snapshot.lastError, "not logged in");
  assert.notEqual(snapshot.latest, null);
});

// --- daemon probe (rule 3), run locally ---

test("daemon probe finds a process running from the data folder, and only that", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "data", ".bb-machines");
  await standIn(t, `${dir}/daemon`);
  const probe = (arg: string) =>
    spawnSync("bash", ["-c", DAEMON_PROBE, "probe", arg], { env: { ...process.env, HOME: home } }).status;
  assert.equal(probe(dir), 0);
  assert.equal(probe(join(home, "elsewhere")), 1, "the probe must not match its own command line");
});

// A box whose process listing can't be trusted answers unknown (exit 2).
test("a daemon probe that can't list processes answers unknown", () => {
  for (const [name, body] of brokenTools) {
    const bin = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
    try {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const env = { ...process.env, HOME: bin, PATH: `${bin}:${process.env.PATH}` };
      assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", bin], { env }).status, 2, `${name}: ${body}`);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }
  // bash also exits 2 on a syntax error, so the whole script must parse.
  assert.equal(spawnSync("bash", ["-n", "-c", DAEMON_PROBE]).status, 0);
});

// A ps that exits 1 is untrusted even when its listing still shows this shell: unknown (exit 2).
test("a daemon probe whose ps exits 1 after a listing without the daemon answers unknown", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  const bin = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const dir = join(home, "data", ".bb-machines");
  const child = await standIn(t, `${dir}/daemon`);
  writeFileSync(join(bin, "ps"), `#!/bin/sh\n${partialPs(child.pid!)}\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", dir], { env }).status, 2);
});

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

// A machine folder given through a symlink is matched through its resolved folder, with no ~/.bb-machines link.
test(
  "a machine folder given through a symlink finds its daemon when ~/.bb-machines is absent",
  sandboxed,
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const machineFolder = join(home, "disk", "server-a");
    mkdirSync(join(machineFolder, "npm", "bin"), { recursive: true });
    symlinkSync(machineFolder, join(home, "alias"));
    await standIn(t, `${realpathSync(machineFolder)}/npm/bin/bb-app`);
    const env = { ...process.env, HOME: home };
    assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", join(home, "alias")], { env }).status, 0);
  },
);

// A folder path with a newline can't be matched within one listing line, so the answer is unknown (exit 2).
test("a daemon probe whose folder path has a newline answers unknown", sandboxed, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, "a\nb");
  mkdirSync(data, { recursive: true });
  await standIn(t, `${realpathSync(data)}/npm/bin/bb-app`);
  const env = { ...process.env, HOME: home };
  assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", "", data], { env }).status, 2);
});

// The probe's own $(ps) subshell carries the folders in its command line; with no daemon running, it is not a match.
test("a probe with no daemon answers no daemon, though its own ps subshell names the folders", sandboxed, () => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  try {
    const x = join(home, "X");
    mkdirSync(join(x, "sub"), { recursive: true });
    const env = { ...process.env, HOME: home };
    assert.equal(spawnSync("bash", ["-c", DAEMON_PROBE, "probe", x, join(x, "sub")], { env }).status, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
