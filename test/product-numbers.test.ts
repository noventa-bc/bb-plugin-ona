import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "product-numbers.sh");

/** A log line as `bb plugin logs` prints it: the stored object, with `ts` in epoch milliseconds. */
const logLine = (message: string, when = "2026-11-02T08:00:00Z") =>
  JSON.stringify({ ts: Date.parse(when), level: "info", message });

/** Runs the script with `input` on stdin and `args`; returns its exit status, stdout and stderr. */
function productNumbers(input: string, args: string[] = []) {
  const run = spawnSync("sh", [SCRIPT, ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Text made of rows: each on its own line, with a final newline. */
const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

// Made-up ids, and the answer each number takes from the lines (the expected output is in the first test).
const FIXTURE = lines(
  // starts: create 1, resume 3, wake-thread 1, wake-cmd 2. starts_soon_after_load is 2: the resumes at up 120 and 299
  // count, the one at 300 does not, and a create does not.
  logLine("metric start env=env-1 via=create up=10"),
  logLine("metric start env=env-2 via=resume up=120"),
  logLine("metric start env=env-3 via=resume up=300"),
  logLine("metric start env=env-4 via=wake-thread up=50"),
  logLine("metric start env=env-5 via=wake-cmd up=60"),
  logLine("metric start env=env-6 via=wake-cmd up=500"),
  logLine("metric start env=env-7 via=resume up=299"),
  // connects: new_boxes 4 (box=new, whatever ok). connect_ok 13, connect_failed 3. The stopped group (box stopped or
  // new, ok=1, with secs) has the ten values 1 to 10, in no order: p50 5, p90 9. The running group has 4 and 9: p50 4,
  // p90 9. The failed connects (secs 2, 999 and 500) and the running line without secs stay out of the percentiles.
  logLine("metric connected via=create box=new secs=4 ok=1"),
  logLine("metric connected via=create box=new secs=2 ok=0"),
  logLine("metric connected via=resume box=stopped secs=3 ok=1"),
  logLine("metric connected via=wake box=stopped secs=1 ok=1"),
  logLine("metric connected via=create box=new secs=9 ok=1"),
  logLine("metric connected via=wake box=stopped secs=2 ok=1"),
  logLine("metric connected via=wake box=stopped secs=10 ok=1"),
  logLine("metric connected via=wake box=stopped secs=7 ok=1"),
  logLine("metric connected via=wake box=stopped secs=5 ok=1"),
  logLine("metric connected via=create box=new secs=8 ok=1"),
  logLine("metric connected via=wake box=stopped secs=6 ok=1"),
  logLine("metric connected via=wake box=stopped secs=999 ok=0"),
  logLine("metric connected via=reconnect box=running secs=4 ok=1"),
  logLine("metric connected via=wake box=running secs=9 ok=1"),
  logLine("metric connected via=wake box=running secs=500 ok=0"),
  logLine("metric connected via=wake box=running ok=1"),
  // deletes 3, of which git=unknown 2. deletes_refused 2 (the keep lines).
  logLine("metric delete env=env-8 via=remove git=known"),
  logLine("metric delete env=env-9 via=cleanup git=unknown"),
  logLine("metric delete env=env-10 via=remove git=unknown"),
  logLine("metric keep env=env-11 via=remove commits=2 files=0"),
  logLine("metric keep env=env-12 via=cleanup commits=0 files=1"),
  // hand runs 5. 2025-12-29 is a Monday in ISO week 1 of 2026; 2026-11-02 and 2026-11-05 are both in 2026-W45; 2026-11-09
  // is 2026-W46; 2027-01-01 is in 2026-W53, so its calendar year is not its week-year.
  logLine("metric cmd name=sync", "2025-12-29T12:00:00Z"),
  logLine("metric cmd name=reconnect", "2026-11-02T09:00:00Z"),
  logLine("metric cmd name=resume", "2026-11-05T10:00:00Z"),
  logLine("metric cmd name=sync", "2026-11-09T08:00:00Z"),
  logLine("metric cmd name=sync", "2027-01-01T12:00:00Z"),
  // Log lines that are not metric lines, and a metric line of a kind the script does not know: ignored.
  logLine("[plugin:ona] a warning"),
  logLine("metric future env=env-13"),
  // skipped_lines 3: plain text, a log object without ts, and null.
  "not json at all",
  JSON.stringify({ level: "info", message: "metric cmd name=sync" }),
  "null",
);

test("the fixture's known answer for every number, in the fixed order, with the per-week lines last", () => {
  const r = productNumbers(FIXTURE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    lines(
      "starts_create 1",
      "starts_resume 3",
      "starts_wake_thread 1",
      "starts_wake_cmd 2",
      "starts_soon_after_load 2",
      "new_boxes 4",
      "deletes 3",
      "deletes_git_unknown 2",
      "deletes_refused 2",
      "hand_runs 5",
      "connect_ok 13",
      "connect_failed 3",
      "connect_secs_stopped_p50 5",
      "connect_secs_stopped_p90 9",
      "connect_secs_running_p50 4",
      "connect_secs_running_p90 9",
      "skipped_lines 3",
      "hand_runs_week_2026-W01 1",
      "hand_runs_week_2026-W45 2",
      "hand_runs_week_2026-W46 1",
      "hand_runs_week_2026-W53 1",
    ),
  );
});

test("empty input prints every number as 0 and every percentile as -", () => {
  const r = productNumbers("");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    lines(
      "starts_create 0",
      "starts_resume 0",
      "starts_wake_thread 0",
      "starts_wake_cmd 0",
      "starts_soon_after_load 0",
      "new_boxes 0",
      "deletes 0",
      "deletes_git_unknown 0",
      "deletes_refused 0",
      "hand_runs 0",
      "connect_ok 0",
      "connect_failed 0",
      "connect_secs_stopped_p50 -",
      "connect_secs_stopped_p90 -",
      "connect_secs_running_p50 -",
      "connect_secs_running_p90 -",
      "skipped_lines 0",
    ),
  );
});

test("one connect gives its own value at both percentiles, and an empty group prints -", () => {
  const r = productNumbers(logLine("metric connected via=resume box=stopped secs=7 ok=1") + "\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    lines(
      "starts_create 0",
      "starts_resume 0",
      "starts_wake_thread 0",
      "starts_wake_cmd 0",
      "starts_soon_after_load 0",
      "new_boxes 0",
      "deletes 0",
      "deletes_git_unknown 0",
      "deletes_refused 0",
      "hand_runs 0",
      "connect_ok 1",
      "connect_failed 0",
      "connect_secs_stopped_p50 7",
      "connect_secs_stopped_p90 7",
      "connect_secs_running_p50 -",
      "connect_secs_running_p90 -",
      "skipped_lines 0",
    ),
  );
});

test("reordered and unknown keys are read by key", () => {
  const r = productNumbers(
    [
      logLine("metric start up=5 via=resume env=env-20 region=eu"),
      logLine("metric connected ok=1 box=running extra=x secs=3 via=wake"),
      logLine("metric delete git=unknown env=env-21 via=remove"),
      logLine("metric cmd extra=1 name=reconnect", "2026-11-02T09:00:00Z"),
    ].join("\n") + "\n",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    lines(
      "starts_create 0",
      "starts_resume 1",
      "starts_wake_thread 0",
      "starts_wake_cmd 0",
      "starts_soon_after_load 1",
      "new_boxes 0",
      "deletes 1",
      "deletes_git_unknown 1",
      "deletes_refused 0",
      "hand_runs 1",
      "connect_ok 1",
      "connect_failed 0",
      "connect_secs_stopped_p50 -",
      "connect_secs_stopped_p90 -",
      "connect_secs_running_p50 3",
      "connect_secs_running_p90 3",
      "skipped_lines 0",
      "hand_runs_week_2026-W45 1",
    ),
  );
});

test("any argument is a usage error", () => {
  for (const args of [["--json"], ["extra"]]) {
    const r = productNumbers("", args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^usage: /m);
  }
});
