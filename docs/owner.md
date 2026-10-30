# Owner guide: running agents on this repo

Agents work under the nono sandbox (`.nono/agent.jsonc`). Inside it they can
read and write their working folder and their own state (`~/.claude`,
`~/.codex`), read the toolchain, and reach only the model APIs. They can't read
`~/.ssh`, `~/.ona` or `~/.bb`, can't write anywhere else, and can't reach
localhost, so `ona`, `ssh` to boxes and the live bb server are out of reach.
Agents never commit or push; you review and commit.

## One-time setup

- `brew install nono` (profile checked with nono 0.81.0; re-run the checks
  below after upgrading, since nono is pre-1.0).
- Claude Code keeps its login in the macOS keychain, which the sandbox blocks.
  Run `claude setup-token` once, then store the token where nono reads it
  (paste it at the prompt):
  `security add-generic-password -U -s nono -a claude_code_oauth_token -w`.
  The scripts have nono pass it in as `CLAUDE_CODE_OAUTH_TOKEN`; an exported
  `CLAUDE_CODE_OAUTH_TOKEN` takes precedence. Don't write it into a file.
- GitHub repository settings: turn on secret scanning, push protection and
  Dependabot alerts.

## Dispatch

- Unattended: `scripts/agent-run.sh "<task brief>" [claude|codex]`. It creates
  `../bb-ona-worktrees/<slug>` on branch `agent/<slug>`, runs the agent there
  and prints where the handoff is. `AGENT_BUDGET_USD` caps a Claude run
  (default 5).
- Attended: `scripts/agent-shell.sh [claude|codex]` from this checkout or a
  worktree. Prompts stay on.
- bb threads opened on this repo run outside the sandbox and rely only on the
  `ask` rules in `.claude/settings.json`. Prefer `agent-shell.sh`.

### Task brief template

```
Goal: <one sentence, user-visible outcome>
Scope: <files or area>; out of scope: <...>
Done when: <tests or behaviour>; `npm run check` passes.
Constraints: <decisions or rules that matter here>
```

Before dispatching, check the task against the accepted records in
`docs/decisions/`. If it conflicts, decide first and say so in the brief, since
an unattended agent skips a conflicting item.

## Review a handoff

1. Read `.agent/HANDOFF.md` in the worktree, then the diff (`git -C <worktree> diff`).
2. Run `npm run check` in the worktree (outside the sandbox, so every test runs).
3. Stage files by name, commit, then run `/changelog` to add the hash and commit that.
4. Apply "Process feedback" proposals to `AGENTS.md` yourself, if they hold up.
5. Remove the worktree: `git worktree remove <worktree>` and `git branch -D agent/<slug>`.

## Promote to live

bb loads the plugin from this folder. After merging into this checkout, run
`~/.bb/bin/bb plugin reload ona`, then `bb ona status` and the handoff's
live-test steps.

## Sandbox checks (nono 0.81.0, checked 2026-10-30)

- `npm run check` passes inside the sandbox; tests that need local ports or
  other processes skip themselves there.
- Reading `~/.ona`, `~/.ssh` and `~/.bb` fails; writing outside the working
  folder fails; a local listener on `127.0.0.1` can't be reached; a
  non-allowed domain can't be reached.
- `agent-run.sh` warns if a run changed `~/.claude/settings.json` or
  `~/.codex/config.toml`, the agents' own config, which the sandbox leaves
  writable.

## Open items

- Codex doesn't connect through nono's network proxy yet (it fails at
  "workspace routing discovery"), so unattended runs are Claude-only for now.
