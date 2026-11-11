import assert from "node:assert/strict";
import { test } from "node:test";
import { GIVE_UP_AFTER } from "../src/reconcile.ts";
import { HOUR, idle, NOW, waitingThread, world } from "./sync-fakes.ts";

// Bug: the retry line hid only a suspended machine, but decide() acts only on an active one, so a machine that was
// creating, removing, resuming or suspending showed a retry it never got.
test("the retry and give-up lines show only for an active machine (fails if either shows for a machine that is removing, resuming, suspending or suspended)", async () => {
  const retryIn = async (phase: string, failures: number) => {
    const { sync, guard } = world([idle("h1", { phase })]);
    const record = { action: "heal-daemon", reason: "daemon down", at: NOW, failures, quietUntil: NOW + HOUR };
    guard.records.set("h1", record);
    const [row] = await sync.statusRows();
    return row!.retry;
  };
  for (const failures of [1, GIVE_UP_AFTER]) {
    for (const phase of ["removing", "resuming", "suspending", "suspended"]) {
      assert.equal(await retryIn(phase, failures), null, `bb shows the machine ${phase}; decide() won't act`);
    }
  }
  assert.match((await retryIn("active", 1)) ?? "", /^retrying after /);
  assert.match((await retryIn("active", GIVE_UP_AFTER)) ?? "", /^gave up after /);
});

test("a resume bb settles active for a waiting thread is a success that says so (fails if the settled resume is not accepted)", async () => {
  const { sync, guard } = world([idle("h1", { ona: "STOPPED", status: "disconnected", threads: [waitingThread()] })]);
  await sync.reconcile(new Set(["h1"]), { wait: true });
  const { failures, reason } = guard.records.get("h1")!;
  assert.deepEqual([failures, reason], [0, "Ona stopped the box; resumed for a waiting thread"]);
});
