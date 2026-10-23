# Changelog

All notable changes to the `ona` bb plugin. The plugin is still at version
0.1.0 (`package.json`) and has not been released; entries are grouped by date,
newest first, with the commit that made each change.

## 0.1.0 (unreleased)

### 2026-10-23

#### Added
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

#### Fixed
- "no rollout found" on Codex threads started right after a box woke: Codex
  could start before the shared home was mounted, write its thread to the
  container's own home, and lose it when the mount appeared. (`13d439c`)
- Suspend no longer tries to stop an environment Ona already stopped, and
  resume waits for an environment that is still stopping. (`3d00dd2`)
- bb's native "Open in" control stayed visible on woken boxes, where bb renders
  it late; it is now hidden whenever it appears. (`3d00dd2`)

### 2026-10-22

#### Added
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

#### Changed
- Machines that are suspended now show as "suspended" instead of
  "disconnected". (`ce3b3a5`)

#### Security
- The proxy only joins a devbox's WebSocket to bb once bb has accepted it. A
  rejected upgrade that bb kept open could otherwise have left a devbox an
  unfiltered connection to bb's API. (`8a72030`)
