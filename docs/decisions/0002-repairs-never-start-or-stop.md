# 0002. Repairs never start or stop a box

Status: accepted

## Rule
Automatic repairs never start or stop a box. Only a user action, `bb machine resume`, starts a box. Automatic suspends mark the machine suspended without calling the provider's stop. SSH to a box is used only when a fresh Ona listing says the box is `RUNNING`.

## Why
- Ona's SSH starts a stopped box, so an SSH attempt to a stopped box costs money and keeps it up.
- A wrong or stale listing must not stop a box that has work on it.
- A daemon restart kills running agent turns, so a live daemon is never restarted.
- A failed or empty listing means "unknown", not "gone", so a network or CLI failure must not change bb's state.

## Consequences
- Tunnels and daemon checks re-check Ona right before connecting. If Ona can't be asked, tunnels wait rather than connect.
- The daemon is restarted only when the probe finds no daemon process. If SSH fails or times out, nothing is restarted.
- A box counts as gone only after two good listings in a row without it.
- Repairs that find a stopped box only change bb's state, so the box stays in whatever state Ona gave it.
