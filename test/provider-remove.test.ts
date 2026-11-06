// The provider's remove of an adopted machine and of a bb-created one, driven through `remove` in the fake host of
// ./provider-fake.ts. The remove paths wait on nothing, so no fake clock is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptedResource, box, lifecycle, register } from "./provider-fake.ts";

const createdResource = { envId: "env-1", envName: "box", adopted: false, key: "key-1" };

const remove = (
  provider: ReturnType<typeof register>["provider"],
  resource: typeof adoptedResource | typeof createdResource,
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
  const { provider, calls, forgotten } = register({ found: box("RUNNING") });
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
