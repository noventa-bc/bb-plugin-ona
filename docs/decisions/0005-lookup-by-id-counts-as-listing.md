# 0005. A lookup by id counts as a listing

Status: accepted

Amends the SSH rule in [0002](0002-repairs-never-start-or-stop.md).

## Rule
Where 0002 asks for a fresh Ona listing that says the box is `RUNNING` before SSH, an `ona environment get <id>` made in the same check counts as that listing. A failed `get` means "unknown", exactly like a failed listing; only Ona saying the id doesn't exist means "not found".

## Why
- `get` answers for one box by id, including archived boxes that `ona environment list` leaves out, so it is at least as fresh and as exact as a listing.
- The provider's remove of an adopted box decides whether to SSH from `get`, not from a listing.
- Keeping "failed is unknown" makes a network or CLI failure unable to look like "stopped" or "gone".

## Consequences
- Remove of an adopted box runs its SSH cleanup only when `get`, made just before, says `RUNNING`.
- Automatic repairs read a box's phase from `get` when two listings in a row
  miss it, so a running box the listing misses is not suspended as gone. Heals
  that SSH still gate on the shared listing.
- 0002 counts a box as gone only after two good listings without it. That stays for the shared listing. For a box looked up by id, one `get` answer that says the id does not exist is enough, because Ona states the absence instead of leaving the box out of a list.
