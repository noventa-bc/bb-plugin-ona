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
