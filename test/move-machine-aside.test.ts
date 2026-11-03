// MOVE_MACHINE_ASIDE, the script that removing an adopted box runs over SSH,
// run locally with bash against a temporary home laid out as on a devbox.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { MOVE_MACHINE_ASIDE } from "../src/provider.ts";
import { DAEMON_PROBE } from "../src/reconcile.ts";
import { sandboxed } from "./sandbox.ts";

/**
 * A home whose ~/.bb-machines links to a local-disk folder (as `machineDataDir`
 * sets it up) holding the data folders of machines host-1 and host-10. Each runs
 * a stand-in daemon whose command line carries the resolved folder, as bb's does.
 * `remove` runs the script and returns its exit code.
 */
function devbox(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bb-ona-remove-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const disk = join(home, "disk");
  const daemons = ["host-1", "host-10"].map((hostId) => {
    const folder = join(disk, `server-${hostId}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "host-id"), `${hostId}\n`);
    const args = ["-e", "setTimeout(() => {}, 60000)", `${realpathSync(folder)}/npm/bin/bb-app`, "host-daemon"];
    return spawn(process.execPath, args, { stdio: "ignore" });
  });
  t.after(() => daemons.forEach((daemon) => daemon.kill()));
  symlinkSync(disk, join(home, ".bb-machines"));
  const remove = (hostId: string, legacy = "", path = process.env.PATH) =>
    promisify(execFile)("/bin/bash", ["-c", MOVE_MACHINE_ASIDE, "bb-ona-remove", hostId, legacy], {
      env: { ...process.env, HOME: home, PATH: path },
    }).then(
      () => 0,
      (error: unknown) => (error as { code: number }).code,
    );
  const running = (i: number) => daemons[i]!.exitCode === null && daemons[i]!.signalCode === null;
  return { home, disk, remove, running };
}

// Bug: the old script matched only ~/.bb-machines/ in command lines, but the
// daemon runs from the resolved folder, and nothing moved the folder, so bb's
// installer refused to adopt the box again. host-10 guards the "/" after the
// folder in the match: without it, removing host-1 stops host-10's daemon.
test("removing an adopted box stops its daemon and moves its data folder aside", sandboxed, async (t) => {
  const { disk, remove, running } = devbox(t);
  assert.equal(await remove("host-1"), 0);
  const [moved, other, ...rest] = readdirSync(disk).sort();
  assert.match(moved ?? "", /^server-host-1\.old-\d{8}T\d{6}Z$/);
  assert.equal(readFileSync(join(disk, moved!, "host-id"), "utf8"), "host-1\n", "the folder is moved, not deleted");
  assert.equal(other, "server-host-10");
  assert.deepEqual(rest, []);
  assert.equal(running(0), false, "the removed machine's daemon must be stopped");
  assert.equal(running(1), true, "another machine's daemon must keep running");
});

// Bug: bb retries a remove whose later teardown step failed, and the retry
// renamed <folder>.old-A to <folder>.old-A.old-B and then said it found nothing.
test("a retried remove leaves the folder it already moved alone and succeeds", sandboxed, async (t) => {
  const { disk, remove } = devbox(t);
  await remove("host-1");
  const moved = readdirSync(disk).sort();
  assert.equal(await remove("host-1"), 0);
  assert.deepEqual(readdirSync(disk).sort(), moved);
});

// Bug: a folder whose server host contains ".old" was taken for one already moved,
// so the folder stayed in place.
test("a folder whose server host contains .old is still moved aside", sandboxed, async (t) => {
  const { disk, remove } = devbox(t);
  renameSync(join(disk, "server-host-1"), join(disk, "bb.old-2.example.com-8443"));
  assert.equal(await remove("host-1"), 0);
  assert.match(readdirSync(disk).sort()[0] ?? "", /^bb\.old-2\.example\.com-8443\.old-\d{8}T\d{6}Z$/);
});

// Bug: on a box without a working ps (missing, or one that rejects -e) or without
// awk, the stop loop saw no daemon and the folder moved under a live one.
const brokenTools: [string, string][] = [
  ["ps", "exit 127"],
  ["awk", "exit 127"],
  // A busybox ps without -o support prints its default PID USER VSZ STAT COMMAND table.
  ["ps", "exec /bin/ps -e -o pid= -o user= -o vsz= -o stat= -o args="],
];
for (const [tool, body] of brokenTools) {
  test(`a box whose ${tool} fails (${body}) moves nothing and exits 4`, sandboxed, async (t) => {
    const { home, disk, remove, running } = devbox(t);
    writeFileSync(join(home, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    assert.equal(await remove("host-1", "", `${home}:${process.env.PATH}`), 4);
    assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
    assert.equal(running(0), true);
  });
}

// Bug: a remove that moved nothing said nothing, as if the folder had moved.
test("removing a machine whose data folder isn't on the box changes nothing and exits 3", sandboxed, async (t) => {
  const { disk, remove, running } = devbox(t);
  assert.equal(await remove("host-3"), 3);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10"]);
  assert.equal(running(0), true);
  assert.equal(running(1), true);
});

// Bug: an empty host id matched a folder whose host-id file is empty.
test("an empty host id moves nothing and exits 2", sandboxed, async (t) => {
  const { disk, remove } = devbox(t);
  mkdirSync(join(disk, "server-new"));
  writeFileSync(join(disk, "server-new", "host-id"), "");
  assert.equal(await remove(""), 2);
  assert.deepEqual(readdirSync(disk).sort(), ["server-host-1", "server-host-10", "server-new"]);
});

// Bug: a legacy data folder that also held other machines' data folders was
// moved with them, and their daemons stopped.
test("a legacy folder that holds other machines' data folders is left alone", sandboxed, async (t) => {
  const { disk, remove, running } = devbox(t);
  writeFileSync(join(disk, "host-id"), "host-3\n");
  assert.equal(await remove("host-3", disk), 3);
  assert.deepEqual(readdirSync(disk).sort(), ["host-id", "server-host-1", "server-host-10"]);
  assert.equal(running(0), true);
  assert.equal(running(1), true);
});

// Bug: POSIX makes the rest of an -o argument its header, as busybox before 1.35 does, so
// "-o pid=,args=" printed only PIDs there: the stop loop and the daemon probe saw no daemon.
test("the box scripts give ps one column per -o", () => {
  for (const script of [MOVE_MACHINE_ASIDE, DAEMON_PROBE]) assert.doesNotMatch(script, /-\w*o \S+=,/);
});
