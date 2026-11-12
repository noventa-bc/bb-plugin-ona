import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, after, test } from "node:test";
import {
  boxFacts,
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
  // The fake rewrites this file and its id counter, so each test starts from a fresh fixture and no counter.
  copyFileSync(fixture("environments.json"), join(dir, "environments.json"));
  rmSync(join(dir, "environments.json.next"), { force: true });
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

// Each ref and the id it must find (null for none). A miss must be null itself: `?.id ?? null` would pass an undefined.
const FIND_CASES: [string, string, string | null][] = [
  ["findEnvironment matches an exact name", "swift-lynx", "env-9abc"],
  ["findEnvironment matches a unique id prefix", "env-9ab", "env-9abc"],
  ["findEnvironment returns null for an ambiguous id prefix", "env-000", null],
  ["findEnvironment returns null for an unknown ref", "no-such-box", null],
];
for (const [title, ref, id] of FIND_CASES) {
  test(title, async () => {
    setFake({});
    const found = await cli.findEnvironment(ref);
    assert.equal(found === null ? null : found.id, id);
  });
}

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

test("a box created after a delete gets a new id", async () => {
  setFake({});
  await cli.createEnvironment({ projectId: "proj-0001", name: "first" });
  const first = (await cli.findEnvironment("first"))!.id;
  await cli.delete(first);
  await cli.createEnvironment({ projectId: "proj-0001", name: "second" });
  assert.notEqual((await cli.findEnvironment("second"))!.id, first);
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
  // Right after the plugin's start, a stopped box with no failure is still on its way.
  assert.deepEqual(readiness(env([]), true), { state: "waiting", reason: "starting" });
  assert.deepEqual(readiness(env([""]), true), { state: "waiting", reason: "starting" });
  assert.deepEqual(readiness(env(null), true), { state: "waiting", reason: "starting" });
});

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

/** A box in `phase` with `desiredPhase` (none when omitted), both without the ENVIRONMENT_PHASE_ prefix. */
const phased = (phase: string, desiredPhase?: string): OnaEnvironment => ({
  id: "env-0001",
  metadata: {},
  ...(desiredPhase && { spec: { desiredPhase: `ENVIRONMENT_PHASE_${desiredPhase}` } }),
  status: { phase: `ENVIRONMENT_PHASE_${phase}` },
});

// Ona can still show STOPPED right after `ona environment start`, older Ona sends no desired phase, and a box Ona's
// inactivity timeout stopped keeps desired phase RUNNING: only "right after the plugin's start" tells them apart.
test("readiness: a stopped or stopping box waits only when the plugin started it and Ona's desired phase isn't stopped; deleted or deleting always fails", () => {
  const starting = { state: "waiting", reason: "starting" };
  const failed = (message: string) => ({ state: "failed", message });
  const cases: [string, OnaEnvironment, boolean, object][] = [
    ["stopped, desired RUNNING, just started", phased("STOPPED", "RUNNING"), true, starting],
    [
      "stopping, desired RUNNING, just started",
      phased("STOPPING", "RUNNING"),
      true,
      { state: "waiting", reason: "stopping" },
    ],
    ["stopped, desired RUNNING, not started (idle stop)", phased("STOPPED", "RUNNING"), false, failed("stopped")],
    ["stopping, desired RUNNING, not started", phased("STOPPING", "RUNNING"), false, failed("stopping")],
    ["stopped, desired STOPPED", phased("STOPPED", "STOPPED"), true, failed("stopped")],
    ["stopping, desired STOPPED", phased("STOPPING", "STOPPED"), true, failed("stopping")],
    ["stopped, older Ona, just started", phased("STOPPED"), true, starting],
    ["stopping, older Ona, just started", phased("STOPPING"), true, { state: "waiting", reason: "stopping" }],
    ["stopped, desired UNSPECIFIED, just started", phased("STOPPED", "UNSPECIFIED"), true, starting],
    ["deleted", phased("DELETED"), true, failed("deleted")],
    ["deleted, desired RUNNING", phased("DELETED", "RUNNING"), true, failed("deleted")],
    ["deleting, desired RUNNING", phased("DELETING", "RUNNING"), true, failed("deleting")],
  ];
  for (const [name, env, started, expected] of cases) assert.deepEqual(readiness(env, started), expected, name);
});

// An SSH retry could wake the box once Ona stops it (rule 1); the proto default must not read as a stop.
test("readiness: a running box fails when its desired phase is stopped or deleted", () => {
  const stopping = { state: "failed", message: "Ona is stopping or deleting the box" };
  const cases: [string, OnaEnvironment, object][] = [
    ["desired STOPPED", phased("RUNNING", "STOPPED"), stopping],
    ["desired DELETED", phased("RUNNING", "DELETED"), stopping],
    ["desired RUNNING", phased("RUNNING", "RUNNING"), { state: "ready" }],
    ["desired UNSPECIFIED", phased("RUNNING", "UNSPECIFIED"), { state: "ready" }],
    ["no desired phase", phased("RUNNING"), { state: "ready" }],
  ];
  for (const [name, env, expected] of cases) assert.deepEqual(readiness(env), expected, name);
});

// The failure is left from an earlier start; as the reason, it reaches the 15-minute timeout's error.
test("readiness: a stopped box whose desired phase is RUNNING waits, with its failure message as the reason", () => {
  const env: OnaEnvironment = {
    id: "env-0001",
    metadata: {},
    spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" },
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["no capacity"] },
  };
  assert.deepEqual(readiness(env, true), { state: "waiting", reason: "no capacity" });
});

test("readiness: a failure message's first non-blank line is used, trimmed", () => {
  const env: OnaEnvironment = {
    id: "env-0001",
    metadata: {},
    status: { phase: "ENVIRONMENT_PHASE_STOPPED", failureMessage: ["", "\n  no capacity  \nmore"] },
  };
  assert.deepEqual(readiness(env), { state: "failed", message: "no capacity" });
});

// A failed dev container can't recover on its own.
test("readiness: a failed dev container fails at once; any other phase short of running waits", () => {
  const env = (phase: string): OnaEnvironment => ({
    id: "env-0001",
    metadata: {},
    status: { phase: "ENVIRONMENT_PHASE_RUNNING", devcontainer: { phase } },
  });
  assert.deepEqual(readiness(env("PHASE_FAILED")), { state: "failed", message: "dev container failed" });
  assert.deepEqual(readiness(env("PHASE_CREATING")), { state: "waiting", reason: "dev container starting" });
});

test("readiness: a failed dev container fails a starting box too, but not a stopped one whose status may predate the start", () => {
  const env = (phase: string): OnaEnvironment => ({
    id: "env-0001",
    metadata: {},
    spec: { desiredPhase: "ENVIRONMENT_PHASE_RUNNING" },
    status: { phase: `ENVIRONMENT_PHASE_${phase}`, devcontainer: { phase: "PHASE_FAILED" } },
  });
  assert.deepEqual(readiness(env("STARTING")), { state: "failed", message: "dev container failed" });
  assert.deepEqual(readiness(env("STOPPED"), true), { state: "waiting", reason: "starting" });
});

// A schema that rejects the live shape makes every `get` unknown.
test("getEnvironment parses the readiness fields of a live get: one box in an array, nulls", async () => {
  setFake({ FAKE_ONA_GET: fixture("ready-environment.json") });
  const env = await cli.getEnvironment("env-6bbb");
  assert.equal(env.status?.devcontainer?.phase, "PHASE_RUNNING");
  assert.deepEqual(readiness(env), { state: "ready" });
});

// One null must not fail the whole listing, which would make every box unknown.
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

// One odd type from Ona must not fail the whole listing either.
test("listEnvironments parses a box whose readiness fields have odd types, and that box waits", async () => {
  setFake({});
  const file = join(dir, "odd.json");
  const odd = {
    id: "env-0001",
    metadata: {},
    spec: { desiredPhase: 7 },
    status: { phase: "ENVIRONMENT_PHASE_STARTING", devcontainer: { phase: 5 }, failureMessage: 42 },
  };
  writeFileSync(file, JSON.stringify([odd]));
  process.env.FAKE_ONA_ENVIRONMENTS = file;
  const [env] = await cli.listEnvironments();
  assert.deepEqual(readiness(env!), { state: "waiting", reason: "starting" });
});

type Git = NonNullable<NonNullable<NonNullable<OnaEnvironment["status"]>["content"]>["git"]>;
const boxWithGit = (git?: Git): OnaEnvironment => ({ id: "env-0001", metadata: {}, status: { content: { git } } });

test("unpushedWork reports unpushed commits and uncommitted files so remove keeps the box", async () => {
  setFake({ FAKE_ONA_GET: fixture("unpushed-environment.json") });
  assert.deepEqual(unpushedWork(await cli.getEnvironment("env-6bbb")), { branch: "feature-x", count: 3, files: 1 });
});

// Bug: on main, a box with uncommitted files and no unpushed commits was deleted with its files.
test("a box with uncommitted files and no unpushed commits is kept, with the files count as a string too", () => {
  const kept = { count: 0, files: 1 };
  assert.deepEqual(unpushedWork(boxWithGit({ totalUnpushedCommits: 0, totalChangedFiles: 1 })), kept);
  assert.deepEqual(unpushedWork(boxWithGit({ totalUnpushedCommits: 0, totalChangedFiles: "1" })), kept);
});

test("unpushedWork is null for zero commits and files, and when Ona doesn't say", async () => {
  assert.equal(unpushedWork(boxWithGit({ branch: "main", totalUnpushedCommits: 0 })), null, "zero");
  assert.equal(unpushedWork(boxWithGit({ totalUnpushedCommits: 0, totalChangedFiles: 0 })), null, "zero files");
  assert.equal(unpushedWork(boxWithGit({ branch: "main" })), null, "no count");
  assert.equal(unpushedWork(boxWithGit()), null, "no git content");
  setFake({});
  assert.equal(unpushedWork((await cli.listEnvironments())[0]!), null, "no content at all");
  assert.deepEqual(unpushedWork(boxWithGit({ totalUnpushedCommits: "2" })), { count: 2, files: 0 }, "a string count");
});

// One odd count from Ona must not fail the whole listing: the count reads as absent.
test("listEnvironments reads an odd uncommitted-files count as absent", async () => {
  const file = join(dir, "odd-files.json");
  const odd = { id: "env-0001", metadata: {}, status: { content: { git: { totalChangedFiles: null } } } };
  writeFileSync(file, JSON.stringify([odd]));
  process.env.FAKE_ONA_ENVIRONMENTS = file;
  const [env] = await cli.listEnvironments();
  assert.equal(unpushedWork(env!), null);
});

// What `bb ona status` shows about a box: every fact from one live get.
test("boxFacts reads the start time, timeout, activity signal, branch and unpushed count of a live get", async () => {
  setFake({ FAKE_ONA_GET: fixture("facts-environment.json") });
  assert.deepEqual(boxFacts(await cli.getEnvironment("env-4ccc")), {
    startedAt: Date.parse("2026-11-03T09:12:40.512306Z"),
    idleTimeoutMs: 3 * 3_600_000,
    activity: { source: "SSH connections", at: Date.parse("2026-11-03T11:02:15Z") },
    branch: "feature-y",
    unpushed: 2,
  });
});

// An odd start, timeout or activity signal must not fail the listing: that box shows the fact as absent.
test("listEnvironments parses a box whose activity signal, start time and timeout have odd types", async () => {
  const file = join(dir, "odd-facts.json");
  const odd = {
    id: "env-0001",
    metadata: { lastStartedAt: 42 },
    spec: { timeout: "3h" },
    status: { phase: "ENVIRONMENT_PHASE_RUNNING", activitySignal: "SSH connections" },
  };
  writeFileSync(file, JSON.stringify([odd]));
  process.env.FAKE_ONA_ENVIRONMENTS = file;
  const [env] = await cli.listEnvironments();
  assert.deepEqual(boxFacts(env!), {
    startedAt: null,
    idleTimeoutMs: null,
    activity: null,
    branch: null,
    unpushed: 0,
  });
});

test("boxFacts: an odd start, timeout or activity reads as null, and a count that is not a safe whole number reads as 0", () => {
  const nothing = { startedAt: null, idleTimeoutMs: null, activity: null, branch: null, unpushed: 0 };
  const env = (extra: Partial<OnaEnvironment>): OnaEnvironment => ({ id: "env-0001", metadata: {}, ...extra });
  assert.deepEqual(boxFacts(env({})), nothing, "nothing given");
  for (const disconnected of ["3h", "1h30s", "10800", "9999999999999s"]) {
    assert.equal(boxFacts(env({ spec: { timeout: { disconnected } } })).idleTimeoutMs, null, disconnected);
  }
  for (const lastStartedAt of [
    "yesterday",
    "42",
    "2026-11-03T09:12:40",
    "2026-13-01T00:00:00Z",
    "0001-01-01T00:00:00Z",
    "1970-01-01T00:00:00Z",
  ]) {
    assert.equal(boxFacts(env({ metadata: { lastStartedAt } })).startedAt, null, lastStartedAt);
  }
  for (const timestamp of ["soon", "42", "2026-11-03T11:02:15"]) {
    const activitySignal = { source: "SSH connections", timestamp };
    assert.equal(boxFacts(env({ status: { activitySignal } })).activity, null, timestamp);
  }
  assert.equal(
    boxFacts(env({ status: { activitySignal: { timestamp: "2026-11-03T11:02:15Z" } } })).activity,
    null,
    "an activity with no source",
  );
  for (const git of [{ totalUnpushedCommits: -1 }, { totalUnpushedCommits: -1, totalChangedFiles: 1 }]) {
    assert.equal(boxFacts(env({ status: { content: { git } } })).unpushed, 0, JSON.stringify(git));
  }
  for (const totalUnpushedCommits of ["Infinity", 2.5, "9007199254740993"]) {
    const git = { totalUnpushedCommits };
    assert.equal(boxFacts(env({ status: { content: { git } } })).unpushed, 0, String(totalUnpushedCommits));
  }
  const uncommitted = boxFacts(env({ status: { content: { git: { totalChangedFiles: 1 } } } }));
  assert.equal(uncommitted.unpushed, 0, "uncommitted files are not unpushed commits");
  assert.deepEqual(
    boxFacts(env({ status: { content: { git: { branch: "main" } } } })),
    { ...nothing, branch: "main" },
    "a branch with no unpushed count",
  );
  assert.equal(
    boxFacts(env({ spec: { timeout: { disconnected: "0s" } } })).idleTimeoutMs,
    0,
    "0s is kept: auto-stop is off",
  );
});
