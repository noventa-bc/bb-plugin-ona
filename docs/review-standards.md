# Review standards

What makes a review finding block a PR. Reviewers judge their findings by this
file; `FACTORY.md` step 6 says which passes run on which round.

## Scope

The item's code is the PR's scope, and reviewer briefs name it and ask for
anything outside it under a separate "Pre-existing" heading.

## What blocks

A finding blocks only when the branch introduced the defect or makes one
reachable or worse, when the branch breaks a safety rule or a coupled change,
leaves its own behaviour untested where a test is possible, leaves a doc in the
diff contradicting the code, or is a big change the owner has not reviewed
(`AGENTS.md` "Complexity").

A finding that was already on `main` and that the branch does not make
reachable or worse becomes a roadmap item, with its guard, and the PR names it
by its label only, whatever severity the reviewer gave it; a credential or a
data-loss risk goes to the owner at once as well.

## Later rounds

After the first round the builder adds no behaviour beyond a fix for a blocking
finding: a fix that needs behaviour beyond that is its own item. Before a round
swaps or retitles a test, run the old test against the mutant its title names:
a title can be right for a clause the round misread.

## What counts as code

Code, here, is anything but comments, lint messages, Markdown, a lockfile, a
`package.json` override and the version bump (`FACTORY.md` step 7); the ten
numbered Code Review Rules in `AGENTS.md` and the rules table in `docs/sync.md`
count as code.

## How reviewers work

These bind every review pass, on top of `AGENTS.md` "Subagents".

- Read-only in the builder's worktree (`AGENTS.md` "Subagents"): run only read-only `git -C <worktree> ...` commands there, never `add`, `commit`, `restore`, `checkout` or `stash`. Nothing is written under the folder that holds the checkouts.
- Work in your own scratch folder only: the new folder the brief names, made with `scripts/scratch-copy.sh <worktree> <sha> <dir>`. Keep every command's working directory inside that copy. The copy has no `.git`, so git commands stay on the worktree. In a pass that runs checks, if the script reports no `node_modules` link, stop and report it; never link, copy or install `node_modules`. The copy's `node_modules` is a link into a checkout, so never write through it.
- Read the diff the brief gives, in its three-dot form. A two-dot diff from a stale base shows main's newer commits as reverted.
- To run a mutant, save the file you will change in your scratch folder first, change the copy, run the test, then copy the saved file back. Never restore with git in the worktree.
- Run tests from a script file you write in your scratch folder, with `sh <file>`; inside `sh -c "..."` the quotes end early. The command is `perl -e 'setpgrp(0,0); $SIG{ALRM} = sub { kill "TERM", 0 }; alarm 240; system @ARGV; exit($? & 127 || $? >> 8)' -- node --test --experimental-strip-types --test-timeout=60000 <files>`. The alarm stops the test process group, because the owner's Mac has no `timeout` command (checked 2026-11-11). A mutant that may hang uses `--test-timeout=10000`, so it fails fast; that can cancel an e2e test that sleeps by design, so its cancellation in that run is expected. A test the sandbox skips prints its reason, and the summary shows `skipped N`.
- Prefix every file you write outside your scratch copy with the name of your scratch folder (the last part of the folder path the brief names, unique per run), so two reviewers never overwrite each other's files. Name a file you wrote by the exact path your write call used.

## Report

Blocking findings first, each with file:line, its concrete failing case and why it blocks (the case under "What blocks"). Then the "Pre-existing" heading, then the nits (`AGENTS.md` "Code Review Rules" caps them). Your last message is the report.
