#!/bin/sh
# Stand-in for the ona CLI: canned environment and project lists, one `get`, and `keep-alive` running the
# command after `--`; argv logged to $FAKE_ONA_LOG.
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
  "environment get")
    # The real CLI's messages for an unknown uuid and for a ref that isn't one (docs/ona-notes.md).
    if [ -n "${FAKE_ONA_GET:-}" ]; then cat "$FAKE_ONA_GET"
    else
      case "$3" in
        env-*) echo "Error: not_found: environment not found" >&2 ;;
        *) printf 'Error: no environment found matching "%s"\nPossible resolutions:\n  - Run `ona environment list`\n' "$3" >&2 ;;
      esac
      exit 1
    fi ;;
  "project list")
    if [ -n "${FAKE_ONA_PROJECTS:-}" ]; then cat "$FAKE_ONA_PROJECTS"; else printf '[]\n'; fi ;;
  "environment keep-alive")
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    shift
    exec "$@" ;;
esac
exit 0
