// The provider's create in adopt mode on a box another bb machine may use, driven through `create` in the fake host of
// ./provider-fake.ts, followed by bb's cleanup of a failed create.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OnaResource } from "../src/provider.ts";
import { adoptedResource, box, connectCalls, lifecycle, register, type Setup } from "./provider-fake.ts";

/**
 * Adopts the box under key "key-2", then cleans up as bb does after a failed create: `remove` once a resource was
 * checkpointed, `reconcileCleanup` before that.
 */
async function adopt(setup: Setup) {
  const fake = register(setup);
  const { report } = lifecycle();
  const signal = new AbortController().signal;
  let checkpointed: OnaResource | null = null;
  const result = await fake.provider
    .create({
      report,
      checkpoint: async (resource) => void (checkpointed = resource as OnaResource),
      inputs: { mode: "adopt", environment: "box" },
      key: "key-2",
      attempt: 1,
      signal,
    })
    .catch((error: unknown) => error);
  if (result instanceof Error) {
    if (checkpointed) await fake.provider.remove({ report, hostId: "host-2", resource: checkpointed, signal });
    else await fake.provider.reconcileCleanup({ key: "key-2", report, signal });
  }
  return { ...fake, result, checkpointed };
}

for (const phase of ["active", "removing"]) {
  test(`adopting a box another bb machine uses (${phase}) is refused before the checkpoint (fails if the failed adopt closes the other machine's tunnel or forgets its keys)`, async () => {
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
    assert.equal(checkpointed, null);
    assert.deepEqual(calls, []);
    assert.ok(result instanceof Error);
    assert.match(result.message, /ona:box \(host-1\) uses Ona environment box; a box holds one bb machine/);
  });
}

test("re-creating the same machine after a failed adopt is not refused (fails if the create counts its own creating host as another machine)", async () => {
  // bb runs create again for a host still creating, whose resource the first attempt checkpointed.
  const { result, calls } = await adopt({
    found: box("RUNNING"),
    machines: [
      { id: "host-2", name: "Ona devbox 2", phase: "creating", resource: { ...adoptedResource, key: "key-2" } },
    ],
  });
  assert.ok(!(result instanceof Error), String(result));
  assert.deepEqual(calls, ["get RUNNING", ...connectCalls]);
});
