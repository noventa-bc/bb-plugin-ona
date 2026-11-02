import assert from "node:assert/strict";
import { test } from "node:test";
import type { Row } from "../src/sync.ts";
import {
  createUpdateClis,
  hostIsBusy,
  parseProviderList,
  threadStatuses,
  updatesToApply,
  type CliStatus,
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

test("provider lists accept commas and spaces", () => {
  assert.deepEqual(parseProviderList(" claude-code, codex  codex "), ["claude-code", "codex"]);
});

type InstallEvents = Awaited<ReturnType<UpdatesBb["sdk"]["hosts"]["installProviderCli"]>>;

/** One machine per entry; installs answer with `install[hostId]`. */
function updater(
  boxes: Array<{ hostId: string; status?: string; threads?: string[]; codex?: Partial<CliStatus> }>,
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
          list: async ({ hostId }) =>
            (byHost.get(hostId)!.threads ?? []).map((threadState) => ({ status: threadState })),
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
      { hostId: "busy", threads: ["idle", "active"], codex: pending },
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
    "box-current: up to date (codex 1.0.0)",
    "box-updated: codex 1.0.0 -> 2.0.0",
    "box-failed: codex update failed (npm said no)",
    "box-exited: codex update failed (exit 3)",
  ]);
  assert.deepEqual(installs, ["updated codex", "failed codex", "exited codex"]);
});

test("updateClis with force updates a busy box; a ref picks one box or none", async () => {
  const { updateClis, installs } = updater([
    { hostId: "busy", threads: ["active"], codex: pending },
    { hostId: "other", codex: pending },
  ]);
  // A ref is a bb host id, bb machine name, Ona env id or Ona env name.
  for (const ref of ["busy", "m-busy", "env-busy", "box-busy"]) {
    assert.deepEqual(await updateClis({ ref, force: true }), ["box-busy: codex 1.0.0 -> 2.0.0"], ref);
  }
  assert.deepEqual(installs, Array(4).fill("busy codex"));
  assert.deepEqual(await updateClis({ ref: "nope" }), ["No matching Ona devboxes."]);
});
