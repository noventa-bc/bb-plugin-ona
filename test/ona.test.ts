import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, after, test } from "node:test";
import {
  isArchived,
  isDeleted,
  isRunning,
  isStarting,
  isStopped,
  OnaCli,
  readiness,
  unpushedWork,
  type OnaEnvironment,
} from "../src/ona.ts";

const fakeOna = fileURLToPath(new URL("./fake-ona.mjs", import.meta.url));
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
  // The fake rewrites this file on create/start/stop, so each test gets a fresh copy of the fixture.
  copyFileSync(fixture("environments.json"), join(dir, "environments.json"));
  process.env.FAKE_ONA_ENVIRONMENTS = join(dir, "environments.json");
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

test("isRunning, the gate for every SSH (safety rule 1), passes only RUNNING: no other phase and no missing box", () => {
  // Guards rule 1's whole test: every SSH gate is isRunning alone, so only RUNNING passes and a box the listing lacks doesn't.
  const box = (phase: string): OnaEnvironment => ({ id: "env-1", metadata: {}, status: { phase } });
  assert.equal(isRunning(box("ENVIRONMENT_PHASE_RUNNING")), true);
  for (const phase of [
    "ENVIRONMENT_PHASE_STARTING",
    "ENVIRONMENT_PHASE_STOPPING",
    "ENVIRONMENT_PHASE_STOPPED",
    "ENVIRONMENT_PHASE_DELETED",
    "ENVIRONMENT_PHASE_DELETING",
    "ENVIRONMENT_PHASE_UNSPECIFIED",
    "",
  ]) {
    assert.equal(isRunning(box(phase)), false, phase || "a blank phase");
  }
  assert.equal(isRunning({ id: "env-1", metadata: {} }), false, "no status");
  assert.equal(isRunning(undefined), false, "a box the listing doesn't have");
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
  assert.equal(readFileSync(log, "utf8"), "environment start env-0001 --timeout 1800s\n");
});

test("stop passes the expected argv", async () => {
  const log = join(dir, "stop.log");
  setFake({ FAKE_ONA_LOG: log });
  await cli.stop("env-0001");
  assert.equal(readFileSync(log, "utf8"), "environment stop env-0001 --timeout 900s\n");
});

test("rename passes the expected argv", async () => {
  const log = join(dir, "rename.log");
  setFake({ FAKE_ONA_LOG: log });
  await cli.rename("env-0001", "new-name");
  assert.equal(readFileSync(log, "utf8"), "environment update env-0001 --name new-name --timeout 120s\n");
});

test("every call passes Ona's own --timeout, matching the wrapper's", async () => {
  const log = join(dir, "timeout.log");
  setFake({ FAKE_ONA_LOG: log, FAKE_ONA_PROJECTS: fixture("projects.json") });
  await cli.listEnvironments();
  await cli.resolveProjectId("proj-0001");
  await cli.createEnvironment({ projectId: "proj-0001", name: "new-box" });
  await cli.delete("env-0001");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "environment list -o json --timeout 120s",
    "project list -o json --timeout 120s",
    "environment create proj-0001 --name new-box --timeout 1800s",
    "environment delete env-0001 --timeout 900s",
  ]);
});

test("openEditor runs ona environment open with the box id", async () => {
  const log = join(dir, "open.log");
  setFake({ FAKE_ONA_LOG: log });
  await cli.openEditor("env-0001");
  assert.match(readFileSync(log, "utf8"), /^environment open env-0001 /);
});

test("openEditor rejects with the CLI's error instead of dropping it", async () => {
  setFake({ FAKE_ONA_FAIL: "environment not found" });
  await assert.rejects(cli.openEditor("env-0000"), /ona environment open failed: environment not found/);
});

test("openEditor rejects when the CLI is missing", async () => {
  await assert.rejects(new OnaCli(join(dir, "no-such-ona")).openEditor("env-0001"), /ENOENT/);
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
  assert.equal(readFileSync(log, "utf8"), "environment get env-5aaa -o json --timeout 120s\n");
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

// Bug: connect probed SSH as soon as Ona started a box, before Ona said it or its dev container was up.
test("readiness: ready only when RUNNING with the dev container running or absent", () => {
  const env = (status: OnaEnvironment["status"]): OnaEnvironment => ({ id: "env-0001", metadata: {}, status });
  const RUNNING = "ENVIRONMENT_PHASE_RUNNING";
  const STARTING = "ENVIRONMENT_PHASE_STARTING";
  const ready = { state: "ready" };
  assert.deepEqual(readiness(env({ phase: RUNNING, devcontainer: { phase: "PHASE_RUNNING" } })), ready);
  assert.deepEqual(readiness(env({ phase: RUNNING, devcontainer: null })), ready, "a box without a dev container");
  assert.deepEqual(readiness(env({ phase: RUNNING })), ready);
  const waiting = (reason: string) => ({ state: "waiting", reason });
  assert.deepEqual(readiness(env({ phase: STARTING, devcontainer: null })), waiting("starting"));
  assert.deepEqual(readiness(env({ phase: "ENVIRONMENT_PHASE_CREATING" })), waiting("creating"));
  assert.deepEqual(readiness(env(undefined)), waiting("unknown"));
  assert.deepEqual(
    readiness(env({ phase: RUNNING, devcontainer: { phase: "PHASE_CREATING" } })),
    waiting("dev container starting"),
  );
  assert.deepEqual(readiness(env({ phase: RUNNING, devcontainer: {} })), waiting("dev container starting"));
});

// Bug: a box that failed to start was probed over SSH for 10 minutes, then failed without Ona's reason.
test("readiness: a stopped box with Ona's failure message, a string or a list, fails with its first line", () => {
  const env = (failureMessage: string | string[] | null): OnaEnvironment => ({
    id: "env-0001",
    metadata: {},
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage },
  });
  const failed = (message: string) => ({ state: "failed", message });
  assert.deepEqual(readiness(env(["image pull failed\ndetail", "second"])), failed("image pull failed"));
  assert.deepEqual(readiness(env("disk full")), failed("disk full"));
  assert.deepEqual(readiness(env([])), { state: "waiting", reason: "starting" });
  assert.deepEqual(readiness(env([""])), { state: "waiting", reason: "starting" });
  assert.deepEqual(readiness(env(null)), { state: "waiting", reason: "starting" });
});

// Bug: a failure message left from an earlier start failed a restart that was still on its way up.
test("readiness: a box still starting waits despite a failure message, which stays out of the reason", () => {
  const env = (status: OnaEnvironment["status"]): OnaEnvironment => ({ id: "env-0001", metadata: {}, status });
  const failureMessage = ["old start error"];
  assert.deepEqual(readiness(env({ phase: "ENVIRONMENT_PHASE_STARTING", failureMessage })), {
    state: "waiting",
    reason: "starting",
  });
  assert.deepEqual(
    readiness(env({ phase: "ENVIRONMENT_PHASE_RUNNING", devcontainer: { phase: "PHASE_CREATING" }, failureMessage })),
    { state: "waiting", reason: "dev container starting" },
  );
});

// Bug: a failure message left from an earlier start failed every reconnect and heal of a healthy box.
test("readiness: a running box with a running dev container is ready despite a stale failure message", () => {
  const env: OnaEnvironment = {
    id: "env-0001",
    metadata: {},
    status: {
      phase: "ENVIRONMENT_PHASE_RUNNING",
      devcontainer: { phase: "PHASE_RUNNING" },
      failureMessage: ["old start error"],
    },
  };
  assert.deepEqual(readiness(env), { state: "ready" });
});

// Bug: a box still shown STOPPED right after `ona environment start` failed the resume, with or without a
// desired phase (older Ona has none).
test("readiness: a stopped or stopping box is starting unless Ona's desired phase is something other than RUNNING", () => {
  const env = (phase: string, desiredPhase?: string): OnaEnvironment => ({
    id: "env-0001",
    metadata: {},
    status: { phase: `ENVIRONMENT_PHASE_${phase}` },
    ...(desiredPhase && { spec: { desiredPhase: `ENVIRONMENT_PHASE_${desiredPhase}` } }),
  });
  const starting = { state: "waiting", reason: "starting" };
  assert.deepEqual(readiness(env("STOPPED", "RUNNING")), starting);
  assert.deepEqual(readiness(env("STOPPING", "RUNNING")), starting);
  assert.deepEqual(readiness(env("STOPPED", "STOPPED")), { state: "failed", message: "stopped" });
  assert.deepEqual(readiness(env("STOPPING", "STOPPED")), { state: "failed", message: "stopping" });
  assert.deepEqual(readiness(env("STOPPED")), starting, "older Ona: no desired phase");
  assert.deepEqual(readiness(env("STOPPING")), starting, "older Ona: no desired phase");
  assert.deepEqual(readiness(env("DELETED")), { state: "failed", message: "deleted" });
  assert.deepEqual(readiness(env("DELETED", "RUNNING")), { state: "failed", message: "deleted" });
  assert.deepEqual(readiness(env("DELETING", "RUNNING")), { state: "failed", message: "deleting" });
});

// Bug: a resume after a failed start failed at once on the earlier start's message while Ona brought the box up.
// Bug: the wait's reason was "starting", so a 15-minute timeout lost Ona's failure.
test("readiness: a stopped box Ona is asked to run waits, with its failure message as the reason", () => {
  const env: OnaEnvironment = {
    id: "env-0001",
    metadata: {},
    spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" },
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] },
  };
  assert.deepEqual(readiness(env), { state: "waiting", reason: "no capacity" });
});

// Bug: a failure message whose first line was blank gave an empty reason.
test("readiness: a failure message's first non-blank line is used, trimmed", () => {
  const env: OnaEnvironment = {
    id: "env-0001",
    metadata: {},
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["", "\n  no capacity  \nmore"] },
  };
  assert.deepEqual(readiness(env), { state: "failed", message: "no capacity" });
});

// Bug: a failed dev container waited the full 15 minutes as "dev container starting".
test("readiness: a failed dev container fails at once; any other phase short of running waits", () => {
  const env = (phase: string): OnaEnvironment => ({
    id: "env-0001",
    metadata: {},
    status: { phase: "ENVIRONMENT_PHASE_RUNNING", devcontainer: { phase } },
  });
  assert.deepEqual(readiness(env("PHASE_FAILED")), { state: "failed", message: "dev container failed" });
  assert.deepEqual(readiness(env("PHASE_CREATING")), { state: "waiting", reason: "dev container starting" });
});

// Bug: a running box Ona was stopping counted as ready, and an SSH retry could wake it once it stopped (rule 1).
test("readiness: a running box Ona means to stop fails; without a desired phase it is ready", () => {
  const env = (desiredPhase?: string): OnaEnvironment => ({
    id: "env-0001",
    metadata: {},
    ...(desiredPhase && { spec: { desiredPhase } }),
    status: { phase: "ENVIRONMENT_PHASE_RUNNING" },
  });
  assert.deepEqual(readiness(env("ENVIRONMENT_PHASE_STOPPED")), {
    state: "failed",
    message: "Ona is stopping the box",
  });
  assert.deepEqual(readiness(env("ENVIRONMENT_PHASE_RUNNING")), { state: "ready" });
  assert.deepEqual(readiness(env()), { state: "ready" });
});

// Bug: a schema that rejects the live shape (an array, nulls, a warning string) makes every `get` unknown.
test("getEnvironment parses the readiness fields of a live get: one box in an array, nulls, a warning string", async () => {
  setFake({ FAKE_ONA_GET: fixture("ready-environment.json") });
  const env = await cli.getEnvironment("env-6bbb");
  assert.equal(env.status?.devcontainer?.phase, "PHASE_RUNNING");
  assert.deepEqual(readiness(env), { state: "ready" });
});

// Bug: one null in a readiness field failed the whole listing, so every box read as unknown.
test("listEnvironments parses a box with a null spec and a null dev container phase", async () => {
  setFake({});
  const file = join(dir, "nulls.json");
  const nulls = {
    id: "env-0001",
    metadata: {},
    spec: null,
    status: { phase: "ENVIRONMENT_PHASE_STARTING", devcontainer: { phase: null } },
  };
  writeFileSync(file, JSON.stringify([nulls]));
  process.env.FAKE_ONA_ENVIRONMENTS = file;
  const [env] = await cli.listEnvironments();
  assert.deepEqual(readiness(env!), { state: "waiting", reason: "starting" });
});

test("unpushedWork reports unpushed commits so remove keeps the box", async () => {
  setFake({ FAKE_ONA_GET: fixture("unpushed-environment.json") });
  assert.deepEqual(unpushedWork(await cli.getEnvironment("env-6bbb")), { branch: "feature-x", count: 3 });
});

test("unpushedWork is null for zero commits and when Ona doesn't say", async () => {
  type Git = NonNullable<NonNullable<NonNullable<OnaEnvironment["status"]>["content"]>["git"]>;
  const env = (git?: Git): OnaEnvironment => ({ id: "env-0001", metadata: {}, status: { content: { git } } });
  assert.equal(unpushedWork(env({ branch: "main", totalUnpushedCommits: 0 })), null, "zero");
  assert.equal(unpushedWork(env({ branch: "main" })), null, "no count");
  assert.equal(unpushedWork(env()), null, "no git content");
  setFake({});
  assert.equal(unpushedWork((await cli.listEnvironments())[0]!), null, "no content at all");
  assert.deepEqual(unpushedWork(env({ totalUnpushedCommits: "2" })), { count: 2 }, "count as a string, no branch");
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
