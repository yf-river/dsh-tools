# Restart button

Adds a **Restart** page under Settings → Plugins. One button asks the Host to
exit; the supervisor relaunches the process; the page waits for the origin to
answer and then reloads itself.

## Why a supervisor is required

A process cannot restart itself. It can only exit, and whether anything comes
back is decided entirely by whoever started it. So the button is only safe when
a supervisor with `Restart=always` owns the process — otherwise it is a stop
button wearing a restart label.

The Host checks this before accepting a request:

| Detected | Signal used | Result |
|---|---|---|
| systemd | `INVOCATION_ID` is set | Restart accepted |
| pm2 | `PM2_HOME` is set | Restart accepted |
| none | neither | **409, refused** |

The page also probes `/plugin/restart/request/status` on mount and disables the
button with an explanation when no supervisor is present.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/plugin/restart/request/ping` | Liveness probe while the page waits |
| GET | `/plugin/restart/request/status` | `{ supervisor, pid }` for the enabled state |
| POST | `/plugin/restart/request` | Reply 202, then exit for the supervisor |

The 202 is written before the exit and flushed deliberately: if the socket dies
first the browser reports a network error, and the page would never reach its
"restarting" state.

## The page

1. Click **Restart now** → confirmation dialog (mentions sessions disconnect but
   no data is lost).
2. Confirm → POST; the connection usually drops mid-request, which is expected
   and treated as success rather than as a failure.
3. The page polls `/ping` every 800 ms for up to 30 s, then reloads.
4. If the origin never returns, it shows the failure instead of hanging.

## What does *not* need this

Most plugin work does not:

- Editing `client.js` — `client-hmr` polls the bundle and the browser reloads it.
- Installing, removing, enabling, or disabling a bundle — `plugin_manager` calls
  the HMR profile reconcile, so the change applies in place.

Reach for this button when `plugin_manager` reports `restart-required`, or when
a change touches the process itself (port, host bind, composition that HMR
cannot recompose).

## Files

| File | Role |
|---|---|
| `index.js` | Host half: supervisor detection plus three routes. |
| `client.js` | Browser half: the settings page and its state machine. |
| `cordis.patch.yml` | Inserts this bundle; disables nothing. |
