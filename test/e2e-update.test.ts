// The Update CLIs button's path through the real server.ts (test/e2e-host.ts): devbox_command `update` for one devbox
// installs the pending CLI on that box and on no other. Kept out of e2e-commands.test.ts, near its line cap.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { OnaResource } from "../src/provider.ts";
import type { BbHost } from "../src/sync.ts";
import { ctx, local, startHost, type E2eHost } from "./e2e-host.ts";

let host: E2eHost["host"];
let provider: E2eHost["provider"];
let close: E2eHost["close"];
const hosts: BbHost[] = [];
const resources: Record<string, OnaResource> = {};

// Claude Code has an update pending on every box, Codex is current.
const cliStatus = {
  "claude-code": {
    installed: true,
    needsUpdate: true,
    installAction: { kind: "update" },
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
  },
  codex: {
    installed: true,
    needsUpdate: false,
    installAction: { kind: "update" },
    currentVersion: "0.5.0",
    latestVersion: "0.5.0",
  },
};

/** Adds a connected, active box to the fake Ona and to bb's hosts. */
async function addBox(hostId: string, key: string, project: string) {
  const result = await provider.create({ ...ctx, inputs: { mode: "create", project }, key, attempt: 1 });
  assert.equal(result.status, "created");
  if (result.status !== "created") throw new Error(`no box for ${hostId}`);
  resources[hostId] = result.resource as OnaResource;
  hosts.push({
    id: hostId,
    name: result.name,
    machineProviderId: "ona",
    status: "connected",
    lastSeenAt: Date.now(),
    updatedAt: Date.now(),
    lifecycle: { phase: "active", message: null, suspendedAt: null },
  });
}

before(async () => {
  if (local.skip) return;
  ({ host, provider, close } = await startHost({
    machineBootstrap: {
      async bootstrap() {
        return { hostId: "host-1" };
      },
    },
    machineResource: async (hostId) => resources[hostId] ?? null,
    sdk: {
      hosts: {
        list: async () => hosts,
        providerCliStatus: async () => cliStatus,
        installProviderCli: async () => [{ type: "completed", exitCode: 0 }],
      },
      threads: { list: async () => [] },
    },
  }));
  await addBox("host-1", "key-1", "Sample Web");
  await addBox("host-2", "key-2", "Data Tools");
});

after(async () => {
  if (!local.skip) await close();
});

test(
  "devbox_command update installs the pending CLI on that devbox only (fails if the host id is dropped or every box updates)",
  local,
  async () => {
    const reply = (await host.harness.behavior.callRpc("devbox_command", { command: "update", hostId: "host-1" })) as {
      exitCode: number;
      stderr?: string;
    };
    assert.equal(reply.exitCode, 0, reply.stderr);
    assert.deepEqual(host.harness.inspection.sdk.callsTo("hosts.installProviderCli"), [
      [{ hostId: "host-1", provider: "claude-code", actionKind: "update" }],
    ]);
  },
);
