# How bb and Ona stay in sync

You can start, stop, restart or delete a devbox outside bb: in Ona's UI, with
the `ona` CLI, or through Ona's own auto-stop. The plugin keeps bb's view of
the box in step with Ona's. This page explains how, so the behaviour is
predictable and the code is easy to pick up. The reasoning behind these rules
is recorded in [docs/decisions](decisions/README.md).

**Who decides what.** Ona decides whether a box exists and is running. bb holds
your intent: a machine is *active* (you're using it) or *suspended* (you're
not). The plugin compares the two and repairs bb's side. Its automatic repairs
never start or stop a box; only bb's own Resume and Pause do that.

**What the plugin does** (`decide()` in `src/reconcile.ts`):

| Ona says | bb shows | The plugin | Why |
|---|---|---|---|
| running | active, disconnected for 45s+ | checks over SSH whether bb's daemon runs on the box; restarts it only if it doesn't | the box was restarted outside bb and the daemon died with it |
| running | active, no tunnel | reopens the tunnel | |
| stopped / stopping | active | marks the machine suspended without stopping anything; if a thread is waiting, lets bb resume it | stopped in Ona's UI, by the CLI, or by Ona's idle timeout |
| deleted, or missing from two listings in a row | active | marks it suspended and reports it gone in `bb ona status`, or archived if `ona environment get` says so | remove it with `bb machine remove`, or unarchive it in Ona |
| running | suspended | nothing: it stays suspended until you use it | starting a box in Ona (say, for its editor) doesn't attach it to bb |
| anything | resuming / suspending for 10 min+ | asks bb to reconcile the machine (at most every 30 min) | bb or the plugin restarted mid-operation |
| starting / creating | anything | nothing; a resume waits for Ona to finish instead of starting it again | |
| unknown (`ona` failed or returned nothing) | anything | nothing; `bb ona status` reports the CLI problem | |

The idle rule from [How it works](../README.md#how-it-works) sits alongside these: after
`idleDisconnect` with no thread activity, an active box is marked suspended
without being stopped. A box isn't let go while bb is setting up or tearing
down one of its thread workspaces: closing the tunnel mid-hook leaves bb unable
to tell how the hook ended, and it then refuses to suspend the machine until
the workspace is recovered.

`bb ona keep-alive <name> <duration>` is the one way to hold a box past Ona's
inactivity timeout, and only on your request; the plugin never starts one by
itself. It runs `ona environment keep-alive --environment-id <id> -q -- sleep
<seconds>` on the bb server machine, which sends Ona activity signals while the
sleep runs. It needs no SSH. Safety rule 1 applies: it starts only when a fresh
`ona environment list` says the box is running, and is refused otherwise
(stopped, starting, or Ona can't be asked). It ends after the duration (at most
`12h`), on `bb ona keep-alive <name> off`, when a new duration replaces it, when
a listing shows the box not running, and when the plugin reloads or bb quits.
Keep-alives are not restored after a reload. `bb ona status` shows
`keep-alive until HH:MM` for a box that has one.

**Safety rules.** Every automatic action keeps these:

1. **Never wake a box.** Ona's SSH starts a stopped box, so the plugin only uses
   SSH (tunnel, daemon check) when Ona says the box is running. It re-checks
   Ona right before each daemon check. If Ona can't be asked, tunnels wait
   rather than connect. *Why: an accidental start costs money and keeps the box up.*
2. **Never stop a box.** Suspends the plugin makes because of what it saw in Ona
   skip the provider's stop. *Why: a wrong or stale listing must not stop a box with your work on it.*
3. **Never restart a live daemon.** The daemon is restarted only when the check
   finds no daemon process. If SSH can't tell, nothing is restarted.
   *Why: a restart kills running agent turns.*
4. **Unknown is not gone.** A failed or empty `ona environment list` changes
   nothing, and "missing" needs two listings in a row. A lookup by id
   (`ona environment get`) that fails is unknown too; only Ona saying the id
   doesn't exist counts as gone.
5. **One action per machine at a time.** After an action, the machine waits 5
   minutes before the next one. Failures back off (5, 10, 20 min, …). After 3
   failures in a row the plugin stops trying and says so in `bb ona status`.
   Daemon checks and restarts run at most 2 at a time.

**When the plugin checks.**

- **Right away** when a thread is waiting for an Ona machine, or bb is setting
  up or tearing down a workspace on it (a running box only; this never starts one).
- **45s after** an Ona machine disconnects, so a brief drop (Wi-Fi, Mac sleep) can recover on its own.
- **30s after** a tunnel comes back up.
- **After** bb's realtime connection reconnects.
- **Every 2 minutes**, as a backstop.

Bursts of events are merged into one check. All checks share one cached `ona
environment list` (at most 15s old; 5s for event-driven checks), so a dozen
boxes reconnecting after the Mac wakes cost one Ona call.

**Seeing and fixing it yourself.**

```sh
bb ona status [name] [--json]  # bb's view, tunnel, Ona's view, and what the plugin last did and why
bb ona sync [name]             # re-check Ona now and repair (skips cooldowns, never the safety rules)
```

Example `bb ona status` output. `now` is what the latest check concluded, and
`last action` is the last thing the plugin actually did. Routine checks never
overwrite `last action`, so a repair stays visible after the box is healthy
again.

```
Ona CLI: ok, listed 12s ago
ona:amber-otter  bb:connected  tunnel:up  ona:running
  now: connected (since 2m ago)
  last action: heal-daemon: running in Ona but the daemon isn't connected; daemon was down; restarted it (3m ago)
ona:brisk-heron  bb:suspended  tunnel:off  ona:running
  now: suspended in bb, running in Ona (since 1h ago)
```

`last action` resets when the plugin restarts or reloads.

If the automatic repairs get in your way, turn them off with
`bb plugin config ona set autoRepair false`. Stopped and deleted boxes are then
still marked suspended, and `bb ona status` shows what would have been done.

**For contributors.** The logic lives in `src/reconcile.ts`:

- `decide()` is a pure function holding the table above.
- `PassScheduler` merges triggers into checks.
- `HostGuard` enforces rule 5.
- `DAEMON_PROBE` is the rule 3 check.

A pass (which machines, carrying out each decision, idle release, the status
rows) is `createSync()` in `src/sync.ts`; `test/sync.test.ts` drives it against
a fake of the bb calls it makes. The events, the backstop and the `bb ona`
commands are wired in `server.ts` (`watchRealtime()`). The shared listing is
`OnaSnapshot` in `src/ona.ts`. Removing an Ona machine drops the box's stored
keys (`forgetBox()` in `src/sync.ts`, called from the provider's `remove()`).
To add or change a rule, update `decide()`, its test in
`test/reconcile.test.ts`, and the table above, all in the same change.

