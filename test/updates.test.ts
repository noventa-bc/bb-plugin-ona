import assert from "node:assert/strict";
import { test } from "node:test";
import { settle, tick, useFakeClock } from "./fake-clock.ts";
import { GIVE_UP_AFTER, HostGuard, type HostRecord } from "../src/reconcile.ts";
import { rowForRef, type Row } from "../src/sync.ts";
import {
  BB_INSTALL_LIMIT_MS,
  createUpdateClis,
  hostIsBusy,
  INSTALL_POLL_MS,
  parseProviderList,
  STUCK_THREAD_MS,
  stuckThreads,
  threadStatuses,
  updatesToApply,
  type CliStatus,
  type ThreadState,
  type UpdatesBb,
} from "../src/updates.ts";

// The wait for an install the SDK gave up on polls on setTimeout and Date.
useFakeClock();

const status = (overrides: Partial<CliStatus>): CliStatus => ({
  installed: true,
  needsUpdate: false,
  installAction: null,
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  ...overrides,
});

test("only installed CLIs with a pending update are updated", () => {
  const statuses = {
    codex: status({ needsUpdate: true, installAction: { kind: "update" } }),
    "claude-code": status({}),
    pi: status({ installed: false, needsUpdate: true, installAction: { kind: "install" } }),
  };
  assert.deepEqual(updatesToApply(statuses, ["claude-code", "codex", "pi"]), ["codex"]);
});

test("a host with an agent turn in flight is busy", () => {
  assert.equal(hostIsBusy(["idle", "error"]), false);
  assert.equal(hostIsBusy(["idle", "active"]), true);
  assert.equal(hostIsBusy(threadStatuses([{ status: "idle", queuedWork: "waiting" }, { status: "idle" }])), true);
});

// Bug: the owner couldn't see why a box was never released.
test("stuckThreads flags busy threads with no update for over 6h", () => {
  const now = 100 * STUCK_THREAD_MS;
  const old = now - STUCK_THREAD_MS - 1;
  const threads = [
    { id: "stuck", status: "active", updatedAt: old },
    { id: "queued", status: "idle", queuedWork: "waiting", updatedAt: old },
    { id: "recent", status: "active", updatedAt: now - 1 },
    { id: "idle", status: "idle", updatedAt: old },
  ];
  assert.deepEqual(
    stuckThreads(threads, now).map((thread) => `${thread.id} ${thread.status}`),
    ["stuck active", "queued pending"],
  );
});

test("provider lists accept commas and spaces", () => {
  assert.deepEqual(parseProviderList(" claude-code, codex  codex "), ["claude-code", "codex"]);
});

type InstallEvents = Awaited<ReturnType<UpdatesBb["sdk"]["hosts"]["installProviderCli"]>>;

/** One machine per entry; installs answer with `install[hostId]`. */
function updater(
  boxes: Array<{
    hostId: string;
    /** The Ona env name; defaults to `box-<hostId>`. */
    envName?: string;
    status?: string;
    threads?: ThreadState[];
    /** Listed only when asked for hidden threads, like bb's workflow workers and side chats. */
    hiddenThreads?: ThreadState[];
    codex?: Partial<CliStatus>;
    /** Runs inside the install, while the update holds the box. */
    duringInstall?: () => Promise<void>;
  }>,
  install: Record<string, InstallEvents> = {},
  guard = new HostGuard(),
) {
  const installs: string[] = [];
  const rows = boxes.map(
    (box) =>
      ({
        hostId: box.hostId,
        machine: `m-${box.hostId}`,
        status: box.status ?? "connected",
        resource: { envId: `env-${box.hostId}`, envName: box.envName ?? `box-${box.hostId}` },
      }) as Row,
  );
  const byHost = new Map(boxes.map((box) => [box.hostId, box]));
  const updateClis = createUpdateClis({
    bb: {
      sdk: {
        threads: {
          // Like bb: hidden threads only when asked, archived ones dropped when asked.
          list: async ({ hostId, includeHidden, archived }) =>
            [
              ...(byHost.get(hostId)!.threads ?? []),
              ...(includeHidden ? (byHost.get(hostId)!.hiddenThreads ?? []) : []),
            ].filter((thread) => archived !== false || thread.archivedAt == null),
        },
        hosts: {
          providerCliStatus: async ({ hostId }) => ({ codex: status(byHost.get(hostId)!.codex ?? {}) }),
          installProviderCli: async ({ hostId, provider }) => {
            installs.push(`${hostId} ${provider}`);
            await byHost.get(hostId)!.duringInstall?.();
            return install[hostId] ?? [{ type: "completed", provider, exitCode: 0, signal: null, success: true }];
          },
        },
      },
    },
    machines: async () => rows,
    autoUpdateProviders: "codex",
    rowForRef,
    guard,
    signal: new AbortController().signal,
  });
  return { updateClis, installs };
}

const pending: Partial<CliStatus> = {
  needsUpdate: true,
  installAction: { kind: "update" },
  latestVersion: "2.0.0",
};

test("updateClis reports one line per box, one outcome each", async () => {
  const { updateClis, installs } = updater(
    [
      { hostId: "off", status: "disconnected", codex: pending },
      { hostId: "busy", threads: [{ status: "idle" }, { status: "active" }], codex: pending },
      // Bug: bb lists hidden threads only when asked, so a workflow worker's CLI was swapped mid-turn.
      { hostId: "hidden", hiddenThreads: [{ status: "active" }], codex: pending },
      // Bug: a thread bb left "active" after archiving blocked the update forever.
      { hostId: "stale", threads: [{ status: "active", archivedAt: 1 }], codex: pending },
      { hostId: "current" },
      { hostId: "updated", codex: pending },
      { hostId: "failed", codex: pending },
      { hostId: "exited", codex: pending },
    ],
    {
      failed: [{ type: "error", provider: "codex", message: "npm said no" }],
      exited: [{ type: "completed", provider: "codex", exitCode: 3, signal: null, success: false }],
    },
  );
  assert.deepEqual(await updateClis(), [
    "box-off: skipped (disconnected)",
    "box-busy: skipped (an agent is running; retry with --force)",
    "box-hidden: skipped (an agent is running; retry with --force)",
    "box-stale: codex 1.0.0 -> 2.0.0",
    "box-current: up to date (codex 1.0.0)",
    "box-updated: codex 1.0.0 -> 2.0.0",
    "box-failed: codex update failed (npm said no)",
    "box-exited: codex update failed (exit 3)",
  ]);
  assert.deepEqual(installs, ["stale codex", "updated codex", "failed codex", "exited codex"]);
});

test("updateClis with force updates a busy box; a ref picks one box or none", async () => {
  const { updateClis, installs } = updater([
    { hostId: "busy", threads: [{ status: "active" }], codex: pending },
    { hostId: "other", codex: pending },
  ]);
  // A ref is a bb host id, bb machine name, Ona env id or Ona env name.
  for (const ref of ["busy", "m-busy", "env-busy", "box-busy"]) {
    assert.deepEqual(await updateClis({ ref, force: true }), ["box-busy: codex 1.0.0 -> 2.0.0"], ref);
  }
  assert.deepEqual(installs, Array(4).fill("busy codex"));
  assert.deepEqual(await updateClis({ ref: "nope" }), ["No matching Ona devboxes."]);
});

// Bug: `update <ref>` updated every box a shared env name matched, not the one box the ref picks.
test("update with a ref two boxes share is refused and touches neither", async () => {
  const { updateClis, installs } = updater([
    { hostId: "one", envName: "shared", codex: pending },
    { hostId: "two", envName: "shared", codex: pending },
  ]);
  await assert.rejects(updateClis({ ref: "shared", force: true }), /"shared" matches 2 devboxes/);
  assert.deepEqual(installs, []);
});

/** A record of past failures on a box, quiet until `quietUntil`. */
const failing = (failures: number, quietUntil: number): HostRecord => ({
  action: "heal-daemon",
  reason: "daemon down",
  at: 0,
  error: "ssh failed",
  failures,
  quietUntil,
});

// Bug: an update ran while a repair held the box.
test("updateClis skips a box another action holds and names it (fails if the update bypasses the guard)", async () => {
  const guard = new HostGuard();
  const { updateClis, installs } = updater(
    [
      { hostId: "held", codex: pending },
      { hostId: "free", codex: pending },
    ],
    {},
    guard,
  );
  let lines: string[] = [];
  let forced: string[] = [];
  await guard.run("held", "reconnect", "by hand", async () => {
    lines = await updateClis();
    forced = await updateClis({ ref: "held", force: true });
  });
  assert.deepEqual(lines, ["box-held: skipped (reconnect in progress)", "box-free: codex 1.0.0 -> 2.0.0"]);
  assert.deepEqual(forced, ["box-held: skipped (reconnect in progress)"], "--force skips only the busy-agent check");
  assert.deepEqual(installs, ["free codex"]);
});

test("another action is refused while an update holds the box, and allowed after it ends or throws (fails if the update does not take the machine's turn)", async () => {
  const guard = new HostGuard();
  const seen: string[] = [];
  const tryOthers = async () => {
    const ran = await guard.run("box", "reconnect", "by hand", async () => {}, { force: true });
    seen.push(`${guard.busyWith("box")} mayAct=${guard.mayAct("box", true)} run=${ran}`);
  };
  const { updateClis } = updater([{ hostId: "box", codex: pending, duringInstall: tryOthers }], {}, guard);
  await updateClis();
  assert.deepEqual(seen, ["update-cli mayAct=false run=false"]);
  assert.equal(guard.mayAct("box"), true);

  const { updateClis: throwing } = updater(
    [{ hostId: "box", codex: pending, duringInstall: () => Promise.reject(new Error("daemon gone")) }],
    {},
    guard,
  );
  await assert.rejects(throwing(), /daemon gone/);
  assert.equal(guard.busyWith("box"), undefined);
  assert.equal(await guard.run("box", "reconnect", "by hand", async () => {}), true);
});

test("an update records nothing, failed or not: no cooldown, backoff or give-up for the box (fails if the update counts toward rule 5)", async () => {
  const guard = new HostGuard(2, { now: () => 1_000 });
  guard.records.set("updated", failing(2, 0));
  guard.records.set("failed", failing(2, 0));
  guard.records.set("thrown", failing(2, 0));
  const { updateClis } = updater(
    [
      { hostId: "updated", codex: pending },
      { hostId: "failed", codex: pending },
      { hostId: "fresh", codex: pending },
      { hostId: "thrown", codex: pending, duringInstall: () => Promise.reject(new Error("daemon gone")) },
    ],
    { failed: [{ type: "error", provider: "codex", message: "npm said no" }] },
    guard,
  );
  await assert.rejects(updateClis(), /daemon gone/);
  assert.deepEqual(guard.records.get("updated"), failing(2, 0), "a success resets no count");
  assert.deepEqual(guard.records.get("failed"), failing(2, 0));
  assert.deepEqual(guard.records.get("thrown"), failing(2, 0));
  assert.equal(guard.records.has("fresh"), false);
});

test("an update runs on a box in backoff or given up (fails if the update waits out another action's backoff)", async () => {
  const guard = new HostGuard(2, { now: () => 1_000 });
  guard.records.set("backoff", failing(1, 60_000));
  guard.records.set("gave-up", failing(GIVE_UP_AFTER, 0));
  const { updateClis, installs } = updater(
    [
      { hostId: "backoff", codex: pending },
      { hostId: "gave-up", codex: pending },
    ],
    {},
    guard,
  );
  assert.deepEqual(await updateClis(), ["box-backoff: codex 1.0.0 -> 2.0.0", "box-gave-up: codex 1.0.0 -> 2.0.0"]);
  assert.deepEqual(installs, ["backoff codex", "gave-up codex"]);
});

const sdkTimeout = () =>
  Promise.reject(Object.assign(new Error("BB request timed out after 75 seconds."), { name: "BbRequestTimeoutError" }));

test("an install the SDK gave up on keeps the box's turn until bb finishes it (fails if the timeout releases the box)", async () => {
  const guard = new HostGuard();
  const box = { hostId: "box", codex: pending, duringInstall: sdkTimeout };
  const { updateClis } = updater([box], {}, guard);
  const lines = updateClis();
  await tick(INSTALL_POLL_MS, 3);
  assert.equal(guard.busyWith("box"), "update-cli");
  assert.equal(await guard.run("box", "reconnect", "by hand", async () => {}, { force: true }), false);
  box.codex = {};
  await tick(INSTALL_POLL_MS);
  assert.deepEqual(await lines, ["box-box: codex 1.0.0 -> 2.0.0 (bb finished after the request timed out)"]);
  assert.equal(guard.busyWith("box"), undefined);
});

test("the wait for an install the SDK gave up on ends at bb's install limit (fails if it waits on)", async () => {
  const guard = new HostGuard();
  const { updateClis } = updater([{ hostId: "box", codex: pending, duringInstall: sdkTimeout }], {}, guard);
  const lines = updateClis();
  await tick(INSTALL_POLL_MS, BB_INSTALL_LIMIT_MS / INSTALL_POLL_MS - 1);
  assert.equal(guard.busyWith("box"), "update-cli", "still waiting just before the limit");
  await tick(INSTALL_POLL_MS);
  await settle();
  assert.equal(guard.busyWith("box"), undefined, "released at the limit");
  assert.deepEqual(await lines, ["box-box: codex update still pending after bb's 15 min install limit"]);
});
