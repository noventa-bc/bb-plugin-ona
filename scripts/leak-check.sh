#!/bin/sh
# Refuses a personal path (AGENTS.md rule 10): a user folder under the Users root or the home root.
# Each match is printed as file:line:path, or line:path for a message, not with the rest of its line.
#   scripts/leak-check.sh [repo root]     the files in the index, which a commit holds; CI runs it too
#   scripts/leak-check.sh --message FILE  a commit message; .githooks/commit-msg runs it
# The pattern is bracketed so that this file does not match itself.
set -u
here=$(cd "$(dirname "$0")" && pwd)
pattern='/([U]sers|[h]ome)/[^/ ]+'

refuse() {
  echo "leak-check: refused, a personal path (AGENTS.md rule 10); replace it with a placeholder" >&2
  exit 1
}

if [ "${1:-}" = --message ]; then
  [ -f "${2:-}" ] || { echo "leak-check: no commit message file ${2:-}" >&2; exit 1; }
  # Comment lines are blanked in place, not deleted, so a line number printed is the message file's own line.
  text=$(sed 's/^#.*//' "$2") || { echo "leak-check: cannot read $2" >&2; exit 1; }
  hits=$(printf '%s\n' "$text" | grep -n -o -E "$pattern")
else
  root=$(cd "${1:-$here/..}" && pwd) || exit 1
  hits=$(git -C "$root" grep --cached -n -o -E "$pattern" -- . ':!.agent')
fi
status=$?
[ "$status" -eq 1 ] && exit 0
[ "$status" -eq 0 ] || { echo "leak-check: search failed" >&2; exit 1; }
printf '%s\n' "$hits"
refuse
