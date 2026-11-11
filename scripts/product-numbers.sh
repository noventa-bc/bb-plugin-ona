#!/bin/sh
# Prints the product numbers from this plugin's metric log lines, one "name value" line each in a fixed order, then one
# line per ISO week that has hand runs. Give it the output of bb plugin logs, which prints one JSON log line per line:
#   bb plugin logs ona -n 10000 > ona.log && scripts/product-numbers.sh < ona.log
# A line that is not a JSON log line is counted in skipped_lines; a log line that is not a metric line is ignored.
set -eu
[ $# -eq 0 ] || { echo "usage: bb plugin logs ona -n 10000 > ona.log && scripts/product-numbers.sh < ona.log" >&2; exit 2; }
node -e '
const fs = require("node:fs");
// A log line is a JSON object with a number ts that a Date can hold and a string message; any other line is skipped.
function logLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const valid =
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.ts === "number" &&
    !Number.isNaN(new Date(entry.ts).getTime()) &&
    typeof entry.message === "string";
  return valid ? entry : undefined;
}
// A metric message is "metric <kind> key=value ...". The fields are read by key, so their order and unknown keys do not matter.
function metricOf(message) {
  const [word, kind, ...pairs] = message.split(" ");
  if (word !== "metric") return undefined;
  const fields = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { kind, fields };
}
// A count or a time: digits with an optional fraction.
function numberOf(text) {
  return text !== undefined && /^[0-9]+([.][0-9]+)?$/.test(text) ? Number(text) : undefined;
}
// The ISO 8601 week of a UTC time, labelled with the year of its Thursday, so late December can be week 1 of the next year.
function isoWeek(ts) {
  const date = new Date(ts);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - sinceMonday + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86400000)) + 1;
  return year + "-W" + String(week).padStart(2, "0");
}
// Nearest-rank: the p-th percentile of n sorted values is the one at rank ceil(p * n / 100); "-" when there are none.
function percentile(values, p) {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return String(sorted[Math.ceil((p * sorted.length) / 100) - 1]);
}
const count = (list, key, value) => list.filter((m) => m.fields[key] === value).length;

const lines = fs.readFileSync(0, "utf8").split("\n");
if (lines[lines.length - 1] === "") lines.pop();
let skipped = 0;
const metrics = [];
for (const line of lines) {
  const entry = logLine(line);
  if (entry === undefined) {
    skipped++;
  } else {
    const metric = metricOf(entry.message);
    if (metric !== undefined) metrics.push({ ts: entry.ts, kind: metric.kind, fields: metric.fields });
  }
}

const ofKind = (kind) => metrics.filter((m) => m.kind === kind);
const starts = ofKind("start");
const connects = ofKind("connected");
const deletes = ofKind("delete");
// bb retries a refused removal, so one box can have a keep line per retry: the keeps are counted by env, not by line.
const keeps = ofKind("keep");
const handRuns = ofKind("cmd");
const soonAfterLoad = starts.filter((m) => {
  const up = numberOf(m.fields.up);
  return m.fields.via === "resume" && up !== undefined && up < 300;
}).length;
// The secs of the connects that worked, for the boxes in the given states. A new box is started by its connect, so it
// counts as stopped.
const secsOf = (boxes) =>
  connects
    .filter((m) => m.fields.ok === "1" && boxes.includes(m.fields.box) && numberOf(m.fields.secs) !== undefined)
    .map((m) => numberOf(m.fields.secs));
const stopped = secsOf(["stopped", "new"]);
const running = secsOf(["running"]);
const weeks = new Map();
for (const m of handRuns) {
  const week = isoWeek(m.ts);
  weeks.set(week, (weeks.get(week) ?? 0) + 1);
}

const rows = [
  ["starts_create", count(starts, "via", "create")],
  ["starts_resume", count(starts, "via", "resume")],
  ["starts_wake_thread", count(starts, "via", "wake-thread")],
  ["starts_wake_cmd", count(starts, "via", "wake-cmd")],
  ["starts_soon_after_load", soonAfterLoad],
  ["new_boxes", count(connects, "box", "new")],
  ["deletes", deletes.length],
  ["deletes_git_unknown", count(deletes, "git", "unknown")],
  ["deletes_refused", new Set(keeps.map((m) => m.fields.env)).size],
  ["hand_runs", handRuns.length],
  ["connect_ok", count(connects, "ok", "1")],
  ["connect_failed", count(connects, "ok", "0")],
  ["connect_secs_stopped_p50", percentile(stopped, 50)],
  ["connect_secs_stopped_p90", percentile(stopped, 90)],
  ["connect_secs_running_p50", percentile(running, 50)],
  ["connect_secs_running_p90", percentile(running, 90)],
  ["skipped_lines", skipped],
];
// The labels sort oldest first as text, since the year leads and the week is zero-padded.
for (const week of [...weeks.keys()].sort()) rows.push(["hand_runs_week_" + week, weeks.get(week)]);
console.log(rows.map(([name, value]) => name + " " + value).join("\n"));
' || { echo "product-numbers: node could not count the log; its message is above" >&2; exit 1; }
