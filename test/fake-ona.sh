#!/bin/sh
# Stand-in for the ona CLI: canned environment and project lists, argv logged to $FAKE_ONA_LOG.
if [ -n "${FAKE_ONA_FAIL:-}" ]; then
  printf '%s\n' "$FAKE_ONA_FAIL" >&2
  exit 1
fi
if [ -n "${FAKE_ONA_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$FAKE_ONA_LOG"
fi
case "$1 $2" in
  "environment list")
    cat "$FAKE_ONA_ENVIRONMENTS" ;;
  "project list")
    if [ -n "${FAKE_ONA_PROJECTS:-}" ]; then cat "$FAKE_ONA_PROJECTS"; else printf '[]\n'; fi ;;
esac
exit 0
