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
  (step 6 says which block).

Subagents run on Haiku at max effort by default (for example: builders of
small changes, reviewers of tests, docs, lint and CI, mechanical work). Use
Opus at medium effort only with a stated reason in its brief: a change to a
safety rule or an accepted decision, a tricky concurrency or state bug, or a
review that must read bb's source. The orchestrator runs on Fable. It checks
a Haiku subagent's output and briefs it with exact commands and a stop
condition.

Merging on green is only as safe as CI. Every PR adds a test for the behaviour
it changes, where a test is possible; a gap CI cannot see and the PR did not open (untested module, missing lint, unchecked
script) becomes a roadmap item and is named in the PR by its label only.

## Ponytail

The ponytail plugin (`docs/owner.md` has the install) is the "least code"
ruleset for every agent in the flow. At session start the orchestrator checks
its skills are listed (`/reload-plugins` after an install) and sets `/ponytail full`. Its hooks inject the ruleset into
subagents, so briefs state the scope and need not repeat it. Reviews run
`/ponytail-review` on a named target (`branch`, or the PR link). A
builder marks a known limit with a `shortcut:` comment (never an unfixed
weakness: that goes to the private roadmap); its handoff carries
those and the "skipped or not checked" lines ponytail ends with.

## Inputs

- The roadmap is a private document the owner keeps outside the repo. The owner
  hands its link to the orchestrator in the session. Never write that link, the
  document's ids or its text into any file in this repo. Refer to items by their
  roadmap label only (for example "T2", "R9").
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
   `docs/ona-notes.md` (bb SDK section). Read it with bounded grep (`grep -n`,
   piped to `head`). Its round-1 adversarial reviewer is briefed to read that
   source too, so it runs on Opus (see the model paragraph under Roles).
   Execute only once sure; until then, ask.
2. **Size.** A task is one PR a reviewer can read in one sitting: one roadmap
   item, or a group of its bullets that share files. Split anything larger.
   Independent tasks run in parallel; tasks that touch the same files run in
   sequence.
3. **Check confidence.** If a task needs a decision only the owner can make (a
   version to pin, a safety rule to bend, a behaviour change users will see),
   ask before building. Batch the questions into one message.
4. **Brief** each builder with the template in `docs/owner.md` (a reviewer
   gets its `Role:` line and the step-6 brief), plus: the
   branch name `agent/<slug>`, the files and line areas involved, the tests to
   write first, the coupled changes from `AGENTS.md`, and what to report back.
5. **Build** in a worktree (slow commands in the background). The builder runs
   `npm ci --ignore-scripts`, then `npm run prepare`, writes
   a failing test first where possible (each test names, in its title or the
   handoff, the bug it fails on; a test that still passes with the rule
   deleted is not done; stage the fix before a mutant you restore with
   `git -C <worktree> checkout -- <file>`, or the restore brings back the
   unfixed file), keeps
   `npm run check` green, writes
   `.agent/HANDOFF.md`, and leaves the work staged for the orchestrator.
6. **Review.** The orchestrator commits the builder's staged work on its
   branch (after the check passes on its own), reads the handoff and the diff,
   runs the
   passes the gate below gives the PR: the adversarial reviewer (brief: the
   diff, the files it touches, the specific ways it could fail, never the
   orchestrator's own verdict), `code-review` (its recipe followed by hand:
   the Skill itself starts many agents) and `/ponytail-review branch`, each
   on the branch against `origin/main`, in its own agent, briefed with the
   builder's worktree path (a fresh agent starts in the main checkout) and
   told to run tests and mutants in a scratch folder of its own under the
   session scratchpad (`git archive <sha>` into a new folder, which has no
   history, so git commands stay `git -C <worktree>`; link `node_modules`
   only when the folder has none), and
   sends blocking findings back to the builder. Code, here, is anything but
   comments, lint messages, Markdown, a lockfile, a `package.json` override
   and the version bump (step 7); the ten numbered Code Review Rules in
   `AGENTS.md` and the rules table in `docs/sync.md` count as code. A PR
   that changes code gets all three passes on its first round, however
   small the change; a PR that changes no code gets the `code-review` pass
   alone (owner, checked 2026-11-05: three passes on a two-line override
   overlap).
   After that, `code-review` runs every round; the adversarial pass and
   `/ponytail-review` run on every round whose diff changed code since they
   last ran. A PR opens after a round with no blocking finding, and only
   once the passes it gets have run on code that has not changed since.
   Check the ten Code Review Rules in `AGENTS.md`.

   **Converge.** The item's code is the PR's scope, and reviewer briefs name
   it and ask for anything outside it under a separate "Pre-existing" heading.
   A finding blocks only when the branch introduced the defect or makes one
   reachable or worse, when the branch breaks a safety rule or a coupled
   change, leaves its own behaviour untested where a test is possible,
   leaves a doc in the diff contradicting the code, or is a big change the
   owner has not reviewed (`AGENTS.md` "Complexity"). A finding that was
   already on `main` and that the branch does not make reachable or worse
   becomes a roadmap item, with its guard, and the PR names it by its label
   only, whatever severity the reviewer gave it; a credential or a data-loss
   risk goes to the owner at once as well. After the first round the builder
   adds no behaviour beyond a fix for a blocking finding: a fix that needs
   behaviour beyond that is its own item.
   Code converges in three rounds; from round 4 on, the orchestrator opens
   the PR once nothing blocks and the passes it gets have run on the code as
   it stands. Before a round swaps or retitles a test, run the old test
   against the mutant its title names: a title can be right for a clause the
   round misread.

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
  blocking finding and CI is green. Nobody commits to `main`
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
  make reachable or worse takes its guard in its roadmap item, step 6): a test with the failing case, a lint rule, a CI step, a
  `.gitignore` line, or a rule here or in `AGENTS.md`. A finding that is only
  fixed, with no guard, is not closed.
- When a rule here conflicts with `AGENTS.md`, fix `AGENTS.md` in the same PR
  so the two agree, and say so in the PR.
- Keep this file under 300 lines (`docs.yml` checks). An addition names what it removes.
- A change to this file goes through a PR like any other change, for a
  roadmap item the owner named in the session (Permissions); otherwise it
  stays uncommitted for the owner.

## Owner instructions on record

Rules the owner gave that no section above states. Checked 2026-11-02.

- Several worktrees are open at once and the shell's working directory drifts
  between them. Address every git command with `git -C <path>` and every file
  with its absolute path; never rely on `cd`. Run npm as
  `sh -c "cd <worktree> && npm run check"`: a `cd` at the start of a compound
  command can be dropped, and `npm` run from a folder without `package.json`
  walks up and installs into the live checkout.
- Before any commit, the check runs as its own command (the `sh -c` form above)
  and its exit code is read before the commit. Never chain `npm run check` into
  a commit with `;` (the commit runs even when the check fails) or pipe it into
  grep (the exit code is grep's). `.githooks/pre-commit` (set by `npm install`)
  runs the checks on every commit; a checkout without the hook reads the exit
  code by hand (checked 2026-11-03).
- A subagent cannot see the owner's approvals and refuses to install packages (the step-5 `npm ci` is its own), commit or
  push. Builders leave work staged; the orchestrator commits, pushes and runs
  approved installs in the builder's worktree, then tells it to continue.
- A builder that was stopped (the owner's credits ran out, the session ended)
  cannot be resumed. Its worktree keeps the staged work: review it, finish the
  handoff and the PR from there instead of starting the task again.
- The owner may stop the session when the weekly usage limit nears 99%. The
  orchestrator cannot see the limit; when the owner says to halt, finish the
  step in hand, write the handoffs and report, and open no new PR.
- Every feature the CLI has gets a UI control too, unless the owner says it is
  not needed; the orchestrator asks the owner where it goes (checked 2026-11-05).
- A commit subject or PR title is at most 100 characters (`scripts/conventional.sh`
  has the rule; `.githooks/commit-msg` refuses longer, after the pre-commit
  check has run): measure it first.
