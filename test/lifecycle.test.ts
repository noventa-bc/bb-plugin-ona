import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lifecycleRefusal,
  machinesToRelease,
  parseDuration,
  RESUMED,
  SUSPENDED,
  type MachineActivity,
} from "../src/lifecycle.ts";

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

test("a lifecycle request bb didn't take is reported with bb's reason", () => {
  assert.equal(lifecycleRefusal({ phase: "suspending", message: null }, SUSPENDED), null);
  assert.equal(lifecycleRefusal({ phase: "suspended", message: null }, SUSPENDED), null);
  assert.equal(lifecycleRefusal({ phase: "resuming", message: null }, RESUMED), null);
  assert.equal(lifecycleRefusal(undefined, SUSPENDED), null);
  assert.equal(
    lifecycleRefusal({ phase: "active", message: "Automatic cleanup is blocked" }, SUSPENDED),
    "bb kept the machine active: Automatic cleanup is blocked",
  );
  assert.equal(lifecycleRefusal({ phase: "suspended", message: null }, RESUMED), "bb kept the machine suspended");
});
