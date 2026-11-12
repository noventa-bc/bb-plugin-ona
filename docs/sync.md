# How bb and Ona stay in sync

You can start, stop, restart or delete a devbox outside bb: in Ona's UI, with
the `ona` CLI, or through Ona's own auto-stop. The plugin keeps bb's view of
the box in step with Ona's. This page explains how, so the behaviour is
predictable and the code is easy to pick up. The reasoning behind these rules
is recorded in [docs/decisions](decisions/README.md).

**Who decides what.** Ona decides whether a box exists and is running. bb holds
your intent: a machine is _active_ (you're using it) or _suspended_ (you're
not). The plugin compares the two and repairs bb's side. Its automatic repairs
never start or stop a box; bb does that on your action in bb, and starts a stopped one when it recovers a machine a bb restart left `resuming` or `suspending`, and the plugin starts one only for a waiting thread when bb's resume would do nothing, or on `bb ona resume` (rule 1; decision 0002 lists them).

**What the plugin does** (`decide()` in `src/reconcile.ts`):

| Ona says                                                                                | bb shows                                                                                                              | The plugin                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| running                                                                                 | active, tunnel up or connecting, disconnected for 45s+, or at once while a thread or bb's workspace work waits for it | checks over SSH whether bb's daemon runs on the box; restarts it only if it doesn't                                                                                                                                                                                                                                                                                                                                                                            | the box was restarted outside bb and the daemon died with it                                                                                                                                 |
| running                                                                                 | active, no tunnel (even if still shown connected)                                                                     | reopens the tunnel                                                                                                                                                                                                                                                                                                                                                                                                                                             | the plugin reloaded or bb restarted; bb shows the old connection until it notices the drop                                                                                                   |
| stopped / stopping                                                                      | active, disconnected                                                                                                  | marks the machine suspended without stopping anything; if a thread is waiting, lets bb resume it; a resume bb refuses, rejects or does not settle on active is a failure, with its backoff and the hold kept or started (rule 3). Without a waiting thread, a refused suspend records the error (`bb ona status`). With one and bb keeping the machine active, the next row applies. A suspend that settles in another phase (removing, for one) wakes nothing | stopped in Ona's UI, by the CLI, or by Ona's idle timeout                                                                                                                                    |
| stopped / stopping                                                                      | active, disconnected, a thread waiting, and bb's suspend refused (bb keeps the machine active)                        | starts the box and connects it (`provider.wake`), as a resume would; a failed start backs off like any action                                                                                                                                                                                                                                                                                                                                                  | you are using the box ([0002](decisions/0002-repairs-never-start-or-stop.md)); bb's resume does nothing on an active machine                                                                 |
| deleted or deleting, or missing from two listings in a row                              | active                                                                                                                | marks it suspended and reports it gone in `bb ona status`, or archived if `ona environment get` says so                                                                                                                                                                                                                                                                                                                                                        | remove it with `bb machine remove`, or unarchive it in Ona                                                                                                                                   |
| missing from two listings in a row, but found by `ona environment get` and not archived | anything                                                                                                              | acts on the phase `get` reports, as for a listed box (a suspend, and for a waiting thread the start safety rule 1 names); a tunnel or a daemon repair waits for the shared listing to show the box running                                                                                                                                                                                                                                                     | the listing leaves out some boxes (another `ona context`, a long list, a box shared with you); a lookup by id counts as a listing ([0005](decisions/0005-lookup-by-id-counts-as-listing.md)) |
| running                                                                                 | suspended                                                                                                             | nothing: it stays suspended until you use it                                                                                                                                                                                                                                                                                                                                                                                                                   | starting a box in Ona (say, for its editor) doesn't attach it to bb                                                                                                                          |
| anything                                                                                | resuming or suspending                                                                                                | nothing: the phase is bb's to resolve (its 10-second sweep resumes the machine, which starts a stopped box; decision 0002, `docs/ona-notes.md`)                                                                                                                                                                                                                                                                                                                | bb restarted mid-operation                                                                                                                                                                   |
| anything                                                                                | creating, removing or destroyed                                                                                       | nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                        | bb is creating or removing the machine, or the machine is gone                                                                                                                               |
| starting / creating                                                                     | anything                                                                                                              | nothing; a resume waits for Ona to finish instead of starting it again                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                              |
| unknown (`ona` failed or returned nothing)                                              | anything                                                                                                              | nothing; `bb ona status` shows the CLI error, or `ona:unknown` for an empty listing                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                              |

The idle rule in [How it works](../README.md#how-it-works) has these exceptions: a box
isn't let go while bb is setting up or tearing down one of its thread workspaces, or
while one is in its retire grace, or while bb waits to retry a failed teardown, or while one needs recovery, or while bb's
workspace or thread list can't be read, or while the Ona listing fails or comes back
empty. Idle boxes then keep running until those reads work again, since the open tunnel
counts as activity to Ona. A retry needs the machine active in bb
([ona-notes](ona-notes.md) has the bb fact, checked 2026-11-04). Closing the tunnel
mid-hook leaves bb unable to tell how the hook ended (checked 2026-11-04). A thread with
a turn in flight also holds the box, hidden ones (workflow steps, side chats) included,
but an archived thread counts for neither busyness nor activity, whatever status bb
still shows for it.

`bb ona keep-alive <ref> <duration>` is the one way to hold a box past Ona's
inactivity timeout, and only on your request; the plugin never starts one by
itself. It runs `ona environment keep-alive --environment-id <id> -q -- sleep
<seconds>` on the bb server machine, which sends Ona activity signals while the
sleep runs. It needs no SSH. Safety rule 1 applies: it starts only when a fresh
`ona environment list` says the box is running, and is refused otherwise
(stopped, starting, or Ona can't be asked). It ends after the duration (at most
`12h`), on `bb ona keep-alive <ref> off`, when a new duration replaces it, when
a listing shows the box not running, and when the plugin reloads or bb quits.
Keep-alives are not restored after a reload. `bb ona status` shows
`keep-alive until HH:MM` for a box that has one.

`ona environment open` runs only when you ask for it, with the Editor button or
`bb ona open`; no sync pass calls it. It may wake a stopped box, which is what
you asked for, so safety rule 1 does not gate it.

`bb ona rename` runs `ona environment update <env> --name <name>` (refused while bb shows its machine in a phase other than active), then, when bb has a machine for the box, renames it to match. The Ona call changes only
the box's name (bb passes no box setting but `--name`) and neither starts nor stops the
box, so safety rule 1 does not gate it (checked 2026-11-06 in Ona's help: `update`
"Updates an environment's metadata or settings", with `--name` and
`--inactivity-timeout` and no start or stop).

`bb ona new` resolves its project name with `ona project list -o json` (`resolveProjectId` in `src/ona.ts`). It is read-only and touches no box, so safety rule 1 does not gate it.

`ona environment stop <id>` runs in the provider's `suspend()` (`src/provider.ts`) when Ona still has the box and does not show it stopped or deleted; a suspend the plugin makes itself skips it (safety rule 2). `ona environment delete <id>` runs in `remove()` and `reconcileCleanup()` only for a box bb created that no other bb machine uses, and only when `unpushedWork()` finds no unpushed commits or uncommitted files; an adopted box is never deleted.

**Safety rules.** Every automatic action keeps these:

1. **Never wake a box, except the starts you ask for and bb's restart recovery.**
   _Why: an accidental start costs money and keeps the box up._

   The starts allowed; each starts the box only when Ona says it is stopped or stopping (a starting box is waited
   for), then connects:
   - a waiting thread on an active machine whose box Ona stopped (the table's row for a refused suspend, when bb's
     resume would do nothing)
   - `bb ona resume`
   - bb's own resume (yours, a message or thread waiting on the machine, or its recovery after a bb restart,
     decision 0002), which reaches the provider's resume

   Create, resume, the wake for a waiting thread and `bb ona resume` start the box you asked for, and bb's recovery
   after a restart starts one you did not (decision 0002) (`ona environment create` for a new box, else
   `ona environment start` when Ona shows it stopped or stopping, a starting box being waited for; any other phase is
   refused), then connect.

   **SSH.** Ona's SSH starts a stopped box, so the plugin uses SSH (tunnel connect and reconnect, `bb ona reconnect`,
   daemon check, cost collector, and the cleanup when you remove an adopted box's machine) only when Ona, asked right
   before it, says the box is running:
   - an `ona environment list` for tunnels, the daemon check and the cost collector; a daemon restart asks Ona again
     after the daemon check, right before it starts
   - `ona environment get` for a connect and that cleanup ([0005](decisions/0005-lookup-by-id-counts-as-listing.md))

   A cached listing, bb showing the machine connected, a box that is starting or stopping, or a listing that lacks
   the box is not enough. If Ona can't be asked, nothing connects: tunnels wait, and a thread's cost shows its last
   figure.

   **Tunnels.** Every connect attempt of a tunnel asks for one fresh listing (so does each reconnect after `ssh`
   exits), plus a check when Ona shows the box stopped. A refused tunnel tries again every 10s for a minute, then
   every minute (every minute while Ona can't be asked). A tunnel closes when bb suspends or removes the machine (unless another machine uses the box), when
   a create or resume fails, when a wake that started its box fails (a wake of a running box, or of a box Ona started
   during the wake's waits, keeps its tunnel), or the plugin stops; a blocked create, resume or wake (below) closes
   nothing. A check that sees the box stopped asks bb to suspend it once bb no longer shows the machine connected. A
   connect that began before bb suspended or removed the machine and reaches its tunnel open after that fails and
   opens none: its open is blocked. A pass's reopen is blocked the same way and counts as a failed action.

   **The connect wait.** Every connect (create, resume, the wake, `bb ona reconnect`, a daemon restart) first asks
   `ona environment get` every 5s, for up to 15 minutes, until it says the box is running and so is its dev
   container, if it has one (`waitForReady()` in `src/ona.ts`,
   [0005](decisions/0005-lookup-by-id-counts-as-listing.md)). No SSH runs before that answer. These end the connect
   at once, with no SSH:
   - a running box whose `spec.desiredPhase` is stopped or deleted (Ona is
     stopping or deleting it); any other desired phase counts as running
   - a box in any phase but stopping or stopped whose dev container is
     `PHASE_FAILED`
   - a deleted or deleting box
   - a box Ona no longer has (`get` finds no id)
   - a stopping or stopped box when the connect began on a running box (a
     reconnect, a daemon restart, or a create or resume of a running box). A
     box Ona's inactivity timeout stopped keeps desired phase running, so that
     can't tell a start from an idle stop. Ona's failure message, if any, is
     shown.
   - a stopping or stopped box that was not running when the connect began,
     but whose desired phase is stopped or deleted, or that carries a failure
     message and no desired phase (older Ona).

   The connect keeps asking in these cases:
   - any other stopping or stopped box that was not running when the connect
     began: Ona can lag behind a start before it reports starting. An earlier
     failure message becomes the progress line and the timeout's reason.
   - any other phase. A failure message there may be left from an earlier start.
   - a `get` that fails (unknown).

   One line of Ona's text is shown: the first non-blank line. When the wait ends early (a caller's own timeout), its
   error still names the last reason. After Ona answers ready, SSH tries stop at 10 minutes, checked between tries; a
   try held for Ona can run past it. Every SSH command in a connect (each try of the waits, the Codex `mkdir`, the
   `~/.bb-machines` step, the preflight and bb's bootstrap) asks `ona environment get` first and runs only on a ready
   answer, read as above: a failed box ends the connect with no SSH, and a box on its way or a failed `get` holds the
   command until Ona says ready, for up to 15 minutes. The reverse tunnel's `ssh` is not gated by these waits; its own
   `shouldConnect` in `server.ts` asks a fresh listing.

   **The 30-minute cap.** A wake (`provider.wake`: a waiting thread on an active machine, and
   `bb ona resume`), a daemon restart (`reconnect`: the heal, and
   `bb ona reconnect`) and bb's own resume (the provider's `resume`: Resume in
   bb, bb's recovery after a restart, and a waiting thread's resume) give up
   after 30 minutes (`CAP_MINUTES` in `src/provider.ts`), above the 25 minutes
   the stop and start waits share. The cap aborts the signal the call passes down, so it can end an
   inner wait (the tunnel wait or bb's installer wait) before that wait's own
   deadline; the 30-minute cut holds while each step honours that signal. Its error names
   the last progress step the call reported. A wake that started the box, and
   bb's resume, close the tunnel when they fail, unless their open was blocked
   (rule 1, Tunnels); a reconnect leaves it open. The waits inside
   keep their own deadlines: the stop, start and SSH waits in
   `src/provider-connect.ts`, the hold for Ona before each SSH command
   (`waitForReady` in `src/ona.ts`, up to 15 minutes), each `ona` call in
   `run` in `src/ona.ts`, each SSH command in `src/ssh.ts`, and bb's
   bootstrap (`docs/ona-notes.md`, bb SDK section). A resume bb is asked for a
   waiting thread is waited for up to 32 minutes after bb answers `resuming`
   (`settledLifecycle` in `src/lifecycle.ts`), outlasting bb's first attempt by
   2 minutes. With a thread waiting, bb's sweep starts a new attempt within 10 s
   of a give-up, each with its own 30-minute cap (`docs/ona-notes.md`, bb SDK
   section). The wake, the restart and the
   resume wait run on a signal a plugin reload aborts, so a reload can end
   them sooner; an ended resume wait
   reads "couldn't confirm the resume for a waiting thread".

   **Not gated.** These commands you run yourself are not gated and may wake a box: `ona environment open` and
   `bb ona ssh --thread`.

2. **The plugin's own suspends never stop a box.** Every suspend the plugin makes
   skips the provider's stop. A suspend you ask for (Pause, `bb machine suspend`, or `bb machine reconcile` of a suspended
   machine) stops the box unless Ona shows it stopped or deleted (not deleting) or no longer has it, a STARTING or
   STOPPING box included. _Why: a wrong or stale listing must not stop a box with your work on it._
3. **Restart a daemon only when the check finds none.** The check looks for a
   process whose command line names a folder under `~/.bb-machines`, the machine
   data folder (`machineDataDir`) or the box's legacy data folder (a relative one
   is matched as given and resolved against `$HOME`), each as given and resolved
   through symlinks. A process listing that can't be trusted, a folder path with
   a newline in it, a failed SSH connection or a timeout counts as unknown, and
   nothing is restarted. _Why: a restart kills running agent turns._ Four callers force the guard, skipping the cooldown, backoff and give-up: `bb ona sync`, `bb ona reconnect`, `bb ona resume`, and the thread's pass (a pass that finds a thread waiting on a box Ona shows stopped or stopping) while no hold is set. The first three skip them outright, and `bb ona sync` still runs this check. Before a thread's pass has failed on a box, the thread's pass skips what other passes left. Once one has (the hold), a success of another, unforced pass does not reset the failure count, and the usual backoff and give-up apply. A thread's pass that fails, forced or not, keeps or starts the hold. The hold ends when bb shows the machine connected with its tunnel up on a box Ona shows running (connected() ends a hold, clearing its count and quiet period; with no hold, it clears them only when the last failure on the box was a daemon repair's), when a thread's pass succeeds, or when `bb ona sync`, `bb ona reconnect` or `bb ona resume` acts on the box (a forced run starts a fresh count: its failure counts 1, and starts a new hold when the forced pass was a thread's pass); a thread's pass is forced again past what other passes left. `bb ona reconnect` runs bb's daemon bootstrap on a box Ona shows running and never starts one; `bb ona resume` also starts a stopped box. Neither runs the daemon check.
4. **Unknown is not gone.** A failed or empty `ona environment list` changes
   nothing (except a daemon repair's read after its check, below), and
   "missing" needs two listings in a row. A lookup by id
   (`ona environment get`) that fails is unknown too; only Ona saying the id
   doesn't exist counts as gone. A daemon repair whose listing fails or leaves
   the box out before its daemon check leaves the guard's record untouched (count, quiet period,
   hold). One that fails or leaves the box out after the
   check, before the restart, is a failed
   repair with no restart: it counts toward the backoff and give-up (rule 5).
5. **One action per machine at a time.** A daemon check or restart makes the machine wait 5 minutes after a success before its next one; suspends, tunnel
   reopens and idle releases do not wait after a success. A CLI update (`bb ona update` and the weekday update) takes the machine's turn and keeps it while bb installs: for each CLI it installs, up to 15 minutes after bb's install request times out (75 s after it is sent; bb's own install limit is in `docs/ona-notes.md`). While another action runs on the machine, the update is skipped. It still runs on a machine in cooldown, backoff or give-up, records no success or failure, and its `--force` skips only the busy-agent check. A failure backs off for every other
   action (5, then 10 min; the third failure, in a row or across a hold (rule 3), stops automatic tries until
   a forced run acts on the box, the hold ends or, for a daemon repair, the box recovers, rule 3), and `bb ona status` says so for an active machine. A machine bb shows connected with its tunnel up on a box Ona shows running clears the count and quiet period, and with them the give-up, when the box is held, or its count is a failing daemon repair's (rule 3). A daemon that goes down again after each recovery, while the box's count is that repair's, is restarted each time with a fresh count, so those restarts are not capped at 3 across recoveries; each still needs Ona to show the box running and the daemon check to find the daemon dead. The exceptions are in rule 3. Daemon checks and restarts run at most 2 at a time.

**When the plugin checks.**

- **When the plugin starts** (load, reload, bb restart). This check is what reopens the tunnels.
- **Right away** when a thread is waiting for an Ona machine. A running box only, except
  a box Ona shows stopped that a waiting thread needs: bb resumes it, or starts it when bb's suspend was refused (the stopped rows
  above; [decision 0002](decisions/0002-repairs-never-start-or-stop.md)). The cooldown, backoff and give-up of that pass follow rule 3.
- **Workspace work** (bb sets up, tears down, retries or retires a workspace) is read by the
  check of its own machine (the check 46 s after a disconnect, or the realtime
  reconnect's pass 2 s later), and by the 2-minute pass at the latest. A failed teardown
  counts as retrying until bb has given up on it, releases it
  ([ona-notes](ona-notes.md), the release bullet: `sweepProviderEnvironmentInSlot`,
  checked 2026-11-04), or it is more than 60 s overdue. A workspace in its retire grace
  counts as busy until bb starts its teardown, so a disconnected box is healed at once for it.
- **46 s after** an Ona machine disconnects, so a brief drop (Wi-Fi, Mac sleep) can recover on its own.
- **30s after** a tunnel comes back up.
- **Right away** when a tunnel finds its box stopped in Ona.
- **After** bb's realtime connection reconnects.
- **About every 2 minutes**, as a backstop.
- **Right after the Mac wakes**: two ticks of a 15s timer more than 60s apart mean the process slept, so the plugin re-reads Ona and checks every machine once.

Bursts of events are merged into one check. All checks share one cached `ona
environment list` (at most 15s old; 5s for event-driven checks), so checking a
dozen boxes after the Mac wakes costs one Ona call. Anything about to SSH skips
the cache (rule 1); callers that ask while a list is running share the next one.

**Seeing and fixing it yourself.**

```sh
bb ona status [ref] [--json]   # bb's view, tunnel, Ona's view, the box's facts, and what the plugin last did and why
bb ona sync [ref]              # re-check Ona now and repair (skips cooldowns, backoff and the give-up, never the safety rules)
```

`bb ona sync` returns once its pass has finished; a resume it asks of bb for a waiting thread is waited for until bb settles it, for up to 32 minutes after bb answers `resuming`.

Example `bb ona status` output. `now` is what the latest check concluded, and
`last action` is the last thing the plugin actually did. Routine checks never
overwrite `last action`, so a repair stays visible after the box is healthy
again.

```
Ona CLI: ok, listed 12s ago
ona:amber-otter  bb:connected  tunnel:up  ona:running
  box: last started 4h ago, idle timeout 3h, last activity SSH connections 2m ago, branch main
  now: connected (since 2m ago)
  last action: heal-daemon: running in Ona but the daemon isn't connected; daemon was down; restarted it (3m ago)
ona:brisk-heron  bb:suspended  tunnel:off  ona:running
  now: suspended in bb, running in Ona (since 1h ago)
```

`last action` resets when the plugin restarts or reloads.

If the automatic repairs get in your way, turn them off with
`bb plugin config ona set autoRepair false`, then `bb plugin reload ona`. With them off, stopped or deleted boxes are
still marked suspended, tunnels still reopen, idle boxes are still let go after
`idleDisconnect`, and a waiting thread still resumes or starts a stopped box; `bb ona status`
shows what would have been done. bb's own recovery after a restart does not read this setting (decision 0002).

**For contributors.** The logic lives in `src/reconcile.ts`:

- `decide()` is a pure function holding the table above.
- `PassScheduler` merges triggers into checks.
- `HostGuard` enforces rule 5.
- `DAEMON_PROBE` is the rule 3 check.

A pass (which machines, carrying out each decision, idle release) is `createSync()` in
`src/sync.ts`, and the status rows it returns are `createStatusRows()` in `src/status.ts`.
`test/sync.test.ts` drives it against a fake of the bb calls it makes (in `test/sync-fakes.ts`). The events are `watchRealtime()` in
`src/sync.ts`; `server.ts` wires them and the backstop to the `lifecycle-sync`
service. The `bb ona` commands are in `src/commands.ts`.
The shared listing is `OnaSnapshot` in `src/ona.ts`. Removing an Ona machine
drops the box's stored keys (`forgetBox()` in `src/sync.ts`, called from the provider's `remove()`), unless another bb
machine uses the box.
`remove()` refuses to delete a created box that Ona reports unpushed commits
or uncommitted files on (`unpushedWork()` in `src/ona.ts`), before it deletes
or forgets anything. `reconcileCleanup()` in `src/provider.ts` refuses the same
way for an orphaned created box.
A box holds one bb machine: an adopt is refused when another bb machine has stored the box (in any phase, creating
included); see `create` in `src/provider.ts`. A create run again and `reconcileCleanup()` leave alone a box another bb
machine has stored since: the create is refused, and the cleanup ends without a delete. `remove()` first asks whether
another bb machine uses the box: if one does, it deletes nothing and leaves the box's tunnel, keys and no-stop flag to
that machine; if the question fails, it changes nothing and bb retries. A machine bb is also removing does not count
there (bb only ever goes on to destroy it), while an adopt still counts it. Every other `remove()` path closes the box's
tunnel (`remove` in `src/provider.ts`).
For an adopted box, `remove()` runs `MOVE_MACHINE_ASIDE` (`src/provider.ts`) with the removed machine's host id: it
picks the data folder whose `host-id` holds that id, stops every process whose command line names that folder (bb's
daemon among them) and moves the folder aside. When no other machine uses the box, `remove()` closes the tunnel before
and again after the script, since a sync pass's wake can reopen the tunnel meanwhile. The script runs over SSH, only
when `ona environment get`, made just before, says the box is running (safety rule 1); the box is never deleted.
To add or change a rule, update `decide()`, its test in
`test/reconcile.test.ts`, and the table above, all in the same change.

CI checks parts of these rules with Semgrep (`.semgrep/rules.yml`):

- `child-process-outside-runners`: only `src/ona.ts`, `src/setup.ts` and
  `src/ssh.ts` start child processes.
- `ona-lifecycle-outside-onacli`: `ona environment start`, `stop`, `delete` and
  `ssh` run only through `OnaCli` in `src/ona.ts` (safety rules 1 and 2).
- `ssh-outside-runners`: `sshExecutor` and `sshCapture` are called only in
  `src/ssh.ts`, `src/provider.ts` and `src/provider-connect.ts`; code elsewhere goes through the
  provider's methods, each of which names its guard (safety rule 1).
- `remote-script-interpolation`: a script sent over SSH interpolates values
  only through `shellQuote`.
- `console-instead-of-bb-log`: plugin code logs through `bb.log`.
- `secret-in-kv-key`: no storage key names a token, secret or password.
- `raw-sleep-promise`: waits go through `sleep` and `pollUntil` in `src/time.ts`,
  which honour the abort signal.
