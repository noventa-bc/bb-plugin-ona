#!/usr/bin/env bash
# Start an interactive Claude session in the current folder (this checkout or a
# worktree) under the nono sandbox, with Claude's normal permission prompts.
#
#   scripts/agent-shell.sh [claude args...]
#
set -euo pipefail

profile=$(cd "$(dirname "$0")/.." && pwd)/.nono/agent.jsonc
here=$(git rev-parse --show-toplevel)
gitdir=$(git rev-parse --absolute-git-dir)
common=$(git rev-parse --path-format=absolute --git-common-dir)

extra=()
# Claude's login from the keychain, unless CLAUDE_CODE_OAUTH_TOKEN is exported (see docs/owner.md).
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] ||
  extra=(--env-credential-map claude_code_oauth_token CLAUDE_CODE_OAUTH_TOKEN)
# In a worktree, git metadata lives in the main checkout.
[ "$gitdir" = "$common" ] || extra+=(--read "$common" --allow "$gitdir")

cd "$here"
exec nono run --allow-cwd --profile "$profile" ${extra[@]+"${extra[@]}"} -- claude "$@"
