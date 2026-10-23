# bb-plugin-ona — Ona devboxes for bb

Run [bb](https://getbb.app) threads (Claude Code, Codex) inside Ona environments.
Each bb machine is one Ona environment, either created by bb from an Ona
project or adopted from one you already have. Agents, git, tests and terminals
all run in the devbox.

## Quick start

```sh
bb plugin install git:<plugin-repo-url>   # 1. install (needs the ona CLI, logged in)
bb ona setup                              # 2. see what's missing
bb ona setup --yes                        # 3. apply the one-time settings
bb ona adopt <ona-environment>            # 4a. use an environment you already have
bb ona new <ona-project>                  # 4b. or create a fresh devbox
bb ona list                               # 5. wait until it says "connected"
```

Then pick the machine in bb's composer. Threads running on a devbox get an
**Editor** button in their header.

## How it works

```
bb server (your Mac, 127.0.0.1:<port>)
  └─ bb-ona plugin
       ├─ machine provider "ona"   create / adopt / suspend / resume / remove
       ├─ daemon-only proxy        127.0.0.1:<random port>, forwards only daemon routes
       ├─ SSH reverse tunnel       ssh -N -R <port>:127.0.0.1:<proxy port> <envId>.ona.environment
       └─ bb ona …                 list / host / ssh / open / rename / reconnect
Ona devbox ── bb daemon ──(tunnel)── proxy ── bb server
          └─ claude / codex run here
```

The devbox reaches your bb server through an SSH reverse tunnel over Ona's own
SSH, and the tunnel lands on a small proxy that only lets bb's daemon traffic
through (see [Security model](#security-model)). The server stays on loopback,
and nothing goes through getbb.app or any other third-party relay. Tunnels only
work while your Mac is awake and bb is running. The tunnel does not reconnect
to an environment Ona has stopped, so Ona's idle auto-stop still works. When
Ona stops a devbox, the plugin marks its bb machine suspended (within about two
minutes). bb's machine list then shows Resume (▶), and starting a thread or
sending a message on that devbox starts it first and waits until it's ready.

## Prerequisites

On your Mac:

- bb app **0.46 or newer**
- `ona` CLI installed and logged in (`ona login`). bb cannot install it for you,
  because plugin dependencies are npm packages only.
- `ssh` (built into macOS at `/usr/bin/ssh`)

On each devbox:

- node **22.19 or newer**, npm, curl and git (setup refuses to continue otherwise)
- Claude Code and/or Codex installed and logged in

## Install

```sh
bb plugin install git:<internal-repo-url>
```

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

View them with `bb plugin config ona`, and change one with `bb plugin config ona set <key> <value>`.

| Setting | Default | What it does |
|---|---|---|
| `onaPath` | `/opt/homebrew/bin/ona` | Path to the `ona` CLI. Change it on Intel Macs or non-Homebrew installs (`which ona`). |
| `sshPath` | `/usr/bin/ssh` | Path to `ssh`. |
| `defaultProject` | *(empty)* | Ona project used when creating a devbox without one, e.g. `my-app`. |
| `inactivityTimeout` | `3h` | Auto-stop timeout for devboxes bb creates. Adopted ones keep their own. |
| `codexSqliteHome` | `/workspaces/.codex-sqlite-bb` | Where Codex launched by bb keeps its SQLite state on the devbox's local disk. |
| `machineDataDir` | `/workspaces/.bb-machines` | Local folder that `~/.bb-machines` is symlinked to on every devbox. Empty leaves `~/.bb-machines` alone. |

The last two exist because Ona devboxes can share an NFS-mounted home. SQLite
breaks on network filesystems, and bb allows only one machine identity per data
folder, so both are kept on each devbox's local disk. bb only restarts a daemon
whose data folder is directly inside `~/.bb-machines`, so the plugin makes
`~/.bb-machines` a symlink to `machineDataDir`. On a shared home that one
symlink resolves to each devbox's own disk. If `~/.bb-machines` already exists
as a real folder, setup stops and asks you to move it aside
(`mv ~/.bb-machines ~/.bb-machines.shared`). Settings apply to machines added
after you change them.

## Usage

### Add a devbox

```sh
bb ona adopt <ona-environment>   # existing environment; bb never deletes it
bb ona new [ona-project]         # new devbox; deleted when you remove the machine
```

These are shortcuts for `bb machine create`. Adopt an existing environment;
bb never deletes adopted environments:

```sh
bb machine create --provider ona --inputs '{"mode":"adopt","environment":"<name-or-id>"}'
```

Create a new one from an Ona project. It gets a fun name such as
`nimble-badger-ca1b`, and bb deletes it when you remove the machine:

```sh
bb machine create --provider ona --inputs '{"mode":"create","project":"my-app"}'
# optional: "classId": "<id from ona environment list-classes>"
```

If Ona is slow to start an environment, setup keeps waiting for up to 10 minutes.

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

The **New Ona devbox** option in the environment picker creates a fresh devbox
for the thread.

Check that the agent CLIs are installed and logged in:

```sh
bb machine provider-cli status ona:<name>
```

### Shell access

**In a thread:** a thread that runs on a devbox shows an **Editor** button in its header, which
opens the box in your Ona editor. For a shell, use bb's terminal panel in the right sidebar: on a
devbox thread it already runs on the box.

bb's native **Open in** menu can't reach devboxes, so the plugin hides it on devbox threads.

**From your Mac's terminal:**

```sh
bb ona ssh <name> --thread <thread-id>   # a new terminal to <name> in that thread (ssh from a Mac thread)
bb ona shell <name> -- git status        # run one command in the checkout, print output, keep its exit code
ssh "$(bb ona host <name>)"              # plain ssh, outside bb
bb ona open <name>                       # open the devbox in your Ona editor
```

### Manage devboxes

```sh
bb ona list                    # machines, Ona env, tunnel status
bb ona rename <name> [new]     # rename env + bb machine (random fun name if omitted)
bb ona reconnect <name>        # reopen the tunnel and restart the bb daemon
bb machine suspend ona:<name>  # stops the Ona environment (Pause button in bb's machine list)
bb machine resume ona:<name>   # starts it, reopens the tunnel, restarts the daemon (Play button)
bb machine remove ona:<name>   # created: deletes the env; adopted: stops bb's daemon only
```

## Troubleshooting

- **Provider shows "setup required":** the message says what's missing: install
  the `ona` CLI (or set `onaPath`), run `ona login`, or run `ona environment ssh-config`.
- **"~/.bb-machines is a real folder on the shared home":** move it aside with
  `mv ~/.bb-machines ~/.bb-machines.shared`, then add the machine again.
- **Creation times out or fails:** check `bb plugin logs ona` and `bb machine show <id>`.
  Prerequisite failures name the missing tool.
- **Machine disconnected:** if Ona stopped it, the plugin marks it suspended
  within about two minutes and it resumes on demand. If it is running, use
  `bb ona reconnect <name>`.
- **Codex: "Unable to load codex models":** right after setup, Codex rebuilds its
  index from your session files (can take a minute). Retry shortly after.
- **Shared `~/.codex` database corruption:** for Codex you run yourself on the
  devboxes, add `export CODEX_SQLITE_HOME=/workspaces/.codex-sqlite` to your
  shell profile. `/workspaces` is each devbox's local disk, so every devbox gets
  its own database while login and sessions stay shared.

## Security model

**The risk.** The bb server answers requests from `127.0.0.1` without
credentials. A reverse tunnel pointed straight at its port would make every
request from a devbox look local, so any process there (an agent, an `npm
install` script, a compromised dependency) could use bb's full API: read your
projects and threads, open terminals, or start a thread on your own machine.

**The fix: a daemon-only proxy.** The tunnel never lands on bb's port. It lands
on a proxy the plugin runs on `127.0.0.1` (random port), which forwards only:

| Allowed | Why |
|---|---|
| `GET /health`, `/install.sh`, `/install/version`, `/install/bb-app.tgz` | Installing and health-checking the daemon (same files bb serves to any machine) |
| `/internal/*` | Daemon API; bb requires the daemon's credentials on it |
| WebSocket `/internal/ws` | Daemon connection; bb authenticates it |

Everything else gets `403` and never reaches bb, including the user API
(`/api/*`), the app and terminal sockets (`/ws`, `/ws/terminals/*`) and the web
app. Two `/internal` routes that bb trusts for any loopback caller are blocked
too: `/internal/hosts/enroll-key` (mints machine enrollment keys) and
`/internal/server-move/*`. The proxy also:

- refuses encoded or unusual paths (`%`, `..`, `//`, backslashes, absolute URLs)
  so routing can't be tricked;
- strips headers that could forge identity or origin (`x-bb-*`, including bb
  Connect's gate headers, `x-forwarded-*`, `forwarded`, `x-real-ip`);
- connects the daemon's WebSocket only after bb accepts the handshake (`101`).
  A rejected handshake is answered and closed, so the connection can't be
  reused to slip other requests past the filter;
- logs every blocked request (`bb plugin logs ona`).

The tunnel's port inside the devbox listens on loopback only (`127.0.0.1`,
`::1`), so other machines on Ona's network can't reach it.

**What remains.**

- Code running as the same user on a devbox can read the bb daemon's
  credentials there and act as that machine's daemon. That is true of any bb
  remote machine. The proxy ensures a devbox gets no more than a daemon's
  access, never your bb user's.
- What a daemon credential can do on `/internal/*` is decided by bb, not by
  this plugin. If bb doesn't scope a daemon to its own machine, a compromised
  devbox could affect other machines' data in bb.
- The proxy relies on its allowlist matching how bb routes requests. Upgrading
  bb can add routes, so re-check the allowlist when bb changes its routing.
- Treat what an agent on a devbox reports (output, diffs, links) as untrusted
  input, as with any remote agent.

**Check it yourself** from inside a devbox:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<bb port>/api/v1/projects   # 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<bb port>/health            # 200
```

**Other notes**

- Plugins are full-trust code. Install this one only from a source you trust,
  and review changes before updating.
- Never put secrets in machine inputs; every bb plugin can read them.
- Commands sent to devboxes pass values as arguments, never by pasting them
  into shell scripts, and Ona names and folder settings are validated.
- Devbox traffic stays between Ona and your Mac, with no third-party relay.

## Development

```sh
npm install
npx tsc --noEmit -p .                                          # typecheck
node --test --experimental-strip-types test/*.test.ts          # tests
bb plugin build                                                # bundle
bb plugin install .                                            # install from this folder
bb plugin reload ona                                           # after changes
```

Source: `server.ts` (settings, tunnels, CLI), `src/provider.ts` (machine
provider), `src/proxy.ts` (daemon-only proxy), `src/ssh.ts` (executor, tunnels),
`src/setup.ts` (prerequisite checks), `src/ona.ts` (ona CLI wrapper),
`src/names.ts` (fun names), `skills/ona-devboxes/SKILL.md` (agent docs).
