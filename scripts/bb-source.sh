#!/bin/sh
# Prints the installed bb version, then each definition of <name> in bb's server bundle with the lines after
# it. With --sdk, prints each definition in the plugin SDK typings in node_modules instead, without the
# version. Read-only.
#   scripts/bb-source.sh <name> [lines, default 60]
#   scripts/bb-source.sh --sdk <name> [lines]
# BB_APP_DIR is the bb-app package folder; by default it is the one inside /Applications/bb.app.
set -eu
usage() { echo "usage: scripts/bb-source.sh [--sdk] <name> [lines]" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)
sdk=
if [ "${1:-}" = --sdk ]; then sdk=1; shift; fi
[ $# -le 2 ] || usage
name=${1:-}
lines=${2:-60}
case $name in ''|*[!A-Za-z0-9_]*) usage ;; esac
case $lines in ''|0?*|*[!0-9]*) usage ;; esac

if [ -n "$sdk" ]; then
  file=$root/node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts
else
  pkg=${BB_APP_DIR:-/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app}
  file=$pkg/server/dist/start-server.js
  [ -f "$file" ] || { echo "bb-source: no bb server bundle at $file; set BB_APP_DIR to the bb-app folder" >&2; exit 1; }
  version=$(sed -n 's/^[[:space:]]*"version": *"\([^"]*\)".*/\1/p' "$pkg/package.json" | head -n 1)
  [ -n "$version" ] || { echo "bb-source: no version in $pkg/package.json" >&2; exit 1; }
  echo "bb-app $version: $file"
fi
[ -f "$file" ] || { echo "bb-source: no SDK typings at $file; run npm ci --ignore-scripts" >&2; exit 1; }

# A definition is `function <name>(` or `function <name><`, `interface <name>`, `const <name>`, or `<name> =`
# (a dot before the name, `==` and `=>` do not count).
# shortcut: a comment that quotes a definition counts; class methods, enums, classes, interface members and `this.<name> =` are missed, upgrade when one of those is the definition needed
found=$(grep -n -E "function ${name}[(<]|interface $name([^A-Za-z0-9_]|\$)|const $name([^A-Za-z0-9_]|\$)|(^|[^A-Za-z0-9_\$.])$name *=([^=>]|\$)" "$file" | cut -d: -f1) || true
[ -n "$found" ] || { echo "bb-source: no definition of $name in $file" >&2; exit 1; }
for n in $found; do
  echo "--- $file:$n"
  sed -n "$n,$((n + lines))p" "$file"
done
