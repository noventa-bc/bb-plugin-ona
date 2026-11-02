#!/bin/sh
# Exit 0 if the commit message on stdin is a Conventional Commit: first line
# `type(scope)!: subject`, scope and `!` optional, at most 100 characters.
# Merge, `Revert "`, `fixup!` and `squash!` commits pass. Used by .githooks/commit-msg and
# scripts/release-check.sh (CI), so the rule lives only here.
subject=$(head -n 1)
case $subject in "Merge "* | "Revert \""* | "fixup! "* | "squash! "*) exit 0 ;; esac
if [ ${#subject} -le 100 ] && printf '%s\n' "$subject" |
  grep -Eq '^(feat|fix|perf|refactor|docs|test|ci|chore|build|revert)(\([a-z0-9/.-]+\))?!?: .+'; then
  exit 0
fi
cat >&2 <<MSG
Not a Conventional Commit: $subject
Rule: type(scope)!: subject, one line of at most 100 characters; type is one of
feat fix perf refactor docs test ci chore build revert; scope and ! are optional.
Examples: "feat(sync): resume a stopped box before the thread starts"
          "fix!: drop the removed tunnel setting"
MSG
exit 1
