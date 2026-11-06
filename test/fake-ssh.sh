#!/bin/sh
# Stand-in for ssh: drop options and the host, run the remote command locally.
# `ssh -N` is a tunnel: hold it open until the TunnelManager kills it.
# With FAKE_SSH_LOG set, every call first appends its arguments there.
# With FAKE_SSH_HOME set, each tunnel first appends its pid to $FAKE_SSH_HOME/tunnel-pids.
[ -z "${FAKE_SSH_LOG:-}" ] || echo "$*" >>"$FAKE_SSH_LOG"
while [ "$1" = "-o" ]; do shift 2; done
if [ "$1" = "-N" ]; then
  [ -z "${FAKE_SSH_HOME:-}" ] || echo $$ >>"$FAKE_SSH_HOME/tunnel-pids"
  exec sleep 100000
fi
shift
# A remote script that reads the home (removing an adopted box, the cost collectors) must never see the developer's own.
exec env -u CLAUDE_CONFIG_DIR HOME="${FAKE_SSH_HOME:-$HOME}" sh -c "$*"
