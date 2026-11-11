#!/bin/sh
# Lists each file ESLint lints whose count of lines is over the max-lines cap in eslint.config.js less [margin]
# (default 10; a margin above the cap lists every file with a counted line), highest count first, as "<count> <file>". Blank and
# comment lines are not counted, as the rule does. The cap is applied to every file ESLint lints, so plain .js
# files the repo's own config leaves out (eslint.config.js) are listed too. Read-only.
#   scripts/lines.sh [margin]
set -eu
usage() { echo "usage: scripts/lines.sh [margin]" >&2; exit 2; }
[ $# -le 1 ] || usage
# CDPATH='' keeps cd from printing the path when the caller has CDPATH set.
CDPATH='' cd "$(dirname "$0")/.."
margin=${1:-10}
case $margin in ''|0?*|*[!0-9]*) usage ;; esac
cap=$(sed -n 's/.*"max-lines".*max: *\([0-9][0-9]*\).*/\1/p' eslint.config.js | head -n 1)
[ -n "$cap" ] || { echo "lines: eslint.config.js has no max-lines cap" >&2; exit 1; }
[ -x node_modules/.bin/eslint ] || { echo "lines: node_modules/.bin/eslint is missing; run npm ci --ignore-scripts" >&2; exit 1; }
max=$((cap > margin ? cap - margin : 0))
rule="{\"max-lines\":[\"error\",{\"max\":$max,\"skipBlankLines\":true,\"skipComments\":true}]}"
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
