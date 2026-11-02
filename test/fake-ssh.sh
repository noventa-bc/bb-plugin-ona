#!/bin/sh
# Stand-in for ssh: drop options and the host, run the remote command locally.
# `ssh -N` is a tunnel: hold it open until the TunnelManager kills it.
while [ "$1" = "-o" ]; do shift 2; done
[ "$1" = "-N" ] && exec sleep 100000
shift
# A remote script that reads the home (the daemon uninstall, the cost collectors) must never see the developer's own.
exec env -u CLAUDE_CONFIG_DIR HOME="${FAKE_SSH_HOME:-$HOME}" sh -c "$*"
