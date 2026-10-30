#!/usr/bin/env bash
# Run a coding agent unattended on a task, in its own git worktree, under the
# nono sandbox (.nono/agent.jsonc). The agent leaves uncommitted changes and
# .agent/HANDOFF.md for the owner to review. See docs/owner.md.
#
#   scripts/agent-run.sh "<task brief>" [claude|codex]
#
# Claude's login: the sandbox has no keychain access, so nono passes in the token
# from `claude setup-token`, stored once in the keychain (see docs/owner.md), or
# CLAUDE_CODE_OAUTH_TOKEN if it is exported. AGENT_BUDGET_USD caps a claude run (default 5).
set -euo pipefail

brief=${1:?usage: scripts/agent-run.sh "<task brief>" [claude|codex]}
agent=${2:-claude}
repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
slug=$(printf '%s' "$brief" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40 | sed 's/-*$//')-$(date +%m%d%H%M)
tree="$repo/../bb-ona-worktrees/$slug"

credential=()
case $agent in
  claude)
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      security find-generic-password -s nono -a claude_code_oauth_token >/dev/null 2>&1 ||
        { echo "No Claude token: see docs/owner.md, one-time setup." >&2; exit 1; }
      credential=(--env-credential-map claude_code_oauth_token CLAUDE_CODE_OAUTH_TOKEN)
    fi ;;
  codex) ;;
  *) echo "agent must be claude or codex" >&2; exit 1 ;;
esac

git -C "$repo" worktree add -q -b "agent/$slug" "$tree" HEAD
cp -c -R "$repo/node_modules" "$tree/node_modules" 2>/dev/null || cp -R "$repo/node_modules" "$tree/node_modules"
mkdir -p "$tree/.agent"

prompt="$brief

You are running unattended. Follow AGENTS.md. Don't ask questions: decide, or record the question in the handoff. Finish by writing .agent/HANDOFF.md."

# Sessions can write the agents' own config; warn if a run changed it.
watched=("$HOME/.claude/settings.json" "$HOME/.codex/config.toml")
before=$(cat "${watched[@]}" 2>/dev/null | shasum)

sandbox=(nono run -s --allow-cwd --profile "$repo/.nono/agent.jsonc"
  --read "$repo/.git" --allow "$repo/.git/worktrees/$slug" ${credential[@]+"${credential[@]}"} --)
cd "$tree"
status=0
if [ "$agent" = claude ]; then
  "${sandbox[@]}" claude -p "$prompt" --permission-mode bypassPermissions \
    --max-budget-usd "${AGENT_BUDGET_USD:-5}" \
    --settings '{"permissions":{"deny":["Bash(git commit:*)","Bash(git push:*)"]}}' \
    </dev/null || status=$?
else
  "${sandbox[@]}" codex exec --sandbox danger-full-access "$prompt" </dev/null || status=$?
fi

[ "$before" = "$(cat "${watched[@]}" 2>/dev/null | shasum)" ] ||
  echo "WARNING: the run changed ~/.claude/settings.json or ~/.codex/config.toml. Check it before your next session." >&2
echo "Worktree: $tree"
echo "Handoff:  $tree/.agent/HANDOFF.md"
exit $status
