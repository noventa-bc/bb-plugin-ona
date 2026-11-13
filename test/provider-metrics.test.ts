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

/** A create of the box named for key-1, in project-1. */
const createNew = (provider: ReturnType<typeof register>["provider"]) =>
  provider.create({
    ...lifecycle(),
    inputs: { mode: "create", project: "project-1" },
    key: "key-1",
    attempt: 1,
    signal: signal(),
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
  await createNew(provider);
  assert.deepEqual(metricText(logs), ["metric connected via=create box=new secs=0 ok=1"]);
});

test("a create whose createEnvironment is rejected writes connected with box=running and ok=0, and still rejects (fails if box reads new before the call returns)", async () => {
  const { provider, logs } = register({
    found: { ...box("RUNNING"), metadata: { name: envNameForKey("key-1") } },
    unlisted: true,
    createFails: true,
  });
  await assert.rejects(createNew(provider), /Ona refused the create/);
  assert.deepEqual(metricText(logs), ["metric connected via=create box=running secs=0 ok=0"]);
});

test("a create whose lookup fails after createEnvironment returns writes connected with box=new and ok=0, since Ona made the box (fails if the flag waits for the lookup)", async () => {
  // The box is named unlike the key, so the lookup after the create finds nothing.
  const { provider, logs } = register({ found: box("RUNNING") });
  await assert.rejects(createNew(provider), /Ona environment .* not found/);
  assert.deepEqual(metricText(logs), ["metric connected via=create box=new secs=0 ok=0"]);
});

test("a created box that ensureRunning then starts reads box=new, not stopped (fails if the start's stopped outranks new)", async () => {
  const { provider, logs } = register({
    found: { ...box("STOPPED"), metadata: { name: envNameForKey("key-1") } },
    unlisted: true,
    phases: ["RUNNING"],
  });
  await createNew(provider);
  assert.deepEqual(metricText(logs), [
    "metric start env=env-1 via=create up=0",
    "metric connected via=create box=new secs=0 ok=1",
  ]);
});

test("a delete that Ona rejects writes no delete line and still rejects, in remove and in cleanup (fails if the line is written before the delete)", async () => {
  const removing = register({ found: boxWithGit({}), deleteFails: true });
  await assert.rejects(remove(removing.provider), /Ona delete failed/);
  assert.deepEqual(metricLines(removing.logs), []);
  const cleaning = register({
    found: boxWithGit({ totalUnpushedCommits: 0, totalChangedFiles: 0 }),
    deleteFails: true,
  });
  await assert.rejects(cleanup(cleaning.provider), /Ona delete failed/);
  assert.deepEqual(metricLines(cleaning.logs), []);
});

test("a remove of a clean box writes a delete line (fails if the line is missing)", async () => {
  const { provider, logs } = register({ found: boxWithGit({}) });
  await remove(provider);
  assert.deepEqual(metricLines(logs), ["metric delete env=env-1 via=remove"]);
});

test("a remove and an orphan cleanup of a box with no git block write keep with git=unknown (fails if the keep line is missing or carries counts)", async () => {
  const removing = register({ found: box("RUNNING") });
  await remove(removing.provider);
  assert.deepEqual(metricLines(removing.logs), ["metric keep env=env-1 via=remove git=unknown"]);
  const cleaning = register({ found: { ...box("RUNNING"), metadata: { name: envNameForKey("key-1") } } });
  await cleanup(cleaning.provider);
  assert.deepEqual(metricLines(cleaning.logs), ["metric keep env=env-1 via=cleanup git=unknown"]);
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

test("an orphan cleanup of a clean box writes a delete line (fails if the line is missing)", async () => {
  const { provider, logs } = register({ found: boxWithGit({}) });
  await cleanup(provider);
  assert.deepEqual(metricLines(logs), ["metric delete env=env-1 via=cleanup"]);
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
