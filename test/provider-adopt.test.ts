// The provider's create in adopt mode on a box another bb machine may use, driven through `create` in the fake host of
// ./provider-fake.ts, followed by bb's cleanup of a failed create.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptedResource, box, connectCalls, lifecycle, register, type Setup } from "./provider-fake.ts";

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
