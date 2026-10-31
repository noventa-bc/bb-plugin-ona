# FACTORY.md

How an orchestrating agent turns roadmap items into merged pull requests on
this repo. `AGENTS.md` still applies to every agent in the flow, and
`docs/owner.md` says how the owner starts agents; this file adds the
orchestration rules on top and records the exceptions the owner granted.

## Purpose

The owner's goal is a repo that stays maintainable for years with one
maintainer, not a one-weekend app. Every step below serves that: small
reviewed PRs, a test for each bug, a guard for each hazard, docs that stay
true, and complexity that pays for itself. When a shortcut would be faster
today and costlier to keep, take the slower path and say so. Removing code,
settings, processes and steps counts as progress: every session looks for a
simplification or an optimisation to propose, in the code and in this flow.
Keep it simple and do not repeat yourself; judge like a staff engineer who
knows when the quick fix is right and when it is not.

## Roles

- **Orchestrator.** One agent that talks to the owner, reads the roadmap,
  splits items into PR-sized tasks, briefs builders, reviews their output, opens
  PRs, keeps the roadmap in step and updates this file.
- **Builder.** One subagent per task, in its own git worktree and branch. It
  writes the code, tests and handoff and leaves them staged; it never pushes.
- **Reviewer.** A fresh agent (not the builder) that reads the diff cold, plus
  the repo's `code-review` pass. Findings go back to the builder until clean.

Pick the cheapest model that can do the task well: a strong model for code,
review and anything touching a safety rule; a small model (Haiku) for
mechanical work (merges, renames, fixtures, lookups); the orchestrator checks
a small model's output and briefs it with exact commands and a stop condition.

Merging on green is only as safe as CI. Every PR adds a test for the behaviour
it changes; a gap CI cannot see (untested module, missing lint, unchecked
script) becomes a roadmap item and is named in the PR.

## Ponytail

The ponytail plugin (`docs/owner.md` has the install) is the "least code"
ruleset for every agent in the flow. At session start the orchestrator checks
its skills are listed (`/reload-plugins` after an install) and sets `/ponytail full`. Its hooks inject the ruleset into
subagents, so briefs state the scope and need not repeat it. Reviews run
`/ponytail-review` on a named target (`staged`, `branch`, or the PR link). A
builder marks a known limit with a `shortcut:` comment; its handoff carries
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
   the task touches a tool, protocol or platform. Execute only once sure;
   until then, ask.
2. **Size.** A task is one PR a reviewer can read in one sitting: one roadmap
   item, or a group of its bullets that share files. Split anything larger.
   Independent tasks run in parallel; tasks that touch the same files run in
   sequence.
3. **Check confidence.** If a task needs a decision only the owner can make (a
   version to pin, a safety rule to bend, a behaviour change users will see),
   ask before building. Batch the questions into one message.
4. **Brief** each builder with the template in `docs/owner.md`, plus: the
   branch name `agent/<slug>`, the files and line areas involved, the tests to
   write first, the coupled changes from `AGENTS.md`, and what to report back.
5. **Build** in a worktree (slow commands in the background). The builder runs
   `npm ci --ignore-scripts`, writes
   a failing test first where possible, keeps `npm run check` green, writes
   `.agent/HANDOFF.md`, and leaves the work staged for the orchestrator.
6. **Review.** The orchestrator reads the handoff and the diff, runs a reviewer
   agent, `code-review` and `/ponytail-review branch`, and sends findings back
   to the builder. Repeat until there are no open findings. Check the ten Code
   Review Rules in `AGENTS.md`.
7. **Open the PR.** Push the branch and open a pull request against `main`.
   The description carries: the roadmap labels, what changed and why, how it
   was tested, the owner live-test steps from the handoff, and anything left
   out. Nothing from the "Security (private)" handoff section goes in the PR.
8. **Wait for CI.** The `check` workflow must be green. A red run goes back to
   the builder; never merge around it.
9. **Merge.** The orchestrator squash-merges as soon as CI is green and the
   review has no open findings, and deletes the branch. PRs that touch the
   same files merge one at a time: merge `main` into the next branch (a merge
   commit; force-pushing is blocked, so never rebase a pushed branch), fix
   conflicts keeping both sides, run `npm run check`, let CI run again, then
   merge. Two green PRs can still break each other once combined, so the
   rerun after merging `main` is never skipped. Never merge a red PR.
10. **Sync the roadmap.** Status lives only in the table at the top of the
    roadmap, one linked row per item, with the landing commit in the Item cell.
    When a PR opens, set the item to In review; when it merges, set it to Done,
    note any part left out, and put the owner's live-test steps in the Live
    checks tab. Fix any status the code shows to be stale. Done items move to
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

- Builders may commit on `agent/*` branches. The orchestrator may push those
  branches and open PRs. Nobody commits to `main` directly.
- Installing or bumping a dependency inside a task is allowed when the owner
  approved that task. Say in the PR which packages changed.
- These permissions cover the PRs the owner approved in the session. Anything
  outside that list needs a new approval.

## Self-improvement

This file is the memory of the flow. Keep it current:

- When the owner gives an instruction worth keeping (a rule, a preference, a
  permission, a thing to avoid), add it here in the same session, in the
  section it belongs to. Edit an existing rule rather than adding one.
- When a step failed or wasted time, record what to do instead, next to the
  step.
- When a bug, a source of noise or a repo hazard shows up (in the code, in CI,
  in a review or in the flow itself), add the guardrail that stops it recurring
  before the PR opens: a test with the failing case, a lint rule, a CI step, a
  `.gitignore` line, or a rule here or in `AGENTS.md`. A finding that is only
  fixed, with no guard, is not closed.
- When a rule here conflicts with `AGENTS.md`, fix `AGENTS.md` in the same PR
  so the two agree, and say so in the PR.
- Keep this file under 150 lines. An addition that goes over names what it
  removes.
- A change to this file goes through a PR like any other change.

## Owner instructions on record

Rules the owner gave that no section above states. Checked 2026-10-30.

- Several worktrees are open at once and the shell's working directory drifts
  between them. Address every git command with `git -C <path>` and every file
  with its absolute path; never rely on `cd`.
- A subagent cannot see the owner's approvals and will often refuse to install,
  commit or push. Brief builders to leave their work staged; the orchestrator
  commits and pushes from the builder's worktree, and runs approved installs
  there before telling the builder to continue.
