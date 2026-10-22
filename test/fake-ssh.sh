#!/bin/sh
# Stand-in for ssh: drop options and the host, run the remote command locally.
while [ "$1" = "-o" ]; do shift 2; done
shift
exec sh -c "$*"
