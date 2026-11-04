#!/bin/sh
# Fails unless the running Node is the exact version .nvmrc pins. CI installs that version.
#   scripts/node-check.sh [path to .nvmrc]
set -eu
nvmrc=${1:-$(dirname "$0")/../.nvmrc}
pin=
if [ -f "$nvmrc" ]; then pin=$(tr -d '[:space:]' <"$nvmrc"); fi
pin=${pin#v}
[ -n "$pin" ] || { echo "node-check: $nvmrc is missing or empty; it must pin one Node version" >&2; exit 1; }
running=$(node --version)
running=${running#v}
if [ "$running" != "$pin" ]; then
  printf '%s\n' "Node $running is running; .nvmrc pins $pin. Run \`nvm install $pin && nvm use $pin\`." >&2
  exit 1
fi
