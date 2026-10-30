# Changelog

All notable changes to the `ona` bb plugin, newest first, with the commit that
made each change. The version is the one in `package.json`.

## Unreleased

### Added
- `bb ona keep-alive <box> <duration>` keeps a running devbox from Ona's
  inactivity timeout for up to 12h; `bb ona keep-alive <box> off` ends it.
  It is refused for a box that isn't running, never starts one, and ends when
  the plugin reloads. `bb ona status` shows `keep-alive until HH:MM`.
- `bb ona status [box]` shows bb's view of each devbox next to Ona's, the
  tunnel, what the latest check found (`now`), and the last repair the plugin
  made and why (`last action`). A repair stays listed after the box is healthy
  again. It also reports when the `ona` CLI can't be reached. `bb ona sync [box]`
  re-checks Ona and repairs right away. (`bdc7e4b`, `bf7c161`)
- `autoRepair` setting (on by default). Turn it off to have the plugin only
  report repairs instead of making them. (`bdc7e4b`)

### Fixed
- Idle release no longer lets a box go while bb is setting up or tearing down
  one of its thread workspaces; doing so could leave the workspace needing
  recovery and the machine impossible to suspend. A disconnected running box
  that bb needs for such work is reconnected right away, and `bb ona status`
  flags workspaces that need recovery.
- When bb accepts a suspend but keeps the machine active (for example while it
  blocks lifecycle changes after an interrupted environment hook), the plugin
  no longer reports the idle release as done and retries every 2 minutes. It
  records bb's reason in `bb ona status`, backs off, and stops after 3 tries.
- An archived devbox is reported as archived in `bb ona status`, not gone.
  Archived environments drop out of `ona environment list`, so before reporting
  a box gone the plugin asks Ona about it once with `ona environment get`.
- bb no longer gets stuck when a devbox is started, stopped, restarted or
  deleted outside bb (Ona UI, `ona` CLI, auto-stop):
  - a box that came back gets its bb daemon restarted, but only after an SSH
    check finds the daemon gone, so running turns are never killed;
  - a box Ona stopped or lost is marked suspended at once, and is resumed if a
    thread is already waiting on it;
  - resuming a box someone else is already starting now waits for it instead of
    failing;
  - machines stuck in *resuming* or *suspending* are handed back to bb.

  The plugin now reacts to bb's realtime events (a thread waiting, a machine
  dropping off, a tunnel coming back), and the 2-minute check remains as a
  backstop. These repairs never start or stop a box. All checks share one cached
  `ona environment list`, so tunnels no longer list every environment on each
  reconnect. If Ona can't be asked, tunnels wait instead of connecting, because
  connecting could wake a stopped box. The README's new "How bb and Ona stay in
  sync" section documents every rule. (`bdc7e4b`)
- Every devbox stayed awake for as long as bb was open: bb's always-open SSH
  tunnel counted as activity, so Ona's inactivity timeout never fired. Now,
  once a box has had no thread activity for `idleDisconnect` (default `1h`),
  the plugin closes its tunnel and marks the bb machine suspended. It leaves the
  Ona environment running, so Ona's own timeout stops it and an open Ona editor
  still keeps it alive. The next message on that machine resumes it as usual.
  The tunnel also no longer reconnects to a box that is still stopping.
  (`54a89c7`)

## 0.2.1 (2026-10-23)

### Added
- Codex's "ignoring 1 unrecognized configuration setting …
  `shell_environment_policy.include` is ignored" warning is hidden in bb's
  thread timeline. Codex prints it on every session in a repo with that setting, it is
  harmless, and bb can't mute warnings. The plugin's app adds a CSS rule that
  hides warning rows with that exact text, so other warnings still show. If
  Codex rewords the message, the rule in `app.tsx` needs updating. (`1e5e4d8`)

## 0.2.0 (2026-10-23)

### Added
- Spend chip on devbox threads: the thread header shows what the thread has
  cost so far. For Codex this is OpenAI's own per-thread estimate, read from a
  short-lived Codex app-server on the box. For Claude Code it is the session's
  token counts (subagents included) priced at Anthropic list prices, kept in
  `src/cost.ts`. The figure is rechecked once per finished turn, at most every
  5 minutes, and a paused box is never woken for it. (`21be741`)
- Stopped devboxes wake on demand: when Ona stops an environment on its own
  (idle timeout), the plugin marks the bb machine suspended. bb then offers
  Resume in Settings → Machines, and starting a thread or sending a message
  starts the box first. (`3d00dd2`)
- `waitForSharedHome` setting (on by default): connecting a box waits until its
  NFS home is mounted before starting bb's daemon and agents. (`13d439c`)

### Fixed
- "no rollout found" on Codex threads started right after a box woke: Codex
  could start before the shared home was mounted, write its thread to the
  container's own home, and lose it when the mount appeared. (`13d439c`)
- Suspend no longer tries to stop an environment Ona already stopped, and
  resume waits for an environment that is still stopping. (`3d00dd2`)
- bb's native "Open in" control stayed visible on woken boxes, where bb renders
  it late; it is now hidden whenever it appears. (`3d00dd2`)

## 0.1.0 (2026-10-22)

### Added
- Editor button in the header of devbox threads; it opens the box in your Ona
  editor. bb's native "Open in" is hidden on devbox threads because it can't
  reach devboxes. (`ce3b3a5`)
- `bb ona ssh <box> --thread <id>` opens a terminal to the devbox in that
  thread's terminal panel; `bb ona shell <box> -- <cmd>` runs one command in the
  box's checkout and prints its output. (`ce3b3a5`)
- Weekday 09:00 auto-update of installed Claude Code and Codex CLIs on connected
  devboxes. Boxes with a running agent turn are skipped until the next run.
  `bb ona update [box] [--force]` runs it on demand. (`ce3b3a5`)
- First version of the plugin (`55c411c`):
  - each bb machine is an Ona environment, adopted or created from an Ona
    project, reached over an SSH reverse tunnel through Ona's own SSH;
  - a daemon-only proxy where the tunnel lands, so devboxes can reach only the
    bb daemon's routes and not bb's user API;
  - suspend and resume stop and start the Ona environment; created devboxes get
    friendly names and a configurable inactivity timeout (default 3h);
  - per-devbox local-disk state (`~/.bb-machines` symlink, `CODEX_SQLITE_HOME`)
    so devboxes that share an NFS home don't collide;
  - `bb ona` commands: setup, adopt, new, list, host, ssh, open, rename,
    reconnect; prerequisite checks; README, overview and agent skill.

### Changed
- Machines that are suspended now show as "suspended" instead of
  "disconnected". (`ce3b3a5`)

### Security
- The proxy only joins a devbox's WebSocket to bb once bb has accepted it. A
  rejected upgrade that bb kept open could otherwise have left a devbox an
  unfiltered connection to bb's API. (`8a72030`)
