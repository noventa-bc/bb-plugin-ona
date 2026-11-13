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
async function timedOutRelease() {
  const made = world([idle("h1")], {
    suspendSettles: { phase: "suspending", message: null },
    pluginStartedAt: Date.now() - 2 * HOUR,
  });
  await made.sync.reconcile(new Set([ALL]));
  assert.equal(made.guard.busyWith("h1"), RELEASE_IDLE);
  await tick(6 * 60_000);
  await settle();
  assert.equal(made.guard.busyWith("h1"), undefined, "the settle timed out");
  assert.ok(made.releasing.has("h1"));
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
    assert.ok(releasing.has("h1"));
    await tick(6 * 60_000);
  }));

test("a pass keeps the flag when bb's fresh read fails (fails if a failed read counts as active)", async () => {
  const { sync, releasing } = world([idle("h1")], { hostGet: "fail" });
  releasing.add("h1");
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(releasing.has("h1"));
});

test("a pass keeps the flag when bb's fresh read shows suspending, though the pass's listing said active (fails if the listing's phase is used)", async () => {
  const made = world([idle("h1")], { afterCall: (call) => call === "list" && showPhase(made.hosts, "suspending") });
  made.releasing.add("h1");
  await made.sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(made.releasing.has("h1"));
});

test("a pass keeps the flag when an action starts on the machine during its fresh read (fails if the busy check is made before the read only)", async () => {
  let finish = () => {};
  const made = world([idle("h1")], {
    afterCall: (call) =>
      call === "get h1" &&
      void made.guard.run("h1", RELEASE_IDLE, "test", () => new Promise<void>((resolve) => (finish = resolve))),
  });
  made.releasing.add("h1");
  await made.sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(made.releasing.has("h1"));
  finish();
});

test("a pass keeps the flag of a machine bb no longer has (fails if a not-found read counts as active)", async () => {
  const { sync, releasing } = world([idle("h1")]);
  releasing.add("gone");
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(releasing.has("gone"));
});

test("a pass keeps a machine's flag while its own action is in flight, and an action on another machine does not hold it (fails if the busy check is dropped or covers every machine)", async () => {
  const { sync, releasing, guard } = world([idle("h1"), idle("h2", { envId: "env-h1" })]);
  releasing.add("h1");
  let finish = () => {};
  const own = guard.run("h1", RELEASE_IDLE, "test", () => new Promise<void>((resolve) => (finish = resolve)));
  await sync.reconcile(new Set(["h2"]), { wait: true });
  assert.ok(releasing.has("h1"), "h1's own action holds its flag");
  finish();
  await own;
  const other = guard.run("h2", RELEASE_IDLE, "test", () => new Promise<void>((resolve) => (finish = resolve)));
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.ok(!releasing.has("h1"), "h2's action does not hold h1's flag");
  finish();
  await other;
});

test("two machines on one box: a pass clears the active machine's flag and keeps the suspended one's (fails if a pass clears a flag whose machine it did not read active)", async () => {
  const { sync, releasing, hosts } = world([idle("h1"), idle("h2", { envId: "env-h1" })]);
  releasing.add("h1");
  releasing.add("h2");
  hosts.get("h2")!.lifecycle.phase = "suspended";
  await sync.reconcile(new Set(["h1"]), { wait: true });
  assert.deepEqual([...releasing], ["h2"]);
});

// Bug: the flag was kept per box, so bb's suspend of the second idle machine on a shared box found it consumed and stopped the box.
test("two idle machines on one box, both let go in one pass: nothing stops the box and both end suspended (fails if the flag is kept per box)", async () => {
  const { sync, calls, hosts } = world([idle("h1"), idle("h2", { envId: "env-h1" })]);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("stop")),
    [],
  );
  assert.deepEqual([hosts.get("h1")!.lifecycle.phase, hosts.get("h2")!.lifecycle.phase], ["suspended", "suspended"]);
});

test("after the plugin lets go of one machine on a shared box, the user's suspend of the other one stops the box (fails if the flag is set for every machine on the box)", async () => {
  const recent = { id: "t1", status: "idle", updatedAt: Date.now(), runtime: { displayStatus: "idle" } };
  const { sync, calls, providerSuspend } = world([idle("h1"), idle("h2", { envId: "env-h1", threads: [recent] })]);
  await sync.reconcile(new Set([ALL]), { wait: true });
  assert.ok(calls.includes("suspend h1") && !calls.includes("suspend h2"), "only h1 is idle");
  assert.ok(!calls.includes("stop env-h1"), "the plugin's own release stopped nothing");
  providerSuspend("h2");
  assert.ok(calls.includes("stop env-h1"));
});

async function onFakeClock(fn: () => Promise<void>) {
  enableFakeClock();
  try {
    await fn();
  } finally {
    await resetFakeClock();
  }
}
