import assert from "node:assert/strict";
import { test } from "node:test";
import { mismatch, trackMismatch, type Mismatch, type MachineView, type OnaView } from "../src/reconcile.ts";
import { ona } from "./sync-fakes.ts";

const machine = (overrides: Partial<MachineView> = {}): MachineView => ({
  hostId: "h1",
  phase: "active",
  status: "connected",
  lastSeenAt: 0,
  tunnel: "up",
  threadWaiting: false,
  ...overrides,
});

test("active-stopped: bb shows the box connected while Ona has it stopped (fails if that state returns no kind)", () => {
  assert.equal(mismatch(machine({ status: "connected" }), ona("STOPPED")), "active-stopped");
  assert.equal(mismatch(machine({ status: "connected" }), ona("STOPPING")), "active-stopped");
});

test("active-gone: bb shows the box active while Ona deleted it, or two good listings lack it (fails if those return no kind, or one listing is enough)", () => {
  assert.equal(mismatch(machine(), ona("DELETED")), "active-gone");
  assert.equal(mismatch(machine(), ona("DELETING")), "active-gone");
  assert.equal(mismatch(machine(), { kind: "missing", streak: 2 }), "active-gone");
  assert.equal(mismatch(machine(), { kind: "missing", streak: 2, archived: true }), "active-gone");
  assert.equal(mismatch(machine(), { kind: "missing", streak: 1 }), null, "one listing is not enough");
});

test("disconnected-running: bb shows an active box disconnected while Ona runs it, not once Ona has it stopped, nor with a status of suspended (fails if any of these returns the wrong kind)", () => {
  assert.equal(mismatch(machine({ status: "disconnected" }), ona("RUNNING")), "disconnected-running");
  assert.equal(mismatch(machine({ status: "disconnected" }), ona("STOPPED")), null, "decide() suspends that box");
  assert.equal(
    mismatch(machine({ status: "suspended" }), ona("RUNNING")),
    null,
    "a suspended status is not a disconnection",
  );
});

test("a suspended machine is no mismatch, whatever Ona says: an idle release leaves a box Ona runs suspended (fails if a suspended box returns a kind)", () => {
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), ona("RUNNING")), null);
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), ona("STOPPED")), null);
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), { kind: "missing", streak: 2 }), null);
});

test("an unknown Ona state is no mismatch, whatever bb shows (fails if an unknown listing returns a kind)", () => {
  const unknown: OnaView = { kind: "unknown" };
  assert.equal(mismatch(machine({ status: "connected" }), unknown), null);
  assert.equal(mismatch(machine({ status: "disconnected" }), unknown), null);
  assert.equal(mismatch(machine({ phase: "suspended", status: "suspended" }), unknown), null);
});

test("a disagreement logs once it has held 120 s, and never before (fails if the hold is not 120 s, or a logged one logs again)", () => {
  const first = trackMismatch(undefined, "active-stopped", 1_000);
  assert.deepEqual(first, { entry: { kind: "active-stopped", since: 1_000, logged: false } });
  assert.deepEqual(trackMismatch(first.entry, "active-stopped", 120_999), { entry: first.entry });
  const held = trackMismatch(first.entry, "active-stopped", 121_000);
  assert.deepEqual(held.log, { kind: "active-stopped", secs: 120 });
  assert.equal(held.entry?.logged, true);
  assert.equal(trackMismatch(held.entry, "active-stopped", 300_000).log, undefined, "once per incident");
});

test("a kind change starts a new hold with its own since, and no kind clears the entry (fails if the kind is not compared, the old since is kept, or the entry is kept)", () => {
  const prior: Mismatch = { kind: "active-stopped", since: 0, logged: true };
  assert.deepEqual(trackMismatch(prior, "active-gone", 150_000), {
    entry: { kind: "active-gone", since: 150_000, logged: false },
  });
  assert.deepEqual(trackMismatch(prior, null, 150_000), {});
});
