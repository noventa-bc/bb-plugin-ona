// The connect path, driven through `create` (adopt mode) and `resume` in the fake host of ./provider-fake.ts: the waits
// for a box Ona is starting or stopping, the `~/.bb-machines` step, and the tunnel a failed connect closes. setTimeout
// and Date are mocked, so each tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settle, tick, useFakeClock } from "./fake-clock.ts";
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

// Bug: a reconnect or wake that read the machine active reopened its box's tunnel after bb's suspend or remove
// closed it, keeping awake a box bb no longer shows active (R25, R31, decision 0003).
test("a reconnect whose box was closed after its mark throws before markConnected and opens no tunnel", async () => {
  const { reconnect, mark, stop, open, connected, calls } = register({ found: box("RUNNING") });
  const since = mark();
  stop("env-1");
  await assert.rejects(
    reconnect(adoptedResource, lifecycle().report, new AbortController().signal, since),
    /^Error: bb suspended or removed the machine on box while it connected, so its tunnel stays closed\.$/,
  );
  assert.equal(open.has("env-1"), false);
  assert.deepEqual(connected, []);
  assert.deepEqual(calls, ["get RUNNING", ...gated("ssh")]);
});

test("a wake whose box was closed after its mark throws before markConnected and opens no tunnel", async () => {
  for (const phase of ["RUNNING", "STOPPED"]) {
    const { wake, mark, stop, open, connected } = register({ found: box(phase), phases: [phase, "RUNNING"] });
    const since = mark();
    stop("env-1");
    await assert.rejects(
      wake(adoptedResource, lifecycle().report, new AbortController().signal, "wake-thread", since),
      /while it connected, so its tunnel stays closed/,
      phase,
    );
    assert.equal(open.has("env-1"), false, phase);
    assert.deepEqual(connected, [], phase);
  }
});

test("a reconnect with a mark taken after the box's last close opens the tunnel and connects", async () => {
  const { reconnect, mark, stop, open, connected } = register({ found: box("RUNNING") });
  stop("env-1");
  await reconnect(adoptedResource, lifecycle().report, new AbortController().signal, mark());
  assert.equal(open.get("env-1"), "connecting");
  assert.deepEqual(connected, ["env-1"]);
});

test("a refused stale wake leaves the tunnel a newer flow opened, and that flow's mark still opens (fails if the refusal closes the box's tunnel)", async () => {
  const { wake, mark, ensure, stop, open, tunnels } = register({
    found: box("STOPPED"),
    phases: ["STOPPED", "RUNNING"],
  });
  const stale = mark();
  stop("env-1"); // bb suspends the machine
  const newer = mark();
  ensure("env-1", newer); // bb's resume opens the tunnel again
  await assert.rejects(
    wake(adoptedResource, lifecycle().report, new AbortController().signal, "wake-thread", stale),
    /while it connected, so its tunnel stays closed/,
  );
  assert.equal(open.get("env-1"), "connecting");
  assert.equal(ensure("env-1", newer), true);
  assert.equal(tunnels.filter((call) => call.startsWith("stop")).length, 1, "only bb's suspend closed it");
});

// The close lands while the call waits for Ona to finish starting the box: a mark taken after that wait would miss it.
test("bb's create and resume refuse the tunnel when the box is closed during the call (fails if either takes its mark late or passes none)", async () => {
  const starting = () => ({ found: box("STARTING"), phases: ["STARTING", "STARTING", "RUNNING"] });
  const created = start(starting());
  const resumed = resume(starting());
  await settle();
  created.stop("env-1");
  resumed.stop("env-1");
  await tick(5_000, 2);
  await assert.rejects(created.created, /while it connected, so its tunnel stays closed/);
  await assert.rejects(resumed.resumed, /while it connected, so its tunnel stays closed/);
  assert.deepEqual([created.connected, resumed.connected], [[], []]);
});

test("bb's create on a box whose tunnel was closed before the call opens the tunnel (fails if create's mark is a constant)", async () => {
  const { created, open } = start({ found: box("RUNNING"), closed: true });
  assert.equal((await created).status, "created");
  assert.equal(open.get("env-1"), "connecting");
});

test("bb's resume of a box whose tunnel was closed before the call opens the tunnel (fails if resume's mark is a constant)", async () => {
  const { resumed, open } = resume({ found: box("RUNNING"), phases: ["RUNNING"], closed: true });
  await resumed;
  assert.equal(open.get("env-1"), "connecting");
});
