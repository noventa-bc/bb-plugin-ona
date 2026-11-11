// The real server.ts in the SDK's fake host: the tunnel gate server.ts passes to the TunnelManager (safety rule 1).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { ctx, local, startHost } from "./e2e-host.ts";

test(
  "a dropped tunnel to a box Ona now shows stopped is not reopened (fails if the gate ignores Ona's answer)",
  local,
  async () => {
    const { provider, log, patchBox, tunnelPids, close } = await startHost({
      machineBootstrap: { bootstrap: async () => ({ hostId: "host-1" }) },
      machineResource: async () => null,
      sdk: {
        hosts: { list: async () => [] },
        environments: { list: async () => [] },
        threads: { list: async () => [] },
      },
    });
    /** The `ona environment list` calls so far: the gate asks one before each (re)connect. */
    const listings = () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("environment list"));
    try {
      const created = await provider.create({
        ...ctx,
        inputs: { mode: "create", project: "Sample Web" },
        key: "k",
        attempt: 1,
      });
      assert.equal(created.status, "created");
      const [pid] = tunnelPids();
      assert.ok(pid, "the create opened a tunnel");
      patchBox("env-1", { phase: "ENVIRONMENT_PHASE_STOPPED" });
      const asked = listings().length;
      process.kill(pid, "SIGTERM");
      // The loop waits 2 s after a short-lived tunnel, then asks the gate.
      for (let waited = 0; listings().length === asked; waited += 100) {
        assert.ok(waited < 10_000, "the gate never asked Ona");
        await sleep(100);
      }
      await sleep(1_000);
      assert.deepEqual(tunnelPids(), [pid], "no second tunnel");
    } finally {
      await close();
    }
  },
);
