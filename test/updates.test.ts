import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../src/sync.ts";
import {
  createUpdateClis,
  hostIsBusy,
  parseProviderList,
  STUCK_THREAD_MS,
  stuckThreads,
  threadStatuses,
  updatesToApply,
  type CliStatus,
  type ThreadState,
  type UpdatesBb,
} from "../src/updates.ts";

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
    status?: string;
    threads?: ThreadState[];
    /** Listed only when asked for hidden threads, like bb's workflow workers and side chats. */
    hiddenThreads?: ThreadState[];
    codex?: Partial<CliStatus>;
  }>,
  install: Record<string, InstallEvents> = {},
) {
  const installs: string[] = [];
  const rows = boxes.map(
    (box) =>
      ({
        hostId: box.hostId,
        machine: `m-${box.hostId}`,
        status: box.status ?? "connected",
        resource: { envId: `env-${box.hostId}`, envName: `box-${box.hostId}` },
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
            return install[hostId] ?? [{ type: "completed", provider, exitCode: 0, signal: null, success: true }];
          },
        },
      },
    },
    machines: async () => rows,
    autoUpdateProviders: "codex",
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
