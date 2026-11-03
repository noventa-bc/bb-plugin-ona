#!/bin/sh
# Refuses a staged text file that holds a personal path (AGENTS.md rule 10): a user folder under
# the Users root or the home root. It searches the whole index, not only this commit's changes, so
# a commit that keeps an earlier file (git commit --amend) is checked too. -I skips binary files.
# Prints file:line for each hit and exits 1. Run by .githooks/pre-commit. The patterns are bracketed
# so that this file does not match itself.
#   scripts/leak-check.sh [repo root]
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "${1:-$here/..}" && pwd) || exit 1

hits=$(git -C "$root" grep --cached -I -n -e '/[U]sers/[^/ ]*/' -e '/[h]ome/[^/ ]*/' -- . ':!.agent')
status=$?
[ "$status" -eq 1 ] && exit 0
[ "$status" -eq 0 ] || { echo "leak-check: git grep failed in $root" >&2; exit 1; }
printf '%s\n' "$hits"
exit 1
