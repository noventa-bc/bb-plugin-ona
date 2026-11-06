# 0002. Repairs never start or stop a box

Status: accepted

Amended 2026-11-05 (the owner accepted it): the plugin starts a box for a waiting thread when bb's resume would be a no-op, and `bb ona resume` starts one on your request. The Rule and the Consequences say so.

Amended 2026-11-06 (the owner accepted it): bb's own recovery after a bb restart also starts a box. The Rule and the Consequences say so.

## Rule

The plugin's automatic repairs never start or stop a box. bb, or the plugin when bb's resume would be a no-op, starts a box only on your action in bb, or in bb's recovery below: creating a machine (adopting a box included), resuming it (Resume, `bb machine resume`, or a message or thread waiting on it), `bb ona resume`, or a command you run that rule 1 in `docs/sync.md` lists as not gated. bb also resumes, on its own, a machine a bb restart left `resuming` or `suspending`, which starts a stopped box as a Resume does (`docs/ona-notes.md`, bb SDK). Automatic suspends mark the machine suspended without calling the provider's stop. SSH to a box is used only when a fresh Ona listing says the box is `RUNNING`.

## Why

- Ona's SSH starts a stopped box, so an SSH attempt to a stopped box costs money and keeps it up.
- A wrong or stale listing must not stop a box that has work on it.
- A daemon restart kills running agent turns, so a live daemon is never restarted.
- A failed or empty listing means "unknown", not "gone", so a network or CLI failure must not change bb's state.

## Consequences

- Tunnels and daemon checks re-check Ona right before connecting. If Ona can't be asked, tunnels wait rather than connect.
- The daemon is restarted only when the probe finds no daemon process. If SSH fails or times out, nothing is restarted.
- A box counts as gone only after two good listings in a row without it.
- The plugin's repairs that find a stopped box only change bb's state, except the start for a waiting thread (see the Rule), so the box stays in whatever state Ona gave it.
- After a bb restart cut a resume or a suspend short (a Pause, or the plugin's idle release), bb's recovery resumes the machine, whatever `autoRepair` says: it starts the box if Ona shows it stopped or stopping, then connects it; once connected, the box stays up until the idle release lets it go (with `idleDisconnect` empty or `0`, it stays connected).
