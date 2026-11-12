// The real server.ts inside the SDK's fake bb host, with the fake `ona` and
// fake `ssh`: the machine provider's create, suspend, resume and remove the
// way bb drives them. The tunnel's health probe needs a real loopback port.
// The tests are one story in file order (shared `resource`, `hosts`,
// `bootstraps`): run the whole file, not one test by name.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { envNameForKey } from "../src/names.ts";
import type { OnaResource } from "../src/provider.ts";
import type { BbHost } from "../src/sync.ts";
import { asRoot, ctx as baseCtx, local, startHost, type E2eHost } from "./e2e-host.ts";

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
/** Plugin log messages about bb's data folder since the last read. */
const logged = () =>
  host.harness.logEntries
    .splice(0)
    .map((entry) => entry.message)
    .filter((message) => message.includes("data folder"));
const ctx = {
  ...baseCtx,
  checkpoint: async (r: unknown) => {
    checkpoints.push(r);
  },
};
let adopted: OnaResource;

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

test("remove refuses a created box with unpushed commits and closes its tunnel", local, async () => {
  patchBox(resource.envId, { content: { git: { branch: "feature-x", totalUnpushedCommits: 2 } } });
  const result = await provider.remove({ ...ctx, resource, hostId: "host-1" });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.match(result.message, /2 unpushed commit\(s\) on branch feature-x/);
  assert.match(result.message, new RegExp(`ona environment delete ${resource.envId}`));
  assert.deepEqual(onaCalls(), [`environment get ${resource.envId}`]);
  // A refused remove closes the tunnel too: nothing in it needs one (decision 0003).
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:off/);
  patchBox(resource.envId, { content: undefined });
});

test("remove deletes a clean created box", local, async () => {
  // The refused remove above closed the tunnel: bring it up, so the remove below has one to close.
  await provider.resume!({ ...ctx, resource, hostId: "host-1" });
  onaCalls();
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:(up|connecting)/);
  const result = await provider.remove({ ...ctx, resource, hostId: "host-1" });
  assert.deepEqual(result, { status: "removed" });
  assert.deepEqual(onaCalls(), [`environment get ${resource.envId}`, `environment delete ${resource.envId}`]);
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:off/);
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
  logged();
  // The script runs locally over fake-ssh, on this machine's legacy data folder.
  const dataDir = mkdtempSync(join(dir, "data-"));
  writeFileSync(join(dataDir, "host-id"), "host-2\n");
  // Bug: a trailing slash made `mv` try to move the folder into itself.
  adopted = { ...(created.resource as OnaResource), dataDir: `${dataDir}/` };
  const result = await provider.remove({ ...ctx, resource: adopted, hostId: "host-2" });
  assert.deepEqual(result, { status: "removed" });
  // Bug: the folder stayed, and bb's installer refused to adopt the box again.
  assert.equal(existsSync(dataDir), false);
  assert.equal(readdirSync(dir).filter((name) => name.startsWith(`${basename(dataDir)}.old-`)).length, 1);
  assert.deepEqual(logged(), []);
  assert.deepEqual(onaCalls(), ["environment get env-adopted"]);
  assert.deepEqual(envs(), [box]);
});

// Bug: a remove that moved nothing said nothing, as if the folder had moved;
// then it said so only in bb's server log.
test("a remove that finds no data folder says so", local, async () => {
  const result = await provider.remove({ ...ctx, resource: adopted, hostId: "host-9" });
  assert.deepEqual(result, { status: "removed" });
  const [line, ...rest] = logged();
  assert.match(line ?? "", /^Found no bb data folder for machine host-9 on brave-otter; nothing moved\. /);
  assert.match(
    line ?? "",
    /If adopting it again fails, move aside .* "Adopting a box again after removing its machine"/,
  );
  assert.deepEqual(rest, []);
  assert.deepEqual(onaCalls(), ["environment get env-adopted"]);
});

// Bug: a failed move was told only in bb's server log.
test(
  "a remove that can't move the data folder says how to move it by hand",
  { skip: local.skip || asRoot },
  async (t) => {
    const parent = mkdtempSync(join(dir, "read-only-"));
    const dataDir = join(parent, "data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "host-id"), "host-2\n");
    chmodSync(parent, 0o555);
    t.after(() => chmodSync(parent, 0o755));
    const result = await provider.remove({ ...ctx, resource: { ...adopted, dataDir }, hostId: "host-2" });
    assert.deepEqual(result, { status: "removed" });
    assert.equal(existsSync(join(dataDir, "host-id")), true);
    const [line, ...rest] = logged();
    assert.match(
      line ?? "",
      /^Could not move bb's data folder on brave-otter aside \(exit 1: .*Permission denied\)\. /,
    );
    assert.match(line ?? "", /Before adopting it again, move aside the bb data folder whose host-id is host-2 /);
    assert.deepEqual(rest, []);
    assert.deepEqual(onaCalls(), ["environment get env-adopted"]);
  },
);

test("removing a stopped adopted box leaves its data folder, says so and keeps the box", local, async () => {
  patchBox("env-adopted", { phase: "ENVIRONMENT_PHASE_STOPPED" });
  const dataDir = mkdtempSync(join(dir, "data-"));
  writeFileSync(join(dataDir, "host-id"), "host-2\n");
  const result = await provider.remove({ ...ctx, resource: { ...adopted, dataDir }, hostId: "host-2" });
  assert.deepEqual(result, { status: "removed" });
  assert.equal(existsSync(join(dataDir, "host-id")), true, "no SSH to a box Ona doesn't report running");
  const [line, ...rest] = logged();
  assert.match(line ?? "", /^brave-otter isn't running, so bb's data folder on it was left in place\./);
  assert.match(line ?? "", /start it and move aside the bb data folder whose host-id is host-2 /);
  assert.deepEqual(rest, []);
  assert.deepEqual(onaCalls(), ["environment get env-adopted"]);
  assert.equal(envs().length, 1);
});
