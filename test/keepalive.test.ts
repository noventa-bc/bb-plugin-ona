import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clockTime,
  KEEP_ALIVE_MAX_MS,
  keepAliveArgs,
  KeepAlives,
  parseKeepAlive,
  type KeepAliveChild,
} from "../src/keepalive.ts";

test("parseKeepAlive takes off, durations up to 12h, and bare minutes", () => {
  assert.deepEqual(parseKeepAlive("off"), { kind: "off" });
  assert.deepEqual(parseKeepAlive("OFF"), { kind: "off" });
  assert.deepEqual(parseKeepAlive("2h"), { kind: "for", ms: 2 * 3_600_000 });
  assert.deepEqual(parseKeepAlive("90m"), { kind: "for", ms: 90 * 60_000 });
  assert.deepEqual(parseKeepAlive("45"), { kind: "for", ms: 45 * 60_000 });
  assert.deepEqual(parseKeepAlive("12h"), { kind: "for", ms: KEEP_ALIVE_MAX_MS });
});

test("parseKeepAlive refuses a missing, zero, unparseable or over-12h duration", () => {
  for (const value of [undefined, "", "0", "0m", "forever", "-1h", "1d", "12.5h", "721m"]) {
    assert.equal(parseKeepAlive(value).kind, "invalid", String(value));
  }
});

test("keepAliveArgs passes the id and seconds as separate argv entries", () => {
  assert.deepEqual(keepAliveArgs("env-0001", 2 * 3_600_000), [
    "environment",
    "keep-alive",
    "--environment-id",
    "env-0001",
    "-q",
    "--",
    "sleep",
    "7200",
  ]);
  assert.equal(keepAliveArgs("env-0001", 1_500).at(-1), "2");
  assert.equal(keepAliveArgs("env-0001; rm -rf /", 1_000)[3], "env-0001; rm -rf /");
});

test("clockTime is HH:MM", () => {
  assert.equal(clockTime(new Date(2026, 0, 2, 7, 5).getTime()), "07:05");
  assert.equal(clockTime(new Date(2026, 0, 2, 23, 59).getTime()), "23:59");
});

class FakeChild implements KeepAliveChild {
  killed = false;
  private listener: ((detail: string) => void) | null = null;
  kill(): void {
    this.killed = true;
    this.exit("killed by SIGTERM");
  }
  onExit(listener: (detail: string) => void): void {
    this.listener = listener;
  }
  exit(detail: string): void {
    this.listener?.(detail);
    this.listener = null;
  }
}

function harness() {
  let now = 1_000_000;
  const children: FakeChild[] = [];
  const early: Array<[string, string]> = [];
  const keepAlives = new KeepAlives(
    () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    (envId, detail) => early.push([envId, detail]),
    () => now,
  );
  return { keepAlives, children, early, advance: (ms: number) => (now += ms), now: () => now };
}

test("start records the end time; a new duration replaces the old child", () => {
  const h = harness();
  assert.equal(h.keepAlives.start("env-a", 60_000), h.now() + 60_000);
  const until = h.keepAlives.start("env-a", 120_000);
  assert.equal(h.children.length, 2);
  assert.equal(h.children[0]!.killed, true);
  assert.equal(h.children[1]!.killed, false);
  assert.equal(h.keepAlives.until("env-a"), until);
  assert.deepEqual(h.early, []);
});

test("stop ends the child and reports whether there was one", () => {
  const h = harness();
  h.keepAlives.start("env-a", 60_000);
  assert.equal(h.keepAlives.stop("env-a"), true);
  assert.equal(h.children[0]!.killed, true);
  assert.equal(h.keepAlives.until("env-a"), null);
  assert.equal(h.keepAlives.stop("env-a"), false);
});

test("a child that ends on time is forgotten quietly; one that ends early is reported", () => {
  const h = harness();
  h.keepAlives.start("env-a", 60 * 60_000);
  h.keepAlives.start("env-b", 60 * 60_000);
  h.advance(60 * 60_000);
  h.children[0]!.exit("exit code 0");
  h.advance(-50 * 60_000);
  h.children[1]!.exit("environment is not running");
  assert.equal(h.keepAlives.until("env-a"), null);
  assert.equal(h.keepAlives.until("env-b"), null);
  assert.deepEqual(h.early, [["env-b", "environment is not running"]]);
});

test("endNotRunning ends keep-alives of listed boxes that aren't running, and keeps unlisted ones", () => {
  const h = harness();
  h.keepAlives.start("env-a", 60_000);
  h.keepAlives.start("env-b", 60_000);
  h.keepAlives.start("env-c", 60_000);
  const listed = [
    { id: "env-a", running: true },
    { id: "env-b", running: false },
    { id: "env-d", running: false },
  ];
  assert.deepEqual(h.keepAlives.endNotRunning(listed), ["env-b"]);
  assert.deepEqual(
    h.children.map((child) => child.killed),
    [false, true, false],
  );
  assert.deepEqual(h.early, []);
});

test("stopAll ends every child", () => {
  const h = harness();
  h.keepAlives.start("env-a", 60_000);
  h.keepAlives.start("env-b", 60_000);
  h.keepAlives.stopAll();
  assert.ok(h.children.every((child) => child.killed));
  assert.equal(h.keepAlives.until("env-a"), null);
});
