# Notes on Ona and bb behaviour this plugin relies on

Facts checked 2026-10-30 unless marked otherwise. Re-check before relying on them.

## Observed behaviour

- Ona's SSH starts a stopped environment as a side effect. The plugin therefore
  only uses SSH (tunnel, daemon check) when Ona reports the box as running.
- Ona's inactivity timeout stops boxes. Activity that Ona can see keeps a box
  running.
- bb's always-open SSH tunnel counted as activity, so Ona's inactivity timeout
  never fired while bb was open (see decision 0004).

## Ona CLI

- `ona environment list -o json` exposes these fields:
  - `status.activitySignal`
  - `spec.timeout.disconnected`
  - `spec.desiredPhase`
  - `spec.machine.class`
  - `status.content.git.totalUnpushedCommits`
  - `status.devcontainer.phase`
  - `status.environmentUrls.*`
  - `metadata.lastStartedAt`
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
- `ona environment ssh --proxy-connect` (the ProxyCommand form) has a `--start`
  flag that defaults to true. A plugin-owned SSH config that passes
  `--start=false` means SSH can never wake a stopped box.

## bb SDK

- The plugin pins `@get-bb/plugin-sdk` 0.6.49, with `engines` set to bb
  `>=0.46`. bb 0.48.0 ships a later SDK than that pin (checked 2026-10-30).
- The SDK in bb 0.48.0 has `experimental_threadAction` with
  `placement: "header"`, which 0.6.49 lacks. It could replace the DOM
  workaround in `app.tsx` that hides bb's native "Open in" button. Check the
  installed SDK version before relying on it.
- SDK surfaces the plugin doesn't use (checked 2026-10-30):
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
