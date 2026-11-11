// The `metric` lines the provider writes: a start with its cause, each connect call's outcome, and each delete or
// refused delete. Driven through the provider's calls in the fake host of ./provider-fake.ts, on the fake clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import type { OnaEnvironment } from "../src/ona.ts";
import { tick, useFakeClock } from "./fake-clock.ts";
import { adoptedResource, box, lifecycle, register, resume, start } from "./provider-fake.ts";

useFakeClock();

const signal = () => new AbortController().signal;
const createdResource = { envId: "env-1", envName: "box", adopted: false, key: "key-1" };

/** The `metric` lines a host logged, in order. */
const metricText = (logs: { message: string }[]) =>
  logs.map((entry) => entry.message).filter((message) => message.startsWith("metric "));

/** The same lines with `up` and `secs` read as N, for the tests that don't tick the clock. */
const metricLines = (logs: { message: string }[]) =>
  metricText(logs).map((message) => message.replace(/ (up|secs)=\d+/g, " $1=N"));

/** A box whose listing carries these git facts; cleanup finds it by its key-derived name. */
const boxWithGit = (git: { totalUnpushedCommits?: number; totalChangedFiles?: number }): OnaEnvironment => ({
  ...box("RUNNING"),
  metadata: { name: envNameForKey("key-1") },
  status: { phase: "ENVIRONMENT_PHASE_RUNNING", content: { git: { branch: "feat", ...git } } },
});

const remove = (provider: ReturnType<typeof register>["provider"]) =>
  provider.remove({ report: lifecycle().report, hostId: "host-1", resource: createdResource, signal: signal() });

const cleanup = (provider: ReturnType<typeof register>["provider"]) =>
  provider.reconcileCleanup({ key: "key-1", report: lifecycle().report, signal: signal() });

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

test("a start that fails after Ona's start was called writes box=stopped with ok=0 and rejects with the start's error (fails if box comes from ensureRunning's return, or the error is replaced)", async () => {
  const { wake, logs } = register({ found: box("STOPPED"), phases: ["STOPPED"], hangs: "start" });
  const controller = new AbortController();
  const woken = wake(adoptedResource, lifecycle().report, controller.signal, "wake-cmd");
  // Ona's start hangs until the call is aborted, so the abort lands after the start was called.
  setImmediate(() => controller.abort());
  await assert.rejects(woken, /The operation was aborted/);
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

test("a resume's lines count secs from the call's entry in whole seconds, rounded (fails if secs is in milliseconds, truncated, or counted from the start)", async () => {
  const { resumed, logs } = resume({ found: box("STOPPED"), phases: ["STOPPED", "RUNNING"], startTakes: 2600 });
  await resumed;
  assert.deepEqual(metricText(logs), [
    "metric start env=env-1 via=resume up=0",
    "metric connected via=resume box=stopped secs=3 ok=1",
  ]);
});

test("a start line's up is whole seconds since the provider registered (fails if up is in milliseconds or counts from the call)", async () => {
  const { wake, logs } = register({ found: box("STOPPED"), phases: ["STOPPED", "RUNNING"] });
  await tick(41_000);
  await wake(adoptedResource, lifecycle().report, signal(), "wake-cmd");
  assert.equal(metricText(logs)[0], "metric start env=env-1 via=wake-cmd up=41");
});

test("a create that makes a new box writes its connected line with box=new (fails if the new box reads as running, or gets a start line)", async () => {
  const { provider, logs } = register({
    found: { ...box("RUNNING"), metadata: { name: envNameForKey("key-1") } },
    unlisted: true,
  });
  await provider.create({
    ...lifecycle(),
    inputs: { mode: "create", project: "project-1" },
    key: "key-1",
    attempt: 1,
    signal: signal(),
  });
  assert.deepEqual(metricText(logs), ["metric connected via=create box=new secs=0 ok=1"]);
});

test("a delete that Ona rejects writes no delete line and still rejects, in remove and in cleanup (fails if the line is written before the delete)", async () => {
  const removing = register({ found: box("RUNNING"), deleteFails: true });
  await assert.rejects(remove(removing.provider), /Ona delete failed/);
  assert.deepEqual(metricLines(removing.logs), []);
  const cleaning = register({
    found: boxWithGit({ totalUnpushedCommits: 0, totalChangedFiles: 0 }),
    deleteFails: true,
  });
  await assert.rejects(cleanup(cleaning.provider), /Ona delete failed/);
  assert.deepEqual(metricLines(cleaning.logs), []);
});

test("a remove that deletes a box with no git content writes delete with git=unknown (fails if the line is missing or says known)", async () => {
  const { provider, calls, logs } = register({ found: box("RUNNING") });
  await remove(provider);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    ["delete env-1"],
  );
  assert.deepEqual(metricLines(logs), ["metric delete env=env-1 via=remove git=unknown"]);
});

test("a remove of a clean box, whose listing gives only the unpushed-commit count, writes delete with git=known (fails if a clean box reads as unknown)", async () => {
  const { provider, logs } = register({ found: boxWithGit({ totalUnpushedCommits: 0 }) });
  await remove(provider);
  assert.deepEqual(metricLines(logs), ["metric delete env=env-1 via=remove git=known"]);
});

test("a remove of a box whose git counts are both zero writes delete with git=known (fails if known reads as unknown)", async () => {
  const { provider, logs } = register({ found: boxWithGit({ totalUnpushedCommits: 0, totalChangedFiles: 0 }) });
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

test("an orphan cleanup writes delete with git=known when the listing gives the unpushed-commit count, and git=unknown with no git content (fails if either flag is wrong)", async () => {
  const known = register({ found: boxWithGit({ totalUnpushedCommits: 0 }) });
  await cleanup(known.provider);
  assert.deepEqual(metricLines(known.logs), ["metric delete env=env-1 via=cleanup git=known"]);
  const unknown = register({ found: { ...box("RUNNING"), metadata: { name: envNameForKey("key-1") } } });
  await cleanup(unknown.provider);
  assert.deepEqual(metricLines(unknown.logs), ["metric delete env=env-1 via=cleanup git=unknown"]);
});

test("an orphan cleanup that finds unpushed commits and uncommitted files writes keep with both counts and deletes nothing (fails if the keep line is missing)", async () => {
  const { provider, calls, logs } = register({ found: boxWithGit({ totalUnpushedCommits: 2, totalChangedFiles: 1 }) });
  const cleaned = await cleanup(provider);
  assert.equal(cleaned.status, "failed");
  assert.deepEqual(
    calls.filter((call) => call.startsWith("delete")),
    [],
  );
  assert.deepEqual(metricLines(logs), ["metric keep env=env-1 via=cleanup commits=2 files=1"]);
});
