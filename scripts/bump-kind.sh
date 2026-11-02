#!/bin/sh
# Print the semver bump a PR asks for: `!` in the title or a `BREAKING CHANGE:`
# line in the body (stdin) means major, `feat` minor, `fix` and `perf` patch,
# any other type none. A change that touches only Markdown is never a bump.
# Used by scripts/bump.sh and scripts/release-check.sh, so the rule lives here.
#
#   printf '%s' "$body" | scripts/bump-kind.sh "<PR title>" <base, e.g. main>
title=$1
base=$2
if [ -z "$(git diff --name-only "$base...HEAD" -- . ':!*.md')" ]; then
  echo none
  exit 0
fi
kind=none
case ${title%%[(!:]*} in feat) kind="minor" ;; fix | perf) kind="patch" ;; esac
if printf '%s\n' "$title" | grep -Eq '^[a-z]+(\([^)]*\))?!: ' || grep -q '^BREAKING CHANGE:'; then
  kind=major
fi
echo "$kind"
