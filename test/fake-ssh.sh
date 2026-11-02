#!/bin/sh
# Stand-in for ssh: drop options and the host, run the remote command locally.
# `ssh -N` is a tunnel: hold it open until the TunnelManager kills it.
while [ "$1" = "-o" ]; do shift 2; done
[ "$1" = "-N" ] && exec sleep 100000
shift
# A remote script that defaults to $HOME (the daemon uninstall) must never touch the developer's own.
exec env HOME="${FAKE_SSH_HOME:-$HOME}" sh -c "$*"
