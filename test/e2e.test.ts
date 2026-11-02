// The real server.ts inside the SDK's fake bb host, with the fake `ona` and
// fake `ssh`: the machine provider's create, suspend, resume and remove the
// way bb drives them. The tunnel's health probe needs a real loopback port.
// The tests are one story in file order (shared `resource`, `hosts`,
// `bootstraps`): run the whole file, not one test by name.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { envNameForKey, type OnaResource } from "../src/provider.ts";

type Env = { id: string; metadata: { name?: string }; status: { phase: string; content?: unknown } };

// The agent sandbox blocks localhost; this file runs in CI and outside the sandbox.
const local = { skip: process.env.NONO_CAP_FILE ? "needs local ports, blocked in the agent sandbox" : false };
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bb-ona-e2e-"));
const state = join(dir, "environments.json");
const log = join(dir, "ona.log");
const KEY = "key-1";
const NAME = envNameForKey(KEY);

let host: ReturnType<typeof createFakePluginHost>;
let provider: NonNullable<ReturnType<typeof host.harness.registrations.machineProviders.get>>;
let health: http.Server;
let resource: OnaResource;
const bootstraps: string[] = [];
const hosts: unknown[] = [];

const envs = (): Env[] => JSON.parse(readFileSync(state, "utf8")) as Env[];
const patchBox = (patch: Partial<Env["status"]>) =>
  writeFileSync(
    state,
    JSON.stringify(envs().map((e) => (e.id === resource.envId ? { ...e, status: { ...e.status, ...patch } } : e))),
  );
/**
 * `ona` calls since the last read, without the `--timeout` and `-o json` every
 * call carries. Listings are dropped: the tunnel loop runs one in the background
 * at a time of its own choosing, and no scenario asserts on them.
 */
const onaCalls = () => {
  const lines = readFileSync(log, "utf8").trim().split("\n");
  writeFileSync(log, "");
  return lines
    .map((line) => line.replace(/ -o json| --timeout \d+s/g, ""))
    .filter((line) => line !== "environment list");
};
const checkpoints: unknown[] = [];
const ctx = {
  report: { step() {}, log() {} },
  signal: new AbortController().signal,
  checkpoint: async (r: unknown) => {
    checkpoints.push(r);
  },
};

before(async () => {
  if (local.skip) return;
  writeFileSync(state, "[]");
  writeFileSync(log, "");
  process.env.FAKE_ONA_ENVIRONMENTS = state;
  process.env.FAKE_ONA_LOG = log;
  process.env.FAKE_ONA_PROJECTS = here("./fixtures/ona/projects.json");
  process.env.FAKE_SSH_HOME = dir;
  health = http.createServer((req, res) => res.writeHead(req.url === "/health" ? 200 : 404).end());
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  host = createFakePluginHost({
    pluginId: "ona",
    loopbackBaseUrl: `http://127.0.0.1:${(health.address() as AddressInfo).port}`,
    settings: {
      onaPath: here("./fake-ona.mjs"),
      sshPath: here("./fake-ssh.sh"),
      waitForSharedHome: false,
      machineDataDir: "",
      codexSqliteHome: "",
    },
    machineBootstrap: {
      async bootstrap({ key }) {
        bootstraps.push(key);
        return { hostId: "host-1" };
      },
    },
    machineResource: async (hostId) => (hostId === "host-1" ? resource : null),
    sdk: { hosts: { list: async () => hosts }, environments: { list: async () => [] } },
  });
  await plugin(host.bb);
  provider = host.harness.registrations.machineProviders.get("ona")!;
});

after(async () => {
  if (local.skip) return;
  await host?.harness.lifecycle.dispose();
  health?.close();
  rmSync(dir, { recursive: true, force: true });
  for (const key of ["FAKE_ONA_ENVIRONMENTS", "FAKE_ONA_LOG", "FAKE_ONA_PROJECTS", "FAKE_SSH_HOME"])
    delete process.env[key];
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
  patchBox({ phase: "ENVIRONMENT_PHASE_STOPPED" });
  await provider.resume!({ ...ctx, resource, hostId: "host-1" });
  const calls = onaCalls();
  assert.equal(calls.filter((call) => call.startsWith("environment start")).length, 1, calls.join("\n"));
  assert.ok(calls.includes(`environment start ${resource.envId}`), calls.join("\n"));
  assert.equal(envs()[0]!.status.phase, "ENVIRONMENT_PHASE_RUNNING");
  assert.deepEqual(bootstraps, [KEY, KEY]);
});

test("remove refuses a created box with unpushed commits and keeps it connected", local, async () => {
  patchBox({ content: { git: { branch: "feature-x", totalUnpushedCommits: 2 } } });
  const result = await provider.remove({ ...ctx, resource, hostId: "host-1" });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.match(result.message, /2 unpushed commit\(s\) on branch feature-x/);
  assert.match(result.message, new RegExp(`ona environment delete ${resource.envId}`));
  assert.deepEqual(onaCalls(), [`environment get ${resource.envId}`]);
  assert.match((await host.harness.behavior.runCli(["list"])).stdout ?? "", /tunnel:(up|connecting)/);
  patchBox({ content: undefined });
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
