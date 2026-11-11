// The `metric` lines the provider writes: a start with its cause, each connect call's outcome, and each delete or
// refused delete. Driven through the provider's calls in the fake host of ./provider-fake.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import type { OnaEnvironment } from "../src/ona.ts";
import { adoptedResource, box, lifecycle, register, resume, start } from "./provider-fake.ts";

const signal = () => new AbortController().signal;
const createdResource = { envId: "env-1", envName: "box", adopted: false, key: "key-1" };

/** The `metric` lines a host logged, in order. `up` and `secs` are whole seconds that vary, so they read as N. */
const metricLines = (logs: { message: string }[]) =>
  logs
    .map((entry) => entry.message)
    .filter((message) => message.startsWith("metric "))
    .map((message) => message.replace(/ (up|secs)=\d+/g, " $1=N"));

/** The box an orphan cleanup finds by its key: named as envNameForKey gives it, with the git counts given. */
const orphanBox = (git: { totalUnpushedCommits?: number; totalChangedFiles?: number }): OnaEnvironment => ({
  ...box("RUNNING"),
  metadata: { name: envNameForKey("key-1") },
  status: { phase: "ENVIRONMENT_PHASE_RUNNING", content: { git: { branch: "feat", ...git } } },
});

test("a resume that starts a stopped box writes a start line naming resume, then a connected line with box=stopped (fails if a line is missing or names another cause)", async () => {
  const { resumed, logs } = resume({ found: box("STOPPED"), phases: ["STOPPED", "RUNNING"] });
  await resumed;
  assert.deepEqual(metricLines(logs), [
    "metric start env=env-1 via=resume up=N",
    "metric connected via=resume box=stopped secs=N ok=1",
  ]);
});

test("a create that starts an adopted stopped box names create as the start's cause (fails if create's start names another cause)", async () => {
  // create starts the box it found stopped, and its first read after the start is the running one.
  const { created, logs } = start({ found: box("STOPPED"), phases: ["RUNNING"] });
  await created;
  assert.deepEqual(metricLines(logs), [
    "metric start env=env-1 via=create up=N",
    "metric connected via=create box=stopped secs=N ok=1",
  ]);
});

test("a wake names its caller as the start's cause, a waiting thread or bb ona resume (fails if either cause is written as the other)", async () => {
  for (const cause of ["wake-thread", "wake-cmd"] as const) {
    const { wake, logs } = register({ found: box("STOPPED"), phases: ["STOPPED", "RUNNING"] });
    await wake(adoptedResource, lifecycle().report, signal(), cause);
    assert.deepEqual(
      metricLines(logs),
      [`metric start env=env-1 via=${cause} up=N`, "metric connected via=wake box=stopped secs=N ok=1"],
      cause,
    );
  }
});

test("a wake of a box Ona shows running writes no start line and a connected line with box=running (fails if a running box is started or reads as stopped)", async () => {
  const { wake, calls, logs } = register({ found: box("RUNNING") });
  await wake(adoptedResource, lifecycle().report, signal(), "wake-cmd");
  assert.deepEqual(
    calls.filter((call) => call === "start"),
    [],
  );
  assert.deepEqual(metricLines(logs), ["metric connected via=wake box=running secs=N ok=1"]);
});

test("a resume whose connect fails writes connected with ok=0 and still rejects with the connect's error (fails if the line is missing or the error is replaced)", async () => {
  const { resumed, logs } = resume({ found: box("RUNNING"), preflightExit: 3 });
  await assert.rejects(resumed, /Devbox is missing bb prerequisites: missing: node/);
  assert.deepEqual(metricLines(logs), ["metric connected via=resume box=running secs=N ok=0"]);
});

test("a start that fails after Ona's start was called writes box=stopped with ok=0 (fails if box comes from ensureRunning's return, which a throw never gives)", async () => {
  const { wake, logs } = register({ found: box("STOPPED"), phases: ["STOPPED"], hangs: "start" });
  const controller = new AbortController();
  const woken = wake(adoptedResource, lifecycle().report, controller.signal, "wake-cmd");
  // Ona's start hangs until the call is aborted, so the abort lands after the start was called.
  setImmediate(() => controller.abort());
  await assert.rejects(woken);
  assert.deepEqual(metricLines(logs), [
    "metric start env=env-1 via=wake-cmd up=N",
    "metric connected via=wake box=stopped secs=N ok=0",
  ]);
});

test("create and reconnect each write one connected line naming themselves (fails if either writes none or names the other)", async () => {
  const created = start({ found: box("RUNNING") });
  await created.created;
  assert.deepEqual(metricLines(created.logs), ["metric connected via=create box=running secs=N ok=1"]);
  const reconnecting = register({ found: box("RUNNING") });
  await reconnecting.reconnect(adoptedResource, lifecycle().report, signal());
  assert.deepEqual(metricLines(reconnecting.logs), ["metric connected via=reconnect box=running secs=N ok=1"]);
});

const remove = (provider: ReturnType<typeof register>["provider"]) =>
  provider.remove({ report: lifecycle().report, hostId: "host-1", resource: createdResource, signal: signal() });

const cleanup = (provider: ReturnType<typeof register>["provider"]) =>
  provider.reconcileCleanup({ key: "key-1", report: lifecycle().report, signal: signal() });

test("a remove that deletes a box Ona reports no git counts for writes delete with git=unknown (fails if the line is missing or says known)", async () => {
  const { provider, calls, logs } = register({ found: box("RUNNING") });
  await remove(provider);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    ["delete env-1"],
  );
  assert.deepEqual(metricLines(logs), ["metric delete env=env-1 via=remove git=unknown"]);
});

test("a remove that deletes a box whose git counts are zero writes delete with git=known (fails if known reads as unknown)", async () => {
  const { provider, logs } = register({ found: box("RUNNING"), gitCounts: true });
  await remove(provider);
  assert.deepEqual(metricLines(logs), ["metric delete env=env-1 via=remove git=known"]);
});

test("a remove that finds unpushed commits writes keep with the counts and deletes nothing (fails if the keep line is missing or a delete runs)", async () => {
  const { provider, calls, logs } = register({ found: box("RUNNING"), unpushed: true });
  const removed = await remove(provider);
  assert.equal(removed.status, "failed");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
  assert.deepEqual(metricLines(logs), ["metric keep env=env-1 via=remove commits=2 files=0"]);
});

test("an orphan cleanup writes delete with git=known when Ona reports both counts, and git=unknown when it reports neither (fails if either flag is wrong)", async () => {
  const known = register({ found: orphanBox({ totalUnpushedCommits: 0, totalChangedFiles: 0 }) });
  await cleanup(known.provider);
  assert.deepEqual(metricLines(known.logs), ["metric delete env=env-1 via=cleanup git=known"]);
  const unknown = register({ found: orphanBox({}) });
  await cleanup(unknown.provider);
  assert.deepEqual(metricLines(unknown.logs), ["metric delete env=env-1 via=cleanup git=unknown"]);
});

test("an orphan cleanup that finds unpushed commits and uncommitted files writes keep with both counts and deletes nothing (fails if the keep line is missing)", async () => {
  const { provider, calls, logs } = register({ found: orphanBox({ totalUnpushedCommits: 2, totalChangedFiles: 1 }) });
  const cleaned = await cleanup(provider);
  assert.equal(cleaned.status, "failed");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
  assert.deepEqual(metricLines(logs), ["metric keep env=env-1 via=cleanup commits=2 files=1"]);
});
