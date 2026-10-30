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
  - `ona environment keep-alive`
  - `ona environment port open` and `ona environment port forward`
  - `ona environment devcontainer rebuild` and `ona environment devcontainer logs`
  - `ona environment logs --follow`
  - `ona environment archive`
  - `ona environment get`
  - `ona environment list` with `--phase`, `--search` and `-a`
  - `ona project secret`
  - `ona prebuild warm-pool`
  - `ona user dotfiles`
- `ona environment ssh --proxy-connect` (the ProxyCommand form) has a `--start`
  flag that defaults to true. A plugin-owned SSH config that passes
  `--start=false` means SSH can never wake a stopped box.

## bb SDK

- The plugin pins `@get-bb/plugin-sdk` 0.6.49, with `engines` set to bb
  `>=0.46`. The bb installed at the time of the check was 0.48.0, so the SDK
  pin lags behind bb.
- The newer SDK has `experimental_threadAction` with `placement: "header"`.
  That could replace the DOM workaround in `app.tsx` that hides bb's native
  "Open in" button. Re-verify the SDK version before relying on it.
- SDK surfaces the plugin does not use yet:
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

- Archived environments vanish from `ona environment list`. The reconciler's
  "missing" rule therefore reports them as gone, even though they still exist
  in Ona.
- The Ona SDK (`@gitpod/sdk`) is Enterprise-only. The Ona CLI is the portable
  path for plugins that must run for every user.
