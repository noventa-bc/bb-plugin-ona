# Owner guide: running agents on this repo

Agents work under the nono sandbox (`.nono/agent.jsonc`). Inside it they can
read and write their working folder and their own state (`~/.claude`,
`~/.codex`), read the toolchain, and reach only the model APIs. They can't read
`~/.ssh`, `~/.ona` or `~/.bb`, can't write anywhere else, and can't reach
localhost, so `ona`, `ssh` to boxes and the live bb server are out of reach.
Agents never commit to `main`. Outside the orchestrated flow they commit
nothing and don't push; you review, commit and merge. Inside it, `FACTORY.md`
(Permissions) says what the orchestrator may do.

## One-time setup

- `brew install nono` (profile checked with nono 0.81.0; re-run the checks
  below after upgrading, since nono is pre-1.0).
- Install the ponytail plugin in Claude Code (installed 5.3.3 on 2026-10-30):
  `claude plugin marketplace add DietrichGebert/ponytail`, then
  `claude plugin install ponytail@ponytail`. It needs `node` on `PATH` for its
  hooks. Leave its optional webhook and ledger settings unset. Agents then
  have `/ponytail`, `/ponytail-review`, `/ponytail-audit` and `/ponytail-debt`.
- Claude Code keeps its login in the macOS keychain, which the sandbox blocks.
  Run `claude setup-token` once, then store the token where nono reads it
  (paste it at the prompt):
  `security add-generic-password -U -s nono -a claude_code_oauth_token -w`.
  The scripts have nono pass it in as `CLAUDE_CODE_OAUTH_TOKEN`; an exported
  `CLAUDE_CODE_OAUTH_TOKEN` takes precedence. Don't write it into a file.
- `npm install` sets up the git hooks in `.githooks` (`npm ci --ignore-scripts`
  does not); what they run is in `.githooks/pre-commit` and `.githooks/commit-msg`.
- GitHub repository settings: turn on secret scanning, push protection and
  Dependabot alerts. Add a ruleset on the default branch that blocks
  deletion and force pushes and requires a pull request with squash merge
  and no required reviews. Do not require status checks: `check.yml` skips
  Markdown-only changes, so a required `check` would block docs PRs.

## Dispatch

- Unattended: `scripts/agent-run.sh "<task brief>" [claude|codex]`. It creates
  `../bb-ona-worktrees/<slug>` on branch `agent/<slug>`, runs the agent there
  and prints where the handoff is. `AGENT_BUDGET_USD` caps a Claude run
  (default 5).
- Attended: `scripts/agent-shell.sh [claude|codex]` from this checkout or a
  worktree. Prompts stay on.
- bb threads opened on this repo run outside the sandbox, with only the
  agent's own permission prompts and `AGENTS.md`. Prefer `agent-shell.sh`.

### Task brief template

The standing rules are in the builder's definition, `.claude/agents/builder.md`; the brief holds only the task:

```
Role: builder (`.claude/agents/builder.md`)
Branch: `agent/<slug>`; worktree: `<absolute path>`; node: `<bin folder of the node version in .nvmrc>`
Goal: <one sentence, user-visible outcome>
Scope: <files or area, quoting the text of each line to change, not its number>; out of scope: <...>
Tests first: <each test, and the bug or rule its title names; "guard, no `// Bug:` line" when main has no bug>
Coupled changes: <the AGENTS.md "Coupled changes" this task touches, or none>
Constraints: <decisions or rules that matter here>
Done when: <tests or behaviour>
```

Before dispatching, check the task against the accepted records in
`docs/decisions/`. If it conflicts, decide first and say so in the brief, since
an unattended agent skips a conflicting item. A brief for a lifecycle call
names the shape of bb's answer (an accepted suspend or resume answers 202
before the operation runs, and a refusal comes back at once as a 4xx;
`docs/ona-notes.md`, checked 2026-11-05), so the builder designs a phase check
on the settled host, not on the answer.

### Reviewer brief template

FACTORY.md step 6 points here. The standing rules are in the reviewer's definition, named in `Role:`; the brief holds only the task:

```
Role: reviewer, pass `adversarial` (`.claude/agents/reviewer-adversarial.md`), `code-review` (`.claude/agents/reviewer-code.md`) or `ponytail-review` (no definition, see below)
Target: worktree `<absolute path>`; commit `<sha>`; base `origin/main`; diff `git -C <worktree> diff origin/main...<sha>`
Scratch folder: `<new absolute path under the session scratchpad>`; node: `<bin folder of the node version in .nvmrc>`
Round: <n>; the passes this round are the ones FACTORY.md step 6 gives it.
Scope: the item's code (roadmap label `<label>`); anything outside it goes under "Pre-existing".
Known roadmap items, not to re-report: <labels only>.
Check list: <what to check in this diff: the coupled changes it touches, the docs it changes against the code, each new test against the rule its title names, the checks to run>.
```

The ponytail pass has no definition: run it as a general-purpose agent with this brief, which names only the `## Standing rules` section of `.claude/agents/reviewer-code.md`; the agent runs `/ponytail-review branch`.

## Review a handoff outside the orchestrated flow

1. Read `.agent/HANDOFF.md` in the worktree, then the diff (`git -C <worktree> diff HEAD`; the work is staged).
   Decide on anything under "Needs owner review", and check that each added
   piece of complexity is worth what the handoff says it costs.
2. Run `npm run check` in the worktree (outside the sandbox, so every test runs) and read its exit code before the commit in step 3.
3. Stage files by name and commit.
4. Apply "Process feedback" proposals to `AGENTS.md` yourself, if they hold up.
5. Remove the worktree: `git worktree remove <worktree>` and `git branch -D agent/<slug>`.

## Verify after upgrading bb (or reloading the plugin)

bb loads the plugin from this folder. After merging into this checkout, or
after a bb upgrade, run through this list:

1. `~/.bb/bin/bb plugin reload ona`, then `bb ona status`.
2. From inside a devbox, the two probes under "Check it yourself" in
   `docs/security.md` (403 on `/api/v1/projects`, 200 on `/health`).
3. One `bb ona new <project>` and one resume of a stopped box, plus the
   handoff's live-test steps.
4. A few minutes later, `bb plugin logs ona`: the same action repeating every
   pass means a repair that never sticks, and an `ona proxy blocked` line for an
   `/internal` path other than `/internal/server-move/*` means the new bb has a
   daemon route `src/proxy.ts` must list.

## Release

A release is a PR whose title is a `feat`, `fix`, `perf` or `!` Conventional
Commit. That PR bumps `version` in `package.json` as the title requires
(`check.yml` fails otherwise; `scripts/release-check.sh` has the rule). On
merge, `release.yml` tags the squash commit `vX.Y.Z` and creates the GitHub
release with notes generated from the PR titles merged since the previous tag
(`https://github.com/noventa-bc/bb-plugin-ona/releases`); a version that
already has a release is left alone. Nobody tags by hand.

If the release run fails, fix `main` through a PR, then rerun `release.yml`
from the Actions tab (`workflow_dispatch`) or let the next push to `main` run
it. Never move a tag: bb's `git:` installs resolve a semver range to tags, so
a fix ships as a new version.

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
