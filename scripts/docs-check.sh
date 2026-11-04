#!/bin/sh
# The Markdown checks docs.yml runs and the pre-commit hook runs too: prettier, the 300-line limits
# of AGENTS.md and FACTORY.md, and relative links. They check the Markdown git tracks, so a
# git-ignored file such as .agent/HANDOFF.md is never checked. Exit 1 if any check fails.
#   scripts/docs-check.sh [repo root]
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "${1:-$here/..}" && pwd) || exit 1
cd "$root" || exit 1
fail=0

# The tracked Markdown files that are on disk, one per line: a file deleted without `git rm` is skipped.
tracked_markdown() {
  git -C "$root" ls-files -z -- '*.md' | tr '\0' '\n' | while IFS= read -r f; do [ -e "$f" ] && printf '%s\n' "$f"; done
}

# The repo's own prettier: npx would fetch one into a folder that has no node_modules.
tracked_markdown | tr '\n' '\0' | xargs -0 "$here/../node_modules/.bin/prettier" --check || fail=1

# The limits AGENTS.md and FACTORY.md set for themselves.
for f in AGENTS.md FACTORY.md; do
  [ -f "$f" ] || { echo "$f is missing"; fail=1; continue; }
  n=$(wc -l <"$f" | tr -d ' ')
  [ "$n" -le 300 ] || { echo "$f has $n lines; the limit is 300"; fail=1; }
done

# shortcut: reference-style and HTML links are not checked, and a bare target ends at its first ')', '#' or space (write a target with parentheses in angle brackets), upgrade when a dead link gets past this or an existing file is reported dead
# Relative Markdown links point at files that exist. Fenced blocks (``` or ~~~, indented or not) and
# inline code are skipped so link examples do not count. A link's title and anchor are not checked.
dead=$(tracked_markdown | while IFS= read -r f; do
  # The backticks and tildes are part of the sed script, not command substitutions.
  # shellcheck disable=SC2016
  sed -E '/^[[:space:]]*(```|~~~)/,/^[[:space:]]*(```|~~~)/d; s/`[^`]*`//g' "$f" | grep -oE '\]\(<[^>]+>|\]\([^)#]+' | sed -E 's/^\]\(<([^>#]*)[^>]*>.*/\1/; s/^\]\(([^[:space:]]*).*/\1/' | grep -vE '^(https?:|mailto:)' |
    while IFS= read -r t; do
      [ -e "$(dirname "$f")/$t" ] || echo "$f: dead link $t"
    done
done)
[ -z "$dead" ] || { printf '%s\n' "$dead"; fail=1; }

exit "$fail"
