// The provider's remove of an adopted machine and of a bb-created one, driven through `remove` in the fake host of
// ./provider-fake.ts. The remove paths wait on nothing, so no fake clock is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import { adoptedResource, box, cleanBox, lifecycle, register } from "./provider-fake.ts";

const createdResource = { envId: "env-1", envName: "box", adopted: false, key: "key-1" };

const remove = (
  provider: ReturnType<typeof register>["provider"],
  resource: typeof createdResource & { dataDir?: string },
) => provider.remove({ report: lifecycle().report, hostId: "host-1", resource, signal: new AbortController().signal });

const warnings = (logs: { level: string; message: string }[]) =>
  logs
    .filter((entry) => entry.level === "warn")
    .map((entry) => entry.message)
    .join("\n");

test("an adopted remove of a box Ona shows STARTING runs no move-aside and warns it isn't running (fails if the move-aside runs on a box that isn't running)", async () => {
  const { provider, calls, forgotten, logs } = register({ found: box("STARTING") });
  const removed = await remove(provider, adoptedResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get STARTING"]);
  assert.deepEqual(forgotten, ["env-1"]);
  assert.match(warnings(logs), /box isn't running, so bb's data folder on it was left in place/);
});

test("an adopted remove of a box Ona no longer has forgets the box and deletes nothing (fails if an absent adopted box is deleted)", async () => {
  const { provider, calls, forgotten } = register({ found: box("RUNNING"), phases: [null] });
  const removed = await remove(provider, adoptedResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get null"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("a remove of a bb-created box deletes it and forgets the box (fails if the created remove drops forgetBox)", async () => {
  const { provider, calls, forgotten } = register({ found: cleanBox("RUNNING") });
  const removed = await remove(provider, createdResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get RUNNING", "delete env-1"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("a remove of a bb-created box Ona shows DELETED deletes nothing and forgets the box (fails if a DELETED box is deleted again)", async () => {
  const { provider, calls, forgotten } = register({ found: box("DELETED") });
  const removed = await remove(provider, createdResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get DELETED"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("a remove of a bb-created box Ona no longer has deletes nothing and forgets the box (fails if an absent box is deleted)", async () => {
  const { provider, calls, forgotten } = register({ found: box("RUNNING"), phases: [null] });
  const removed = await remove(provider, createdResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get null"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("an adopted remove whose move-aside exits non-zero still removes the machine and warns the folder could not move (fails if the exit propagates)", async () => {
  const { provider, calls, forgotten, logs } = register({ found: box("RUNNING"), moveAside: 1 });
  const removed = await remove(provider, adoptedResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
  assert.deepEqual(forgotten, ["env-1"]);
  assert.match(warnings(logs), /Could not move bb's data folder on box aside \(exit 1: \)\./);
});

test("an adopted remove whose move-aside throws still removes the machine and warns it may not have moved (fails if the throw propagates)", async () => {
  const { provider, calls, forgotten, logs } = register({ found: box("RUNNING"), moveAside: new Error("ssh dropped") });
  const removed = await remove(provider, adoptedResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
  assert.deepEqual(forgotten, ["env-1"]);
  assert.match(warnings(logs), /May not have moved bb's data folder on box aside \(exit -1: Error: ssh dropped\)\./);
});

test("a remove of a bb-created box Ona shows STOPPED deletes it and forgets the box (fails if a stopped created box is kept)", async () => {
  const { provider, calls, forgotten } = register({ found: cleanBox("STOPPED") });
  const removed = await remove(provider, createdResource);
  assert.equal(removed.status, "removed");
  assert.deepEqual(calls, ["get STOPPED", "delete env-1"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("an adopted remove whose move-aside exits 4 logs why the daemon may still run (fails if exit 4 loses its cause)", async () => {
  const { provider, logs } = register({ found: box("RUNNING"), moveAside: 4 });
  await remove(provider, adoptedResource);
  assert.match(warnings(logs), /Could not move .*\(exit 4: \)\. The process listing couldn't be trusted/);
});

test("an adopted remove whose move-aside exits 5 logs that the folder is or holds the home folder (fails if exit 5 loses its warning)", async () => {
  const { provider, logs } = register({ found: box("RUNNING"), moveAside: 5 });
  await remove(provider, adoptedResource);
  assert.match(
    warnings(logs),
    /Did not move bb's data folder for machine host-1 on box: it is or holds the home folder/,
  );
});

test("an adopted remove runs the move-aside on the box's env id with hostId and dataDir as arguments, before the keys go (fails if the target, the args or the order change)", async () => {
  const { provider, moves, forgotten } = register({ found: box("RUNNING") });
  await remove(provider, { ...adoptedResource, dataDir: "/data/bb" });
  assert.deepEqual(moves, [{ envId: "env-1", args: ["host-1", "/data/bb"], keysKept: true, tunnel: "off" }]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("an adopted remove closes the box's tunnel before the move-aside and stops or deletes nothing (fails if the close comes after the move-aside)", async () => {
  const { provider, calls, moves, tunnels } = register({ found: box("RUNNING"), tunnel: "up" });
  const removed = await remove(provider, adoptedResource);
  assert.equal(removed.status, "removed");
  assert.equal(moves[0]?.tunnel, "off");
  assert.deepEqual(tunnels, ["stop env-1", "stop env-1"]);
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
});

const cleanup = (provider: ReturnType<typeof register>["provider"]) =>
  provider.reconcileCleanup({ key: "key-1", report: lifecycle().report, signal: new AbortController().signal });

/** The box an orphan cleanup finds by its key-derived name, with this status. */
const orphan = (status: NonNullable<ReturnType<typeof box>["status"]>) => ({
  ...box("RUNNING"),
  metadata: { name: envNameForKey("key-1") },
  status,
});

const deletes = (calls: string[]) => calls.filter((call) => call.startsWith("delete"));

const manualDelete =
  /Ona did not report its unpushed work\. .*`ona environment delete env-1`, then run `bb machine retry-cleanup` again\./;

test("a remove of a bb-created box with no git block is refused, deletes nothing and keeps its keys (fails if a box whose work Ona didn't report is deleted)", async () => {
  // Bug: unpushedWork read a missing git block as no work, so remove deleted a box whose work nobody had seen.
  const { provider, calls, forgotten, tunnels } = register({ found: box("RUNNING"), tunnel: "up" });
  const removed = await remove(provider, createdResource);
  assert.equal(removed.status, "failed");
  if (removed.status !== "failed") return;
  assert.match(removed.message, manualDelete);
  assert.deepEqual(deletes(calls), []);
  assert.deepEqual(forgotten, []);
  assert.deepEqual(tunnels, ["stop env-1"]);
});

test("an orphan cleanup of a box with no git block is refused and deletes nothing (fails if a box whose work Ona didn't report is deleted)", async () => {
  // Bug: the same missing git block let the orphan cleanup delete the box.
  const { provider, calls, tunnels } = register({
    found: orphan({ phase: "ENVIRONMENT_PHASE_RUNNING" }),
    tunnel: "up",
  });
  const cleaned = await cleanup(provider);
  assert.equal(cleaned.status, "failed");
  if (cleaned.status !== "failed") return;
  assert.match(cleaned.message, manualDelete);
  assert.deepEqual(deletes(calls), []);
  assert.deepEqual(tunnels, ["stop env-1"]);
});

test("a git block with no counts or with both counts zero is clean, so remove and orphan cleanup delete the box (fails if a clean box is refused)", async () => {
  for (const git of [{ branch: "main" }, { branch: "main", totalUnpushedCommits: 0, totalChangedFiles: 0 }]) {
    const status = { phase: "ENVIRONMENT_PHASE_RUNNING", content: { git } };
    const removing = register({ found: { ...box("RUNNING"), status } });
    assert.equal((await remove(removing.provider, createdResource)).status, "removed", JSON.stringify(git));
    assert.deepEqual(deletes(removing.calls), ["delete env-1"]);
    const cleaning = register({ found: orphan(status) });
    assert.equal((await cleanup(cleaning.provider)).status, "removed", JSON.stringify(git));
    assert.deepEqual(deletes(cleaning.calls), ["delete env-1"]);
  }
});
