# Notes on Ona and bb behaviour this plugin relies on

Facts checked 2026-10-30 unless marked otherwise. Re-check before relying on them.

## Observed behaviour

- Ona's SSH starts a stopped environment as a side effect. The plugin therefore
  only uses SSH (tunnel, daemon check) when Ona reports the box as running.
- Ona's inactivity timeout stops boxes. Activity that Ona can see keeps a box
  running.
- bb's always-open SSH tunnel counted as activity, so Ona's inactivity timeout
  never fired while bb was open (see decision 0004).
- Codex records a thread's usage for `account/usage/read` some time after a turn
  ends; about 30 minutes in one observation, checked 2026-11-03. Until then it
  answers `estimatedUsageUsdMicros` 0 with no `groups`.

## Ona CLI

- `ona --help` lists `--timeout <duration>`, "timeout for the operation
  (default 30s)". Whether it bounds the whole command or each request is not
  verified: `keep-alive` runs for hours without it. The plugin passes its own
  wait as `--timeout` on every call (`onaTimeoutArgs` in `src/ona.ts`) except
  `keep-alive` (its argv ends with `-- sleep …`) and `ssh-config`.
- `ona environment list -o json` exposes these fields:
  - `status.activitySignal`: `{ source, timestamp }`, e.g. source `SSH connections`. On a stopped box too, as the
    last signal before the stop (checked 2026-11-04).
  - `spec.timeout.disconnected`: seconds as a string, e.g. `10800s` (checked 2026-11-04).
  - `spec.desiredPhase`
  - `spec.machine.class`
  - `status.content.git`: `branch`, `cloneUrl`, `latestCommit`,
    `totalUnpushedCommits` (a number) and `unpushedCommits` (one string per
    commit). Absent when the box has no git content (checked 2026-10-30 on a
    live listing).
  - `status.devcontainer.phase`
  - `status.environmentUrls.*`
  - `metadata.lastStartedAt`: RFC 3339 with microseconds, on a running and a stopped box (checked 2026-11-04).
- Commands the plugin may use or could use:
  - `ona environment exec` (goes through the EnvironmentOps API, not SSH)
  - `ona environment keep-alive`: watches a process (`--pid`, or a command
    after `--`) and sends activity signals every `--interval` (default `5m`)
    while it runs; `--environment-id` picks the box. It is not an on/off
    switch (checked 2026-10-30).
  - `ona environment port open` and `ona environment port forward`
  - `ona environment devcontainer rebuild` and `ona environment devcontainer logs`
  - `ona environment logs --follow`
  - `ona environment archive`
  - `ona environment get`
  - `ona environment list` with `--phase`, `--search` and `-a`
  - `ona project secret`
  - `ona prebuild warm-pool`
  - `ona user dotfiles`
- `ona environment get <id> -o json` for an id Ona doesn't know exits 1 and
  prints one of two messages on stderr (checked 2026-10-30):
  - a well-formed unknown uuid: `Error: not_found: environment not found`
  - a ref that isn't an id: `Error: no environment found matching "<ref>"`,
    followed by a "Possible resolutions" hint
    `OnaCli.getEnvironmentIfExists` in `src/ona.ts` treats only these as "not
    found"; every other failure means "unknown".
- `ona environment get <id> -o json` on a box that is starting and then running
  (checked 2026-11-04):
  - `status.phase` is `ENVIRONMENT_PHASE_STARTING`, then `ENVIRONMENT_PHASE_RUNNING`.
  - `status.devcontainer` is null while the box starts, then an object with
    `phase: "PHASE_RUNNING"`, the container's id and name, the remote user and
    workspace folder. Its phase values while the container builds are not
    known. Ona's API docs list `PHASE_FAILED`, which has not been seen live.
  - `status.content.phase` was `CONTENT_PHASE_READY` and `status.machine.phase`
    was `PHASE_RUNNING` in both states.
  - `status.failureMessage` was null. Ona's public API
    (<https://ona.com/docs/api-reference/generated/environment/get-environment>)
    documents `failureMessage` and `warningMessage` as lists of strings, a non-empty
    `failureMessage` meaning the environment failed.
  - `status.machine.warningMessage` appeared as a single string (a slow-disk
    warning) on the running box.
- `spec.desiredPhase` is in the live field list above. Its meaning and values
  come from the same API page: the phase Ona is driving the box to, with the
  same values as `status.phase` (`ENVIRONMENT_PHASE_RUNNING`, …). A box stopped
  by Ona's inactivity timeout keeps `spec.desiredPhase`
  `ENVIRONMENT_PHASE_RUNNING` (checked 2026-11-04), so RUNNING there does not
  mean Ona is starting the box.
  A non-empty `failureMessage` meaning a failed environment is also from the
  API docs; on a live box (checked 2026-11-04) it was null while starting and
  running. `readiness()` in `src/ona.ts` holds what the plugin makes of them.
- `ona environment ssh --proxy-connect` (the ProxyCommand form) has a `--start`
  flag that defaults to true. A plugin-owned SSH config that passes
  `--start=false` means SSH can never wake a stopped box.

## bb SDK

- The plugin pins `@get-bb/plugin-sdk` 0.6.109 (checked 2026-11-03).
- SDK 0.6.109's public types do not declare an `experimental_threadHeaderAction`
  slot (checked 2026-11-03). Its app collector accepts the slot, so `app.tsx`
  takes `LegacyThreadHeaderActionRegistration` from the SDK's
  `internal/plugin-app-collector` subpath. bb 0.48 draws header items
  registered through that slot (owner checked 2026-10-30).
- SDK 0.6.109 has `experimental_threadAction` on `app.slots` with
  `placement: "header"` (checked 2026-11-03). A header action is a labelled
  button with an icon and a `run`, not a component, so it can't show the cost
  chip. bb places it after the workspace's Open button, and it cannot hide
  that button, so it cannot replace the hide in `app.tsx`.
- SDK 0.6.109 has no `machine_busy` suspend error code (checked 2026-11-03: the
  name occurs nowhere in its typings or `dist`).
- bb 0.48.1's `startMachineResume` accepts a machine that is `active`,
  `suspended`, `suspending` or `resuming`, and answers 409 for `creating`,
  `removing` and `destroyed` (checked 2026-11-03 in `server/dist/start-server.js`
  under the bb app's bundled `bb-app` package, function `startMachineResume`).
- bb 0.48.1's `threads.list` leaves out hidden threads (workflow steps, side
  chats) unless asked with `includeHidden: true`, drops archived ones on the
  server with `archived: false`, and applies no limit when none is passed.
  `bb thread archive <id>` accepts a hidden thread's id, and archiving a thread
  also archives the hidden threads it started (checked 2026-11-03).
- bb 0.48.1 registers the daemon's `/internal` routes in the `registerInternal*`
  functions of `server/dist/start-server.js` and calls them from
  `host-daemon/dist/daemon-bundle.mjs` (its route-string calls, plus
  `/internal/hosts/enroll`, `/internal/ws` and the server-move downloads built
  from `downloadPath`), both under the app's
  `node_modules/bb-app` (on macOS inside `bb.app/Contents/Resources/app.asar.unpacked`).
  `src/proxy.ts` lists them (checked 2026-11-02).
- bb 0.48.1's installer (`server/dist/assets/install-machine.sh` under the
  app's `node_modules/bb-app`) refuses a data folder whose `host-id` names
  another machine, or whose `auth.json` does when `host-id` is empty ("<dir> on
  this computer belongs to machine <old>, not <new>."), and its `--uninstall`
  deletes the data folder. The daemon it starts runs `bb-app` from the folder's
  resolved path, unless it falls back to a `bb-app` already on the `PATH`. The
  daemon clones a project into `<data folder>/checkouts/<slug>` unless given a
  path (`resolveProjectCloneDefaultPath` in
  `host-daemon/dist/start-host-daemon.js`) (checked 2026-11-03).
- bb 0.48.1 accepts `bb machine remove <m> --force` only for a provider machine
  left removing after a failed cleanup that a workspace still blocks, and only
  while no daemon is connected for it (409 `machine_cleanup_not_failed`,
  `machine_connected`, `machine_cleanup_not_blocked`; `assertForcedRemovalAllowed`
  in `server/dist/start-server.js`) (checked 2026-11-03).
- bb 0.48.1 writes a machine provider's `report.log` only to bb's server log;
  `bb.log.*` also goes to `bb plugin logs <id>`; `report.step` text is cleared
  when the remove finishes (`lifecycleReporter` and `emitLog` in
  `server/dist/start-server.js`) (checked 2026-11-03).
- In SDK 0.6.109 a provider resource is written by the provider's own lifecycle
  hooks (`create`, `suspend`, `resume`, through `checkpoint` or the returned
  `resource`) and read with `bb.experimental_machines.getResource` (checked 2026-11-03).
- SDK surfaces in 0.6.109 that the plugin doesn't use (checked 2026-11-03):
  - host entries: `experimental_defineHostEntry` (plugin code on the daemon,
    fs watch, signals) and the `experimental_host.deleted` event
  - UI: `settingsSection` and `navPanel`
  - provider inputs: `experimental_machineProviderInputs` and
    `experimental_environmentProviderInputs`
  - `bb.agents.contributeInstructions`
  - `bb.realtime.publish`
  - declarative `defineCli`
  - `bb.status.needsConfiguration`
  - `ephemeral: true` machines

## Known gaps

- Archived environments vanish from `ona environment list`, but
  `ona environment get <id>` still returns them. The plugin reads
  `metadata.archivedAt` from that output to tell archived from gone. That field
  name comes from Ona's API and hasn't been seen on a real archived box yet
  (checked 2026-10-30); if it's wrong, archived boxes are still reported gone.
- The Ona SDK (`@gitpod/sdk`) is Enterprise-only. The Ona CLI is the portable
  path for plugins that must run for every user.
