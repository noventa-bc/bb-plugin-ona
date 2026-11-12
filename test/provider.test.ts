// The provider's bootstrap, suspend, resume, remove and cleanup paths, driven through `wake`,
// `suspend`, `resume`, `remove` and `reconcileCleanup` in the fake host of ./provider-fake.ts. setTimeout and Date
// are mocked, so each tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import { onaRef, resourceSchema } from "../src/provider.ts";
import { tick, useFakeClock } from "./fake-clock.ts";
import { adoptedResource, box, connectCalls, lifecycle, register } from "./provider-fake.ts";

useFakeClock();

// Bug: a waiting thread on an active machine whose box Ona stopped had bb's resume asked, which does nothing there.
test("wake starts a stopped box and connects it (fails if wake skips the start)", async () => {
  const { wake, calls } = register({ found: box("STOPPED"), phases: ["STOPPED", "RUNNING"] });
  await wake(adoptedResource, lifecycle().report, new AbortController().signal);
  assert.deepEqual(calls, ["get STOPPED", "start", "get RUNNING", ...connectCalls]);
});

test("wake on a running box connects it without starting it (fails if wake starts a running box)", async () => {
  const { wake, calls } = register({ found: box("RUNNING") });
  await wake(adoptedResource, lifecycle().report, new AbortController().signal);
  assert.deepEqual(calls, ["get RUNNING", "get RUNNING", ...connectCalls]);
});

test("wake refuses a box Ona is deleting, and starts nothing (fails if wake starts a deleting box)", async () => {
  const { wake, calls } = register({ found: box("DELETING") });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /box deleting, so it was not started/,
  );
  assert.deepEqual(calls, ["get DELETING"]);
});

test("wake names the environment Ona can't find, and starts nothing (fails if a missing box is started anyway)", async () => {
  const { wake, calls } = register({ found: { ...box("STOPPED"), id: "env-other" } });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /Ona environment "env-1" not found/,
  );
  assert.deepEqual(calls, []);
});

test("wake on a running box keeps its tunnel when the connect fails (fails if a failed connect closes it)", async () => {
  const { wake, tunnels } = register({ found: box("RUNNING"), tunnel: "up", preflightExit: 3 });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /missing bb prerequisites/,
  );
  assert.deepEqual(tunnels, ["ensure env-1"]);
});

test("a create with no project and no defaultProject is refused, naming the setting and the reload (fails if the reload is dropped)", async () => {
  const { provider } = register({ found: box("RUNNING") });
  const verdict = await provider.validate!({ inputs: { mode: "create" } });
  assert.equal(verdict.action, "refuse");
  assert.match("message" in verdict ? verdict.message : "", /`defaultProject` setting; .*`bb plugin reload ona`/);
});

// sync sets the no-stop flag before bb's suspend. If that suspend leaves it set, the user's next suspend
// must still stop the box.
test("a resume clears a no-stop flag a suspend left, so the next suspend stops the box (fails if the flag outlives the resume)", async () => {
  const { provider, releasing, calls } = register({ found: box("RUNNING") });
  releasing.add("env-1");
  const signal = new AbortController().signal;
  await provider.resume!({ ...lifecycle(), hostId: "host-1", resource: adoptedResource, signal });
  const before = calls.length;
  await provider.suspend!({ ...lifecycle(), hostId: "host-1", resource: adoptedResource, signal });
  assert.deepEqual(calls.slice(before), ["get RUNNING", "stop env-1"]);
});

// sync sets the flag before bb's suspend, so a flagged suspend only closes the tunnel.
test("a flagged suspend only closes the tunnel and consumes the flag (fails if it stops the box or keeps the flag)", async () => {
  const { provider, calls, releasing, tunnels } = register({ found: box("RUNNING"), tunnel: "up" });
  releasing.add("env-1");
  await provider.suspend!({
    ...lifecycle(),
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(calls, []);
  assert.equal(releasing.size, 0);
});

// A suspend you ask for (Pause, `bb machine suspend`, or `bb machine reconcile` of a suspended machine) stops the box
// unless Ona shows it stopped or deleted (not deleting) or no longer has it (docs/sync.md rule 2).
for (const [phase, after] of [
  ["STARTING", ["get STARTING", "stop env-1"]],
  ["STOPPING", ["get STOPPING", "stop env-1"]],
  ["STOPPED", ["get STOPPED"]],
  ["DELETING", ["get DELETING", "stop env-1"]],
  ["DELETED", ["get DELETED"]],
  [null, ["get null"]],
] as const) {
  const stops = after.length > 1;
  const fails = stops ? "only a RUNNING box is stopped" : "it stops a stopped, deleted or missing box";
  test(`a user suspend of a ${phase ?? "missing"} box ${stops ? "stops" : "leaves"} it (fails if ${fails})`, async () => {
    const { provider, calls } = register({ found: box("RUNNING"), phases: [phase] });
    await provider.suspend!({
      ...lifecycle(),
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    });
    assert.deepEqual(calls, after);
  });
}

test("a resume clears only its own box's flag (fails if another box's flag is wiped)", async () => {
  const { provider, releasing } = register({ found: box("RUNNING") });
  releasing.add("env-1");
  releasing.add("env-2");
  await provider.resume!({
    ...lifecycle(),
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.deepEqual([...releasing], ["env-2"]);
});

test("a resume that fails at preflight still clears the flag (fails if a failed resume keeps it)", async () => {
  const { provider, releasing } = register({ found: box("RUNNING"), preflightExit: 3 });
  releasing.add("env-1");
  await assert.rejects(
    provider.resume!({
      ...lifecycle(),
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    }),
    /^Error: Devbox is missing bb prerequisites: missing: node$/,
  );
  assert.equal(releasing.size, 0);
});

test("a resume whose Ona lookup throws clears the no-stop flag (fails if the flag is cleared after the lookup)", async () => {
  const { provider, releasing } = register({ found: box("RUNNING"), phases: [new Error("Ona is unreachable")] });
  releasing.add("env-1");
  await assert.rejects(
    provider.resume!({
      ...lifecycle(),
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    }),
    /Ona is unreachable/,
  );
  assert.equal(releasing.size, 0);
});

test("a resume of a box Ona shows deleting clears the no-stop flag (fails if the flag is cleared after the start)", async () => {
  const { provider, releasing } = register({ found: box("DELETING") });
  releasing.add("env-1");
  await assert.rejects(
    provider.resume!({
      ...lifecycle(),
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    }),
    /deleting, so it was not started/,
  );
  assert.equal(releasing.size, 0);
});

test("a resume of a box Ona no longer has rejects as not found, starts nothing and clears the no-stop flag (fails if an absent box is started or keeps the flag)", async () => {
  const { provider, calls, releasing } = register({ found: box("STOPPED"), phases: [null] });
  releasing.add("env-1");
  await assert.rejects(
    provider.resume!({
      ...lifecycle(),
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    }),
    /Ona environment "env-1" not found/,
  );
  assert.deepEqual(calls, ["get null"]);
  assert.equal(releasing.size, 0);
});

// The tests below guard the order: the tunnel closes before the lookup, so a failed lookup leaves it closed, and again
// after the move-aside.
test("remove of an adopted machine closes its tunnel (fails if an adopted remove deletes or stops its box)", async () => {
  const { provider, calls, tunnels } = register({ found: box("RUNNING"), phases: ["RUNNING"], tunnel: "up" });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "removed");
  assert.deepEqual(tunnels, ["stop env-1", "stop env-1"]);
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
});

test("remove of an adopted machine whose Ona lookup throws still closes its tunnel (fails if it deletes or stops the box)", async () => {
  const { provider, calls, tunnels, forgotten } = register({ found: box("RUNNING"), lookupFails: true, tunnel: "up" });
  await assert.rejects(
    provider.remove({
      report: lifecycle().report,
      hostId: "host-1",
      resource: adoptedResource,
      signal: new AbortController().signal,
    }),
    /Ona is unreachable/,
  );
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, [], "the keys stay for bb's retry");
  assert.deepEqual(calls, ["get failed"]);
});

test("remove of a bb-created machine whose Ona lookup throws still closes its tunnel", async () => {
  const { provider, tunnels, forgotten } = register({ found: box("RUNNING"), lookupFails: true, tunnel: "up" });
  await assert.rejects(
    provider.remove({
      report: lifecycle().report,
      hostId: "host-1",
      resource: { envId: "env-1", envName: "box", adopted: false, key: "key-1" },
      signal: new AbortController().signal,
    }),
    /Ona is unreachable/,
  );
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, [], "the keys stay for bb's retry");
});

test("remove of an adopted machine closes a tunnel that reopened during the move-aside (fails if it deletes or stops the box)", async () => {
  const { provider, calls, open, tunnels } = register({
    found: box("RUNNING"),
    phases: ["RUNNING"],
    tunnel: "up",
    reopenDuringMove: true,
  });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.equal(open.get("env-1") ?? "off", "off");
  assert.deepEqual(tunnels, ["stop env-1", "ensure env-1", "stop env-1"]);
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
  assert.equal(removed.status, "removed");
});

test("a refused remove of a bb-created machine closes its tunnel and keeps its keys", async () => {
  const { provider, tunnels, forgotten } = register({ found: box("RUNNING"), unpushed: true, tunnel: "up" });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: { envId: "env-1", envName: "box", adopted: false, key: "key-1" },
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "failed");
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, []);
});

// An adopted box keeps its own name, so the key-derived name never finds it.
test("reconcileCleanup deletes the box its key names, running or stopped, and closes its tunnel (fails if a stopped orphan is kept)", async () => {
  for (const phase of ["RUNNING", "STOPPED"]) {
    const created = { ...box(phase), metadata: { name: envNameForKey("key-1") } };
    const { provider, calls, tunnels } = register({ found: created });
    const cleaned = await provider.reconcileCleanup({
      key: "key-1",
      report: lifecycle().report,
      signal: new AbortController().signal,
    });
    assert.equal(cleaned.status, "removed", phase);
    assert.deepEqual(calls, ["delete env-1"], phase);
    assert.deepEqual(tunnels, ["stop env-1"], phase);
  }
});

test("reconcileCleanup with a failed Ona listing rejects and deletes nothing (fails if an unknown listing counts as removed)", async () => {
  const { provider, calls, tunnels } = register({ found: box("RUNNING"), lookupFails: true });
  await assert.rejects(
    provider.reconcileCleanup({
      key: "key-1",
      report: lifecycle().report,
      signal: new AbortController().signal,
    }),
    /Ona is unreachable/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(tunnels, []);
});

test("reconcileCleanup deletes nothing and closes no tunnel when no box carries the key's name (fails if a name miss still deletes)", async () => {
  const { provider, calls, tunnels } = register({ found: box("RUNNING") });
  const cleaned = await provider.reconcileCleanup({
    key: adoptedResource.key,
    report: lifecycle().report,
    signal: new AbortController().signal,
  });
  assert.equal(cleaned.status, "removed");
  assert.deepEqual(calls, []);
  assert.deepEqual(tunnels, []);
});

test("a refused remove of a bb-created machine names its uncommitted files and keeps its keys", async () => {
  const { provider, forgotten } = register({ found: box("RUNNING"), uncommitted: true });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: { envId: "env-1", envName: "box", adopted: false, key: "key-1" },
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "failed");
  if (removed.status !== "failed") return;
  assert.match(removed.message, /1 uncommitted file\(s\) on branch feat/);
  assert.deepEqual(forgotten, []);
});

// The box an orphan cleanup finds by its key: named as envNameForKey gives it.
const orphanBox = (git: { totalUnpushedCommits?: number; totalChangedFiles?: number }) => ({
  ...box("RUNNING"),
  metadata: { name: envNameForKey("key-1") },
  status: { phase: "ENVIRONMENT_PHASE_RUNNING", content: { git: { branch: "feat", ...git } } },
});

test("an orphan cleanup keeps a created box with unpushed commits and uncommitted files", async () => {
  const { provider, tunnels, calls } = register({
    found: orphanBox({ totalUnpushedCommits: 2, totalChangedFiles: 1 }),
    tunnel: "up",
  });
  const cleaned = await provider.reconcileCleanup({
    key: "key-1",
    report: lifecycle().report,
    signal: new AbortController().signal,
  });
  assert.equal(cleaned.status, "failed");
  if (cleaned.status !== "failed") return;
  assert.match(cleaned.message, /2 unpushed commit\(s\) and 1 uncommitted file\(s\) on branch feat/);
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
});

test("an orphan cleanup keeps a created box with uncommitted files and no unpushed commits", async () => {
  const { provider, calls } = register({ found: orphanBox({ totalChangedFiles: 1 }) });
  const cleaned = await provider.reconcileCleanup({
    key: "key-1",
    report: lifecycle().report,
    signal: new AbortController().signal,
  });
  assert.equal(cleaned.status, "failed");
  if (cleaned.status !== "failed") return;
  assert.match(cleaned.message, /1 uncommitted file\(s\) on branch feat/);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
});

// A relative legacy dataDir is kept: the scripts resolve it against $HOME on the box.
test("a relative legacy dataDir is kept and a trailing slash is stripped", () => {
  const resource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data" }).dataDir, "data");
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data/" }).dataDir, "data");
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "/srv/bb/" }).dataDir, "/srv/bb");
});

test("a remove clears a no-stop flag a suspend left, so the box's next suspend stops it (fails if remove leaves the flag)", async () => {
  const { provider, releasing } = register({ found: box("STOPPED") });
  releasing.add("env-1");
  await provider.remove!({
    ...lifecycle(),
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.equal(releasing.has("env-1"), false);
});

test("a wake clears a no-stop flag a failed suspend left, so the next Pause stops the box (fails if wake leaves the flag)", async () => {
  const { wake, releasing } = register({ found: box("RUNNING") });
  releasing.add("env-1");
  await wake(adoptedResource, lifecycle().report, new AbortController().signal);
  assert.equal(releasing.has("env-1"), false);
});

test("wake refuses a STOPPING box that Ona settles as deleting, and starts nothing (fails if ensureRunning starts it)", async () => {
  const { wake, calls } = register({ found: box("STOPPING"), phases: ["STOPPING", "DELETING"] });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /deleting, so it was not started/,
  );
  assert.ok(!calls.includes("start"), calls.join(", "));
});

// A box Ona is stopping can be started by someone else after the stop finished, between two reads: wake must connect
// it, not refuse it.
test("wake connects a STOPPING box that Ona settles as running, and does not start it (fails if the stopped check runs before the running check)", async () => {
  const { wake, calls } = register({ found: box("STOPPING"), phases: ["STOPPING", "RUNNING"] });
  await wake(adoptedResource, lifecycle().report, new AbortController().signal);
  assert.ok(!calls.includes("start"), calls.join(", "));
  assert.deepEqual(calls.slice(-connectCalls.length), connectCalls);
});

test("wake waits for a STOPPING box that Ona settles as starting, then connects it without starting it (fails if the stopped check refuses the starting box)", async () => {
  const { wake, calls } = register({ found: box("STOPPING"), phases: ["STOPPING", "STARTING", "RUNNING"] });
  await wake(adoptedResource, lifecycle().report, new AbortController().signal);
  assert.ok(!calls.includes("start"), calls.join(", "));
  assert.deepEqual(calls.slice(-connectCalls.length), connectCalls);
});

// 180 STARTING reads at 5 s fill the 15-minute start cap; 109 STOPPING reads then end the stop wait at the
// STARTING read at 1435 s, 65 s before the deadline. Without the shared deadline, the last start wait would run
// its full 15 minutes.
test("wake's waits share one 25-minute deadline, so a box Ona keeps starting and stopping is refused at 25 minutes (fails if each wait gets its own cap)", async () => {
  const phases = [...Array<string>(180).fill("STARTING"), ...Array<string>(109).fill("STOPPING"), "STARTING"];
  const { wake, calls } = register({ found: box("STARTING"), phases });
  const began = Date.now();
  let refusedAt = 0;
  const attempt = wake(adoptedResource, lifecycle().report, new AbortController().signal);
  attempt.catch(() => {
    refusedAt = Date.now();
  });
  for (let i = 0; i < 1_000 && refusedAt === 0; i++) await tick(5_000);
  await assert.rejects(attempt, /starting, so it was not started/);
  assert.ok(!calls.includes("start"), calls.join(", "));
  const elapsed = refusedAt - began;
  assert.ok(elapsed >= 24.9 * 60_000 && elapsed <= 25 * 60_000, `refused after ${elapsed / 60_000} minutes`);
});

test("wake closes the tunnel it opened for a stopped box it starts, when the connect fails (fails if the tunnel stays open)", async () => {
  const { wake, tunnels } = register({ found: box("STOPPED"), phases: ["STOPPED", "RUNNING"], preflightExit: 3 });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /missing bb prerequisites/,
  );
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

test("wake keeps the tunnel when Ona settles a STARTING box as running and the connect fails (fails if wake closes a box it did not start)", async () => {
  const { wake, calls, tunnels } = register({
    found: box("STARTING"),
    phases: ["STARTING", "RUNNING"],
    preflightExit: 3,
  });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /missing bb prerequisites/,
  );
  assert.ok(!calls.includes("start"), calls.join(", "));
  assert.deepEqual(tunnels, ["ensure env-1"]);
});

test("wake keeps the tunnel when Ona settles a STOPPING box as running and the connect fails (fails if wake closes a box it did not start)", async () => {
  const { wake, calls, tunnels } = register({
    found: box("STOPPING"),
    phases: ["STOPPING", "RUNNING"],
    preflightExit: 3,
  });
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal),
    /missing bb prerequisites/,
  );
  assert.ok(!calls.includes("start"), calls.join(", "));
  assert.deepEqual(tunnels, ["ensure env-1"]);
});

// The field trims and treats blank as ready, so the table cannot reach these; `bb ona new` passes its argument untrimmed.
test("onaRef refuses a trailing newline and the empty name", () => {
  assert.equal(onaRef.safeParse("a\n").success, false, "trailing newline");
  assert.equal(onaRef.safeParse("").success, false, "empty name");
});

test("the daemon probe answers unknown for an exit other than 0 or 1 and for a failed SSH (fails if either reads as no daemon)", async () => {
  for (const [probeExit, alive] of [
    [0, true],
    [1, false],
    [2, null],
    [255, null],
    [new Error("ssh: connection refused"), null],
  ] as const) {
    const { daemonAlive, calls } = register({ found: box("RUNNING"), probeExit });
    assert.equal(await daemonAlive(adoptedResource, new AbortController().signal), alive, String(probeExit));
    assert.deepEqual(calls, ["probe"]); // one probe and nothing else: an extra SSH or start could wake a stopped box
  }
});
