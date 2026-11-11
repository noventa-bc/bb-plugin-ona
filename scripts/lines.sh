#!/bin/sh
# Lists the lint-checked files with fewer than [margin] lines (default 10) under the max-lines cap in
# eslint.config.js, highest count first, as "<count> <file>". Blank and comment lines are not counted,
# as the rule does. Read-only.
#   scripts/lines.sh [margin]
set -eu
usage() { echo "usage: scripts/lines.sh [margin]" >&2; exit 2; }
cd "$(dirname "$0")/.."
margin=${1:-10}
case $margin in ''|*[!0-9]*) usage ;; esac
cap=$(sed -n 's/.*"max-lines".*max: *\([0-9][0-9]*\).*/\1/p' eslint.config.js | head -n 1)
[ -n "$cap" ] || { echo "lines: eslint.config.js has no max-lines cap" >&2; exit 1; }
[ -x node_modules/.bin/eslint ] || { echo "lines: node_modules/.bin/eslint is missing; run npm ci --ignore-scripts" >&2; exit 1; }
rule="{\"max-lines\":[\"error\",{\"max\":$((cap - margin)),\"skipBlankLines\":true,\"skipComments\":true}]}"
# eslint exits 1 while a file is over the rule, and its JSON still lists every file it linted.
json=$(node_modules/.bin/eslint --rule "$rule" -f json . 2>/dev/null) || true
[ -n "$json" ] || { echo "lines: eslint printed no JSON; run node_modules/.bin/eslint . to see why" >&2; exit 1; }
printf '%s\n' "$json" | node -e '
const path = require("node:path");
const files = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const rows = [];
for (const file of files) {
  for (const m of file.messages) {
    const count = /has too many lines \((\d+)\)/.exec(m.message);
    if (count) rows.push([Number(count[1]), path.relative(process.cwd(), file.filePath)]);
  }
}
rows.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1));
for (const [count, file] of rows) console.log(count + " " + file);
'
