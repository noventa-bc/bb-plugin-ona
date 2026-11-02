import assert from "node:assert/strict";
import { test } from "node:test";
import { pollUntil, sleep } from "../src/time.ts";

const never = new AbortController().signal;

test("pollUntil returns the first truthy probe result", async () => {
  let calls = 0;
  const result = await pollUntil(async () => (++calls === 3 ? "ready" : false), {
    deadlineMs: 1_000,
    intervalMs: 1,
    signal: never,
  });
  assert.equal(result, "ready");
  assert.equal(calls, 3);
});

test("pollUntil returns undefined once the deadline passes, probing once per interval", async () => {
  let calls = 0;
  const result = await pollUntil(async () => void calls++, { deadlineMs: 100, intervalMs: 30, signal: never });
  assert.equal(result, undefined);
  assert.ok(calls >= 3 && calls <= 5, `one probe per 30ms round in 100ms, got ${calls}`);
});

test("an abort ends the wait without another probe", async () => {
  const controller = new AbortController();
  let calls = 0;
  const started = Date.now();
  const waiting = pollUntil(
    async () => {
      calls++;
      return false;
    },
    { deadlineMs: 60_000, intervalMs: 10_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("cancelled")), 5);
  await assert.rejects(waiting, /cancelled/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1_000);
});

test("an abort during the sleep that outlasts the deadline still rejects", async () => {
  const controller = new AbortController();
  const waiting = pollUntil(async () => false, { deadlineMs: 10, intervalMs: 50, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await assert.rejects(waiting, /cancelled/);
});

test("sleep resolves early on abort, at once on an aborted signal, and runs with no signal", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 5);
  await sleep(10_000, controller.signal);
  assert.ok(Date.now() - started < 1_000);
  await sleep(10_000, AbortSignal.abort());
  await sleep(1);
});
