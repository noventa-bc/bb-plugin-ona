import assert from "node:assert/strict";
import { test } from "node:test";
import { machinesToSuspend } from "../src/lifecycle.ts";
import type { OnaEnvironment } from "../src/ona.ts";

const env = (id: string, phase: string): OnaEnvironment => ({ id, metadata: {}, status: { phase } });

test("an active machine whose environment Ona stopped is suspended", () => {
  const hosts = machinesToSuspend(
    [{ hostId: "h1", envId: "e1", phase: "active", status: "disconnected" }],
    [env("e1", "ENVIRONMENT_PHASE_STOPPED")],
  );
  assert.deepEqual(hosts, ["h1"]);
});

test("connected, already suspended, running or stopping machines are left alone", () => {
  const hosts = machinesToSuspend(
    [
      { hostId: "connected", envId: "e1", phase: "active", status: "connected" },
      { hostId: "suspended", envId: "e1", phase: "suspended", status: "disconnected" },
      { hostId: "running", envId: "e2", phase: "active", status: "disconnected" },
      { hostId: "stopping", envId: "e3", phase: "active", status: "disconnected" },
    ],
    [env("e1", "ENVIRONMENT_PHASE_STOPPED"), env("e2", "ENVIRONMENT_PHASE_RUNNING"), env("e3", "ENVIRONMENT_PHASE_STOPPING")],
  );
  assert.deepEqual(hosts, []);
});

test("deleted or unknown environments are not suspended", () => {
  const hosts = machinesToSuspend(
    [
      { hostId: "deleted", envId: "e1", phase: "active", status: "disconnected" },
      { hostId: "missing", envId: "gone", phase: "active", status: "disconnected" },
    ],
    [env("e1", "ENVIRONMENT_PHASE_DELETED")],
  );
  assert.deepEqual(hosts, []);
});
