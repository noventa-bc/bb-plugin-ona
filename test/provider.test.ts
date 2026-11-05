// The provider's bootstrap, resume, remove and cleanup paths, driven through `create` (adopt mode), `resume`,
// `remove` and `reconcileCleanup` in the fake host of ./provider-fake.ts. setTimeout and Date are mocked, so each
// tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey, resourceSchema } from "../src/provider.ts";
import { tick, useFakeClock } from "./fake-clock.ts";
import { adoptedResource, box, connectCalls, gated, lifecycle, register, resume, start } from "./provider-fake.ts";

useFakeClock();

test("~/.bb-machines retries on exit 6 (fails if a real folder on a not-yet-mounted home is final)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [6, 6, 0] });
  await tick(10_000, 2);
  assert.equal((await created).status, "created");
  assert.deepEqual(calls, ["get RUNNING", ...gated("ssh", "root", "root", "root", "curl", "preflight", "bootstrap")]);
});

test("~/.bb-machines throws at once on any other failure (fails if exit 5 is retried)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [5], rootOutput: "points elsewhere" });
  await assert.rejects(created, /Could not set up ~\/\.bb-machines: points elsewhere/);
  assert.deepEqual(calls, ["get RUNNING", ...gated("ssh", "root")]);
});

test("~/.bb-machines exit 6 past the deadline throws with the script output (fails if it reports success)", async () => {
  const { created, calls } = start({ found: box("RUNNING"), rootExits: [6], rootOutput: "a real folder\n" });
  await tick(10_000, 12);
  await assert.rejects(created, /Could not set up ~\/\.bb-machines: a real folder$/);
  assert.equal(calls.filter((call) => call === "root").length, 12, "one try every 10s for 2 minutes");
});

test("a STARTING box that settles to STOPPING waits for the stop, then starts (fails if it starts a stopping box)", async () => {
  const { created, calls, tunnels } = start({
    found: box("STARTING"),
    phases: ["STARTING", "STOPPING", "STOPPING", "STOPPED", "RUNNING"],
  });
  await tick(5_000, 3);
  assert.equal((await created).status, "created");
  assert.deepEqual(calls, [
    "get STARTING",
    "get STOPPING",
    "get STOPPING",
    "get STOPPED",
    "start",
    "get RUNNING",
    ...connectCalls,
  ]);
  assert.deepEqual(tunnels, ["ensure env-1"]);
});

test("a box that disappears while starting throws (fails if a missing box counts as settled)", async () => {
  const { created, calls } = start({ found: box("STARTING"), phases: ["STARTING", null] });
  // Past the 15-minute start wait, so a loop that keeps polling fails rather than hangs.
  await tick(5_000, 180);
  await assert.rejects(created, /disappeared while starting/);
  assert.deepEqual(calls, ["get STARTING", "get null"]);
});

test(
  "an abort during a wait rejects without another probe (fails if the wait sleeps out its interval)",
  { timeout: 1_000 },
  async () => {
    const { created, calls, controller } = start({ found: box("STARTING"), phases: ["STARTING"] });
    await tick(1_000);
    controller.abort(new Error("cancelled"));
    await assert.rejects(created, /cancelled/);
    assert.deepEqual(calls, ["get STARTING"]);
  },
);

// Bug: connect() opens the tunnel before the tunnel wait, preflight and bootstrap, so a resume or
// create that failed after it left the tunnel open, keeping awake a box bb doesn't show active (decision 0003).
test("a resume that fails at preflight closes the tunnel it opened and rethrows (fails if the tunnel stays open)", async () => {
  const { resumed, tunnels } = resume({ found: box("RUNNING"), phases: ["RUNNING"], preflightExit: 3 });
  await assert.rejects(resumed, /^Error: Devbox is missing bb prerequisites: missing: node$/);
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

test("a create that fails at preflight closes the tunnel it opened and rethrows (fails if the tunnel stays open)", async () => {
  const { created, tunnels } = start({ found: box("RUNNING"), preflightExit: 3 });
  await assert.rejects(created, /^Error: Devbox is missing bb prerequisites: missing: node$/);
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

// Bug: a failed adopt left an already-open tunnel up; bb's cleanup remove() closes it later anyway, so nothing
// keeps it for another machine on the box.
test("a failed adopt on a box with a tunnel up closes it", async () => {
  const { created, tunnels } = start({ found: box("RUNNING"), preflightExit: 3, tunnel: "up" });
  await assert.rejects(created, /^Error: Devbox is missing bb prerequisites: missing: node$/);
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
});

// Bug: the close keyed on "this call opened the tunnel", so a resume re-run after a stuck one found it
// open and left it open on failure, keeping awake a box bb doesn't show active (decision 0003).
test("a resume that fails with the box's tunnel already open, connecting or up, closes it", async () => {
  for (const tunnel of ["connecting", "up"] as const) {
    const { resumed, tunnels } = resume({ found: box("RUNNING"), phases: ["RUNNING"], preflightExit: 3, tunnel });
    await assert.rejects(resumed, /^Error: Devbox is missing bb prerequisites: missing: node$/);
    assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"], tunnel);
  }
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

// The lookup-throws test below guards the order: the tunnel closes after the move-aside, and on a failed lookup.
test("remove of an adopted machine closes its tunnel", async () => {
  const { provider, calls, tunnels } = register({ found: box("RUNNING"), phases: ["RUNNING"], tunnel: "up" });
  const removed = await provider.remove({
    report: lifecycle().report,
    hostId: "host-1",
    resource: adoptedResource,
    signal: new AbortController().signal,
  });
  assert.equal(removed.status, "removed");
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
});

test("remove of an adopted machine whose Ona lookup throws still closes its tunnel", async () => {
  const { provider, tunnels, forgotten } = register({ found: box("RUNNING"), lookupFails: true, tunnel: "up" });
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

test("remove of an adopted machine closes a tunnel that reopened during the move-aside", async () => {
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
  assert.deepEqual(tunnels, ["ensure env-1", "stop env-1"]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
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

// Cleanup looks a box up by the name its key gives it.
test("reconcileCleanup deletes the box its key names and closes its tunnel (fails if an orphaned box is kept)", async () => {
  const created = { ...box("RUNNING"), metadata: { name: envNameForKey("key-1") } };
  const { provider, calls, tunnels } = register({ found: created });
  const cleaned = await provider.reconcileCleanup({
    key: "key-1",
    report: lifecycle().report,
    signal: new AbortController().signal,
  });
  assert.equal(cleaned.status, "removed");
  assert.deepEqual(calls, ["delete env-1"]);
  assert.deepEqual(tunnels, ["stop env-1"]);
});

test("reconcileCleanup looks a box up by the name its key gives it, so a box under its own name is kept (fails if the lookup reaches it by id)", async () => {
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

// A relative legacy dataDir is kept: the scripts resolve it against $HOME on the box.
test("a relative legacy dataDir is kept and a trailing slash is stripped", () => {
  const resource = { envId: "env-1", envName: "box", adopted: true, key: "key-1" };
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data" }).dataDir, "data");
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "data/" }).dataDir, "data");
  assert.equal(resourceSchema.parse({ ...resource, dataDir: "/srv/bb/" }).dataDir, "/srv/bb");
});
