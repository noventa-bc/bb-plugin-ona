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
  - `status.activitySignal`: `{ source, timestamp }`, e.g. source
    `SSH connections`. On a stopped box too, as the last signal before
    the stop (checked 2026-11-04).
  - `spec.timeout.disconnected`: seconds as a string, e.g. `10800s`;
    `0s` disables auto-stop (`ona environment create --help`,
    checked 2026-11-04).
  - `spec.desiredPhase`
  - `spec.machine.class`
  - `status.content.git`: `branch`, `cloneUrl`, `latestCommit`,
    `totalUnpushedCommits` (a number) and `unpushedCommits` (one string per
    commit). Absent when the box has no git content (checked 2026-10-30 on a
    live listing).
  - `status.content.git`: `totalChangedFiles` (a number) and `changedFiles`
    (one path per entry) for uncommitted changes. A stopped box shows them in
    both `ona environment list -o json` and `ona environment get <id> -o json`;
    a clean box has no `totalChangedFiles` at all (checked 2026-11-05).
  - `status.devcontainer.phase`
  - `status.environmentUrls.*`
  - `metadata.lastStartedAt`: RFC 3339 with microseconds, on a running and a
    stopped box (checked 2026-11-04).
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
- bb 0.48.1's suspend (`maintainMachine` in `server/dist/start-server.js`, checked
  2026-11-05) cancels unfinished environment hooks and stops active threads through
  the daemon before the provider's suspend runs. With the daemon gone, that stop
  fails at once with "Host is not connected" (502 `host_unavailable`). bb then sets
  the phase back to `active`, sets the host's `lifecycle.message` to "Machine
  suspension failed: <message>", and sets `suspendRetryAt` to now plus `RETRY_MS`
  (10 s). A drain that runs past its 5-minute deadline fails with "Machine drain
  exceeded its deadline; old compute is retained" instead. `suspendRetryAt` is a
  lock, not a retry: while it holds, bb's suspend fails inside the background
  operation (the next bullet).
- bb answers the suspend and resume routes with 202 before the operation runs
  (`startMachineSuspension`, `startMachineResume`; checked 2026-11-05). The host reads
  `suspending` or `resuming` until bb settles it. Inside the lock the 202 carries the
  host as it is, `active` with the old message: the lock's 409 `machine_maintenance`
  is raised inside the background operation and only logged. What reaches the client at
  once are the synchronous checks' answers: 404 `host_not_found`, 409
  `machine_provider_unavailable` and `machine_suspend_unsupported` (from
  `requireSuspendableMachine`), and 409 `machine_not_active` and `machine_busy` (from
  `requireActiveSuspendableMachine`). The resume route answers its own synchronous 409
  `machine_not_suspended`, for a machine that is neither active, suspended, suspending nor
  resuming. A suspend that bb later fails looks accepted when
  it is answered.
- For an enrolled machine, bb's `createMachineBootstrapApi` runs `install-machine.sh --start`, whose start branch returns at once when `daemon_matches` holds (the daemon on the host's port reports this host id and server URL). Whether a plugin bootstrap reaches that branch was not traced (checked 2026-11-05).
- `resumeMachine` waits for an in-flight suspend, then `resumeMachineWithIntent`
  returns at once unless the phase is suspended, suspending or resuming. A resume of
  an active machine does nothing (checked 2026-11-05).
- The host's status is only `connected` or `disconnected` (`toHostWithStatus`). The
  new-thread composer labels a selected host whose status is not connected "Host is
  offline" (`NewThreadComposer` in bb's app bundle, checked 2026-11-05).
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
- bb 0.48.1 retries a failed environment teardown (`writeEnvironmentTeardownFailure` in
  `server/dist/start-server.js`): after the first to fourth failed attempt,
  `lifecycle.retireAt` is the next retry, 1, 2, 4 or 8 minutes later (`REMOVE_RETRY_MS`
  doubled per failure); after the fifth (`MAX_REMOVE_ATTEMPTS` is 5) it is null and the
  message starts "Needs recovery:" (checked 2026-11-04). bb sets `retireAt` from
  `Date.now()` in `requestEnvironmentRemoval` and `writeEnvironmentTeardownFailure`, so
  its unit is epoch ms; the SDK types it `number | null` (checked 2026-11-04).
- bb's `lifecycle.phase` for a workspace is `destroyed` when it is destroyed, else
  `teardown` once a teardown status is set, else `retiring` while `retireAt` is set,
  else `active` (`toEnvironmentResponseWithHostLifecycle`, checked 2026-11-04).
- bb's retire grace: `refreshProviderRetirement` runs after bb deletes a thread whose
  storage is gone and after an unarchive. It sets `retireAt` to now plus the provider's
  `retireGraceMs` while no thread on the workspace is live (`environmentHasLiveThreads`),
  keeps an existing `retireAt`, and clears `retireAt` while a thread is live or when
  `retireGraceMs` is null. It does nothing once a teardown status is set (checked 2026-11-04).
- `sweepProviderEnvironmentInSlot` sets the same `retireAt` on a
  workspace with no owner thread and no live thread, clears it while a live thread is
  on the workspace and no teardown status is set, and returns while the workspace has an
  owner thread id and no teardown status. Once `retireAt` has passed it asks for the
  removal (`requestEnvironmentRemoval`). `retireGraceMs` defaults to 300000 (5 min) in
  `environmentProviderPolicySchema`, and the plugin's provider keeps that default (checked 2026-11-04).
- bb's periodic sweep runs every 10 s (`setInterval` with `1e4` in
  `server/dist/start-server.js`). A tick is skipped while the previous run of the
  job is still going (`runPeriodicSweepJob`). A run waits for each workspace it
  sweeps, including that workspace's teardown hook, which can take up to 15 min
  (`ENVIRONMENT_HOOK_TIMEOUT_MS`). A teardown retry starts through its host's
  cleanup slot: one active cleanup per host, four in all
  (`withEnvironmentCleanupSlot`) (checked 2026-11-04).
- bb 0.48.1's owner-mismatch failure (`PROVIDER_OWNER_MISMATCH_MESSAGE` in
  `server/dist/start-server.js`) sets `lifecycle.teardown.status` to failed and leaves
  `retireAt` as it was; no retry runs while the mismatch lasts (checked 2026-11-04). The
  message says the workspace belongs to a different plugin or has no recorded owner, and
  bb writes no `Needs recovery:` text for it (checked 2026-11-04).
- A teardown's hook, a retry's included, needs its host active: an inactive host fails the attempt with
  `host_unavailable` (`assertHostActiveForRead`), except while the machine is being
  removed (`isCleanupRpc`). A teardown never wakes the host (`hostCommandMayWake`)
  (checked 2026-11-04).
- bb pauses a retry while a live thread is on the environment, except while the machine
  is being removed; the next bullet says when it releases the workspace.
  `environmentHasLiveThreads` counts a thread on the environment that is not archived or
  deleted, plus any thread whose status is `active` or `stopping`, whatever its archive
  or delete state. `sweepProviderEnvironmentInSlot` returns before the retry while that
  holds. `requestEnvironmentRemoval` returns false, before any write, when a live thread
  is on the environment and the machine is not being removed (checked 2026-11-04).
- `sweepProviderEnvironmentInSlot` releases a workspace that has an owner and a teardown
  status when a live thread is on the environment, or when it is `ready` with a path,
  and never while the machine is being removed. The release clears `ownerThreadId`,
  `claimPath`, `retireAt` and `teardownStatus`; with a live thread the function then
  returns. A released workspace has no teardown status and no `retireAt`, so bb reports
  its phase as `active` (`toEnvironmentResponseWithHostLifecycle` derives the phase from
  the teardown status), and the plugin reads it as active (checked 2026-11-04).
- bb blocks automatic cleanup of a workspace whose hook outcome is unknown after an
  interruption. `cancelPendingEnvironmentHook` throws "Environment hook outcome is
  unknown after interruption. Automatic cleanup is blocked; inspect the workspace before
  recovering it." `sweepProviderEnvironmentInSlot` records that error as a failed
  teardown (checked 2026-11-04).
- bb 0.48.1's SDK for a plugin is built by `createNodeBbSdk` with a fetch that gives up after
  `DEFAULT_BB_REQUEST_TIMEOUT_MS` (75 s) and throws an Error named `BbRequestTimeoutError`, while bb
  goes on with the request (checked 2026-11-05 in `server/dist/start-server.js`).
- bb 0.48.1 refuses a thread spawn into its personal project unless the workspace is a personal one
  ("Personal project threads must use a personal workspace", `assertProjectWorkspaceCompatibility`).
  An environment's `workspaceProvisionType` is set only for bb's default environment providers
  (`resolveDeprecatedWorkspaceProvisionType`); a workspace from any other provider reads null
  (checked 2026-11-05).
- bb 0.48.1 returns `threads.conversationOutline` items oldest first: event rows sorted ascending,
  items pushed in timeline order (checked 2026-11-05).
- bb 0.48.1 refuses a fork onto another host in `assertForkSourceHost`, called from
  `createThreadFromRequest`, only for a create with `originKind` `fork`: a plain spawn meets no host
  check. `createThreadFromRequest` calls `ensureHostSessionReadyForWork` before the thread row exists,
  so the create request itself waits while bb resumes a suspended host: a move's stopped target is
  started by bb (checked 2026-11-05 in `server/dist/start-server.js`).
- bb 0.48.1 caps each `threads.conversationOutline` item's `preview` at 200
  characters (`CONVERSATION_OUTLINE_PREVIEW_MAX_LENGTH`) and returns one item
  per user or assistant message, with no limit on their number (checked 2026-11-05).
- bb 0.48.1's app only logs an error thrown by a thread action's `run`
  (`console.error`), so a plugin shows its own (checked 2026-11-05).
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
