#!/bin/sh
# Bump package.json (and the lockfile) the way the PR title requires, before
# the PR is opened. CI then checks the same rule with scripts/release-check.sh.
#
#   scripts/bump.sh "<PR title>" [base, default main]
set -e
kind=$(scripts/bump-kind.sh "$1" "${2:-main}" </dev/null)
if [ "$kind" = none ]; then
  echo "no bump: $1"
  exit 0
fi
npm version "$kind" --no-git-tag-version
