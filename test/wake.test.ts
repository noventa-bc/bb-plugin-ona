// `bb ona resume`: its refusals, and that a stopped box gets a start and a connect while a running one only connects.
// The provider's wake runs against the fake Ona of ./provider-fake.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OnaEnvironment } from "../src/ona.ts";
import { HostGuard } from "../src/reconcile.ts";
import type { Row } from "../src/sync.ts";
import { onaCommands, type OnaCommandDeps } from "../src/commands.ts";
import { resumeCommand, type ResumeDeps } from "../src/wake.ts";
import { adoptedResource, box, connectCalls, register } from "./provider-fake.ts";

const signal = () => new AbortController().signal;

/** The command's deps for the adopted box: its bb row in `phase`, and Ona listing it (or not), with a provider whose wake runs on a fake Ona. */
function fixture(
  found: OnaEnvironment,
  phases: string[],
  options: { phase?: string; listed?: boolean; listingFails?: boolean; guard?: HostGuard } = {},
) {
  const fake = register({ found, phases });
  const row: Row = {
    hostId: "h1",
    machine: "box",
    status: "disconnected",
    phase: options.phase ?? "active",
    lastSeenAt: null,
    updatedAt: 0,
    resource: adoptedResource,
  };
  const deps: ResumeDeps = {
    findMachine: async () => row,
    snapshot: {
      refresh: async () => {
        if (options.listingFails) throw new Error("not logged in");
        return { at: Date.now(), envs: options.listed === false ? [] : [found] };
      },
      lastError: options.listingFails ? "not logged in" : null,
    },
    guard: options.guard ?? new HostGuard(),
    provider: { wake: fake.wake },
  };
  return { deps, calls: fake.calls };
}

test("bb ona resume refuses when Ona can't be asked, and starts nothing (fails if it starts a box it can't check)", async () => {
  const { deps, calls } = fixture(box("STOPPED"), ["STOPPED", "RUNNING"], { listingFails: true });
  const result = await resumeCommand(deps, "box", signal());
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /^Can't ask Ona whether box is running \(not logged in\); not started/);
  assert.deepEqual(calls, []);
});

test("bb ona resume refuses a box Ona doesn't list (fails if it starts an unlisted box)", async () => {
  const { deps, calls } = fixture(box("STOPPED"), ["STOPPED", "RUNNING"], { listed: false });
  const result = await resumeCommand(deps, "box", signal());
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /^box is not listed in Ona/);
  assert.deepEqual(calls, []);
});

test("bb ona resume refuses a machine bb shows suspended, and points at bb machine resume (fails if it wakes it)", async () => {
  const { deps, calls } = fixture(box("STOPPED"), ["STOPPED", "RUNNING"], { phase: "suspended" });
  const result = await resumeCommand(deps, "box", signal());
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /^box is suspended in bb.*`bb machine resume box`/);
  assert.deepEqual(calls, []);
});

test("bb ona resume starts a stopped box and connects it (fails if it only reconnects)", async () => {
  const { deps, calls } = fixture(box("STOPPED"), ["STOPPED", "RUNNING"]);
  const result = await resumeCommand(deps, "box", signal());
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["get STOPPED", "start", "get RUNNING", ...connectCalls]);
  assert.match(result.stdout ?? "", /^Started box and reconnected it$/m);
});

test("bb ona resume on a running box connects it without starting it (fails if it starts a running box)", async () => {
  const { deps, calls } = fixture(box("RUNNING"), ["RUNNING"]);
  const result = await resumeCommand(deps, "box", signal());
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["get RUNNING", "get RUNNING", ...connectCalls]);
  assert.match(result.stdout ?? "", /^Reconnected box$/m);
});

/** `bb ona`'s run handler over the resume deps; the other subcommands' deps are not reached by these tests. */
function dispatch(deps: ResumeDeps) {
  const run = onaCommands({ ...deps } as unknown as OnaCommandDeps);
  return (ref: string) => run(["resume", ref], {});
}

test("bb ona resume through the command dispatch starts a stopped box (fails if the resume case is not dispatched)", async () => {
  const { deps, calls } = fixture(box("STOPPED"), ["STOPPED", "RUNNING"]);
  const result = await dispatch(deps)("box");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /^Started box and reconnected it$/m);
  assert.deepEqual(calls, ["get STOPPED", "start", "get RUNNING", ...connectCalls]);
});

test("bb ona resume refuses a box whose machine another action holds, and starts nothing (fails if it starts a busy box)", async () => {
  const guard = new HostGuard();
  let finish: () => void = () => {};
  const held = guard.run(
    "h1",
    "sync",
    "held by the test",
    () =>
      new Promise<void>((resolve) => {
        finish = () => resolve();
      }),
  );
  const { deps, calls } = fixture(box("STOPPED"), ["STOPPED", "RUNNING"], { guard });
  const result = await resumeCommand(deps, "box", signal());
  finish();
  await held;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /^box is busy \(sync\)/);
  assert.deepEqual(calls, []);
});

test("bb ona resume's refused wake exits 1, not a rejection (fails when the resume case returns the wake without await, which skipped the dispatcher's catch)", async () => {
  const { deps, calls } = fixture(box("DELETING"), ["DELETING"]);
  const result = await dispatch(deps)("box");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /box deleting, so it was not started/);
  assert.deepEqual(calls, ["get DELETING"]);
});

test("bb ona resume on a STARTING box waits for Ona to finish and does not start it (fails if it starts the box while Ona is starting it)", async () => {
  const { deps, calls } = fixture(box("STARTING"), ["STARTING", "RUNNING"]);
  const result = await dispatch(deps)("box");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /^Waited for box to start and reconnected it$/m);
  assert.ok(!calls.includes("start"), calls.join(", "));
});

test("bb ona resume on a STOPPING box starts it only after the stop has settled (fails if it starts before the stop has settled)", async () => {
  const { deps, calls } = fixture(box("STOPPING"), ["STOPPING", "STOPPED", "RUNNING"]);
  const result = await dispatch(deps)("box");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /^Started box and reconnected it$/m);
  assert.ok(calls.indexOf("start") > calls.indexOf("get STOPPED"), calls.join(", "));
});
