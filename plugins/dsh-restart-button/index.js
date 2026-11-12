/**
 * Restart button, node half.
 *
 * Exposes one authenticated route that asks the process to exit, and lets the
 * supervisor (systemd) bring it back. This half never restarts anything itself:
 * a process cannot reliably restart itself, and one that exits without a
 * supervisor is simply gone.
 *
 * Preconditions this relies on:
 * - A supervisor with `Restart=always` owns the process (dsh-web.service).
 * - Session state is persisted, so an exit loses no conversation data.
 * If either is untrue the button degrades into a stop button, which is why the
 * route reports the supervisor state before accepting a request.
 */
export function apply(ctx) {
  /** Route path; the client half posts here. */
  const PATH = '/plugin/restart/request'

  /**
   * Detect how this process is supervised.
   *
   * `INVOCATION_ID` is set by systemd for every service it starts, so its
   * presence is a reliable signal that an exit will be followed by a restart.
   * @returns a short identifier, or undefined when nothing supervises us.
   */
  function supervisor() {
    if (typeof process.env.INVOCATION_ID === 'string' && process.env.INVOCATION_ID !== '') return 'systemd'
    if (typeof process.env.PM2_HOME === 'string' && process.env.PM2_HOME !== '') return 'pm2'
    return undefined
  }

  ctx.inject(['webServer', 'connection'], (host) => {
    const web = host.webServer
    const connection = host.connection
    if (web === undefined) {
      ctx.logger?.warn?.('restart-button: no webServer service; the restart page cannot work')
      return
    }

    /** Unauthenticated liveness probe used while the page waits to reload. */
    host.effect(() => web.register({
      kind: 'exact',
      path: `${PATH}/ping`,
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true }))
      },
    }), 'restart-button: ping route')

    /**
     * Report whether a supervisor owns this process, so the page can disable the
     * action instead of offering a stop button dressed as a restart.
     */
    host.effect(() => web.register({
      kind: 'exact',
      path: `${PATH}/status`,
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, supervisor: supervisor() ?? null, pid: process.pid }))
      },
    }), 'restart-button: status route')

    host.effect(() => web.register({
      kind: 'exact',
      path: PATH,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
          res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
          return
        }
        /* A restart is a process-wide action, so it needs the same credential as
           any other browser call. Without this check any page on the machine (or
           anything that can reach the port) could stop the harness. */
        const admission = connection?.admit?.({ headers: req.headers })
        if (admission === undefined || 'rejection' in admission) {
          res.writeHead(admission !== undefined && 'rejection' in admission ? admission.rejection : 401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
          return
        }
        const detected = supervisor()
        if (detected === undefined) {
          /* Refusing is the point: without a supervisor, exiting would leave the
             user with no server and no way back except a shell. */
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no-supervisor' }))
          return
        }
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, supervisor: detected }))
        /* Reply first, then leave. The response must flush before the listener
           closes, otherwise the browser sees a network error instead of the
           acknowledgement it needs to render "restarting". */
        setTimeout(() => {
          ctx.logger?.info?.('restart requested; exiting for %s to relaunch', detected)
          process.exit(0)
        }, 150)
      },
    }), 'restart-button: route')

    host.logger?.info?.('restart route ready at %s (supervisor: %s)', PATH, supervisor() ?? 'none')
  })
}
