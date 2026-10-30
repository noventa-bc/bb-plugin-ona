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
today and costlier to keep, take the slower path and say so.

## Roles

- **Orchestrator.** One agent that talks to the owner, reads the roadmap,
  splits items into PR-sized tasks, briefs builders, reviews their output, opens
  PRs, keeps the roadmap in step and updates this file.
- **Builder.** One subagent per task, in its own git worktree and branch. It
  writes the code, tests and handoff, and commits on its branch. It never pushes.
- **Reviewer.** A fresh agent (not the builder) that reads the diff cold, plus
  the repo's `code-review` pass. Findings go back to the builder until clean.

Pick the cheapest model that can do the task well: a strong model for code,
review and anything touching a safety rule; a small model for mechanical edits
and lookups.

## Inputs

- The roadmap is a private document the owner keeps outside the repo. The owner
  hands its link to the orchestrator in the session. Never write that link, the
  document's ids or its text into any file in this repo. Refer to items by their
  roadmap label only (for example "T2", "R9").
- Items come with a size (S, M, L) and a status (Open, In review, Done, Parked,
  Ruled out). Work only on items the owner names.

## Flow

1. **Read** the named items in full, then the code they touch. Confirm the
   repo still matches the roadmap text; the roadmap may lag the code.
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
5. **Build** in a worktree. The builder runs `npm ci --ignore-scripts`, writes
   a failing test first where possible, keeps `npm run check` green, writes
   `.agent/HANDOFF.md`, and commits on its branch.
6. **Review.** The orchestrator reads the handoff and the diff, runs a reviewer
   agent and `code-review`, and sends findings back to the builder. Repeat until
   there are no open findings. Check the ten Code Review Rules in `AGENTS.md`.
7. **Open the PR.** Push the branch and open a pull request against `main`.
   The description carries: the roadmap labels, what changed and why, how it
   was tested, the owner live-test steps from the handoff, and anything left
   out. Nothing from the "Security (private)" handoff section goes in the PR.
8. **Wait for CI.** The `check` workflow must be green. A red run goes back to
   the builder; never merge around it.
9. **Merge.** The owner merges. The orchestrator does not merge unless the
   owner says so in the session.
10. **Sync the roadmap.** When a PR opens, set the item's status to In review.
    When it merges, set it to Done and note the gap if part of the item was left
    out. Fix any other status that the code shows to be stale.
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

- When the owner gives an instruction in a session that would be useful next
  time (a rule, a preference, a permission, a thing to avoid), add it here in the
  same session, in the section it belongs to. Edit an existing rule rather than
  adding a near-duplicate.
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

Rules the owner gave in sessions, restated so they stay true. Checked 2026-10-30.

- Make the repo sustainable in the long term; it is not a vibe-coded
  one-weekend app.
- Use subagents; the orchestrator supervises and holds the quality bar.
- Every change goes through a PR, is code reviewed, and merges only when CI is
  green.
- The owner merges.
- Do not expose the roadmap link anywhere.
- Keep roadmap statuses up to date; update the roadmap whenever the code shows
  it is stale. Propose improvements and simplifications in it, and improve its
  structure.
- Run slow commands in the background and keep working meanwhile.
- Whenever something buggy, noisy or risky for the repo is seen, add
  guidelines, guardrails and harnesses so it does not happen again, and keep
  that rule documented in the repo.
- The roadmap keeps status only in its Status tab table, one row per item,
  with the PR or commit named in the Item cell. The main tab carries no status
  words. Follow the structure the owner sets; do not add status elsewhere.
- A subagent cannot see the owner's approvals. When a builder needs an approved
  install or commit, the orchestrator performs that step in the builder's
  worktree, then tells the builder to continue.
