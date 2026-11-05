# AGENTS.md

## What this is

bb-ona is a bb plugin. It runs bb threads (Claude Code, Codex) in Ona devboxes and keeps bb's view of each devbox in step with Ona.
This repo is public. Name only this plugin and public tools.

Roadmap items are delivered through the orchestrated flow in `FACTORY.md`.

## Commands

- Run `npm run check` (Node pin, typecheck, lint, format check and tests) before you finish. `npm run format` fixes formatting.
- CI: `check.yml` runs `npm run check` and skips changes that touch only Markdown; `docs.yml` runs on Markdown changes and is where a job that validates `.md` files goes.
- `scripts/docs-check.sh` runs the Markdown checks CI runs.
- CI also runs `shellcheck` on `scripts/*.sh`, `test/*.sh` and `.githooks/*`; `npm run check` does not. After changing a `.sh` file, run `shellcheck` on it (`brew install shellcheck`), or say in the handoff that it was not run.
- CI also runs the Semgrep rules in `.semgrep/rules.yml` (fixtures in `.semgrep/rules.ts`). Locally: `brew install semgrep`, then `semgrep --test --metrics=off .semgrep/` and `semgrep scan --config .semgrep/rules.yml --error --metrics=off app.tsx server.ts src`.
- Each test times out after 60 s (`--test-timeout` in `package.json`), so a hang shows up as a named failure.
- Run one test file with `node --test --experimental-strip-types test/reconcile.test.ts`.
- Inside the agent sandbox, tests that need local ports or other processes skip themselves. CI runs them.
- Live reload of the plugin is owner-only. Do not run it.

## Live systems

- bb loads this folder live. A change here can reach the owner's running bb.
- Ona devboxes cost money while they run.
- Ona's SSH starts stopped devboxes. Any SSH to a devbox can wake it.
- Never run `ona` actions, `ssh` to devboxes, or `bb machine` or `bb plugin` changes.
- Never commit to `main` or push, except as `FACTORY.md` allows: for a roadmap item the owner named in the session (as its Permissions section defines it), the orchestrator commits on `agent/*` branches, pushes them, opens PRs and merges them once the review has no blocking finding (`FACTORY.md` step 6) and CI is green.
- Commit messages and PR titles are Conventional Commits, `type(scope): subject` (`scripts/conventional.sh` has the rule; `.githooks/commit-msg` and `.githooks/pre-commit` run the checks, and those files say which; `check.yml` checks the PR). `feat` bumps the minor version, `fix` and `perf` the patch, `!` the major: that PR bumps `package.json` (`scripts/bump.sh "<title>"` does it). Other types, and any Markdown-only change, need no bump. A push to `main` tags and releases the version with notes generated from the merged PR titles.
- Read-only `bb ona status` is fine, but only when the owner is present.

## Coupled changes

Change these together, in the same edit.

- Plugin settings go with the settings table in `README.md`.
- `bb ona` commands go with their usage text, `README.md`, `skills/ona-devboxes/SKILL.md` and `PLUGIN_OVERVIEW.md`.
- `decide()` in `src/reconcile.ts` goes with its tests in `test/reconcile.test.ts` and the rules table in `docs/sync.md`.
- A user-visible change is described by its PR title (a Conventional Commit in user-facing wording) and, when more is needed, the PR body: release notes are generated from merged PR titles.

## Decisions

- Decision records live in `docs/decisions/`. The index is `docs/decisions/README.md`.
- Accepted records are binding.
- If a task conflicts with an accepted record, stop and say so. When unattended, note the conflict in the handoff and skip that item.
- To propose a change, add a proposed record and update the index. The owner accepts it.

## How to work

- Rule 1: simplicity, always. The simplest thing that fully works beats the clever, the general and the defensive.
- Tests, fakes and stubs meet the same bar as `src/`: clear names, one job per helper, a comment only for a why. Not production code is no excuse for a mess.
- Write the least code that solves the whole task (the ponytail ruleset, installed as a Claude Code plugin; see `docs/owner.md`). A shortcut with a known limit gets a comment `shortcut: <the limit>, <when to upgrade>`; `/ponytail-debt` lists them. A shortcut comment never describes an unfixed weakness; that goes to the private roadmap.
- Fix a bug with a failing test first, where a test is possible. A `// Bug:` line names only a bug that was on `main`, not a design tried and dropped inside the PR (git history has it).
- When you find a bug, a source of noise or anything that can damage the repo, add the guard that stops it recurring in the same change (a finding already on `main` that the branch does not make reachable or worse takes its guard in its roadmap item, `FACTORY.md` step 6): a test, a lint rule, a CI step, a `.gitignore` line or a written rule here. Say in the handoff which guard you added.
- A change to what a sync pass does gets a scenario in `test/sync.test.ts` or, since that file sits at the 500-line lint cap, `test/sync-status.test.ts` (fake bb calls and Ona listing from `test/sync-fakes.ts`).
- For `server.ts` code without tests, list owner check steps in the handoff instead.
- Put logic in `src/` as pure functions with tests.
- Every SSH or `ona` call must name the safety rule that covers it, in `docs/sync.md`.
- Keep changes small. Do not refactor unrelated code.

## Complexity

- This plugin has one maintainer. Every piece of complexity you add (a dependency, module, abstraction, setting, command, background process, child process, cache or persisted state) must buy more than it costs to read, test and keep working. Prefer the smaller change that solves the problem, and say in the handoff what each addition costs and what it buys.
- A big change needs the owner's review before it is built: a new dependency, command, setting, background or child process, persisted state, a change to a safety rule or an accepted decision, a refactor across modules, or anything that changes how users run the plugin. Attended: stop and ask. Unattended: don't build it; put the plan, its cost and the smallest alternative under "Needs owner review" in the handoff, and build only the parts that aren't big.

## Docs

- Each file owns one thing. `README.md` is for users. `skills/ona-devboxes/SKILL.md` is for agents that use the plugin. `docs/decisions/` is for reasons.
- Use exact numbers.
- Write "box" or "devbox" for an Ona environment. Write "machine" only for the bb machine.
- Put commands and settings in backticks.
- Write facts that stay true over time. Avoid words that depend on when the text is read.
- A dated fact carries the words "checked YYYY-MM-DD".
- Do not document what the code shows. Point to the code instead. Comments and docs
  describe what exists; nothing about what was removed or is absent (git history has
  that; a `// Bug:` line in a test is the one exception).
- `docs/ona-notes.md` holds facts about Ona and bb. A fact about a build or CI tool lives as a comment next to its pin.

## Code Review Rules

The safety rules behind 1–4 are in `docs/sync.md`. Cite `file:line` for each finding. Report at most 5 nits. Run `/ponytail-review branch` in its own agent when FACTORY.md step 6 gives the PR that pass.

1. No SSH, start or stop of a box unless an Ona listing from the same check says the box is RUNNING, except the two starts `docs/sync.md` rule 1 names (a waiting thread on an active machine, and `bb ona resume`). A failed listing means "unknown".
2. Automatic suspends never stop a box.
3. Forcing (`bb ona sync`, `bb ona reconnect`, `bb ona resume`, and any pass that finds a thread waiting on a box Ona shows stopped or stopping) only skips cooldowns, backoff and the give-up. Before a thread's pass has failed on a box, it skips the cooldown, backoff and give-up that other passes left; once one has, the failure count is kept across every unforced pass, a success included, and the usual backoff and give-up apply, until bb shows the machine connected, a thread's pass succeeds, or `bb ona sync`, `bb ona reconnect` or `bb ona resume` acts on the box (docs/sync.md rule 3). It never skips a safety rule.
4. Removing a machine never deletes an adopted environment.
5. Remote script text is a constant. Values are passed as arguments or through `shellQuote`.
6. The tunnel goes only to the loopback proxy, its devbox end listens on loopback only, and the proxy forwards only to bb's loopback URL. A change to `src/proxy.ts` that lets more through (a listed route, the upgrade check, or a looser matcher, path, method or header check) needs allowed and denied cases in `test/proxy.test.ts` and keeps `docs/security.md` accurate.
7. No secrets in logs, storage or errors.
8. A call that changes state can be accepted without taking effect (bb suspend, resume and reconcile return the host). Check the result, treat "not done" as a failure so the guard backs off, and never report an action as done on the call alone. ESLint enforces this for the bb lifecycle calls.
9. Complexity the change doesn't justify is a finding: a simpler way to the same result, an unused option, or a big change (see "Complexity") made without the owner's review.
10. Public content: no company, client or person names, no personal paths, no real environment names or IDs, and no description of an unfixed weakness (those go to the private roadmap as items to fix).

## Handoff

Write `.agent/HANDOFF.md` when a task ends. The file is git-ignored. Use these sections, in this order:

- Goal
- Changes, with what each added piece of complexity costs and buys
- Needs owner review (big changes planned but not built)
- `npm run check` output
- Review findings, and what was done about each
- Owner live-test steps
- Open questions
- Weaknesses for the roadmap (private)
- Process feedback

Leave changes uncommitted for the owner to review, unless the orchestrator runs a roadmap item the owner named in the session (as `FACTORY.md` Permissions defines it), where it commits them on an `agent/*` branch and opens a PR.
List unfixed weaknesses only under Weaknesses for the roadmap; the orchestrator adds each to the private roadmap. Never describe one in a committed file, a code comment, a commit message or PR text.
Process feedback holds proposed edits to this file, with evidence.

## Improving this file

- Propose an edit when the same correction was needed twice, or when a fact was missing.
- Edit an existing rule instead of adding one.
- The owner applies proposals.
- Keep this file under 300 lines. A proposal that goes over the limit names the line it removes.
- The owner runs `/doctor prompt-audit` once per release.
