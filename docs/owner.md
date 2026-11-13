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

- Unattended: `scripts/agent-run.sh "<task brief>"`. It creates
  `../bb-ona-worktrees/<slug>` on branch `agent/<slug>`, runs Claude there
  and prints where the handoff is. `AGENT_BUDGET_USD` caps a run (default 5).
- Attended: `scripts/agent-shell.sh [claude|codex]` from this checkout or a
  worktree. Prompts stay on.
- bb threads opened on this repo run outside the sandbox, with only the
  agent's own permission prompts and `AGENTS.md`. Prefer `agent-shell.sh`.

### Task brief template

The standing rules are in `AGENTS.md` "Subagents"; the builder's definition, `.claude/agents/builder.md`, holds what is particular to the builder. The brief holds only the task:

```
Role: builder (`.claude/agents/builder.md`)
Branch: `agent/<slug>`; worktree: `<absolute path>`; node: `<bin folder of the node version in .nvmrc>`
Goal: <one sentence, user-visible outcome>
Scope: <files or area, quoting the text of each line to change, not its number>; out of scope: <...>
Tests first: <each test, and the bug or rule its title or the handoff names; "guard, no `// Bug:` line" when main has no bug>
Coupled changes: <the AGENTS.md "Coupled changes" this task touches, or none>
Model: <Opus at low effort, or Opus at medium with the reason>
Constraints: <decisions or rules that matter here; a dependency the owner approved, if any>
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

FACTORY.md step 6 points here. The standing rules are in `AGENTS.md` "Subagents" and `docs/review-standards.md` "How reviewers work" and "Report"; the reviewer's definition, named in `Role:`, holds what is particular to its pass. The brief holds only the task:

```
Role: reviewer, pass `adversarial` (`.claude/agents/reviewer-adversarial.md`), `code-review` (`.claude/agents/reviewer-code.md`) or `ponytail-review` (`.claude/agents/reviewer-ponytail.md`, see below)
Target: worktree `<absolute path>` (a fresh agent starts in the main checkout, so pass this path); commit `<sha>`; base `origin/main`; diff `git -C <worktree> diff origin/main...<sha>`; `ponytail-review` target: `<branch, or the PR link>`
Scratch folder: `<new absolute path under the session scratchpad>`; node: `<bin folder of the node version in .nvmrc>`
Model: <Haiku at max effort, or Opus at medium with the reason>
Round: <n>; the passes this round are the ones FACTORY.md step 6 gives it.
Scope: the item's code (roadmap label `<label>`); anything outside it goes under "Pre-existing".
Known roadmap items, not to re-report: <labels only>.
Check list: <what to check in this diff: the coupled changes it touches, the docs it changes against the code, each new test against the rule its title names, the checks to run>.
```

The ponytail pass runs as the `reviewer-ponytail` definition (Haiku at max effort, set there). It gets this brief and runs `/ponytail-review` on the target the brief names (`branch`, or a PR link), against the worktree on its `Target:` line.

## Review a handoff outside the orchestrated flow

1. Read `.agent/HANDOFF.md` in the worktree, then the diff (`git -C <worktree> diff HEAD`; the work is staged).
   Decide on anything under "Needs owner review", and check that each added
   piece of complexity is worth what the handoff says it costs.
2. Run `npm run check` in the worktree (outside the sandbox, so every test runs) and read its exit code before the commit in step 3.
3. Stage files by name and commit.
4. Apply "Process feedback" proposals to `AGENTS.md` yourself, if they hold up: agents only propose them.
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

A release is a PR whose title bumps the version (the rule is in `AGENTS.md`
"Live systems" and `scripts/bump-kind.sh`); `check.yml` fails when its
`package.json` does not match (`scripts/release-check.sh`). On
merge, `release.yml` tags the squash commit `vX.Y.Z` and creates the GitHub
release with notes generated from the PR titles merged since the previous tag
(`https://github.com/noventa-bc/bb-plugin-ona/releases`); a version that
already has a release is left alone. Nobody tags by hand.

If the release run fails, fix `main` through a PR, then rerun `release.yml`
from the Actions tab (`workflow_dispatch`) or let the next push to `main` run
it. Never move a tag: bb's `git:` installs resolve a semver range to tags, so
a fix ships as a new version.

Once per release, run `/doctor prompt-audit`.

## Metric lines and product numbers

The plugin writes `metric` lines to its log, which `bb plugin logs ona` prints. Each is `metric <event> key=value ...`, and a value's spaces and `=` are written as `_`:

- `metric cmd name=<sync|reconnect|resume>`: a hand run. A hand run is any run of `bb ona sync`, `bb ona reconnect` or `bb ona resume`, including the buttons in the Ona devboxes section and runs by an agent.
- `metric start env=<id> via=<create|resume|wake-thread|wake-cmd> up=<seconds>`: the plugin asked Ona to start a box; `via` says what led to it, and `up` is the seconds since the plugin loaded. The line is written when the attempt begins, so it records an attempt, not a success.
- `metric connected via=<create|resume|wake|reconnect> box=<new|stopped|running> secs=<n> ok=<1|0>`: a connect call ended. `box` is `new` once Ona has returned the created box, including a create that fails after that (`ok=0`). Otherwise it is `stopped` when the call started the box, and `running` otherwise, which includes a create that failed before Ona returned a box. `ok=0` means the call failed.
- `metric delete env=<id> via=<remove|cleanup>`: the plugin deleted a box.
- `metric keep env=<id> via=<remove|cleanup> commits=<n> files=<n>`: the plugin refused to delete a box with unpushed commits or uncommitted files, and kept it. `metric keep env=<id> via=<remove|cleanup> git=unknown`: the plugin refused because Ona's listing had no `status.content.git` block for the box, and kept it.
- `metric mismatch host=<machine> kind=<kind> secs=<n>`: written once per incident, at the first pass that sees the same kind 120 seconds or more after the first pass that saw it (both counted from each pass's start); `secs` is the time between those two starts. A change of kind, or a pass that reads the box and finds no kind, starts a new incident, and so does a machine bb stops listing; a pass that does not read the box (a failed listing, or one listing that omits it) neither ends an incident nor restarts its count. Kinds: `active-stopped` (bb active and connected, Ona stopped or stopping); `active-gone` (bb active, Ona says deleted or deleting, or two good listings in a row lack the box and a lookup by id finds no live box); `disconnected-running` (bb active but disconnected, Ona running). Other disagreements write no line.

`scripts/product-numbers.sh` prints the product numbers from the log; its header has the command. It prints one `name value` line per number, in a fixed order. Every name is printed: `0` when nothing matched, and a percentile is `-` when there is no value. `mismatches` counts the `metric mismatch` lines; a line with no kind counts only there. After the fixed names come one `mismatches_<kind>` line per kind seen (`-` written as `_`), then one `hand_runs_week_<year>-W<week>` line per ISO week that has hand runs, oldest first. The weeks are UTC.

`deletes_refused` counts the boxes a removal refused at least once, not keep lines: a box refused more than once has a keep line for each refusal. `deletes_refused_git_unknown` counts those boxes the same way, from the `git=unknown` keep lines. `connect_secs_stopped_*` covers the connects that worked (`ok=1`) with `box=stopped` or `box=new`, and `connect_secs_running_*` those with `box=running`. `skipped_lines` counts the input lines that are not log lines: lines that are not a JSON object, and JSON objects whose `ts` is not a number a Date can hold or whose `message` is not a string. A log line whose first word is not `metric` is ignored and is not counted in `skipped_lines`.

The numbers cannot see starts made outside the plugin, or lines older than those the command returns. `starts_soon_after_load` counts the resume starts whose `up` is under 300 seconds.

## Sandbox checks (nono 0.81.0, checked 2026-10-30)

- `npm run check` passes inside the sandbox; tests that need local ports or
  other processes skip themselves there.
- Reading `~/.ona`, `~/.ssh` and `~/.bb` fails; writing outside the working
  folder fails; a local listener on `127.0.0.1` can't be reached; a
  non-allowed domain can't be reached.
- `agent-run.sh` warns if a run changed `~/.claude/settings.json`, Claude's
  own config, which the sandbox leaves writable.

## Open items

- Codex doesn't connect through nono's network proxy (it fails at
  "workspace routing discovery").
