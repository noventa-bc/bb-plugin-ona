#!/bin/sh
# Merge a pull request only once the workflow it needs has run and every check
# passed (FACTORY.md steps 8 and 9). A PR that touches code needs `check`, one
# that touches Markdown needs `docs`, one with both needs both. The squash
# subject is the PR title, and only the head commit the checks ran on is merged.
#
#   scripts/pr-merge.sh <pr number>
set -e
pr=$1
[ -n "$pr" ] || { echo "usage: scripts/pr-merge.sh <pr number>" >&2; exit 2; }

title=$(gh pr view "$pr" --json title --jq .title)
sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
files=$(gh pr diff "$pr" --name-only)
needed=""
if printf '%s\n' "$files" | grep -qv '\.md$'; then needed="check"; fi
if printf '%s\n' "$files" | grep -q '\.md$'; then needed="$needed docs"; fi

# GitHub sometimes drops the pull_request event; FACTORY step 8 says to push
# again in that case, so give up after 5 minutes instead of merging blind.
has_run() {
  gh pr checks "$pr" --json name --jq "[.[] | select(.name == \"$1\")] | length" 2>/dev/null | grep -q '^[1-9]'
}
for job in $needed; do
  tries=0
  until has_run "$job"; do
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      echo "PR $pr has no '$job' run after 5 minutes; push a merge of main or an empty commit to retrigger it" >&2
      exit 1
    fi
    sleep 10
  done
done

gh pr checks "$pr" --watch --fail-fast >/dev/null || true
# shellcheck disable=SC2016
not_passed=$(gh pr checks "$pr" --json name,bucket --jq '[.[] | select(.bucket != "pass" and .bucket != "skipping")] | length') || not_passed=unknown
if [ "$not_passed" != "0" ]; then
  gh pr checks "$pr" >&2 || true
  echo "PR $pr is not green ($not_passed check(s) not passed); not merging" >&2
  exit 1
fi
gh pr merge "$pr" --squash --delete-branch --subject "$title" --match-head-commit "$sha"
