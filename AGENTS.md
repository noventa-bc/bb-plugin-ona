# AGENTS.md

## What this is

bb-ona is a bb plugin. It runs bb threads (Claude Code, Codex) in Ona devboxes and keeps bb's view of each devbox in step with Ona.
This repo is public. Name only this plugin and public tools.

Roadmap items are delivered through the orchestrated flow in `FACTORY.md`.

## Commands

- Run `npm run check` (typecheck, lint, format check and tests) before you finish. `npm run format` fixes formatting.
- Run one test file with `node --test --experimental-strip-types test/reconcile.test.ts`.
- Inside the agent sandbox, tests that need local ports or other processes skip themselves. CI runs them.
- Live reload of the plugin is owner-only. Do not run it.

## Live systems

- bb loads this folder live. A change here can reach the owner's running bb.
- Ona devboxes cost money while they run.
- Ona's SSH starts stopped devboxes. Any SSH to a devbox can wake it.
- Never run `ona` actions, `ssh` to devboxes, or `bb machine` or `bb plugin` changes.
- Never commit to `main` or push, except as `FACTORY.md` allows: builders commit on `agent/*` branches, the orchestrator pushes them and opens PRs.
- Read-only `bb ona status` is fine, but only when the owner is present.

## Coupled changes

Change these together, in the same edit.

- Plugin settings go with the settings table in `README.md`.
- `bb ona` commands go with their usage text, `README.md`, `skills/ona-devboxes/SKILL.md` and `PLUGIN_OVERVIEW.md`.
- `decide()` in `src/reconcile.ts` goes with its tests in `test/reconcile.test.ts` and the rules table in `docs/sync.md`.
- A user-visible change gets a bullet under "Unreleased" in `CHANGELOG.md`. Leave out the commit hash. The owner adds it.

## Decisions

- Decision records live in `docs/decisions/`. The index is `docs/decisions/README.md`.
- Accepted records are binding.
- If a task conflicts with an accepted record, stop and say so. When unattended, note the conflict in the handoff and skip that item.
- To propose a change, add a proposed record and update the index. The owner accepts it.

## How to work

- Fix a bug with a failing test first, where a test is possible.
- When you find a bug, a source of noise or anything that can damage the repo, add the guard that stops it recurring in the same change: a test, a lint rule, a CI step, a `.gitignore` line or a written rule here. Say in the handoff which guard you added.
- A change to what a sync pass does gets a scenario in `test/sync.test.ts` (fake bb calls, fake Ona listing).
- For `server.ts` code without tests, list owner check steps in the handoff instead.
- Put logic in `src/` as pure functions with tests.
- Every SSH or `ona` call must name the safety rule that covers it, in `docs/sync.md`.
- Keep changes small. Do not refactor unrelated code.

## Complexity

- This plugin has one maintainer. Every piece of complexity you add (a dependency, module, abstraction, setting, command, background process, child process, cache or persisted state) must buy more than it costs to read, test and keep working. Prefer the smaller change that solves the problem, and say in the handoff what each addition costs and what it buys.
- A big change needs the owner's review before it is built: a new dependency, command, setting, background or child process, persisted state, a change to a safety rule or an accepted decision, a refactor across modules, or anything that changes how users run the plugin. Attended: stop and ask. Unattended: don't build it; put the plan, its cost and the smallest alternative under "Needs owner review" in the handoff, and build only the parts that aren't big.

## Docs

- Each file owns one thing. `README.md` is for users. `skills/ona-devboxes/SKILL.md` is for agents that use the plugin. `CHANGELOG.md` is for changes. `docs/decisions/` is for reasons.
- Use exact numbers.
- Write "box" or "devbox" for an Ona environment. Write "machine" only for the bb machine.
- Put commands and settings in backticks.
- Write facts that stay true over time. Avoid words that depend on when the text is read.
- A dated fact carries the words "checked YYYY-MM-DD".
- Do not document what the code shows. Point to the code instead.

## Code Review Rules

The safety rules behind 1–4 are in `docs/sync.md`. Cite `file:line` for each finding. Report at most 5 nits.

1. No SSH, start or stop of a box unless an Ona listing from the same check says the box is RUNNING. A failed listing means "unknown".
2. Automatic suspends never stop a box.
3. Forcing (`bb ona sync`) only skips cooldowns. It never skips a safety rule.
4. Removing a machine never deletes an adopted environment.
5. Remote script text is a constant. Values are passed as arguments or through `shellQuote`.
6. The tunnel goes only to the loopback proxy. Added proxy routes need a test and a line in `docs/security.md`.
7. No secrets in logs, storage or errors.
8. A call that changes state can be accepted without taking effect (bb suspend, resume and reconcile return the host). Check the result, treat "not done" as a failure so the guard backs off, and never report an action as done on the call alone. ESLint enforces this for the bb lifecycle calls.
9. Complexity the change doesn't justify is a finding: a simpler way to the same result, an unused option, or a big change (see "Complexity") made without the owner's review.
10. Public content: no company, client or person names, no personal paths, no real environment names or IDs, and no description of an unfixed weakness (those go under Security (private) in the handoff).

## Handoff

Write `.agent/HANDOFF.md` when a task ends. The file is git-ignored. Use these sections, in this order:

- Goal
- Changes, with what each added piece of complexity costs and buys
- Needs owner review (big changes planned but not built)
- `npm run check` output
- Review findings, and what was done about each
- Owner live-test steps
- Open questions
- Security (private)
- Process feedback

Leave changes uncommitted for the owner to review, unless the task runs under `FACTORY.md`, where they go into a PR.
Write unfixed weaknesses only under Security (private). Never put them in a committed file.
Process feedback holds proposed edits to this file, with evidence.

## Improving this file

- Propose an edit when the same correction was needed twice, or when a fact was missing.
- Edit an existing rule instead of adding one.
- The owner applies proposals.
- Keep this file under 150 lines. A proposal that goes over the limit names the line it removes.
- The owner runs `/doctor prompt-audit` once per release.
