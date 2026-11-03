#!/bin/sh
# Stand-in for gh in the scripts/pr-merge.sh tests: a PR whose checks all ran
# and passed. Its changed files come from FAKE_GH_FILES, how far it is behind
# main from FAKE_GH_BEHIND. Every call is appended to FAKE_GH_LOG.
printf '%s\n' "$*" >>"$FAKE_GH_LOG"
case "$1 $2" in
# The field name stands in for its value (the title, the head sha).
"pr view") echo "$5" ;;
"pr diff") printf '%s\n' "$FAKE_GH_FILES" ;;
# `--json name` counts the runs of a job; `--json name,bucket` counts the checks not passed.
"pr checks") case "$5" in name) echo 1 ;; name,bucket) echo 0 ;; esac ;;
# Only the compare call pr-merge.sh must make answers; FAKE_GH_BEHIND=fail plays an API error.
"api repos/{owner}/{repo}/compare/main...headRefOid") [ "$3 $4" = "--jq .behind_by" ] && [ "$FAKE_GH_BEHIND" != fail ] && echo "$FAKE_GH_BEHIND" || exit 1 ;;
esac
