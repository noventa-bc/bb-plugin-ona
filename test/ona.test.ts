import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, after, test } from "node:test";
import { isArchived, isDeleted, isRunning, isStarting, isStopped, OnaCli, type OnaEnvironment } from "../src/ona.ts";

const fakeOna = fileURLToPath(new URL("./fake-ona.sh", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/ona/${name}`, import.meta.url));
const cli = new OnaCli(fakeOna);
const dir = mkdtempSync(join(tmpdir(), "bb-ona-fake-"));
const FAKE_KEYS = [
  "FAKE_ONA_ENVIRONMENTS",
  "FAKE_ONA_PROJECTS",
  "FAKE_ONA_GET",
  "FAKE_ONA_LOG",
  "FAKE_ONA_FAIL",
] as const;

function setFake(vars: Partial<Record<(typeof FAKE_KEYS)[number], string>>): void {
  process.env.FAKE_ONA_ENVIRONMENTS = fixture("environments.json");
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
}

afterEach(() => {
  for (const key of FAKE_KEYS) delete process.env[key];
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("lists environments and parses phases", async () => {
  setFake({});
  const envs = await cli.listEnvironments();
  assert.deepEqual(
    envs.map((env) => [env.id, env.metadata.name, env.status?.phase]),
    [
      ["env-0001", "brave-otter", "ENVIRONMENT_PHASE_RUNNING"],
      ["env-0002", "quiet-heron", "ENVIRONMENT_PHASE_STARTING"],
      ["env-9abc", "swift-lynx", "ENVIRONMENT_PHASE_STOPPING"],
      ["env-7def", "calm-falcon", "ENVIRONMENT_PHASE_STOPPED"],
    ],
  );
});

test("isRunning, isStarting and isStopped agree with the fixture phases", async () => {
  setFake({});
  const byId = new Map((await cli.listEnvironments()).map((env) => [env.id, env]));
  const env = (id: string) => byId.get(id)!;

  assert.equal(isRunning(env("env-0001")), true);
  assert.equal(isStarting(env("env-0002")), true);
  assert.equal(isStopped(env("env-7def")), true);

  // STOPPING is none of the three: not running, not on its way up, not stopped yet.
  assert.equal(isRunning(env("env-9abc")), false);
  assert.equal(isStarting(env("env-9abc")), false);
  assert.equal(isStopped(env("env-9abc")), false);
});

test("findEnvironment matches an exact id", async () => {
  setFake({});
  assert.equal((await cli.findEnvironment("env-0001"))?.metadata.name, "brave-otter");
});

test("findEnvironment matches an exact name", async () => {
  setFake({});
  assert.equal((await cli.findEnvironment("swift-lynx"))?.id, "env-9abc");
});

test("findEnvironment matches a unique id prefix", async () => {
  setFake({});
  assert.equal((await cli.findEnvironment("env-9ab"))?.id, "env-9abc");
});

test("findEnvironment returns null for an ambiguous id prefix", async () => {
  setFake({});
  assert.equal(await cli.findEnvironment("env-000"), null);
});

test("findEnvironment returns null for an unknown ref", async () => {
  setFake({});
  assert.equal(await cli.findEnvironment("no-such-box"), null);
});

test("resolveProjectId matches by id", async () => {
  setFake({ FAKE_ONA_PROJECTS: fixture("projects.json") });
  assert.equal(await cli.resolveProjectId("proj-0002"), "proj-0002");
});

test("resolveProjectId matches by name, case-insensitively", async () => {
  setFake({ FAKE_ONA_PROJECTS: fixture("projects.json") });
  assert.equal(await cli.resolveProjectId("sample web"), "proj-0001");
  assert.equal(await cli.resolveProjectId("DATA TOOLS"), "proj-0002");
});

test("resolveProjectId throws a message pointing at ona project list for an unknown project", async () => {
  setFake({ FAKE_ONA_PROJECTS: fixture("projects.json") });
  await assert.rejects(cli.resolveProjectId("no-such-project"), /ona project list/);
});

test("start passes the expected argv", async () => {
  const log = join(dir, "start.log");
  setFake({ FAKE_ONA_LOG: log });
  await cli.start("env-0001");
  assert.equal(readFileSync(log, "utf8"), "environment start env-0001\n");
});

test("stop passes the expected argv", async () => {
  const log = join(dir, "stop.log");
  setFake({ FAKE_ONA_LOG: log });
  await cli.stop("env-0001");
  assert.equal(readFileSync(log, "utf8"), "environment stop env-0001\n");
});

test("rename passes the expected argv", async () => {
  const log = join(dir, "rename.log");
  setFake({ FAKE_ONA_LOG: log });
  await cli.rename("env-0001", "new-name");
  assert.equal(readFileSync(log, "utf8"), "environment update env-0001 --name new-name\n");
});

test("a CLI failure becomes a readable error", async () => {
  setFake({ FAKE_ONA_FAIL: "failed to authenticate: context deadline exceeded" });
  await assert.rejects(cli.listEnvironments(), /ona environment list failed: .*context deadline exceeded/);
});

test("getEnvironment finds an archived box that the list leaves out", async () => {
  setFake({ FAKE_ONA_GET: fixture("archived-environment.json") });
  assert.equal(await cli.findEnvironment("env-5aaa"), null);
  const env = await cli.getEnvironment("env-5aaa");
  assert.equal(env.id, "env-5aaa");
  assert.equal(isArchived(env), true);
  assert.equal(isArchived((await cli.listEnvironments())[0]!), false);
});

test("getEnvironment rejects when Ona doesn't know the box", async () => {
  setFake({});
  await assert.rejects(cli.getEnvironment("env-0000"), /ona environment get failed: .*not found/);
});

test("getEnvironmentIfExists returns the box by id, including one the list leaves out", async () => {
  const log = join(dir, "get.log");
  setFake({ FAKE_ONA_GET: fixture("archived-environment.json"), FAKE_ONA_LOG: log });
  assert.equal((await cli.getEnvironmentIfExists("env-5aaa"))?.id, "env-5aaa");
  assert.equal(readFileSync(log, "utf8"), "environment get env-5aaa -o json\n");
});

test("getEnvironmentIfExists returns null only when Ona says the box doesn't exist", async () => {
  setFake({});
  assert.equal(await cli.getEnvironmentIfExists("env-0000"), null, "unknown uuid");
  assert.equal(await cli.getEnvironmentIfExists("not-an-id"), null, "ref that matches nothing");
});

test("getEnvironmentIfExists rethrows any other failure: unknown is not gone", async () => {
  for (const message of [
    "failed to authenticate: context deadline exceeded",
    "unavailable: connection refused",
    "Error: 404 Not Found",
    "Error: config file not found",
  ]) {
    setFake({ FAKE_ONA_FAIL: message });
    await assert.rejects(cli.getEnvironmentIfExists("env-0001"), /ona environment get failed/, message);
  }
});

test("isDeleted is true for a box Ona deleted or is deleting, so remove doesn't delete it again", () => {
  const env = (phase: string): OnaEnvironment => ({ id: "env-0001", metadata: {}, status: { phase } });
  assert.equal(isDeleted(env("ENVIRONMENT_PHASE_DELETED")), true);
  assert.equal(isDeleted(env("ENVIRONMENT_PHASE_DELETING")), true);
  assert.equal(isDeleted(env("ENVIRONMENT_PHASE_STOPPED")), false);
  assert.equal(isDeleted(env("ENVIRONMENT_PHASE_RUNNING")), false);
});

function exited(child: ReturnType<OnaCli["keepAlive"]>): Promise<string> {
  return new Promise((resolve) => child.onExit(resolve));
}

test("keepAlive runs ona environment keep-alive on a sleep of the duration, values as separate argv", async () => {
  const log = join(dir, "keep-alive.log");
  setFake({ FAKE_ONA_LOG: log });
  const detail = await exited(cli.keepAlive("env-0001", 1_000));
  assert.equal(readFileSync(log, "utf8"), "environment keep-alive --environment-id env-0001 -q -- sleep 1\n");
  assert.equal(detail, "exit code 0");
});

test("keepAlive's kill ends the child", async () => {
  setFake({});
  const started = Date.now();
  const child = cli.keepAlive("env-0001", 600_000);
  child.kill();
  assert.match(await exited(child), /killed by SIGTERM/);
  assert.ok(Date.now() - started < 5_000);
});

test("keepAlive reports the CLI's error when it fails", async () => {
  setFake({ FAKE_ONA_FAIL: "environment is not running" });
  assert.equal(await exited(cli.keepAlive("env-0001", 60_000)), "environment is not running");
});
