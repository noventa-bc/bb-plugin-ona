# Contributing

Everything a person, or the coding agent they hand this repo to, needs in
order to make a change that gets merged. The plugin is maintained by one
person, so the rules below exist to keep it maintainable, not to slow you down.

## What you need

- Node at the version in `.nvmrc`, npm and git. Nothing else is needed to
  build or test: the tests fake bb and the `ona` CLI.
- Optional, for the checks CI also runs: `shellcheck` (shell scripts) and
  `semgrep` (`brew install semgrep`; rules in `.semgrep/rules.yml`).
- Only for trying a change live: a Mac with the bb app and the `ona` CLI, as in
  the README's Prerequisites. Devboxes cost money while they run.

## Set up

```sh
git clone <this repository>
cd bb-plugin-ona
npm ci --ignore-scripts
npm run prepare      # sets up the git hooks; npm install does this too
npm run check        # Node pin, typecheck, lint, format check, tests
```

## Read before changing anything

- `AGENTS.md`: the rules for every change, human or agent. It covers commands,
  the live systems you must not touch, the files that change together, the
  Code Review Rules and the handoff format. It is binding.
- `docs/sync.md`: the safety rules the plugin lives by (never wake, start or
  stop a box by accident). Every SSH or `ona` call cites one of them.
- `docs/decisions/`: accepted records are binding; propose a new record to
  change one.
- `docs/security.md`: why the tunnel lands on a proxy and what it allows.

## Make a change

1. Branch from `main`. Agent-made branches are named `agent/<slug>`. Commit
   messages are Conventional Commits, `type(scope): subject` (the hook from
   "Set up" checks them; `scripts/conventional.sh` has the rule).
2. Fix a bug with a failing test first. Put logic in `src/` as pure functions
   with tests; a change to a sync pass gets a scenario in `test/sync-status.test.ts`
   or `test/sync-chain.test.ts`; run `scripts/lines.sh` first, since the `max-lines` cap in `eslint.config.js` applies to both.
   Offline end-to-end: `test/e2e.test.ts` loads the real `server.ts` in the
   SDK's fake bb host with the fake `ona` (`test/fake-ona.mjs`, stateful) and
   fake `ssh`, and drives the provider's create, suspend, resume and remove;
   `test/e2e-commands.test.ts` does the same for the sync pass and the `bb ona`
   commands, and `test/e2e-heal.test.ts` for the daemon heal, a resume during
   an Ona start and the `thread_cost` rpc. All three need a loopback port, so
   they skip themselves inside the agent sandbox.
3. Write the least code that solves the whole task. Mark a known limit with a
   `shortcut: <the limit>, <when to upgrade>` comment. Never describe an
   unfixed security weakness in a comment, issue or PR: report it as
   `SECURITY.md` says.
4. Make the coupled changes `AGENTS.md` lists (README settings table, usage
   text, `docs/sync.md` rules table).
5. Run `npm run check`, plus `shellcheck` on any `.sh` you touched and the two
   Semgrep commands from `AGENTS.md` if you have Semgrep.
6. Open a pull request against `main`. The title is a Conventional Commit too:
   the squash merge puts it on `main`, and CI reads the bump from it (`feat`
   minor, `fix` and `perf` patch, `!` major; other types none; a Markdown-only
   change never bumps, so give it `docs:`). Run `scripts/bump.sh "<title>"`
   before opening the PR; it sets `version` in `package.json` as the title
   requires, and merging the PR releases it, with notes
   generated from the merged PR titles, so a user-visible change gets a title
   in user-facing wording. In the body, say what changed and why, how you
   tested it, and what a maintainer should check live. CI must be green:
   `check` (Ubuntu, with Semgrep, shellcheck and a test file per `src/` module)
   and, for Markdown, `docs` (formatting, line limits and dead relative links).
   `main` only changes through squash-merged pull requests.

## Working with a coding agent

- Point it at this repo and tell it to read `AGENTS.md` first. The rules there
  are written for agents and apply as they stand.
- Brief it with the template in `docs/owner.md` ("Task brief template"): goal,
  scope, done-when, constraints. Ask for a `.agent/HANDOFF.md` at the end.
- Never let it run `ona` actions, `ssh` to a devbox, or `bb machine` and
  `bb plugin` changes: those reach real systems and can wake a box. The tests
  and fakes cover what it needs.
- The ponytail plugin (install in `docs/owner.md`) is the "least code" ruleset
  the maintainer uses; `/ponytail-review` on your diff is a good last step.
- `FACTORY.md` describes the maintainer's orchestrated flow (one agent
  coordinating builders and reviewers). You do not need it for a single
  change.

## Propose work or a rule change

- The roadmap is a private document of the maintainer. Open a GitHub issue
  with the problem you see or the change you want; the maintainer adds it to
  the roadmap or answers there.
- A change to a safety rule or an accepted decision starts as a proposed record
  in `docs/decisions/` with the index updated. The maintainer accepts it.

## Where things are written down

| File                               | Owns                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `README.md`                        | Using the plugin                                              |
| `skills/ona-devboxes/SKILL.md`     | Agents that use the plugin inside bb                          |
| `AGENTS.md`                        | Rules for changing the plugin                                 |
| `FACTORY.md`                       | The maintainer's orchestrated agent flow                      |
| `docs/owner.md`                    | How the maintainer runs agents, verifies a build and releases |
| `docs/sync.md`, `docs/security.md` | Safety rules and the security model                           |
| `docs/ona-notes.md`                | Facts about Ona and bb, each with a checked date              |
| `docs/decisions/`                  | Why the rules are what they are                               |
| `SECURITY.md`                      | How to report a vulnerability                                 |
