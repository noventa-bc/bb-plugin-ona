---
name: changelog
description: Add the commit hash to the changelog bullet for a change that was just committed
disable-model-invocation: true
---

Add the hash of the latest commit to the matching bullet in `CHANGELOG.md`.

1. Find the latest commit: `git log -1 --format=%h`.
2. In `CHANGELOG.md`, under `## Unreleased`, find the bullet or bullets that
   describe that change. Match on the subject and the files it touched
   (`git show --stat <hash>`).
3. Append the hash in the same style as the existing bullets, for example
   `(`abc1234`)`. If a bullet already cites other commits, add the new hash to
   that list, for example `(`bdc7e4b`, `bf7c161`)`. Look at the existing bullets
   for the exact format before editing.
4. If no bullet matches, say so and stop. Don't write a new bullet unless the
   owner asks.
5. Show the diff (`git diff -- CHANGELOG.md`) and stop.

Never commit or push. Committing the changelog is the owner's call.
