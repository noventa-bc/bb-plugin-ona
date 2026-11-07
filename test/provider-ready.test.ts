// The readiness gate before every SSH command in connect (safety rule 1, docs/sync.md), and the 30-minute cap on a
// wake and a reconnect, driven through `resume`, `wake` and `reconnect` in the fake host of ./provider-fake.ts.
// setTimeout and Date are mocked, so each tick is one poll interval and the tests are instant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { OnaEnvironment } from "../src/ona.ts";
import { settle, tick, useFakeClock } from "./fake-clock.ts";
import {
  adoptedResource,
  box,
  connectCalls,
  gated,
  lifecycle,
  register,
  resume,
  running,
  type Setup,
} from "./provider-fake.ts";

useFakeClock();

// Bug: connect probed SSH every 5s as soon as Ona accepted the start, before Ona said the box and its
// dev container were up, and the user saw only "Waiting for the dev container to accept SSH".
test("a resume waits for Ona to report the box and its dev container running before any SSH", async () => {
  const { resumed, calls, steps } = resume({
    found: box("STOPPED"),
    phases: ["STOPPED", "STARTING", running("PHASE_CREATING"), running("PHASE_RUNNING")],
  });
  await tick(5_000, 2);
  await resumed;
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get RUNNING", "get RUNNING", ...connectCalls]);
  assert.deepEqual(steps.slice(1, 3), ["Waiting for Ona: starting", "Waiting for Ona: dev container starting"]);
});

test("a resume fails at once with Ona's failure message, no SSH, and closes the tunnel", async () => {
  // A start that failed: Ona sets the message and the box is stopped again.
  const failing = {
    ...box("STOPPED"),
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] },
  };
  const { resumed, calls, tunnels } = resume({ found: box("STOPPED"), phases: ["STOPPED", "STARTING", failing] });
  // Past every deadline, so a wait that ignores the failure rejects with the wrong message instead of hanging.
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona environment box is not ready: no capacity$/);
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get STOPPED"]);
  assert.deepEqual(tunnels, ["stop env-1"]);
});

test("a resume fails without SSH when Ona no longer has the box during the wait", async () => {
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", "STARTING", null] });
  await tick(5_000, 1);
  await assert.rejects(resumed, /^Error: Ona environment box disappeared\.$/);
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get null"]);
});

// Bug: a box stopped in Ona during the wait was probed over SSH, and Ona's SSH starts a stopped box (rule 1).
test("a resume fails without SSH when Ona reports the box stopped during the wait", async () => {
  const stopped = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_STOPPED" } };
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", "STARTING", stopped] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona environment box is not ready: stopped$/);
  assert.deepEqual(calls, ["get STOPPED", "start", "get STARTING", "get STOPPED"]);
});

// Ona can still show a box STOPPED right after `ona environment start` returns; older Ona sends no desired phase,
// and a failure message may be left from an earlier start.
test("a resume waits on a box Ona still shows stopped right after the start, then connects", async () => {
  const stopped = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const cases: [string, OnaEnvironment][] = [
    ["desired phase RUNNING", stopped],
    ["no desired phase", box("STOPPED")],
    ["an old failure", { ...stopped, status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] } }],
  ];
  for (const [name, waking] of cases) {
    const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", waking, "RUNNING"] });
    await tick(5_000, 1);
    await resumed;
    assert.deepEqual(calls, ["get STOPPED", "start", "get STOPPED", "get RUNNING", ...connectCalls], name);
  }
});

test("a resume that times out on a failing start names Ona's failure", async () => {
  const failing = {
    ...box("STOPPED"),
    spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" },
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] },
  };
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", failing] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona did not report box ready within 15 minutes: no capacity$/);
  assert.equal(calls.includes("ssh"), false);
});

// The stored name goes stale after `bb ona rename`; the heal and `bb ona reconnect` pass the stored resource.
test("a reconnect to a stopped box fails at once, naming the box as Ona's latest answer does", async () => {
  const renamed = { ...box("STOPPED"), metadata: { name: "renamed" } };
  const { reconnect } = register({ found: renamed, phases: [renamed] });
  const reconnected = reconnect(adoptedResource, lifecycle().report, new AbortController().signal);
  await assert.rejects(reconnected, /^Error: Ona environment renamed is not ready: stopped$/);
});

// `curl -sf` and `mountpoint -q` print nothing when they fail.
test("a silent probe's timeout keeps its hint and names no empty reason", async () => {
  const cases: [Partial<Setup>, string][] = [
    [
      { curlExits: [7] },
      "The devbox could not reach the bb server through the SSH tunnel within 10 minutes. Check `bb plugin logs ona`.",
    ],
    [
      { mountExits: [1] },
      "The devbox's home folder was not mounted within 5 minutes. If your Ona environments don't share a home folder, turn off the plugin's `waitForSharedHome` setting; a changed setting applies after `bb plugin reload ona`.",
    ],
  ];
  for (const [setup, message] of cases) {
    const { resumed } = resume({ found: box("RUNNING"), ...setup });
    await tick(5_000, 200);
    await assert.rejects(resumed, { message }, message);
  }
});

// Bug: SSH ran while Ona could not be asked; a failed lookup is unknown (decision 0005).
test("a resume makes no SSH while Ona can't be asked, then connects once it says RUNNING", async () => {
  const unreachable = new Error("Ona is unreachable");
  const { resumed, calls } = resume({
    found: box("STOPPED"),
    phases: ["STOPPED", unreachable, unreachable, "RUNNING"],
  });
  await tick(5_000, 2);
  await resumed;
  assert.deepEqual(calls, ["get STOPPED", "start", "get failed", "get failed", "get RUNNING", ...connectCalls]);
});

// The rest of Ona's stderr is more than the progress line needs (rule 7).
test("a failed lookup shows only the first line of Ona's error as progress", async () => {
  const unreachable = new Error("\n ona environment get failed: dial tcp: timeout \nsecond line\nthird line");
  const { resumed, steps } = resume({ found: box("STOPPED"), phases: ["STOPPED", unreachable, "RUNNING"] });
  await tick(5_000, 1);
  await resumed;
  assert.equal(steps[1], "Waiting for Ona: ona environment get failed: dial tcp: timeout");
});

test("a failed lookup with no text shows a plain reason", async () => {
  const steps: string[] = [];
  const { reconnect } = register({ found: box("RUNNING"), phases: [new Error("\n"), "RUNNING"] });
  const reconnected = reconnect(adoptedResource, lifecycle(steps).report, new AbortController().signal);
  await tick(5_000, 1);
  await reconnected;
  assert.equal(steps[0], "Waiting for Ona: no reason given");
});

// A ZodError's first line is "[".
test("an answer from Ona that can't be read shows a plain progress line", async () => {
  const unreadable = z.object({ id: z.string() }).safeParse({}).error!;
  const { resumed, steps } = resume({ found: box("STOPPED"), phases: ["STOPPED", unreadable, "RUNNING"] });
  await tick(5_000, 1);
  await resumed;
  assert.equal(steps[1], "Waiting for Ona: Ona's answer could not be read");
});

test("a resume while Ona can't be asked fails after 15 minutes without SSH", async () => {
  const { resumed, calls } = resume({ found: box("STOPPED"), phases: ["STOPPED", new Error("Ona is unreachable")] });
  await tick(5_000, 180);
  await assert.rejects(resumed, /^Error: Ona did not report box ready within 15 minutes: Ona is unreachable$/);
  assert.equal(calls.includes("ssh"), false);
});

test("a box without a dev container connects once Ona says RUNNING", async () => {
  const { resumed, calls } = resume({ found: running(null), phases: [running(null)] });
  await resumed;
  assert.deepEqual(calls, ["get RUNNING", "get RUNNING", ...connectCalls]);
});

// Rule 1: a try Ona can't vouch for makes no SSH. A failed lookup is unknown (decision 0005), and a dev container
// restarting between probes waits, as it does before the first SSH.
test("an SSH retry skips its probe while Ona can't be asked or the dev container restarts, then probes again", async () => {
  const cases: [Error | OnaEnvironment, string][] = [
    [new Error("x"), "get failed"],
    [running("PHASE_CREATING"), "get RUNNING"],
  ];
  for (const [answer, logged] of cases) {
    const phases = ["RUNNING", "RUNNING", "RUNNING", answer, "RUNNING"];
    const { resumed, calls } = resume({ found: box("RUNNING"), phases, sshExits: [255, 0] });
    await tick(5_000, 3);
    await resumed;
    assert.deepEqual(calls, ["get RUNNING", "get RUNNING", ...gated("ssh"), logged, ...connectCalls], logged);
  }
});

test("Ona unanswerable before an SSH command ends the connect with Ona's error, and no SSH", async () => {
  const cases: [Error, string][] = [
    [new Error("ona environment get failed: timeout\nmore"), "ona environment get failed: timeout"],
    [z.object({ id: z.string() }).safeParse({}).error!, "Ona's answer could not be read"],
  ];
  for (const [error, reason] of cases) {
    const { resumed, calls } = resume({ found: box("RUNNING"), phases: ["RUNNING", "RUNNING", error] });
    await tick(5_000, 200);
    const message = `Ona did not report box ready within 15 minutes: ${reason}`;
    await assert.rejects(resumed, { message }, reason);
    assert.equal(calls.includes("ssh"), false, reason);
  }
});

// Bug: SSH in connect ran without asking Ona right before (the waits' retries, mkdir, preflight, bootstrap), so a
// box stopped meanwhile was woken (rule 1).
test("every SSH command in connect asks Ona first, and runs no further once Ona says the box stopped", async () => {
  const stopped = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const commands = ["ssh", "mount", "mkdir", "root", "curl", "preflight", "bootstrap"];
  for (const [i, command] of commands.entries()) {
    const phases = [...Array<string>(2 + i).fill("RUNNING"), stopped];
    const setup = { mountExits: [0], rootExits: [0], codexHome: true };
    const { resumed, calls } = resume({ found: box("RUNNING"), phases, ...setup });
    await assert.rejects(resumed, /^Error: Ona environment box is not ready: stopped$/, command);
    const before = commands.slice(0, i).flatMap((ran) => ["get RUNNING", ran]);
    assert.deepEqual(calls, ["get RUNNING", "get RUNNING", ...before, "get STOPPED"], command);
  }
});

// A box Ona's inactivity timeout stopped keeps desired phase RUNNING.
test("a reconnect to a box Ona idled out fails at once without SSH", async () => {
  const idled = { ...box("STOPPED"), spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" } };
  const { reconnect, calls } = register({ found: idled, phases: [idled] });
  const reconnected = reconnect(adoptedResource, lifecycle().report, new AbortController().signal);
  reconnected.catch(() => {});
  // Past every deadline, so a wait that treats the box as starting rejects with the wrong message instead of hanging.
  await tick(5_000, 180);
  await assert.rejects(reconnected, /^Error: Ona environment box is not ready: stopped$/);
  assert.deepEqual(calls, ["get STOPPED"]);
});

// A caller's own timeout can end a wait before its deadline.
test("an aborted wait names the last reason it was waiting for", async () => {
  const ona = "Ona did not report box ready before the wait ended: dev container starting";
  const creating = running("PHASE_CREATING");
  const cases: [Partial<Setup>, string][] = [
    [{ phases: [creating] }, ona],
    [{ sshExits: [255] }, "Could not SSH into the devbox before the wait ended: refused"],
    // After a refused SSH try, the gate is waiting on Ona when the abort comes: Ona's reason, not the stale SSH one.
    [{ phases: ["RUNNING", "RUNNING", creating], sshExits: [255] }, ona],
  ];
  for (const [setup, message] of cases) {
    const controller = new AbortController();
    const { reconnect } = register({ found: box("RUNNING"), ...setup });
    const reconnected = reconnect(adoptedResource, lifecycle().report, controller.signal);
    reconnected.catch(() => {});
    await tick(5_000, 2);
    controller.abort(new Error("The operation was aborted due to timeout"));
    await assert.rejects(reconnected, { message }, message);
  }
});

test("a stop that Ona reports as the wait is aborted ends with the stop, not the wait", async () => {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("The operation was aborted due to timeout"));
  // Ona answers "stopped" as the caller's timeout fires.
  const stopping = {
    ...box("STOPPED"),
    spec: { desiredPhase: "ENVIRONMENT_PHASE_STOPPED" },
    get metadata() {
      abort();
      return { name: "box" };
    },
  };
  const { reconnect } = register({ found: box("RUNNING"), phases: [running("PHASE_CREATING"), stopping] });
  const reconnected = reconnect(adoptedResource, lifecycle().report, controller.signal);
  reconnected.catch(() => {});
  await tick(5_000, 1);
  await assert.rejects(reconnected, { message: "Ona environment box is not ready: stopped" });
});

// The daemon heal in src/sync.ts calls this reconnect: test/sync.test.ts covers what the pass does when it rejects.
test("a reconnect waits for the dev container before SSH, and fails without SSH on a failed one", async () => {
  const waits = register({ found: box("RUNNING"), phases: [running("PHASE_CREATING"), running("PHASE_RUNNING")] });
  const reconnected = waits.reconnect(adoptedResource, lifecycle().report, new AbortController().signal);
  await tick(5_000, 1);
  await reconnected;
  assert.deepEqual(waits.calls, ["get RUNNING", "get RUNNING", ...connectCalls]);
  const fails = register({ found: box("RUNNING"), phases: [running("PHASE_FAILED")] });
  await assert.rejects(
    fails.reconnect(adoptedResource, lifecycle().report, new AbortController().signal),
    /^Error: Ona environment box is not ready: dev container failed$/,
  );
  assert.deepEqual(fails.calls, ["get RUNNING"]);
});

const MINUTE = 60_000;
const capped = (what: string, step: string) => `Gave up ${what} after 30 minutes; last step: ${step}`;
const installing = "Starting enrolled machine";

// Bug: a wake and a daemon restart had no overall bound, only the waits inside them, and those can add up to hours.
test("a wake or a reconnect that never finishes gives up after 30 minutes, and a wake closes the tunnel it opened", async () => {
  const cases: [string, "wake" | "reconnect", Setup, string, string[]][] = [
    [
      "wake, start",
      "wake",
      { found: box("STOPPED"), hangs: "start" },
      capped("waking box", "Starting Ona environment box"),
      [],
    ],
    [
      "wake, bootstrap",
      "wake",
      { found: box("STOPPED"), phases: ["STOPPED", "RUNNING"], hangs: "bootstrap" },
      capped("waking box", installing),
      ["ensure env-1", "stop env-1"],
    ],
    [
      "reconnect",
      "reconnect",
      { found: box("RUNNING"), hangs: "bootstrap" },
      capped("reconnecting box", installing),
      ["ensure env-1"],
    ],
  ];
  for (const [name, call, setup, message, tunnelCalls] of cases) {
    const registered = register(setup);
    let settled = false;
    const run = registered[call](adoptedResource, lifecycle().report, new AbortController().signal);
    run.then(
      () => (settled = true),
      () => (settled = true),
    );
    await tick(MINUTE, 29);
    await settle();
    assert.equal(settled, false, `${name}: still running at 29 minutes`);
    await tick(MINUTE);
    await settle();
    assert.equal(settled, true, `${name}: ended at 30 minutes`);
    await assert.rejects(run, { message }, name);
    assert.deepEqual(registered.tunnels, tunnelCalls, name);
  }
});

// Guard, no `// Bug:` line: a plugin reload ends the call with the error its own abort caused, not the cap's.
test("a caller's abort ends a capped wake or reconnect at once with its own error, not the cap's", async () => {
  const cases: [string, "wake" | "reconnect", Setup][] = [
    ["wake", "wake", { found: box("STOPPED"), hangs: "start" }],
    ["reconnect", "reconnect", { found: box("RUNNING"), hangs: "bootstrap" }],
  ];
  for (const [name, call, setup] of cases) {
    const controller = new AbortController();
    const run = register(setup)[call](adoptedResource, lifecycle().report, controller.signal);
    run.catch(() => {});
    await tick(MINUTE);
    const reloaded = new Error("plugin reloaded");
    controller.abort(reloaded);
    // bb's bootstrap rethrows the reason itself; a killed `ona` start rejects with its own error, never the cap's.
    await assert.rejects(
      run,
      (error: Error) => (call === "reconnect" ? error === reloaded : !error.message.startsWith("Gave up")),
      name,
    );
  }
});

// Guard, no `// Bug:` line: the user sees only the message, so the cap names the step it cut short, not an earlier one.
test("a reconnect the cap ends in bb's installer names that step, after earlier waits for Ona", async () => {
  // connect's entry gate waits a minute for the dev container, so a "Waiting for Ona" step comes first.
  const creating = running("PHASE_CREATING");
  const phases = [...Array<OnaEnvironment>(12).fill(creating), "RUNNING"];
  const steps: string[] = [];
  const { reconnect } = register({ found: box("RUNNING"), phases, hangs: "bootstrap" });
  const run = reconnect(adoptedResource, lifecycle(steps).report, new AbortController().signal);
  run.catch(() => {});
  await tick(5_000, 360);
  await assert.rejects(run, { message: capped("reconnecting box", installing) });
  assert.deepEqual(steps.slice(0, 1), ["Waiting for Ona: dev container starting"]);
});
