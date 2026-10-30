#!/usr/bin/env bash
# Start an interactive agent session in the current folder (this checkout or a
# worktree) under the nono sandbox, with the agent's normal permission prompts.
#
#   scripts/agent-shell.sh [claude|codex] [agent args...]
#
# Env: CLAUDE_CODE_OAUTH_TOKEN for claude (see docs/owner.md).
set -euo pipefail

agent=${1:-claude}
shift || true
profile=$(cd "$(dirname "$0")/.." && pwd)/.nono/agent.jsonc
here=$(git rev-parse --show-toplevel)
gitdir=$(git rev-parse --absolute-git-dir)
common=$(git rev-parse --path-format=absolute --git-common-dir)

extra=()
# In a worktree, git metadata lives in the main checkout.
[ "$gitdir" = "$common" ] || extra=(--read "$common" --allow "$gitdir")

cd "$here"
exec nono run --allow-cwd --profile "$profile" ${extra[@]+"${extra[@]}"} -- "$agent" "$@"
