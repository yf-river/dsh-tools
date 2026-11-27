# Restart button

Adds a **Restart** page under Settings → Plugins. One button asks the Host to
exit; the supervisor relaunches the process; the page waits for the origin to
answer and then reloads itself.

## Install

```bash
dsh plugin --profile web add @yf-river/dsh-restart-button
```

Or from this repository directly:

```bash
dsh plugin --profile web add github:yf-river/dsh-tools#plugins/dsh-restart-button
```

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

## Resuming work across the restart

A restart closes any running Turn as `interrupted`, and that Turn cannot be
replayed. The goal, however, survives — but a resumed Session always starts
`disarmed`, so the round driver will not continue on its own.

This half closes that gap. Two moments matter:

| Moment | Action |
|---|---|
| Before exiting (and on `SIGTERM`) | Snapshot every Session that is running a Turn or holds an `active` goal |
| After `appReady`, delayed | For whitelisted Sessions: reopen, re-arm the goal, and queue one notice when a Turn was cut |

`config.sessions` decides which of the snapshotted Sessions reopen. `*` matches
every Session; exact ids and `prefix*` patterns narrow it when a deployment wants
only some to resume; an empty list records the snapshot and resumes nothing.
Only Sessions that were running a Turn or holding an `active` goal at exit are in
the snapshot, so an idle Session is never woken.

```yaml
- id: restart-button
  name: '@yf-river/dsh-restart-button'
  config:
    sessions:
      - '*'
    startDelayMs: 15000
```

| Field | Default | Meaning |
|---|---|---|
| `sessions` | `[]` | Which snapshotted Sessions resume: `*`, exact ids, or `prefix*` |
| `dir` | `$DSH_HOME/storages/restart-resume` | Snapshot, archives, and journal |
| `startDelayMs` | `4000` | Delay after readiness before reopening Sessions |
| `maxAgeMs` | `1800000` | A snapshot older than this is archived without resuming |
| `keepArchives` | `20` | Processed snapshots retained |

The snapshot is claimed by renaming it to `processed-<time>.json` before any
Session is touched, so consecutive restarts never resume twice. Every Session
is isolated: a missing Session, a held writer, or an exhausted goal round cap
is journaled and skipped, and nothing here can keep the application from
starting.

Only `active` goals are touched — `paused`, `blocked`, and `complete` stay as
they are. `GET /plugin/restart/request/status` reports `resume.sessions` (how
many whitelist entries) and `resume.pending` (whether a snapshot is waiting).

Observability does not depend on the logging exporter: read
`$DSH_HOME/storages/restart-resume/journal.log`.

## Files

| File | Role |
|---|---|
| `index.js` | Host half: supervisor detection, three routes, restart snapshot and resume pass. |
| `client.js` | Browser half: the settings page and its state machine. |
| `cordis.patch.yml` | Inserts this bundle; disables nothing. |

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.

---

在「设置 → 插件」里加一个重启页面：请求 Host 退出，由守护进程重新拉起，页面在服务恢复后自动刷新。
