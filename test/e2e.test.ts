// The real server.ts inside the SDK's fake bb host, with the fake `ona` and
// fake `ssh`: the machine provider's create, suspend, resume and remove the
// way bb drives them. The tunnel's health probe needs a real loopback port.
// The tests are one story in file order (shared `resource`, `hosts`,
// `bootstraps`): run the whole file, not one test by name.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { envNameForKey, type OnaResource } from "../src/provider.ts";
import type { BbHost } from "../src/sync.ts";
import { ctx as baseCtx, local, startHost, type E2eHost } from "./e2e-host.ts";

const KEY = "key-1";
const NAME = envNameForKey(KEY);

let host: E2eHost["host"];
let provider: E2eHost["provider"];
let dir: string;
let state: string;
let envs: E2eHost["envs"];
let onaCalls: E2eHost["onaCalls"];
let close: E2eHost["close"];
let resource: OnaResource;
const bootstraps: string[] = [];
const hosts: BbHost[] = [];
let patchBox: E2eHost["patchBox"];
const checkpoints: unknown[] = [];
const ctx = {
  ...baseCtx,
  checkpoint: async (r: unknown) => {
    checkpoints.push(r);
  },
};

before(async () => {
  if (local.skip) return;
  ({ host, provider, dir, state, envs, onaCalls, close, patchBox } = await startHost({
    machineBootstrap: {
      async bootstrap({ key }) {
        bootstraps.push(key);
        return { hostId: "host-1" };
      },
    },
    machineResource: async (hostId) => (hostId === "host-1" ? resource : null),
    sdk: {
      hosts: { list: async () => hosts },
      environments: { list: async () => [] },
      threads: { list: async () => [] },
    },
  }));
});

after(async () => {
  if (!local.skip) await close();
});

test("create makes the box from the project, checkpoints the resource and bootstraps bb on it", local, async () => {
  const result = await provider.create({
    ...ctx,
    inputs: { mode: "create", project: "Sample Web" },
    key: KEY,
    attempt: 1,
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  resource = result.resource as OnaResource;
  assert.equal(result.name, `ona:${NAME}`);
  assert.deepEqual(resource, { envId: "env-1", envName: NAME, adopted: false, key: KEY });
  assert.deepEqual(checkpoints, [resource]);
  assert.deepEqual(bootstraps, [KEY]);
  const calls = onaCalls();
  assert.ok(calls.includes("project list"), calls.join("\n"));
  assert.ok(calls.includes(`environment create proj-0001 --name ${NAME} --inactivity-timeout 3h`), calls.join("\n"));
  hosts.push({
    id: "host-1",
    name: result.name,
    machineProviderId: "ona",
    status: "connected",
    lastSeenAt: Date.now(),
    updatedAt: Date.now(),
    lifecycle: { phase: "active", message: null, suspendedAt: null },
  });
});

test("bb ona status shows the created box next to Ona's view", local, async () => {
  const result = await host.harness.behavior.runCli(["status"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /^Ona CLI: ok/);
  assert.match(
    result.stdout ?? "",
    new RegExp(`^ona:${NAME}  bb:connected  tunnel:(up|connecting)  ona:running$`, "m"),
  );
});

test("a user-initiated suspend closes the tunnel and stops the box", local, async () => {
  await provider.suspend!({ ...ctx, resource, hostId: "host-1" });
  assert.deepEqual(onaCalls(), [`environment get ${resource.envId}`, `environment stop ${resource.envId}`]);
  assert.equal(envs()[0]!.status.phase, "ENVIRONMENT_PHASE_STOPPED");
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:off/);
});

test("resume after an Ona auto-stop starts the box once and bootstraps bb again", local, async () => {
  patchBox(resource.envId, { phase: "ENVIRONMENT_PHASE_STOPPED" });
  writeFileSync(
    state,
    JSON.stringify(
      envs().map((e) => (e.id === resource.envId ? { ...e, metadata: { ...e.metadata, name: "renamed" } } : e)),
    ),
  );
  const result = await provider.resume!({ ...ctx, resource, hostId: "host-1" });
  // Bug: the stored resource kept the creation name for good after a rename.
  assert.deepEqual(result.resource, { ...resource, envName: "renamed" });
  assert.deepEqual(checkpoints.at(-1), result.resource);
  const calls = onaCalls();
  assert.equal(calls.filter((call) => call.startsWith("environment start")).length, 1, calls.join("\n"));
  assert.ok(calls.includes(`environment start ${resource.envId}`), calls.join("\n"));
  assert.equal(envs()[0]!.status.phase, "ENVIRONMENT_PHASE_RUNNING");
  assert.deepEqual(bootstraps, [KEY, KEY]);
});

test("remove refuses a created box with unpushed commits and keeps it connected", local, async () => {
  patchBox(resource.envId, { content: { git: { branch: "feature-x", totalUnpushedCommits: 2 } } });
  const result = await provider.remove({ ...ctx, resource, hostId: "host-1" });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.match(result.message, /2 unpushed commit\(s\) on branch feature-x/);
  assert.match(result.message, new RegExp(`ona environment delete ${resource.envId}`));
  assert.deepEqual(onaCalls(), [`environment get ${resource.envId}`]);
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:(up|connecting)/);
  patchBox(resource.envId, { content: undefined });
});

test("remove deletes a clean created box", local, async () => {
  const result = await provider.remove({ ...ctx, resource, hostId: "host-1" });
  assert.deepEqual(result, { status: "removed" });
  assert.deepEqual(onaCalls(), [`environment get ${resource.envId}`, `environment delete ${resource.envId}`]);
  assert.deepEqual(envs(), []);
  hosts.length = 0;
});

test("remove never deletes an adopted box", local, async () => {
  const box = { id: "env-adopted", metadata: { name: "brave-otter" }, status: { phase: "ENVIRONMENT_PHASE_RUNNING" } };
  writeFileSync(state, JSON.stringify([box]));
  const created = await provider.create({
    ...ctx,
    inputs: { mode: "adopt", environment: "brave-otter" },
    key: "key-2",
    attempt: 1,
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  assert.equal((created.resource as OnaResource).adopted, true);
  onaCalls();
  // The uninstall script runs locally over fake-ssh: an empty data dir makes it a no-op.
  const adopted = { ...(created.resource as OnaResource), dataDir: mkdtempSync(join(dir, "data-")) };
  const result = await provider.remove({ ...ctx, resource: adopted, hostId: "host-2" });
  assert.deepEqual(result, { status: "removed" });
  assert.deepEqual(onaCalls(), ["environment get env-adopted"]);
  assert.deepEqual(envs(), [box]);
});
