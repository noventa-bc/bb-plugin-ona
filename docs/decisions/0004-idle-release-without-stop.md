# 0004. Idle release without stop

Status: accepted

## Rule
After `idleDisconnect` (default `1h`) with no thread activity, the plugin closes the tunnel and marks the machine suspended, but leaves the Ona environment running. Ona's own inactivity timeout stops it later, and an open Ona editor keeps it running.

## Why
- The bb tunnel counts as activity to Ona. An always-open tunnel meant Ona's timeout never fired, so every box stayed awake as long as bb was open.
- Closing the tunnel lets Ona's timeout do its job. Stopping the box directly would be a stop by the plugin, which 0001 and 0002 forbid.
- An open Ona editor is real use of the box, so the box keeps running while it is open.

## Consequences
- A box isn't released while bb sets up or tears down one of its workspaces, or while one needs recovery; the release waits for the next check.
- Setting `idleDisconnect` to empty or `0` keeps every box connected.
- The next message on the machine resumes it as usual (see 0003).
- An idle box keeps running until Ona's timeout stops it. Devboxes bb creates use `inactivityTimeout` (default `3h`); adopted ones keep their own.
- The tunnel does not reconnect to a box that Ona has stopped or is stopping.
