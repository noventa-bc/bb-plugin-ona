// The real server.ts in the SDK's fake host: a setting's schema is wired to bb's settings path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { local, startHost } from "./e2e-host.ts";

test("bb refuses an idleDisconnect typo and accepts 90m (fails if the setting loses its schema)", local, async () => {
  const { host, close } = await startHost({
    machineBootstrap: {
      async bootstrap() {
        return { hostId: "host-1" };
      },
    },
    machineResource: async () => null,
    sdk: { hosts: { list: async () => [] }, environments: { list: async () => [] }, threads: { list: async () => [] } },
  });
  try {
    await assert.rejects(
      host.harness.setSettings({ idleDisconnect: "1h30m" }),
      /idleDisconnect: use 30m, 2h, 45s or 90/,
    );
    await host.harness.setSettings({ idleDisconnect: "90m" });
  } finally {
    await close();
  }
});
