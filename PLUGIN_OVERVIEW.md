Run bb threads, including Claude Code and Codex, inside Ona environments.
Each devbox becomes a bb machine. Agents, git, tests and terminals run there,
and you drive them from bb as usual.

## What you get

- An **Ona devbox** machine type. **Adopt** an environment you already have
  (bb never deletes it), or **create** a new one from an Ona project. New
  devboxes get fun names like `nimble-badger-ca1b` and a 3h idle timeout.
- A **New Ona devbox** option in the environment picker, for starting a thread
  on a fresh devbox.
- **Suspend and resume**: bb's Pause/Play buttons stop and start the Ona
  environment. A devbox Ona stopped on its own shows as suspended, and a new
  thread or message on it starts it first.
- **Shell access**: `ssh "$(bb ona host <name>)"`, `bb ona open <name>` for
  your Ona editor, and bb's terminal panel on the devbox.
- `bb ona adopt <environment>` and `bb ona new [project]` to add devboxes, and
  `bb ona list`, `rename` and `reconnect` for day-to-day management.

## How it works

The bb daemon runs inside each devbox and connects back to your bb server
through an SSH reverse tunnel over Ona's own SSH. Your bb server stays on
loopback, and nothing goes through a third-party relay.

The tunnel lands on a small proxy that forwards only the bb daemon's own
routes. bb's user API, app and terminal sockets, and the enrollment-key route
answer 403 to the devbox. So code running in a devbox, such as an agent or an
install script, can't control your bb server or your machine.

Each devbox keeps bb's machine data and bb's Codex database on its own local
disk, so devboxes that share an NFS-mounted home don't collide.

## Requirements

- bb 0.46 or newer, and the Ona CLI installed and logged in (`ona login`) on
  the bb server machine.
- Devboxes with node 22.19 or newer, npm, curl and git, plus Claude Code and/or
  Codex logged in.
- One-time setup: run `bb ona setup` to see what's missing, then
  `bb ona setup --yes` to apply it (Ona SSH config, and bb's machine access set
  to direct with the server URL `http://127.0.0.1:<bb port>`).

bb's Machines settings show "setup required", with the fix, until the Ona CLI
is found and logged in and the SSH config exists.

## For agents

The bundled `ona-devboxes` skill explains how to add, suspend, resume and
remove devboxes, how to reach them over SSH, and that the devbox's view of the
bb port is the daemon-only proxy, not bb itself.
