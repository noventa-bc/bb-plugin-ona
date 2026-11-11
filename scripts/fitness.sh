#!/bin/sh
# Prints the architecture fitness numbers, one "name value" line each in a fixed order, where lower is better.
# --check compares them with scripts/fitness-baseline.txt: a number above its baseline fails (exit 1), a number
# below its baseline prints a note to stderr, and a name missing from either side fails (exit 1). CI runs --check.
#   scripts/fitness.sh [--check]
set -eu
usage() { echo "usage: scripts/fitness.sh [--check]" >&2; exit 2; }
# CDPATH='' keeps cd from printing the path when the caller has CDPATH set.
CDPATH='' cd "$(dirname "$0")/.."
mode=print
case "$#:${1:-}" in
  0:) ;;
  1:--check) mode=check ;;
  *) usage ;;
esac

# Near the cap: the files scripts/lines.sh lists within 10 counted lines of the max-lines cap.
rows=$(scripts/lines.sh 10)
near_cap_src=$(printf '%s\n' "$rows" | awk '$2 ~ /^(src\/[^\/]+\.ts|server\.ts|app\.tsx)$/ { n++ } END { print n + 0 }')
near_cap_test=$(printf '%s\n' "$rows" | awk '$2 ~ /^test\// { n++ } END { print n + 0 }')
# The length of server.ts, which the unit tests do not read.
server_lines=$(wc -l <server.ts | tr -d ' ')
# Settings: the four-space keys of the bb.settings.define({ ... }) block in server.ts.
settings=$(awk '/bb[.]settings[.]define[(][{]/ { on = 1; next } on && /^  [}][)];/ { exit } on && /^    [A-Za-z_][A-Za-z0-9_]*: [{]/ { n++ } END { print n + 0 }' server.ts)
# Commands: the name entries of the commands array in src/commands.ts.
commands=$(awk '/^export const commands = \[/ { on = 1; next } on && /^\]/ { exit } on && /name:/ { n++ } END { print n + 0 }' src/commands.ts)
# Timers: occurrences of setInterval( in the source.
intervals=$(awk '{ n += gsub(/setInterval[(]/, "&") } END { print n + 0 }' src/*.ts server.ts)
# Shortcut comments: the lines that carry one, minus this script and its test.
shortcuts=$(grep -r -h -F --exclude=fitness.sh --exclude=fitness.test.ts shortcut: src test scripts server.ts app.tsx | awk 'END { print NR + 0 }')

# The run-time imports and package.json's dependencies, from one node run. typescript is a devDependency that parses
# the imports: a run-time edge is an import or an export from a module, and an import type or an export type is not one.
graph=$(node -e '
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
// The modules a file loads at run time: a relative one as a path from the repo root, any other as written.
function loads(file) {
  const out = [];
  for (const st of ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest).statements) {
    const isImport = ts.isImportDeclaration(st);
    if (!isImport && !ts.isExportDeclaration(st)) continue;
    if (!st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (isImport ? st.importClause?.isTypeOnly : st.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    out.push(spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec);
  }
  return [...new Set(out)];
}
const nodes = [...fs.readdirSync("src").filter((f) => f.endsWith(".ts")).map((f) => "src/" + f), "server.ts"].sort();
const edges = new Map(nodes.map((file) => [file, loads(file).filter((t) => nodes.includes(t))]));
let cycles = 0;
for (const start of nodes) {
  // Each cycle is walked from its smallest node only, so it is counted once.
  const walk = (at, route) => {
    for (const next of edges.get(at)) {
      if (next === start) cycles++;
      else if (next > start && !route.includes(next)) walk(next, [...route, next]);
    }
  };
  walk(start, [start]);
}
// Layering: the modules listed below load none of these at run time (the Ona, SSH, provider and sync modules, and the node child process, net and HTTP modules).
const forbidden = ["src/ssh.ts", "src/ona.ts", "src/provider.ts", "src/provider-connect.ts", "src/sync.ts", "node:child_process", "node:net", "node:http"];
let layering = 0;
for (const file of ["src/reconcile.ts", "src/names.ts", "src/time.ts", "src/machine-inputs.ts"]) {
  layering += loads(file).filter((t) => forbidden.includes(t)).length;
}
const deps = Object.keys(JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies ?? {}).length;
console.log("runtime_deps " + deps);
console.log("layering " + layering);
console.log("cycles " + cycles);
')

# The value of one of the node run's lines.
pick() { printf '%s\n' "$graph" | awk -v name="$1" '$1 == name { print $2 }'; }

# The numbers, in their fixed order.
numbers() {
  printf 'near_cap_src %s\n' "$near_cap_src"
  printf 'near_cap_test %s\n' "$near_cap_test"
  printf 'server_lines %s\n' "$server_lines"
  printf 'runtime_deps %s\n' "$(pick runtime_deps)"
  printf 'settings %s\n' "$settings"
  printf 'commands %s\n' "$commands"
  printf 'intervals %s\n' "$intervals"
  printf 'shortcuts %s\n' "$shortcuts"
  printf 'layering %s\n' "$(pick layering)"
  printf 'cycles %s\n' "$(pick cycles)"
}

if [ "$mode" = print ]; then
  numbers
  exit 0
fi
baseline=scripts/fitness-baseline.txt
[ -f "$baseline" ] || { echo "fitness: $baseline is missing" >&2; exit 1; }
# Each number is compared with its own baseline line; a name without one on either side fails.
numbers | awk -v baseline="$baseline" '
  BEGIN {
    while ((getline line < baseline) > 0) if (line !~ /^#/ && split(line, f) == 2) base[f[1]] = f[2]
  }
  { cur[$1] = $2; order[++n] = $1 }
  END {
    status = 0
    for (i = 1; i <= n; i++) {
      name = order[i]
      if (!(name in base)) {
        print "fitness: " name " is measured but has no line in " baseline > "/dev/stderr"; status = 1
      } else if (cur[name] + 0 > base[name] + 0) {
        print "fitness: " name " is " cur[name] ", above its baseline of " base[name] "; a rise needs the owner to say yes and a baseline edit in the same PR" > "/dev/stderr"; status = 1
      } else if (cur[name] + 0 < base[name] + 0) {
        print "fitness: " name " is " cur[name] ", below its baseline of " base[name] "; the baseline in " baseline " can be lowered to " cur[name] > "/dev/stderr"
      }
    }
    for (name in base) if (!(name in cur)) { print "fitness: " name " is in " baseline " but is not measured" > "/dev/stderr"; status = 1 }
    exit status
  }'
