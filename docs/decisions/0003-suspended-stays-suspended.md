# 0003. Suspended stays suspended

Status: accepted

## Rule
A box that runs in Ona while bb shows it suspended stays suspended in bb. It is attached to bb again only when the user uses it, by starting a thread or sending a message on that machine.

## Why
- Starting a box in Ona, for example to open its editor, is not a request to use it through bb.
- Attaching a box opens a tunnel, and an open tunnel counts as activity to Ona, so an automatic attach would keep the box awake.
- The suspended state is the user's intent, and automatic repairs must not override it.

## Consequences
- `bb ona status` reports "suspended in bb, running in Ona", so the mismatch stays visible.
- A box can be open in an Ona editor and running with no tunnel from bb.
- Ona's own timeout stops the box as usual, because nothing from bb keeps it up.
- The next message or thread on the machine resumes it as usual.
