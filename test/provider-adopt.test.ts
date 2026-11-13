// The provider's create on a box another bb machine may use, driven through `create` in the fake host of
// ./provider-fake.ts, followed by bb's cleanup of a failed create, and the remove of a machine whose box another
// machine uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import { adoptedResource, box, cleanBox, connectCalls, lifecycle, register, type Setup } from "./provider-fake.ts";

/** Adopts the box under key "key-2"; a refusal before the checkpoint gets bb's cleanup, `reconcileCleanup`. */
async function adopt(setup: Setup) {
  const fake = register(setup);
  const { report } = lifecycle();
  const signal = new AbortController().signal;
  let checkpointed = false;
  const result = await fake.provider
    .create({
      report,
      checkpoint: async () => void (checkpointed = true),
      inputs: { mode: "adopt", environment: "box" },
      key: "key-2",
      attempt: 1,
      signal,
    })
    .catch((error: unknown) => error);
  if (result instanceof Error) await fake.provider.reconcileCleanup({ key: "key-2", report, signal });
  return { ...fake, result, checkpointed };
}

for (const phase of ["active", "removing", "creating"]) {
  test(`adopting a box another bb machine uses (${phase}) is refused before the checkpoint (fails if the failed adopt closes the other machine's tunnel or forgets its keys, or leaves creating machines out of the listing)`, async () => {
    const { result, checkpointed, open, tunnels, forgotten, calls } = await adopt({
      found: box("RUNNING"),
      tunnel: "up",
      // Without the refusal, the adopt would get as far as the connect and fail there, after its checkpoint.
      preflightExit: 1,
      machines: [{ id: "host-1", name: "ona:box", phase, resource: adoptedResource }],
    });
    assert.equal(open.get("env-1"), "up");
    assert.deepEqual(tunnels, []);
    assert.deepEqual(forgotten, []);
    assert.equal(checkpointed, false);
    assert.deepEqual(calls, []);
    assert.ok(result instanceof Error);
    assert.match(result.message, /ona:box \(host-1\) uses Ona environment box; a box holds one bb machine/);
  });
}

test("bb running create again for the same machine, still creating with the box checkpointed, is not refused (fails if the create counts its own host as another machine)", async () => {
  const { result, calls } = await adopt({
    found: box("RUNNING"),
    machines: [
      { id: "host-2", name: "Ona devbox 2", phase: "creating", resource: { ...adoptedResource, key: "key-2" } },
    ],
  });
  assert.ok(!(result instanceof Error), String(result));
  assert.deepEqual(calls, ["get RUNNING", ...connectCalls]);
});

test("a machine that is not this box's Ona machine does not refuse the adopt (fails if the provider filter, the box-id check or the resource guard is dropped)", async () => {
  const { result } = await adopt({
    found: box("RUNNING"),
    machines: [
      { id: "host-9", name: "other", phase: "active", resource: adoptedResource, provider: "other" },
      { id: "host-10", name: "ona:other", phase: "active", resource: { ...adoptedResource, envId: "env-2" } },
      { id: "host-11", name: "Ona devbox 11", phase: "creating", resource: null },
    ],
  });
  assert.ok(!(result instanceof Error), String(result));
});

// The box machine host-1's create made under key "key-1", before its checkpoint; host-2 has adopted it since.
const unfinished = { ...cleanBox("RUNNING"), metadata: { name: envNameForKey("key-1") } };
const adoptedSince = { id: "host-2", name: "ona:m2", phase: "active", resource: { ...adoptedResource, key: "key-2" } };
const creating = { id: "host-1", name: "Ona devbox 1", phase: "creating", resource: null };

const cleanup = (fake: ReturnType<typeof register>) =>
  fake.provider.reconcileCleanup({ key: "key-1", report: lifecycle().report, signal: new AbortController().signal });

// Bug: bb's cleanup of host-1 found the box by its key-derived name and deleted the box host-2 had adopted.
for (const phase of ["active", "removing"]) {
  test(`cleanup of an unfinished create leaves a box another machine (${phase}) adopted (fails if cleanup deletes by name alone, or skips a removing machine)`, async () => {
    const fake = register({ found: unfinished, tunnel: "up", machines: [creating, { ...adoptedSince, phase }] });
    assert.equal((await cleanup(fake)).status, "removed");
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(fake.tunnels, []);
    assert.deepEqual(fake.forgotten, []);
  });
}

test("cleanup leaves a box another machine adopted, unpushed work and all, without a call (fails if the work check runs first)", async () => {
  const content = { git: { branch: "feat", totalUnpushedCommits: 2 } };
  const withWork = { ...unfinished, status: { ...unfinished.status, content } };
  const fake = register({ found: withWork, tunnel: "up", machines: [creating, adoptedSince] });
  assert.equal((await cleanup(fake)).status, "removed");
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.tunnels, []);
});

test("cleanup still deletes its own orphaned box when no other machine stores it (fails if the guard counts any listed machine or drops the cleanup's key)", async () => {
  const other = { ...adoptedSince, resource: { ...adoptedResource, envId: "env-2", key: "key-2" } };
  // bb calls cleanup only for a host that stores nothing; this row stores the box to pin that cleanup passes its own key.
  const own = { ...creating, resource: { ...adoptedResource, adopted: false } };
  const fake = register({ found: unfinished, machines: [own, other] });
  assert.equal((await cleanup(fake)).status, "removed");
  assert.deepEqual(fake.calls, ["delete env-1"]);
});

/** bb runs host-1's create again under key "key-1"; returns the result or the error and whether it checkpointed. */
async function createAgain(setup: Setup) {
  const fake = register(setup);
  let checkpointed = false;
  const result = await fake.provider
    .create({
      report: lifecycle().report,
      checkpoint: async () => void (checkpointed = true),
      inputs: { mode: "create", project: "p" },
      key: "key-1",
      attempt: 2,
      signal: new AbortController().signal,
    })
    .catch((error: unknown) => error);
  return { ...fake, result, checkpointed };
}

// Bug: the create reused the box by its name and checkpointed it as created, so host-1's remove deleted it.
for (const phase of ["active", "removing"]) {
  test(`a create run again refuses a box another machine (${phase}) adopted since (fails if the create takes the box over as created, or skips a removing machine)`, async () => {
    const { result, checkpointed, calls, tunnels, forgotten } = await createAgain({
      found: unfinished,
      tunnel: "up",
      machines: [creating, { ...adoptedSince, phase }],
    });
    assert.ok(result instanceof Error);
    assert.ok(
      result.message.startsWith(
        `ona:m2 (host-2) uses Ona environment ${unfinished.metadata.name}; a box holds one bb machine`,
      ),
    );
    assert.equal(checkpointed, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(tunnels, []);
    assert.deepEqual(forgotten, []);
  });
}

test("a create run again reuses its own checkpointed box (fails if the create counts its own host as another machine)", async () => {
  const own = { ...creating, resource: { ...adoptedResource, adopted: false } };
  const { result, checkpointed } = await createAgain({ found: unfinished, machines: [own] });
  assert.ok(!(result instanceof Error), String(result));
  assert.equal(checkpointed, true);
});

for (const hostReadFails of ["list", "resource"] as const) {
  test(`a failed bb ${hostReadFails} read rejects the cleanup and the create run again (fails if an unknown machine counts as no machine)`, async () => {
    const setup: Setup = { found: unfinished, tunnel: "up", machines: [creating, adoptedSince], hostReadFails };
    const fake = register(setup);
    await assert.rejects(cleanup(fake), /bb is unreachable/);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(fake.tunnels, []);
    const again = await createAgain(setup);
    assert.match(String(again.result), /bb is unreachable/);
    assert.equal(again.checkpointed, false);
    assert.deepEqual(again.calls, []);
    assert.deepEqual(again.tunnels, []);
  });
}

/** bb removes host-1, the machine whose create made the box; `releasing` starts with the box's no-stop flag set. */
async function removeCreated(setup: Setup) {
  const fake = register(setup);
  fake.releasing.add("env-1");
  const resource = { ...adoptedResource, adopted: false };
  const removed = await fake.provider
    .remove({ report: lifecycle().report, hostId: "host-1", resource, signal: new AbortController().signal })
    .catch((error: unknown) => error);
  return { ...fake, removed };
}

test("removing the created machine of a box another machine adopted since keeps the box, unpushed work and all, and what that machine needs (fails if the remove deletes, checks the work first, closes the tunnel, forgets the keys or drops the no-stop flag)", async () => {
  // Bug: the remove saw `adopted: false` and deleted the box host-2 had adopted.
  const { removed, calls, tunnels, forgotten, releasing, logs } = await removeCreated({
    found: box("RUNNING"),
    unpushed: true,
    tunnel: "up",
    machines: [adoptedSince],
  });
  assert.deepEqual(removed, { status: "removed" });
  assert.deepEqual(calls, []);
  assert.deepEqual(tunnels, []);
  assert.deepEqual(forgotten, []);
  assert.ok(releasing.has("env-1"));
  assert.ok(logs.some((entry) => /ona:m2 \(host-2\) uses Ona environment box/.test(entry.message)));
});

const createdBy = { id: "host-1", name: "ona:box", phase: "active", resource: { ...adoptedResource, adopted: false } };

/** bb removes host-2, the machine that adopted the box host-1's create made; `releasing` starts with the no-stop flag set. */
async function removeAdopting(setup: Omit<Setup, "found">) {
  const fake = register({ found: box("RUNNING"), tunnel: "up", machines: [createdBy], ...setup });
  fake.releasing.add("env-1");
  const resource = { ...adoptedResource, key: "key-2" };
  const removed = await fake.provider
    .remove({ report: lifecycle().report, hostId: "host-2", resource, signal: new AbortController().signal })
    .catch((error: unknown) => error);
  return { ...fake, removed };
}

test("removing the adopting machine while the creating one still stores the box moves only its own folder aside and keeps what that machine needs (fails if the guard skips the adopted check, or the remove closes the tunnel, forgets the keys or drops the no-stop flag)", async () => {
  // Bug: the adopted remove closed the box's tunnel and forgot its keys, which host-1 still runs on.
  const { removed, calls, moves, tunnels, forgotten, releasing, logs } = await removeAdopting({});
  assert.deepEqual(removed, { status: "removed" });
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
  assert.deepEqual(moves[0]?.args, ["host-2", ""]);
  assert.ok(
    logs.some((entry) => /ona:box \(host-1\) uses .* removing host-2 kept its tunnel and keys/.test(entry.message)),
  );
  assert.deepEqual(tunnels, []);
  assert.deepEqual(forgotten, []);
  assert.ok(releasing.has("env-1"));
});

test("removing the adopting machine while bb also removes the creating one closes the tunnel and forgets the keys (fails if a machine being removed counts as using the box)", async () => {
  const { removed, calls, tunnels, forgotten, releasing } = await removeAdopting({
    machines: [{ ...createdBy, phase: "removing" }],
  });
  assert.deepEqual(removed, { status: "removed" });
  assert.deepEqual(calls, ["get RUNNING", "move-aside"]);
  assert.deepEqual(tunnels, ["stop env-1", "stop env-1"]);
  assert.deepEqual(forgotten, ["env-1"]);
  assert.ok(!releasing.has("env-1"));
});

test("removing the created machine while bb also removes the adopting one deletes the box (fails if a machine being removed counts as using the box)", async () => {
  const { removed, calls, tunnels, forgotten } = await removeCreated({
    found: cleanBox("RUNNING"),
    tunnel: "up",
    machines: [{ ...adoptedSince, phase: "removing" }],
  });
  assert.deepEqual(removed, { status: "removed" });
  assert.deepEqual(calls, ["get RUNNING", "delete env-1"]);
  assert.deepEqual(tunnels, ["stop env-1"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("removing the created machine deletes its box when only other boxes' machines are listed (fails if the guard counts any listed machine or drops the remove's key)", async () => {
  const own = { id: "host-1", name: "ona:box", phase: "removing", resource: { ...adoptedResource, adopted: false } };
  const other = { ...adoptedSince, resource: { ...adoptedResource, envId: "env-2", key: "key-2" } };
  const { removed, calls, forgotten } = await removeCreated({ found: cleanBox("RUNNING"), machines: [own, other] });
  assert.deepEqual(removed, { status: "removed" });
  assert.deepEqual(calls, ["get RUNNING", "delete env-1"]);
  assert.deepEqual(forgotten, ["env-1"]);
});

test("a failed bb list read rejects the remove of a created machine before anything changes (fails if an unknown machine counts as no machine)", async () => {
  const { removed, calls, tunnels, forgotten } = await removeCreated({
    found: box("RUNNING"),
    tunnel: "up",
    machines: [adoptedSince],
    hostReadFails: "list",
  });
  assert.match(String(removed), /bb is unreachable/);
  assert.deepEqual(calls, []);
  assert.deepEqual(tunnels, []);
  assert.deepEqual(forgotten, []);
});
