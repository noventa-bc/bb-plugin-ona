# 0001. Ona owns compute

Status: accepted

## Rule
Ona decides whether a devbox exists and whether it runs. bb decides intent: a machine is `active` or `suspended`. The plugin reconciles bb to Ona and never starts or stops a box on its own.

## Why
- Boxes change outside bb (Ona's UI, the `ona` CLI, Ona's inactivity timeout), so Ona's listing is the only reliable record of whether compute exists.
- Compute costs money while it runs, and a wrong start or stop interrupts work in progress.
- bb keeps the user's intent, which is what the user set with Resume and Pause, so the plugin only repairs bb's side.

## Consequences
- bb's view can lag Ona's. `bb ona status` shows both views and `bb ona sync` repairs the gap.
- Starting and stopping is done only by user actions in bb: `bb machine resume` and `bb machine suspend`, or the Play and Pause buttons (see 0002).
- A box missing from Ona is marked suspended and reported; removing it is left to `bb machine remove`.
