import assert from "node:assert/strict";
import { test } from "node:test";
import { mismatch, trackMismatch, type Mismatch, type MachineView, type OnaView } from "../src/reconcile.ts";

const machine = (overrides: Partial<MachineView> = {}): MachineView => ({
  hostId: "h1",
  phase: "active",
  status: "connected",
  lastSeenAt: 0,
  tunnel: "up",
  threadWaiting: false,
  ...overrides,
});
const ona = (phase: string): OnaView => ({ kind: "env", phase: `ENVIRONMENT_PHASE_${phase}` });

test("active-stopped: bb shows the box connected while Ona has it stopped (fails if that state returns no kind)", () => {
  assert.equal(mismatch(machine({ status: "connected" }), ona("STOPPED")), "active-stopped");
  assert.equal(mismatch(machine({ status: "connected" }), ona("STOPPING")), "active-stopped");
});

test("active-gone: bb shows the box active while Ona deleted it or two good listings lack it (fails if those return no kind)", () => {
  assert.equal(mismatch(machine(), ona("DELETED")), "active-gone");
  assert.equal(mismatch(machine(), ona("DELETING")), "active-gone");
  assert.equal(mismatch(machine(), { kind: "missing", streak: 2 }), "active-gone");
  assert.equal(mismatch(machine(), { kind: "missing", streak: 2, archived: true }), "active-gone");
});

test("a box missing from one good listing is not a mismatch yet (fails if one listing is enough)", () => {
  assert.equal(mismatch(machine(), { kind: "missing", streak: 1 }), null);
});

test("suspended-running: bb shows the box suspended while Ona runs it (fails if that state returns no kind)", () => {
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), ona("RUNNING")), "suspended-running");
});

test("disconnected-running: bb shows an active box disconnected while Ona runs it, not once Ona has it stopped (fails if either returns the wrong kind)", () => {
  assert.equal(mismatch(machine({ status: "disconnected" }), ona("RUNNING")), "disconnected-running");
  assert.equal(mismatch(machine({ status: "disconnected" }), ona("STOPPED")), null, "decide() suspends that box");
});

test("an unknown Ona state is no mismatch, whatever bb shows (fails if an unknown listing returns a kind)", () => {
  const unknown: OnaView = { kind: "unknown" };
  assert.equal(mismatch(machine({ status: "connected" }), unknown), null);
  assert.equal(mismatch(machine({ status: "disconnected" }), unknown), null);
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), unknown), null);
});

test("agreeing states are no mismatch (fails if a connected box running in Ona returns a kind)", () => {
  assert.equal(mismatch(machine({ status: "connected" }), ona("RUNNING")), null);
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), ona("STOPPED")), null);
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), { kind: "missing", streak: 2 }), null);
});

test("a disagreement logs once it has held 120 s, and never before (fails if the hold is not 120 s)", () => {
  const first = trackMismatch(undefined, "active-stopped", 1_000);
  assert.deepEqual(first, { entry: { kind: "active-stopped", since: 1_000, logged: false } });
  assert.deepEqual(trackMismatch(first.entry, "active-stopped", 120_999), { entry: first.entry });
  const held = trackMismatch(first.entry, "active-stopped", 121_000);
  assert.deepEqual(held.log, { kind: "active-stopped", secs: 120 });
  assert.equal(held.entry?.logged, true);
  assert.equal(trackMismatch(held.entry, "active-stopped", 300_000).log, undefined, "once per incident");
});

test("a kind change starts a new hold, and agreement clears the entry (fails if the kind is not compared or the entry is kept)", () => {
  const prior: Mismatch = { kind: "active-stopped", since: 0, logged: true };
  assert.deepEqual(trackMismatch(prior, "active-gone", 150_000), {
    entry: { kind: "active-gone", since: 150_000, logged: false },
  });
  assert.deepEqual(trackMismatch(prior, null, 150_000), {});
});
