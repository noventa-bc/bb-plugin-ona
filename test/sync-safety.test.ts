// Sync passes against the safety rules in docs/sync.md: each test fails if the check it names is removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL, RELEASE_IDLE } from "../src/reconcile.ts";
import type { BbHost } from "../src/sync.ts";
import { enableFakeClock, resetFakeClock, settle, tick } from "./fake-clock.ts";
import { HOUR, NOW, idle, world } from "./sync-fakes.ts";

test("a daemon repair makes no SSH check when the repair's own listing shows the box stopped (fails if the check before the SSH is dropped)", async () => {
  const { sync, calls } = world([idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR })], {
    stopBeforeRefresh: true,
  });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, [], "the pass's listing said RUNNING, the fresh one STOPPED: no probe");
});

test("two empty Ona listings settle nothing: no lookup by id, no suspend (fails if an empty listing counts as the box missing)", async () => {
  // An empty listing is as likely a wrong `ona context` as no boxes; a lookup by id there finds nothing either.
  const { sync, calls } = world([idle("h1")], { listing: "empty" });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual(calls, []);
});

test("an unknown daemon answer is reported as unknown (fails if the fake turns null into true)", async () => {
  const box = idle("h1", { status: "disconnected", lastSeenAt: NOW - HOUR });
  const { sync, guard } = world([box], { daemonAlive: null });
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.match(guard.records.get("h1")!.reason, /couldn't tell whether the daemon runs/);
});

/**
 * An idle release of h1 whose settle times out: bb still shows the machine suspending after the 6 minutes, and the
 * no-stop flag stays for the provider's suspend bb may still run. Runs on the fake clock the caller enabled.
 */
async function timedOutRelease(boxes = [idle("h1")]) {
  const made = world(boxes, {
    suspendSettles: { phase: "suspending", message: null },
    pluginStartedAt: Date.now() - 2 * HOUR,
  });
  await made.sync.reconcile(new Set([ALL]));
  assert.equal(made.guard.busyWith("h1"), RELEASE_IDLE);
  await tick(6 * 60_000);
  await settle();
  assert.equal(made.guard.busyWith("h1"), undefined, "the settle timed out");
  assert.ok(made.releasing.has("env-h1"));
  return made;
}

/** h1's phase as bb shows it from now on. */
const showPhase = (hosts: Map<string, BbHost>, phase: string) => {
  const host = hosts.get("h1")!;
  host.lifecycle = { ...host.lifecycle, phase };
};

// Bug: a flag left by a timed-out settle stayed after bb failed that suspend, so the user's next suspend kept the box running.
test("after a timed-out release that bb fails (machine active), a pass clears the flag and the user's suspend stops the box (fails if no pass clears a leftover flag)", () =>
  onFakeClock(async () => {
    const { sync, hosts, calls, providerSuspend } = await timedOutRelease();
    showPhase(hosts, "active");
    await sync.reconcile(new Set(["h1"]), { wait: true });
    providerSuspend("h1");
    assert.ok(calls.includes("stop env-h1"));
  }));

test("a pass keeps the flag while bb still shows the timed-out release suspending, so bb's suspend then stops nothing (fails if the pass clears a flag on any phase)", () =>
  onFakeClock(async () => {
    const { sync, calls, providerSuspend } = await timedOutRelease();
    await sync.reconcile(new Set(["h1"]), { wait: true });
    providerSuspend("h1");
    assert.ok(!calls.includes("stop env-h1"));
  }));

test("a pass during a release's settle keeps the flag, though bb shows the machine active (fails if the busy check is dropped)", () =>
  onFakeClock(async () => {
    const { sync, hosts, guard, releasing } = world([idle("h1")], {
      suspendSettles: { phase: "suspending", message: null },
      pluginStartedAt: Date.now() - 2 * HOUR,
    });
    await sync.reconcile(new Set([ALL]));
    await settle(); // the settle's first read, which shows suspending
    showPhase(hosts, "active");
    await sync.reconcile(new Set(["h1"]), { wait: true });
    assert.equal(guard.busyWith("h1"), RELEASE_IDLE, "the release is still settling");
    assert.ok(releasing.has("env-h1"));
    await tick(6 * 60_000);
  }));

test("a pass keeps the flag when bb's fresh read fails (fails if a failed read counts as active)", async () => {
  const { sync, releasing } = world([idle("h1")], { hostGet: "fail" });
  releasing.add("env-h1");
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(releasing.has("env-h1"));
});

test("a pass keeps the flag when bb's fresh read shows suspending, though the pass's listing said active (fails if the listing's phase is used)", async () => {
  const made = world([idle("h1")], { afterCall: (call) => call === "list" && showPhase(made.hosts, "suspending") });
  made.releasing.add("env-h1");
  await made.sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(made.releasing.has("env-h1"));
});

test("a pass keeps the flag when an action starts on the machine during its fresh read (fails if the busy check is not made again after the read)", async () => {
  let finish = () => {};
  const made = world([idle("h1")], {
    afterCall: (call) =>
      call === "get h1" &&
      void made.guard.run("h1", RELEASE_IDLE, "test", () => new Promise<void>((resolve) => (finish = resolve))),
  });
  made.releasing.add("env-h1");
  await made.sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(made.releasing.has("env-h1"));
  finish();
});

test("a pass keeps the flag of a box no listed machine uses (fails if an empty machine list counts as all active)", async () => {
  const { sync, releasing } = world([idle("h1")]);
  releasing.add("env-gone");
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(releasing.has("env-gone"));
});

test("two machines on one box: the flag stays while the other one is busy, or not active (fails if only the pass's machine is checked)", async () => {
  const boxes = () => [idle("h1"), idle("h2", { envId: "env-h1" })];
  const busy = world(boxes());
  busy.releasing.add("env-h1");
  let finish = () => {};
  const inFlight = busy.guard.run("h2", RELEASE_IDLE, "test", () => new Promise<void>((resolve) => (finish = resolve)));
  await busy.sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(busy.releasing.has("env-h1"), "h2 busy");
  finish();
  await inFlight;

  const suspended = world(boxes());
  suspended.releasing.add("env-h1");
  suspended.hosts.get("h2")!.lifecycle.phase = "suspended";
  await suspended.sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(suspended.releasing.has("env-h1"), "h2 suspended");
});

async function onFakeClock(fn: () => Promise<void>) {
  enableFakeClock();
  try {
    await fn();
  } finally {
    await resetFakeClock();
  }
}
