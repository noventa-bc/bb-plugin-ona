import assert from "node:assert/strict";
import { test } from "node:test";
import { machinesToRelease, machinesToSuspend, parseDuration, type MachineActivity } from "../src/lifecycle.ts";
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

const MIN = 60_000;
const NOW = 1_000 * MIN;
const machine = (hostId: string, overrides: Partial<MachineActivity> = {}): MachineActivity => ({
  hostId,
  phase: "active",
  threadStatuses: [],
  lastActivityAt: NOW - 60 * MIN,
  ...overrides,
});

test("a machine idle for the window is released", () => {
  assert.deepEqual(machinesToRelease([machine("idle")], NOW, 30 * MIN), ["idle"]);
});

test("busy, recently active, recently connected or non-active machines are kept", () => {
  const hosts = machinesToRelease(
    [
      machine("busy", { threadStatuses: ["idle", "active"] }),
      machine("recent", { lastActivityAt: NOW - 5 * MIN }),
      machine("suspended", { phase: "suspended" }),
      machine("resuming", { phase: "resuming" }),
    ],
    NOW,
    30 * MIN,
  );
  assert.deepEqual(hosts, []);
});

test("a zero window releases nothing", () => {
  assert.deepEqual(machinesToRelease([machine("idle")], NOW, 0), []);
});

test("parseDuration reads s/m/h and bare minutes, and treats junk as off", () => {
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("30m"), 30 * MIN);
  assert.equal(parseDuration("2h"), 120 * MIN);
  assert.equal(parseDuration("1.5h"), 90 * MIN);
  assert.equal(parseDuration("15"), 15 * MIN);
  assert.equal(parseDuration(""), 0);
  assert.equal(parseDuration("0"), 0);
  assert.equal(parseDuration("soon"), 0);
});
