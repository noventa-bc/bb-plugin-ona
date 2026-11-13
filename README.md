# bb-plugin-ona — Ona devboxes for bb

Run [bb](https://getbb.app) threads (Claude Code, Codex) inside Ona environments.
Each bb machine is one Ona environment, either created by bb from an Ona
project or adopted from one you already have. Agents, git, tests and terminals
all run in the devbox.

## Quick start

```sh
bb plugin install git:https://github.com/noventa-bc/bb-plugin-ona.git@^0.3.0   # 1. install (needs the ona CLI, logged in)
bb ona setup                                                                   # 2. see what's missing
bb ona setup --yes                                                             # 3. apply the one-time settings
bb ona adopt <ona-environment>                                                 # 4a. use an environment you already have
bb ona new <ona-project>                                                       # 4b. or create a fresh devbox
bb ona status                                                                  # 5. wait until it says "bb:connected"
```

Then pick the machine in bb's composer. Threads running on a devbox show what
they've spent so far and an **Editor** button in their header.

## How it works

```
bb server (your Mac, 127.0.0.1:<port>)
  └─ bb-ona plugin
       ├─ machine provider "ona"   create / adopt / suspend / resume / remove
       ├─ daemon-only proxy        127.0.0.1:<random port>, forwards only daemon routes
       ├─ SSH reverse tunnel       ssh -N -R <port>:127.0.0.1:<proxy port> <envId>.ona.environment
       └─ bb ona …                 the commands under Usage
Ona devbox ── bb daemon ──(tunnel)── proxy ── bb server
          └─ claude / codex run here
```

The devbox reaches your bb server through an SSH reverse tunnel over Ona's own
SSH, and the tunnel lands on a small proxy that only lets bb's daemon traffic
through (see [Security model](docs/security.md)). The server stays on loopback,
and nothing goes through getbb.app or any other third-party relay. Tunnels only
work while your Mac is awake and bb is running. An open tunnel counts as
activity to Ona, so the plugin keeps it open only while you use the box, or after bb's restart recovery resumes the machine. After
`idleDisconnect` (1h by default) without thread activity (counted from the later of a thread's last activity and the box's last create, adopt,
`bb ona resume`, `bb ona reconnect` or resume by bb: `bb machine resume`, bb's restart recovery or a waiting thread's resume;
the plugin's own repairs, and its start of a box for a thread waiting on an active machine, do not restart it),
it closes the tunnel (busy workspaces and failed reads hold the box: the exceptions are in [How bb and Ona stay in sync](docs/sync.md), after the table) and marks the bb machine suspended, but it doesn't stop the
environment. Ona's
own inactivity timeout stops it later, unless you still have an Ona editor open
on it. The tunnel never reconnects to an environment that Ona has stopped or is
stopping. When Ona stops a devbox, the plugin marks its bb machine suspended.
bb's machine list then shows Resume (▶), and starting a thread or sending a
message on that devbox starts it first and waits until it's ready. If a turn was still running when Ona stopped the box, bb can't suspend the machine, so the plugin starts the box for the waiting thread instead. Changes made
outside bb are covered in [How bb and Ona stay in sync](docs/sync.md).

## How bb and Ona stay in sync

How the plugin keeps bb's view of each devbox in step with Ona, its safety
rules, and troubleshooting stuck boxes: [docs/sync.md](docs/sync.md).

## Prerequisites

On your Mac:

- bb app **0.48.1 or newer**
- `ona` CLI installed and logged in (`ona login`). bb cannot install it for you,
  because plugin dependencies are npm packages only.
- `ssh` (built into macOS at `/usr/bin/ssh`)

On each devbox:

- node **22.19 or newer**, npm, curl and git (setup refuses to continue otherwise)
- Claude Code and/or Codex installed and logged in

## Install

```sh
bb plugin install git:https://github.com/noventa-bc/bb-plugin-ona.git@^0.3.0
```

The `^0.3.0` range installs the highest matching release tag, and `bb plugin
update` follows it; `bb plugin install https://github.com/noventa-bc/bb-plugin-ona`
tracks `main` instead.

bb installs the npm dependencies and builds the plugin itself, so you don't need
Node on your Mac's PATH. Plugins are full-trust code inside bb; only install
from a source you trust.

## One-time setup

```sh
bb ona setup          # shows what's missing (changes nothing)
bb ona setup --yes    # applies it
```

It checks that the Ona CLI is installed and logged in, then sets up three
things:

- **Ona SSH config:** lets SSH reach Ona environments by name. This adds an
  Include line to `~/.ssh/config`.
- **Machine access:** sets bb's default machine access to `direct`, with the
  server URL `http://127.0.0.1:<your bb port>`. That address is the tunnel end
  on each devbox. This setting applies to **all** your remote bb machines, not
  only Ona ones.
- **GitHub login forwarding:** stops forwarding your Mac's GitHub login to
  devboxes, since Ona already gives them git access. Add
  `--keep-git-credentials` to leave this as it is.

Run `bb ona setup` again at any time to check that everything is still in place.

<details>
<summary>Set it up by hand instead</summary>

1. Let SSH reach Ona environments by name:

   ```sh
   ona environment ssh-config
   ```

2. Point remote machines at your bb server through the tunnel. Find your port
   with `bb status` (look for `BB_SERVER_URL`); it may not be 38886.

   ```sh
   bb settings general defaultMachineAccess direct
   bb settings general machineServerUrl http://127.0.0.1:<your-bb-port>
   ```

3. Optional: stop forwarding your Mac's GitHub login to devboxes.

   ```sh
   bb settings general machineGitCredentialsEnabled false
   ```

4. Check that bb sees the provider:

   ```sh
   bb machine providers        # should list: ona  Ona devbox
   ```

</details>

## Plugin settings

View them with `bb plugin config ona`, and change one with `bb plugin config ona set <key> <value>`, then `bb plugin reload ona`.

| Setting               | Default                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onaPath`             | `/opt/homebrew/bin/ona`        | Path to the `ona` CLI. Change it on Intel Macs or non-Homebrew installs (`which ona`).                                                                                                                                                                                                                                                                                                                                        |
| `sshPath`             | `/usr/bin/ssh`                 | Path to `ssh`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `defaultProject`      | _(empty)_                      | Ona project used when creating a devbox without one, e.g. `my-app`.                                                                                                                                                                                                                                                                                                                                                           |
| `inactivityTimeout`   | `3h`                           | Auto-stop timeout for devboxes bb creates. Adopted ones keep their own.                                                                                                                                                                                                                                                                                                                                                       |
| `autoRepair`          | `true`                         | Repair bb's view of devboxes changed outside bb (see [How bb and Ona stay in sync](docs/sync.md)). Off: stopped or deleted boxes are still marked suspended, tunnels still reopen, idle boxes are still let go after `idleDisconnect`, and a waiting thread still resumes or starts a stopped box, as does bb's recovery after a restart; everything else is only reported by `bb ona status`.                                |
| `idleDisconnect`      | `1h`                           | After this long with no thread activity, bb closes its tunnel to a devbox and marks the machine suspended so Ona's timeout can stop it (what restarts the window is in How it works; the exceptions are in [docs/sync.md](docs/sync.md)). The next message wakes it. Empty or `0` keeps every box connected. Write it as `45s`, `30m`, `1.5h` or bare minutes (`90`); bb refuses forms like `1h30m` or `90min` when you save. |
| `waitForSharedHome`   | `true`                         | After a devbox starts, wait until its NFS home is mounted before starting bb's daemon and agents. Starting earlier lets Codex write threads into the container's own home, where the mount hides them ("no rollout found"). Turn off if your environments don't share a home.                                                                                                                                                 |
| `codexSqliteHome`     | `/workspaces/.codex-sqlite-bb` | Where Codex launched by bb keeps its SQLite state on the devbox's local disk.                                                                                                                                                                                                                                                                                                                                                 |
| `machineDataDir`      | `/workspaces/.bb-machines`     | Local folder that `~/.bb-machines` is symlinked to on every devbox. Empty leaves `~/.bb-machines` alone.                                                                                                                                                                                                                                                                                                                      |
| `autoUpdateClis`      | `true`                         | Weekdays at 09:00 (this Mac's time), apply pending updates for the CLIs in `autoUpdateProviders` on connected devboxes. A box with a running agent turn, or that another action is running on, is skipped until the next run.                                                                                                                                                                                                 |
| `autoUpdateProviders` | `claude-code,codex`            | Provider ids of the CLIs to update, comma-separated. Only installed CLIs are updated; nothing new is installed.                                                                                                                                                                                                                                                                                                               |

`waitForSharedHome`, `codexSqliteHome` and `machineDataDir` reach a box on its next connect (`bb ona reconnect`, a resume or the daemon's restart); `inactivityTimeout` applies to boxes created after the reload.

The last two exist because Ona devboxes can share an NFS-mounted home. SQLite
breaks on network filesystems, and bb allows only one machine identity per data
folder, so both are kept on each devbox's local disk. bb only restarts a daemon
whose data folder is directly inside `~/.bb-machines`, so the plugin makes
`~/.bb-machines` a symlink to `machineDataDir`. On a shared home that one
symlink resolves to each devbox's own disk. If `~/.bb-machines` already exists
as a real folder, setup stops and asks you to move it aside
(`mv ~/.bb-machines ~/.bb-machines.shared`).

**In settings:** the plugin's settings page has an **Ona devboxes** section with `bb ona status` and buttons that
run `bb ona sync`, `bb ona reconnect`, `bb ona resume`, `bb ona update` and `bb ona rename` for a devbox (**Sync all**
runs `bb ona sync` for every devbox). **Update CLIs** never passes `--force`, so a box with a running agent is skipped:
click again once the agent is idle. A **Resume**, **Reconnect** or **Update CLIs** started here keeps running after the
page closes and ends on a plugin reload. The page reads the status again every 30 seconds.

## Usage

### Add a devbox

```sh
bb ona adopt <ona-environment>   # existing environment; bb never deletes it
bb ona new [ona-project]         # new devbox; deleted when you remove the machine, unless it has unpushed commits or uncommitted files or another machine uses it
```

These are shortcuts for `bb machine create`. Adopt an existing environment;
bb never deletes adopted environments. A box holds one bb machine: adopting a box another bb machine uses fails with
"<machine> (<host id>) uses Ona environment <box>; a box holds one bb machine", and you remove that machine first.

```sh
bb machine create --provider ona --inputs '{"mode":"adopt","environment":"<name-or-id>"}'
```

Create a new one from an Ona project. It gets a fun name such as
`nimble-badger-ca1b`, and bb deletes it when you remove the machine. While
another bb machine uses the box, the remove succeeds and keeps it. Otherwise,
if Ona reports unpushed commits or uncommitted files on the box, the remove
fails and the box is kept: commit and push, or discard, the work, or delete the box with
`ona environment delete <id>`, then run `bb machine retry-cleanup`:

```sh
bb machine create --provider ona --inputs '{"mode":"create","project":"my-app"}'
# optional: "classId": "<id from ona environment list-classes>"
```

Before its first SSH, setup waits up to 15 minutes for Ona to report the box and
its dev container running, and shows Ona's progress. It fails at once, without SSH,
when the box can't come up, for example a box Ona deleted or is deleting;
"The connect wait" in [docs/sync.md](docs/sync.md) (safety rule 1) has every case.

### Run threads on it

Point a bb project at the checkout on the devbox:

```sh
bb project source add <projectId> --machine ona:<name> --path /workspaces/<repo>
```

Then pick that machine in the composer, or:

```sh
bb thread spawn --project <projectId> --machine ona:<name> \
  --environment /workspaces/<repo> --provider claude-code --prompt "..."
```

The **Ona devbox** option in the environment picker runs the thread on a devbox.
Its selector picks **Create** (a fresh devbox from the **Ona project** field; a
blank field uses the `defaultProject` setting) or **Adopt** (an Ona environment
you already have, named in the **Ona environment** field; removing the machine
keeps it). An environment another bb machine uses is refused.

Check that the agent CLIs are installed and logged in:

```sh
bb machine provider-cli status ona:<name>
```

### Move a thread to another devbox

**Move to devbox** in a devbox thread's menu (next to Archive) lists the other devboxes. Picking one
starts a new thread on that box at the same path, with the same title, whose first message hands
the work over: where it came from, and the old conversation in outline. The old thread stays as it
is. From your Mac's terminal: `bb ona move <thread-id> <ref>`.

- Only a thread whose workspace is a checkout path on the box can move, and the path must exist on
  the target box. It does for the Ona project checkout (`/workspaces/<repo>`). A thread in a
  bb-managed worktree or bb's personal workspace is refused, and so is one in bb's personal project;
  the message says so.
- A stopped target box is started by bb. The new thread should appear once the box is up, which can
  take minutes. If bb is still starting the box when you move, the menu says so and asks you not to
  move the thread again.
- Uncommitted changes stay on the old box: commit and push a branch first. The new thread starts a
  fresh agent session; it learns the rest from the hand-over message.

### Shell access

**In a thread:** a thread that runs on a devbox shows an **Editor** button in its header, which
opens the box in your Ona editor. For a shell, use bb's terminal panel in the right sidebar: on a
devbox thread it already runs on the box.

bb's native **Open in** menu can't reach devboxes, so the plugin hides it on devbox threads.

### Spend per thread

A devbox thread's header shows what the thread has cost so far (for example `$3.50`); hover it
for the source. The figure is an estimate that updates after a turn finishes; Codex records a turn's
usage some time later ([docs/ona-notes.md](docs/ona-notes.md)). For Codex, a `≥` before the figure
means some sessions have no recorded usage. A paused box shows its last saved figure, and reading
it never wakes the box.

- **Codex:** OpenAI's own per-thread estimate, the number behind Codex's `estimated-thread-cost`
  status item. The plugin asks a short-lived `codex app-server` on the box (`account/usage/read`),
  using the box's own Codex login.
- **Claude Code:** Claude Code doesn't save its cost, so the plugin adds up the session's tokens per
  model (including subagents) from `~/.claude/projects` on the box and multiplies by Anthropic list
  prices, which is how Claude Code works out its own figure. The prices live in `CLAUDE_PRICES` in
  `src/cost.ts`; update them when Anthropic changes prices. A model missing from that table shows
  as `≥$…` (the total leaves it out).

`<ref>` is a bb machine name/id or an Ona environment name/id; a name two devboxes share is refused by commands that act on one box (use a host id); `bb ona status` lists them all.

**From your Mac's terminal:**

```sh
bb ona ssh <ref> --thread <thread-id>    # a new terminal to <ref> in that thread (ssh from a Mac thread)
bb ona shell <ref> -- git status         # run one command in the checkout, print output, keep its exit code (exit 1 with a note when bb reports no exit code)
ssh "$(bb ona host <ref>)"               # plain ssh, outside bb
```

### Manage devboxes

```sh
bb ona status [ref]            # each machine's host id, Ona environment, adopted or created, tunnel, bb's view next to Ona's, the box's start, idle timeout, activity, branch and unpushed commits, and what the plugin last did
bb ona sync [ref]              # re-check Ona now and repair out-of-step machines; a resume it starts is waited for up to 32 minutes after bb answers `resuming`
bb ona move <thread-id> <ref>  # continue a thread in a new thread on another devbox, at the same path
bb ona rename <ref> [name]     # rename env + bb machine (random fun name if omitted); refused while bb shows its machine in a phase other than active
bb ona reconnect <ref>         # active machines: reopen the tunnel and restart the bb daemon; refused unless bb shows the machine active and Ona shows its box running; gives up after 30 minutes ("Gave up …; last step: …")
bb ona resume <ref>            # a stopped active machine: starts its box and reconnects the bb daemon (your action); a running box is only reconnected; refused unless bb shows the machine active; gives up after 30 minutes ("Gave up …; last step: …")
bb ona update [ref] [--force]  # apply pending agent-CLI updates on connected devboxes (also weekdays 09:00 when `autoUpdateClis` is on); a box with an agent running is skipped unless --force; a box another action is running on is skipped
bb machine suspend ona:<name>  # stops the Ona environment (Pause button in bb's machine list)
bb machine resume ona:<name>   # starts it, reopens the tunnel, restarts the daemon (Play button); gives up after 30 minutes ("Machine resume failed: Gave up resuming <box> after 30 minutes; last step: …")
bb machine remove ona:<name>   # created: deletes the box unless it has unpushed commits or uncommitted files or another machine uses it; adopted: stops bb's daemon, moves its data folder aside
```

## Troubleshooting

- **Provider shows "setup required":** the message says what's missing: install
  the `ona` CLI (or run `bb plugin config ona set onaPath <path>`, then `bb plugin reload ona`), run `ona login`, or run `ona environment ssh-config`.
- **"~/.bb-machines is a real folder on the shared home":** move it aside with
  `mv ~/.bb-machines ~/.bb-machines.shared`, then add the machine again.
- **Creation times out or fails:** check `bb plugin logs ona` and `bb machine show <id>`.
  Prerequisite failures name the missing tool.
- **"thread … holds this box" in `bb ona status`:** bb still shows that thread
  busy after more than 6 hours with no update, so the plugin won't release the
  box or update its agent CLIs. Open the thread; if nothing is running in it,
  archive it. Archived threads never hold a box. A workflow step or side chat
  runs in a thread bb hides from its sidebar; archive it with
  `bb thread archive <id>`, or archive the thread that started it, which
  archives it too.
- **"workspace(s) may need recovery" in `bb ona status`:** a thread workspace's
  teardown failed and bb is retrying or has given up; an active box stays awake until
  it clears (bb's retries and messages: [docs/ona-notes.md](docs/ona-notes.md)). Check
  what's left in the workspace (`bb environment list --host <machine>`, then the
  workspace path on the box). On an adopted box only (removing a created one deletes
  it unless it has unpushed commits or uncommitted files or another bb machine uses it), once that list shows `Needs recovery:` for the workspace, start over: keep the box running, run `bb machine remove <machine>`,
  then `bb ona adopt <box>`. If the remove fails, stop every bb daemon on the box, and
  anything running from a checkout in it, with
  `ssh "$(bb ona host <box>)" 'pkill -f "$(readlink -f ~/.bb-machines)/"'`, run
  `bb machine remove <machine> --force`, then `bb ona adopt <box>`.
- **"bb's workspace or thread list couldn't be read" in `bb ona status`:** bb's own list of
  that machine's threads or workspaces failed; the box isn't let go while it lasts.
  `bb plugin logs ona` has the error; the next `bb ona status` shows it cleared once bb answers.
- **"Ona lists no environments" in `bb ona status`:** `ona environment list` answered with no boxes
  (a different `ona context` or login, say); idle boxes are not released while it lasts, and the Ona column reads `unknown`.
- **Adopting a box again after removing its machine:** removing an adopted
  machine while its box is running stops bb's daemon there and moves bb's data
  folder aside, to `~/.bb-machines/<server>.old-<UTC time>`; nothing in it is
  deleted, and bb's clones of your projects (it clones into that folder by default), with any unpushed work, move with it.
  When the remove leaves the folder (the box wasn't running, the daemon couldn't be
  stopped, the move failed, or the folder is or holds the home folder) or finds none,
  it says so in `bb plugin logs ona`: start the box, then rename the folder whose
  `host-id` file holds the host id the log line names (in a shell from
  `ssh "$(bb ona host <box>)"`, `grep -l <host-id> ~/.bb-machines/*/host-id` finds
  it), or bb's installer refuses it ([docs/ona-notes.md](docs/ona-notes.md)). After
  the re-adopt, the old machine's threads can't take new messages, and its project
  sources must be added again.
- **bb and Ona disagree about a box** (bb says down but it's running, or the
  other way round): run `bb ona status <ref>`, then follow "Seeing and fixing it
  yourself" in [How bb and Ona stay in sync](docs/sync.md).
- **Codex: "Unable to load codex models":** right after setup, Codex rebuilds its
  index from your session files (can take a minute). Retry shortly after.
- **Shared `~/.codex` database corruption:** for Codex you run yourself on the
  devboxes, add `export CODEX_SQLITE_HOME=/workspaces/.codex-sqlite` to your
  shell profile. `/workspaces` is each devbox's local disk, so every devbox gets
  its own database while login and sessions stay shared.

## Security model

How devboxes are kept to the bb daemon's routes and what remains to trust:
[docs/security.md](docs/security.md).

## Development

To contribute a change, start with [CONTRIBUTING.md](CONTRIBUTING.md). To run
the plugin from this folder:

```sh
bb plugin build                                                # bundle
bb plugin install .                                            # install from this folder
bb plugin reload ona                                           # after changes
```

Source: `server.ts` wires the plugin to the modules in `src/`; "Where things
are" in [AGENTS.md](AGENTS.md) maps them.

Working on the plugin, including with coding agents: see [AGENTS.md](AGENTS.md).
Decision records are in [docs/decisions](docs/decisions/README.md).
