#!/usr/bin/env bash
# PR gate (check.yml): the PR title and every commit since the base are Conventional Commits, and
# package.json's version moved as the title requires: `!` or a `BREAKING CHANGE:` footer in the body
# bumps major, `feat` minor, `fix` and `perf` patch, any other type or a Markdown-only change leaves it unchanged.
#
#   PR_TITLE=... PR_BODY=... scripts/release-check.sh <base, e.g. origin/main>
#
set -euo pipefail

base=$1
here=$(dirname "$0")

printf '%s\n' "$PR_TITLE" | "$here/conventional.sh"
git log --format=%s "$base..HEAD" | while IFS= read -r subject; do
  printf '%s\n' "$subject" | "$here/conventional.sh"
done

bump=$(printf '%s\n' "${PR_BODY-}" | "$here/bump-kind.sh" "$PR_TITLE" "$base")

was=$(git show "$base:package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
now=$(node -p "require('./package.json').version")
# shellcheck disable=SC2016  # the ${} below are JavaScript template literals
node -e '
  const [was, now, bump] = process.argv.slice(1);
  const [a, b, c] = was.split(".").map(Number);
  const want = { major: [a + 1, 0, 0], minor: [a, b + 1, 0], patch: [a, b, c + 1], none: [a, b, c] }[bump].join(".");
  if (now !== want) { console.error(`package.json version is ${now}; a ${bump} bump from ${was} needs ${want}: run scripts/bump.sh "<PR title>"`); process.exit(1); }
  console.log(`version ${now}: ${bump} bump from ${was}`);
' "$was" "$now" "$bump"
