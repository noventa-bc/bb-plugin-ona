import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

// --- decide: one test per rule (README "How bb and Ona stay in sync") ---

test("R1: running in Ona, active but disconnected past the grace period -> heal the daemon", () => {
  assert.equal(decide(machine(), ona("RUNNING"), NOW).action, "heal-daemon");
});

test("R1: a brief disconnect waits out the grace period, unless a thread is waiting", () => {
  const brief = machine({ lastSeenAt: NOW - GRACE_MS + 1_000 });
  assert.equal(decide(brief, ona("RUNNING"), NOW).action, "none");
  assert.equal(decide({ ...brief, threadWaiting: true }, ona("RUNNING"), NOW).action, "heal-daemon");
});

test("R1: running in Ona with no tunnel -> open the tunnel", () => {
  assert.equal(decide(machine({ tunnel: "off" }), ona("RUNNING"), NOW).action, "ensure-tunnel");
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

// The agent sandbox hides other processes from `ps`; this runs in CI and outside the sandbox.
const sandboxed = {
  skip: process.env.NONO_CAP_FILE ? "needs to see other processes, hidden in the agent sandbox" : false,
};

test("daemon probe finds a process running from the data folder, and only that", sandboxed, async () => {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-probe-"));
  const dir = join(home, "data", ".bb-machines");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", `${dir}/daemon`], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const probe = (arg: string) =>
      spawnSync("bash", ["-c", DAEMON_PROBE, "probe", arg], { env: { ...process.env, HOME: home } }).status;
    assert.equal(probe(dir), 0);
    assert.equal(probe(join(home, "elsewhere")), 1, "the probe must not match its own command line");
  } finally {
    child.kill();
  }
});
