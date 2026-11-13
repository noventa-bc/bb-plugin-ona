# FACTORY.md

How an orchestrating agent turns roadmap items into merged pull requests on
this repo. `AGENTS.md` still applies to every agent in the flow, and
`docs/owner.md` says how the owner starts agents; this file adds the
orchestration rules on top and records the exceptions the owner granted.

## Purpose

Rule 1 of this repo: simplicity, always. The simplest thing that fully
works beats the clever, the general and the defensive, in code, tests, CI,
docs and this flow. The goal is a repo that stays maintainable for years
with one maintainer, not a one-weekend app: small reviewed PRs, a test for
each bug, a guard for each hazard, docs that stay true, and complexity that
pays for itself. When a shortcut would be faster today and costlier to keep,
take the slower path and say so. Removing code, settings, processes and
steps counts as progress: every session looks for a simplification to
propose. Do not repeat yourself; judge like a staff engineer who knows when
the quick fix is right and when it is not.

## Roles

- **Orchestrator.** One agent that talks to the owner, reads the roadmap,
  splits items into PR-sized tasks, briefs builders, reviews their output, opens
  PRs, keeps the roadmap in step and updates this file.
- **Builder.** One subagent per task, in its own git worktree and branch. It
  writes the code, tests and handoff and leaves them staged; it never pushes.
- **Reviewer.** A fresh agent (not the builder) briefed to break the change:
  it hunts for the input, timing or state that makes it wrong, and reports
  only findings with a concrete failing case. Plus the repo's `code-review`
  pass and `/ponytail-review`: the passes step 6 gives a PR, all
  independent of the orchestrator. Blocking findings go back to the builder
  (`docs/review-standards.md` says which block).

Builders run on Opus at low effort and reviewers on Haiku at max effort by
default; the role definitions in `.claude/agents/` set it, and a brief for an
agent without a definition names its model and effort (for example, Haiku at max
effort for mechanical work). Use Opus at medium effort only per call, with a stated reason
in its brief: a change to a safety rule or an accepted decision, a tricky
concurrency or state bug, or a review that must read bb's source. The
orchestrator runs on Fable. It checks each subagent's output
and briefs it with exact commands and a stop condition.

Merging on green is only as safe as CI. Every PR adds a test for the behaviour
it changes, where a test is possible; a gap CI cannot see and the PR did not open (untested module, missing lint, unchecked
script) becomes a roadmap item and is named in the PR by its label only.

## Ponytail

The ponytail plugin (`docs/owner.md` has the install) is the "least code"
ruleset for every agent in the flow. At session start the orchestrator checks
its skills are listed (`/reload-plugins` after an install) and sets `/ponytail full`. Its hooks inject the ruleset into
subagents, so briefs state the scope and need not repeat it. Reviews run
`/ponytail-review` on a named target (`branch`, or the PR link) in the
`reviewer-ponytail` agent, briefed as `docs/owner.md` says. A builder marks a
known limit with a `shortcut:` comment (never an unfixed weakness: that goes to
the private roadmap); its handoff carries those and the "skipped or not checked"
lines ponytail ends with.

## Inputs

- The roadmap is a private document the owner keeps outside the repo. The owner
  hands its link to the orchestrator in the session; what of it may enter the
  repo is `AGENTS.md` Code Review Rule 10.
- Items carry a size and a status. Work only on items the owner names.

## Flow

1. **Research** before anything is built. Read the named items in full and
   the code they touch; confirm the repo still matches the roadmap text. List
   the alternatives, look at the task from the user's, the safety rules' and
   the maintainer's angle, and check current best practice on the web when
   the task touches a tool, protocol or platform. A tooling or process item
   (lint, CI, hooks, release flow) starts with a measured survey: run the
   candidate rules on the code, count the hits, propose only what pays, and
   let the owner pick. A task that touches bb's machine lifecycle (create,
   resume, suspend, remove, reconnect, the daemon) has its brief name the bb
   server function the builder reads first; a task that calls bb's API names
   the server-side validation of that call too (it lives only in the server
   source: a fork onto another host is refused there). The source path is in
   `docs/ona-notes.md` (bb SDK section). Read it with `scripts/bb-source.sh <name>`
   (`AGENTS.md` "Commands" says what it prints). Its round-1 adversarial reviewer is briefed to read that
   source too, so it runs on Opus (see the model paragraph under Roles).
   Execute only once sure; until then, ask.
2. **Size.** A task is one PR a reviewer can read in one sitting: one roadmap
   item, or a group of its bullets that share files. Split anything larger.
   Independent tasks run in parallel; tasks that touch the same files run in
   sequence.
3. **Check confidence.** If a task needs a decision only the owner can make (a
   version to pin, a safety rule to bend, a behaviour change users will see),
   ask before building. Batch the questions into one message.
4. **Brief** each builder with the task fields of the template in `docs/owner.md`
   (a reviewer gets the "Reviewer brief template" there, step 6). The standing rules are in
   `AGENTS.md` "Subagents" and, for reviewers, `docs/review-standards.md` "How
   reviewers work" and "Report"; the role definitions in `.claude/agents/` hold
   only what is particular to the role. A brief repeats none of them.
5. **Build** in a worktree, by the `builder`
   definition (`.claude/agents/builder.md`): its commands, failing test first,
   mutants, checks, handoff and report are there. The builder leaves the work
   staged for the orchestrator and never commits or pushes.
6. **Review.** The orchestrator commits the builder's staged work on its
   branch (after the check passes on its own), reads the handoff and the diff,
   and runs the passes the gate below gives the PR, each in its own agent on the
   branch against `origin/main`: the adversarial reviewer (brief: the diff, the
   files it touches and the ways it could fail, never the orchestrator's own
   verdict), `code-review` (its recipe followed by hand: the Skill itself starts
   many agents) and `/ponytail-review branch`. Brief each with the template in
   `docs/owner.md`; the standing rules and the report are where step 4 says,
   and `.claude/agents/reviewer-adversarial.md`, `reviewer-code.md` and
   `reviewer-ponytail.md` hold each pass's own part. Blocking findings go back to the builder. Code is what
   `docs/review-standards.md` counts as code. A PR
   that changes code gets all three passes on its first round, however
   small the change; a PR that changes no code gets the `code-review` pass
   alone (owner, checked 2026-11-05: three passes on a two-line override
   overlap).
   After that, `code-review` runs every round; the adversarial pass and
   `/ponytail-review` run on every round whose diff changed code since they
   last ran. A PR opens after a round with no blocking finding, and only
   once the passes it gets have run on code that has not changed since.
   Check the ten Code Review Rules in `AGENTS.md`.

   **Converge.** `docs/review-standards.md` owns the PR's scope (reviewer
   briefs name it), what blocks, what becomes of a finding already on `main`,
   and what a later round may add.
   Code converges in three rounds; from round 4 on, the orchestrator opens
   the PR once nothing blocks and the passes it gets have run on the code as
   it stands.

7. **Open the PR.** The title is a Conventional Commit (`type(scope):
subject`, see `AGENTS.md`): the squash merge makes it the commit on
   `main`, and it decides the release. First run
   `sh -c "cd <worktree> && scripts/bump.sh \"<title>\""` (a bare call from
   the main checkout bumps that checkout), run the check, and commit what it
   changes: it bumps `package.json` as the title requires (or does
   nothing), and CI checks the same rule. A version bump is not a code change
   for the review passes. Then push the branch and open a pull request
   against `main`. The description carries: the roadmap labels, what changed and why, how it
   was tested, the review passes it got and what each found, the owner
   live-test steps from the handoff, and anything left out. Nothing from the
   "Weaknesses for the roadmap" handoff section goes in the PR; the
   orchestrator adds each to the private roadmap.
8. **Wait for CI.** The workflows the PR needs must be green: `check` for
   code, `docs` for Markdown, both for a PR with both. A red run goes back to
   the builder; never merge around it. A PR whose run has not appeared after
   5 minutes (GitHub sometimes drops the event when the branch and the PR
   appear together) is not green: push a merge of `main` or an empty commit
   to retrigger, and merge only once the runs exist. `gh pr checks --watch`
   can return before every check exists, so never chain it straight into a
   merge. A title edited after CI ran is checked again by CI (`edited` is in
   the workflows' `pull_request` types).
9. **Merge.** The orchestrator merges with
   `scripts/pr-merge.sh <pr>` from the main checkout (the branch is deleted
   on merge, which fails from a worktree that has it checked out). It waits
   for the runs the PR needs and merges only a fully green head (see the
   script). It runs as soon as the review has no blocking finding. A push
   to `main` then tags and releases the version in `package.json` on its own
   (`release.yml`); no step here does it. PRs that touch the same files merge
   one at a time: merge `main` into the next branch (a merge commit;
   force-pushing is blocked, so never rebase a pushed branch), fix conflicts
   keeping both sides, run `npm run check`, let CI run again, then merge. Two
   green PRs can still break each other once combined, so the rerun after
   merging `main` is never skipped. Never merge a red PR. A PR that changes
   `package.json` and is behind `main` is refused: merge `main`, set the version
   in `package.json` and `package-lock.json` back to `main`'s (a clean merge
   keeps the PR's), then run the `scripts/bump.sh` command from step 7 again.
10. **Sync the roadmap.** Status lives only in the table at the top of the
    roadmap, one linked row per item, with the landing commit in the Item cell.
    When a PR opens, set the item to In review; when it merges, set it to Done,
    note any part left out, and put the owner's live-test steps in the Pending
    Manual Tests tab. Fix any status the code shows to be stale. Done items move to
    the Done tab and leave the table only when the owner asks.
11. **Improve the roadmap.** The orchestrator may add items (fixes,
    simplifications, tests, features) it found while reading the code, revise
    an item whose text the code has overtaken, re-order phases, and tighten
    the document's structure. New or changed items start as Open with a size
    and a "why"; a ruled-out idea is never deleted, it moves to the Ruled out
    tab with the reason. Say in the session report what was changed.
12. **Close the session** with a short report: PRs opened, their state, roadmap
    edits, open questions, and what the owner must test live.

## Permissions the owner granted

- For a roadmap item the owner named in the session (an instruction to change
  this file or `AGENTS.md` counts), the orchestrator may commit on `agent/*`
  branches (builders leave work staged), push them, open
  PRs, and merge a PR with `scripts/pr-merge.sh` once its review has no
  blocking finding (`docs/review-standards.md`) and CI is green. Nobody commits to `main`
  directly.
- Installing or bumping a dependency inside an owner-approved task is allowed;
  say in the PR which packages changed. Anything else needs a new approval.

## Self-improvement

This file is the memory of the flow. Keep it current:

- When the owner gives an instruction worth keeping (a rule, a preference, a
  permission, a thing to avoid), add it here in the same session, in the
  section it belongs to. Edit an existing rule rather than adding one.
- When a step failed or wasted time, record what to do instead, next to the step.
- When a bug, a source of noise or a repo hazard shows up (in the code, in CI,
  in a review or in the flow itself), add the guardrail that stops it recurring
  before the PR opens (a finding already on `main` that the branch does not
  make reachable or worse takes its guard in its roadmap item, `docs/review-standards.md`): a test with the failing case, a lint rule, a CI step, a
  `.gitignore` line, or a rule here or in `AGENTS.md`. A finding that is only
  fixed, with no guard, is not closed.
- When a rule here conflicts with `AGENTS.md`, fix `AGENTS.md` in the same PR
  so the two agree, and say so in the PR.
- Keep this file under 300 lines (`docs.yml` checks). An addition names what it removes.
- A change to this file goes through a PR like any other change, for a
  roadmap item the owner named in the session (Permissions); otherwise it
  stays uncommitted for the owner.

## Owner instructions on record

Rules the owner gave that no section above states. Checked 2026-11-11.

- The path, git, npm and exit-code rules in `AGENTS.md` "Subagents" bind the
  orchestrator too. Before any commit, the check runs as its own command and
  its exit code is read before the commit. `.githooks/pre-commit` (set by
  `npm install`) runs the checks on every commit; a checkout without the hook
  reads the exit code by hand (checked 2026-11-03).
- A builder that was stopped cannot be resumed. Its worktree keeps the staged
  work: review it, finish the handoff and the PR from there instead of starting
  the task again.
- When the owner says to halt, finish the step in hand, write the handoffs and
  report, and open no new PR.
- Removing a command or a setting is released as a minor version: its PR title is
  `feat`, never `feat!`, and the PR body says what users lose (checked 2026-11-12).
- Every feature the CLI has gets a UI control too, unless the owner says it is
  not needed; the orchestrator asks the owner where it goes (checked 2026-11-05).
- A commit subject or PR title is at most 100 characters (`scripts/conventional.sh`
  has the rule; `.githooks/commit-msg` refuses longer, after the pre-commit
  check has run): measure it first.
- A roadmap item tagged `[COST]` (it raises what Ona bills) is never worked
  on without the owner's explicit approval of that item, given with its label;
  a general "continue" or a list that includes it is not that (checked
  2026-11-06).
- Once per release the orchestrator has an agent audit the safety checks: in
  a scratch copy it removes or inverts each check that enforces a safety rule
  (`docs/sync.md` rules 1 to 5, Code Review Rules 1 to 8 in `AGENTS.md`) and
  runs `npm run check`. A check nothing catches gets a test, once the code
  confirms the mutant changes behaviour: this instruction names that work, and
  the test goes through the flow as its own PR. The count (caught of total)
  goes on the roadmap. Do not add a mutant list, marker comments, a script or
  a workflow for this audit: the owner chose the audit over standing tooling
  (checked 2026-11-11).
- Keep up to 5 tasks in flight, and at least 2 when the named items allow:
  when an item waits on a review, a merge or the owner, take the next
  independent item the owner named in the session (no shared files, no
  `[COST]` tag) through the flow, steps 1 to 3 and `AGENTS.md` "Complexity"
  included, rather than wait, unless the owner said to halt (checked
  2026-11-06).
