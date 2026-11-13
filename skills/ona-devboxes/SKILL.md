---
name: ona-devboxes
description: Run bb threads in Ona environments (devboxes) — create or adopt one as a bb machine, reach it over SSH, suspend/resume/remove it.
---

# Ona devboxes

Each bb machine from the `ona` provider is one Ona environment. bb's daemon
runs inside the devbox and reaches the bb server through an SSH reverse
tunnel (`ssh -R <port>:127.0.0.1:<proxy port> <envId>.ona.environment`) that
lands on a daemon-only proxy, so the server stays on loopback. Agents
(claude-code, codex), git, tests and terminals all run in the devbox.

## Security

Inside a devbox, `http://127.0.0.1:<bb port>` is the proxy, not bb. It forwards
only the daemon's routes (its `/internal` calls, `/internal/ws`, the installer
files and `/health`) and answers 403 to everything else, including bb's user
API `/api/*`, `/ws` and `/internal/hosts/enroll-key`. Do not try to work around
it from a devbox. Use `bb` commands from a thread instead; bb routes them correctly.

## One-time setup

- `bb ona setup` lists what is missing; `bb ona setup --yes` applies the Ona SSH
  config and bb's machine access settings. Ask the user before running it with
  `--yes`: it changes their SSH config and bb settings.
- Optional: `bb plugin config ona set defaultProject my-app`, then `bb plugin reload ona` once the user agrees (a reload ends any wake, resume or reconnect in flight).

## Machines

- Shortcuts: `bb ona adopt <environment>`, `bb ona new [project]`.
- Adopt an existing environment (never deleted by bb; refused when another bb machine uses the box):
  `bb machine create --provider ona --inputs '{"mode":"adopt","environment":"box-1"}'`
- Create a new one from an Ona project (deleted on `bb machine remove`, which
  keeps the box without failing while another bb machine uses it, and otherwise
  fails and keeps it while Ona reports unpushed commits or uncommitted files on it,
  or reports no git state for it):
  `bb machine create --provider ona --inputs '{"mode":"create","project":"my-app"}'`
  (optional `"classId"` from `ona environment list-classes`). New devboxes get
  the plugin's `inactivityTimeout` (default `3h`; `bb plugin config ona set inactivityTimeout 6h`, then `bb plugin reload ona` once the user agrees).
- `bb machine suspend <m>` stops the Ona environment; `bb machine resume <m>`
  starts it, reopens the tunnel and restarts the daemon; it gives up after 30
  minutes with "Machine resume failed: Gave up resuming <box> after 30 minutes;
  last step: …". Devboxes Ona stopped
  on its own are marked suspended automatically, and starting a thread on one
  wakes it (takes a few minutes). If a turn was still running when Ona stopped the box, bb can't suspend the machine, so the plugin starts the box for the waiting thread instead.
- Check agent CLIs: `bb machine provider-cli status <m>`. Install a missing one with
  `bb machine provider-cli install <m> codex` (or `claude-code`); thread startup does
  not install or update agent CLIs. `--action update` runs an update instead.
- Point a project at the devbox checkout:
  `bb project source add <projectId> --machine <m> --path /workspaces/<repo>`.
- Thread in a fresh devbox: `bb thread spawn --project <id> --environment-provider ona-devbox --prompt "..."`.
- Pick the box's Ona project with `--machine-inputs`: `bb thread spawn --project <id> --environment-provider ona-devbox --machine-inputs '{"mode":"create","project":"my-app"}' --prompt "..."`. `bb machine create --provider ona` takes the same inputs in `--inputs`.
- `<ref>` is a bb machine name/id or an Ona environment name/id; a name two devboxes share is refused by commands that act on one box (use a host id); `bb ona status` lists them all.
- `bb ona move <thread-id> <ref>` — continue a thread in a new thread on another devbox at the same path (the path must exist there; uncommitted changes stay behind; the old thread stays).
- `bb ona rename <ref> [name]` — rename the Ona environment and its bb machine (a random fun name if `name` is omitted); refused while bb shows its machine in a phase other than active.
- `bb ona update [ref] [--force]` — apply pending updates of the CLIs in `autoUpdateProviders` (default Claude Code and Codex) on connected devboxes (also weekdays at 09:00 when `autoUpdateClis` is on). A box with an agent running is skipped unless `--force`; a box another action is running on is skipped.

## Shell access

- `bb ona shell <ref> -- <cmd…>` — run one command in the devbox checkout; prints output, keeps the exit code (exit 1 with a note when bb reports no exit code).
- `bb ona ssh <ref> --thread <thread-id>` — open another terminal to the devbox in that thread's
  terminal panel (threads on a devbox also get an **Editor** header button and a cost-so-far chip). Agents should not type into the
  user's terminals; use your own thread terminals instead.
- `ssh "$(bb ona host <machine-or-env>)"` — interactive shell.
- `bb ona reconnect <ref>` — reopen the tunnel and restart the daemon; restarts the box's `idleDisconnect` window. `waitForSharedHome`, `codexSqliteHome` and `machineDataDir` reach a box on its next connect after `bb plugin reload ona` (`bb ona reconnect`, a resume or the daemon's restart).
  Refused unless bb shows the machine active and Ona shows its box running; `bb machine resume <m>` resumes a suspended one. Gives up after 30 minutes with "Gave up …; last step: <the step it was on>".
- `bb ona resume <ref>` — start a stopped box and reconnect bb's daemon (your action; a running box is only reconnected); restarts the box's `idleDisconnect` window. Refused unless bb shows the machine active; `bb machine resume <m>` resumes a suspended one. Gives up after 30 minutes with "Gave up …; last step: <the step it was on>".
- `bb ona status [ref]` — each machine's host id, Ona environment, adopted or created and tunnel; bb's view of each devbox next to Ona's, the box's start, idle timeout, activity, branch and unpushed commits, and what the plugin last did and why (`--json` carries `needsRecovery` and `stuckThreads` as null when bb's workspace or thread list couldn't be read).
  Use it first when bb and Ona disagree (box changed outside bb); `bb ona sync [ref]` re-checks and repairs now; a resume it starts is waited for up to 32 minutes after bb answers `resuming`.

## Codex state

`~/.codex` may live on a shared NFS home where SQLite WAL corrupts. bb's daemon
runs with `CODEX_SQLITE_HOME` (setting `codexSqliteHome`, default
`/workspaces/.codex-sqlite-bb`, local disk) so Codex launched by bb keeps its
own state DB. Sessions and auth still come from `~/.codex`.

For the same reason `~/.bb-machines` is a symlink to a local folder (setting
`machineDataDir`, default `/workspaces/.bb-machines`), so two devboxes sharing
an NFS home never collide on one machine identity. If `~/.bb-machines` is a
real folder, setup stops and asks to move it aside.

- bb terminals on the machine work too (terminal panel or `bb terminal`).

## Constraints

- Devbox needs node ≥ 22.19, npm, curl and git (preflight refuses otherwise).
- Tunnels live only while the bb server machine is awake.
- Never put secrets in machine inputs; they are readable by every plugin.
- A box can run several threads: suspending it stops every active thread on it and force-closes its terminals, so suspend or remove a box only when the user asks.
