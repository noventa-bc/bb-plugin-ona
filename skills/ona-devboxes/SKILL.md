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
only the daemon's routes (`/internal/*`, `/internal/ws`, the installer files and
`/health`) and answers 403 to everything else, including bb's user API `/api/*`,
`/ws` and `/internal/hosts/enroll-key`. Do not try to work around it from a
devbox. Use `bb` commands from a thread instead; bb routes them correctly.

## One-time setup
- `bb ona setup` lists what is missing; `bb ona setup --yes` applies the Ona SSH
  config and bb's machine access settings. Ask the user before running it with
  `--yes`: it changes their SSH config and bb settings.
- Optional: `bb plugin config ona set defaultProject my-app`.

## Machines
- Shortcuts: `bb ona adopt <environment>`, `bb ona new [project]`.
- Adopt an existing environment (never deleted by bb):
  `bb machine create --provider ona --inputs '{"mode":"adopt","environment":"box-1"}'`
- Create a new one from an Ona project (deleted on `bb machine remove`):
  `bb machine create --provider ona --inputs '{"mode":"create","project":"my-app"}'`
  (optional `"classId"` from `ona environment list-classes`). New devboxes get
  the plugin's `inactivityTimeout` (default `3h`; `bb plugin config ona set inactivityTimeout 6h`).
- `bb machine suspend <m>` stops the Ona environment; `bb machine resume <m>`
  starts it, reopens the tunnel and restarts the daemon. Devboxes Ona stopped
  on its own are marked suspended automatically, and starting a thread on one
  wakes it (takes a few minutes).
- Check agent CLIs: `bb machine provider-cli status <m>`.
- Point a project at the devbox checkout:
  `bb project source add <projectId> --machine <m> --path /workspaces/<repo>`.
- Thread in a fresh devbox: `bb thread spawn --project <id> --environment-provider ona-devbox --prompt "..."`.

## Shell access
- `bb ona list` — machines, Ona env, tunnel status.
- `bb ona shell <ref> -- <cmd…>` — run one command in the devbox checkout; prints output, keeps the exit code.
- `bb ona ssh <ref> --thread <thread-id>` — open another terminal to the devbox in that thread's
  terminal panel (threads on a devbox also get an **Editor** header button). Agents should not type into the
  user's terminals; use your own thread terminals instead.
- `ssh "$(bb ona host <machine-or-env>)"` — interactive shell; `bb ona ssh <ref>` prints the command.
- `bb ona open <ref>` — open in your Ona editor.
- `bb ona reconnect <ref>` — reopen the tunnel and restart the daemon (after changing settings).

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
