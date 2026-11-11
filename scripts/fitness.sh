#!/bin/sh
# Prints the architecture fitness numbers, one "name value" line each in a fixed order, where lower is better.
# --check compares them with scripts/fitness-baseline.txt: the numbers must equal the baseline line for line (its #
# lines aside). Any difference is shown as a diff and exits 1. CI runs --check.
#   scripts/fitness.sh [--check]
# What the numbers count, in the repo as it is:
#   near_cap_src, near_cap_test  the files scripts/lines.sh 10 lists: src/*.ts, server.ts and app.tsx, then test/
#   server_lines                 the lines of server.ts
#   runtime_deps                 the dependencies of package.json, not its devDependencies
#   settings                     the properties of the object literal passed to bb.settings.define(...) in server.ts
#   commands                     the elements of the array the exported commands constant of src/commands.ts holds
#   intervals                    setInterval( in src/*.ts, server.ts and app.tsx, comments included
#   shortcuts                    lines with shortcut: in src, test, scripts, server.ts, app.tsx, eslint.config.js and
#                                .githooks, except scripts/fitness.sh and test/fitness.test.ts
#   layering                     forbidden loads by the four layered modules named in the node block
#   cycles                       the modules that reach themselves through run-time imports
set -eu
usage() { echo "usage: scripts/fitness.sh [--check]" >&2; exit 2; }
# CDPATH='' keeps cd from printing the path when the caller has CDPATH set.
CDPATH='' cd "$(dirname "$0")/.."
case "$*" in
  '') mode=print ;;
  --check) mode=check ;;
  *) usage ;;
esac

# Each command here stops the run with a message when it fails. grep's status is checked by hand, because 1 means no match.
rows=$(scripts/lines.sh 10) || { echo "fitness: scripts/lines.sh 10 failed" >&2; exit 1; }
rc=0
hits=$(grep -r -h -F --exclude=fitness.sh --exclude=fitness.test.ts shortcut: src test scripts server.ts app.tsx eslint.config.js .githooks) || rc=$?
[ "$rc" -le 1 ] || { echo "fitness: grep failed with exit $rc while finding shortcut comments" >&2; exit 1; }
numbers=$(FITNESS_ROWS="$rows" FITNESS_HITS="$hits" node -e '
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const fail = (message) => {
  console.error("fitness: " + message);
  process.exit(1);
};
const read = (file) => fs.readFileSync(file, "utf8");
const parse = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest);
// The first node under root that test accepts, in source order.
const find = (root, test) => {
  let found;
  const visit = (node) => {
    if (found) return;
    if (test(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};
// The modules a file loads at run time: relative specifiers as repo paths, other names as written with node: dropped.
// Static imports and export-from count, and so do import() and require() calls with a string literal. import type and
// export type do not.
function loads(file) {
  const out = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
      if (node.moduleSpecifier && !typeOnly) out.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      out.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return [...out].map((spec) =>
    spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec.replace(/^node:/, ""),
  );
}
const tsFiles = [...fs.readdirSync("src").filter((f) => f.endsWith(".ts")).map((f) => "src/" + f), "server.ts"];

const nearFiles = process.env.FITNESS_ROWS.split("\n")
  .filter((row) => row !== "")
  .map((row) => row.slice(row.indexOf(" ") + 1));
const nearCapSrc = nearFiles.filter((file) => /^(src\/[^\/]+\.ts|server\.ts|app\.tsx)$/.test(file)).length;
const nearCapTest = nearFiles.filter((file) => file.startsWith("test/")).length;
const serverLines = read("server.ts").split("\n").length - 1;
const runtimeDeps = Object.keys(JSON.parse(read("package.json")).dependencies ?? {}).length;

const isDefineCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "define" &&
  ts.isPropertyAccessExpression(node.expression.expression) &&
  node.expression.expression.name.text === "settings" &&
  ts.isIdentifier(node.expression.expression.expression) &&
  node.expression.expression.expression.text === "bb";
const settingsArg = find(parse("server.ts"), isDefineCall)?.arguments[0];
if (!settingsArg || !ts.isObjectLiteralExpression(settingsArg)) fail("no bb.settings.define({...}) call in server.ts");
const settings = settingsArg.properties.length;

let commandsInit;
for (const statement of parse("src/commands.ts").statements) {
  if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    continue;
  }
  for (const decl of statement.declarationList.declarations) {
    if (ts.isIdentifier(decl.name) && decl.name.text === "commands") commandsInit = decl.initializer;
  }
}
while (
  commandsInit &&
  (ts.isAsExpression(commandsInit) || ts.isSatisfiesExpression(commandsInit) || ts.isParenthesizedExpression(commandsInit))
) {
  commandsInit = commandsInit.expression;
}
if (!commandsInit || !ts.isArrayLiteralExpression(commandsInit)) fail("no exported commands array in src/commands.ts");
const commands = commandsInit.elements.length;

const intervals = [...tsFiles, "app.tsx"].reduce((n, file) => n + (read(file).match(/setInterval\(/g) ?? []).length, 0);
const shortcuts = process.env.FITNESS_HITS.split("\n").filter((line) => line !== "").length;

// Layering: each forbidden module that a layered module loads counts once, whichever form loads it (see loads above).
// shortcut: only the imports a module makes itself are read, not what its imports load in turn; upgrade when a layered module imports a helper module
const forbidden = ["src/ssh.ts", "src/ona.ts", "src/provider.ts", "src/provider-connect.ts", "src/sync.ts", "child_process", "net", "http", "https"];
const layering = ["src/reconcile.ts", "src/names.ts", "src/time.ts", "src/machine-inputs.ts"].reduce(
  (n, file) => n + loads(file).filter((target) => forbidden.includes(target)).length,
  0,
);

// Cycles: a module counts when a run-time import path leads from it back to itself. Each walk visits each module once.
const edges = new Map(tsFiles.map((file) => [file, loads(file).filter((target) => tsFiles.includes(target))]));
const cycles = tsFiles.filter((start) => {
  const seen = new Set();
  const stack = [...edges.get(start)];
  while (stack.length > 0) {
    const at = stack.pop();
    if (at === start) return true;
    if (!seen.has(at)) {
      seen.add(at);
      stack.push(...edges.get(at));
    }
  }
  return false;
}).length;

const numbers = [
  ["near_cap_src", nearCapSrc],
  ["near_cap_test", nearCapTest],
  ["server_lines", serverLines],
  ["runtime_deps", runtimeDeps],
  ["settings", settings],
  ["commands", commands],
  ["intervals", intervals],
  ["shortcuts", shortcuts],
  ["layering", layering],
  ["cycles", cycles],
];
console.log(numbers.map(([name, value]) => name + " " + value).join("\n"));
') || { echo "fitness: node could not count the repo; its message is above" >&2; exit 1; }

if [ "$mode" = print ]; then
  printf '%s\n' "$numbers"
  exit 0
fi
baseline=scripts/fitness-baseline.txt
[ -f "$baseline" ] || { echo "fitness: $baseline is missing" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed '/^#/d' "$baseline" > "$tmp/baseline"
printf '%s\n' "$numbers" > "$tmp/numbers"
diff "$tmp/baseline" "$tmp/numbers" >&2 || {
  echo "fitness: a rise needs the owner's yes; a drop is recorded by lowering the baseline in the same PR" >&2
  exit 1
}
