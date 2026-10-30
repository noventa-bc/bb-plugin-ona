# Security model

**The risk.** The bb server answers requests from `127.0.0.1` without
credentials. A reverse tunnel pointed straight at its port would make every
request from a devbox look local, so any process there (an agent, an `npm
install` script, a compromised dependency) could use bb's full API: read your
projects and threads, open terminals, or start a thread on your own machine.

**The fix: a daemon-only proxy.** The tunnel never lands on bb's port. It lands
on a proxy the plugin runs on `127.0.0.1` (random port), which forwards only:

| Allowed | Why |
|---|---|
| `GET /health`, `/install.sh`, `/install/version`, `/install/bb-app.tgz` | Installing and health-checking the daemon (same files bb serves to any machine) |
| `/internal/*` | Daemon API; bb requires the daemon's credentials on it |
| WebSocket `/internal/ws` | Daemon connection; bb authenticates it |

Everything else gets `403` and never reaches bb, including the user API
(`/api/*`), the app and terminal sockets (`/ws`, `/ws/terminals/*`) and the web
app. Two `/internal` routes that bb trusts for any loopback caller are blocked
too: `/internal/hosts/enroll-key` (mints machine enrollment keys) and
`/internal/server-move/*`. The proxy also:

- refuses encoded or unusual paths (`%`, `..`, `//`, backslashes, absolute URLs)
  so routing can't be tricked;
- strips headers that could forge identity or origin (`x-bb-*`, including bb
  Connect's gate headers, `x-forwarded-*`, `forwarded`, `x-real-ip`);
- connects the daemon's WebSocket only after bb accepts the handshake (`101`).
  A rejected handshake is answered and closed, so the connection can't be
  reused to slip other requests past the filter;
- logs every blocked request (`bb plugin logs ona`).

The tunnel's port inside the devbox listens on loopback only (`127.0.0.1`,
`::1`), so other machines on Ona's network can't reach it.

**What remains.**

- Code running as the same user on a devbox can read the bb daemon's
  credentials there and act as that machine's daemon. That is true of any bb
  remote machine. The proxy ensures a devbox gets no more than a daemon's
  access, never your bb user's.
- What a daemon credential can do on `/internal/*` is decided by bb, not by
  this plugin, which relies on bb limiting each daemon to its own machine. If
  you connect devboxes you don't fully trust, check bb's documentation on how
  it scopes machine credentials.
- The proxy relies on its allowlist matching how bb routes requests. Upgrading
  bb can add routes, so re-check the allowlist when bb changes its routing.
- Treat what an agent on a devbox reports (output, diffs, links) as untrusted
  input, as with any remote agent.

**Check it yourself** from inside a devbox:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<bb port>/api/v1/projects   # 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<bb port>/health            # 200
```

**Other notes**

- Plugins are full-trust code. Install this one only from a source you trust,
  and review changes before updating.
- Never put secrets in machine inputs; every bb plugin can read them.
- Commands sent to devboxes pass values as arguments, never by pasting them
  into shell scripts, and Ona names and folder settings are validated.
- Devbox traffic stays between Ona and your Mac, with no third-party relay.

