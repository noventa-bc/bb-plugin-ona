import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { metric } from "../src/ona.ts";
import { MISMATCH_LINE } from "./sync-fakes.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "product-numbers.sh");

/** A log line as `bb plugin logs` prints it: the stored object, with `ts` in epoch milliseconds. */
const logLine = (message: string, when = "2026-11-02T08:00:00Z") =>
  JSON.stringify({ ts: Date.parse(when), level: "info", message });

/** Runs the script with `input` on stdin and `args`; returns its exit status, stdout and stderr. */
function productNumbers(input: string, args: string[] = []) {
  // A zone 14 hours ahead of UTC: a week or day computed in local time lands on another day and fails the tests.
  const env = { ...process.env, TZ: "Pacific/Kiritimati" };
  const run = spawnSync("sh", [SCRIPT, ...args], { input, encoding: "utf8", timeout: 60_000, env });
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
  // deletes 3, of which git=unknown 2. deletes_refused 2 (two boxes, one keep line each).
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
  // mismatches 4: two active-stopped lines (both box-1), one disconnected-running (box-2) and one with no kind, which
  // counts in mismatches and in no kind line. So mismatches_active_stopped 2 and mismatches_disconnected_running 1.
  logLine("metric mismatch host=box-1 kind=active-stopped secs=120"),
  logLine("metric mismatch host=box-1 kind=active-stopped secs=360"),
  logLine("metric mismatch host=box-2 kind=disconnected-running secs=240"),
  logLine("metric mismatch host=box-3 secs=120"),
  // Log lines that are not metric lines, and a metric line of a kind the script does not know: ignored.
  logLine("[plugin:ona] a warning"),
  logLine("metric future env=env-13"),
  // skipped_lines 3: plain text, a log object without ts, and null.
  "not json at all",
  JSON.stringify({ level: "info", message: "metric cmd name=sync" }),
  "null",
);

test("the fixture's known answer for every number, in the fixed order, with the per-week lines last, and a mismatch line with no kind counted in mismatches only (fails if that line gets a kind line)", () => {
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
      "mismatches 4",
      "skipped_lines 3",
      "mismatches_active_stopped 2",
      "mismatches_disconnected_running 1",
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
      "mismatches 0",
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
      "mismatches 0",
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
      "mismatches 0",
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

test("a box refused on each bb retry counts once in deletes_refused (fails if each keep line counts)", () => {
  const r = productNumbers(
    lines(
      logLine("metric keep env=env-30 via=remove commits=2 files=0"),
      logLine("metric keep env=env-30 via=remove commits=2 files=0", "2026-11-02T08:01:00Z"),
      logLine("metric keep env=env-31 via=cleanup commits=0 files=1"),
      // A later removal deleted env-30: it still counts as refused once.
      logLine("metric delete env=env-30 via=remove git=known", "2026-11-02T08:02:00Z"),
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^deletes_refused 2$/m);
});

test("a hand run's ISO week starts on Monday, so a Sunday is in the week that ends on it (fails if the Monday-first adjustment is dropped)", () => {
  const r = productNumbers(
    lines(
      logLine("metric cmd name=sync", "2026-11-08T12:00:00Z"),
      logLine("metric cmd name=sync", "2026-11-02T12:00:00Z"),
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^hand_runs_week_2026-W45 2$/m);
});

test("the week lines print oldest first when a later week comes before an earlier one (fails if the week labels are not sorted)", () => {
  const r = productNumbers(
    lines(
      logLine("metric cmd name=sync", "2026-11-09T12:00:00Z"),
      logLine("metric cmd name=sync", "2026-11-02T12:00:00Z"),
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.match(/^hand_runs_week_.*$/gm), ["hand_runs_week_2026-W45 1", "hand_runs_week_2026-W46 1"]);
});

test("a log line whose message does not start with metric counts nowhere (fails if the metric word is not checked)", () => {
  const r = productNumbers(lines(logLine("note cmd name=sync"), logLine("ona start env=e via=create up=1")));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, productNumbers("").stdout);
});

test("a log line whose message is not a string is skipped, and the run goes on (fails if the message type is not checked)", () => {
  const r = productNumbers(
    lines(
      JSON.stringify({ ts: Date.parse("2026-11-02T08:00:00Z"), level: "info", message: 5 }),
      logLine("metric cmd name=sync"),
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^hand_runs 1$/m);
  assert.match(r.stdout, /^skipped_lines 1$/m);
});

test("a metric line whose ts is a string is skipped (fails if the ts type is not checked)", () => {
  const r = productNumbers(lines('{"ts":"2026-11-02T08:00:00Z","level":"info","message":"metric cmd name=sync"}'));
  assert.match(r.stdout, /^hand_runs 0$/m);
  assert.match(r.stdout, /^skipped_lines 1$/m);
});

test("a metric line whose ts a Date cannot hold is skipped, and no week prints NaN (fails if the ts is not range-checked)", () => {
  const r = productNumbers(lines('{"ts":1e20,"level":"info","message":"metric cmd name=sync"}'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^hand_runs 0$/m);
  assert.match(r.stdout, /^skipped_lines 1$/m);
  assert.doesNotMatch(r.stdout, /NaN/);
});

test("the metric lines src/ona.ts writes are counted here, one of each kind (fails if the writer and this script disagree on a name or key)", () => {
  const r = productNumbers(
    lines(
      logLine(metric("cmd", { name: "sync" })),
      logLine(metric("start", { env: "env-1", via: "wake-thread", up: 5 })),
      logLine(metric("connected", { via: "create", box: "new", secs: 4, ok: 1 })),
      logLine(metric("delete", { env: "env-2", via: "remove", git: "unknown" })),
      logLine(metric("keep", { env: "env-3", via: "remove", commits: 2, files: 0 })),
      logLine(MISMATCH_LINE),
    ),
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    lines(
      "starts_create 0",
      "starts_resume 0",
      "starts_wake_thread 1",
      "starts_wake_cmd 0",
      "starts_soon_after_load 0",
      "new_boxes 1",
      "deletes 1",
      "deletes_git_unknown 1",
      "deletes_refused 1",
      "hand_runs 1",
      "connect_ok 1",
      "connect_failed 0",
      "connect_secs_stopped_p50 4",
      "connect_secs_stopped_p90 4",
      "connect_secs_running_p50 -",
      "connect_secs_running_p90 -",
      "mismatches 1",
      "skipped_lines 0",
      "mismatches_active_stopped 1",
      "hand_runs_week_2026-W45 1",
    ),
  );
});
