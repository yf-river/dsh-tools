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
 *
 * ## Resuming work across the restart
 *
 * A restart closes any running Turn as `interrupted`; that Turn cannot be
 * replayed. What survives is the durable goal. Before exiting, this half writes
 * a snapshot of every Session that was running a Turn or holding an active
 * goal. After the next start it reopens those Sessions, re-arms the goals that
 * the resume edge left disarmed, and — when a Turn was actually cut — queues one
 * notice so the model re-reads the workspace before continuing.
 *
 * The resumed set is never implicit: `config.sessions` whitelists exact Session
 * ids or `prefix*` patterns. An empty list records the snapshot and resumes
 * nothing, so a restart never silently authorizes work the user did not name.
 *
 * @module @yf-river/dsh-restart-button
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Route path; the client half posts here. */
const PATH = '/plugin/restart/request'

/** Resolved configuration with defaults applied. */
function resolveConfig(config) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  const sessions = Array.isArray(config?.sessions)
    ? config.sessions.filter(rule => typeof rule === 'string' && rule.trim() !== '').map(rule => rule.trim())
    : []
  return {
    /**
     * Session ids, or `prefix*` patterns, whose interrupted work may resume.
     * Empty disables resuming entirely.
     */
    sessions,
    /** Where the snapshot and its processed archives live. */
    dir: typeof config?.dir === 'string' && config.dir.trim() !== ''
      ? config.dir.trim()
      : join(home, 'storages', 'restart-resume'),
    /** Delay after readiness before resolving Sessions, in milliseconds. */
    startDelayMs: Number.isFinite(config?.startDelayMs) ? Math.max(0, config.startDelayMs) : 4000,
    /** A snapshot older than this is archived and ignored, in milliseconds. */
    maxAgeMs: Number.isFinite(config?.maxAgeMs) ? Math.max(0, config.maxAgeMs) : 30 * 60 * 1000,
    /** How many processed archives to keep. */
    keepArchives: Number.isFinite(config?.keepArchives) ? Math.max(1, config.keepArchives) : 20,
  }
}

/** Whether a Session id is whitelisted by an exact id or a `prefix*` rule. */
function whitelisted(rules, sessionId) {
  for (const rule of rules) {
    if (rule.endsWith('*')) {
      if (sessionId.startsWith(rule.slice(0, -1))) return true
    } else if (rule === sessionId) {
      return true
    }
  }
  return false
}

/**
 * Collect the Sessions whose work a restart would break.
 *
 * A Session qualifies while it runs a Turn, or while it holds a goal in the
 * `active` phase — every live goal is disarmed by the resume edge, so an
 * untouched one would otherwise stall until a human re-armed it.
 * @param ctx - Host context carrying the Agent registry and goal service.
 * @returns one record per qualifying Session, in registry order.
 */
function collect(ctx) {
  const agents = ctx.get('agents')
  if (agents === undefined) return []
  const goals = ctx.get('goals')
  const records = []
  for (const agent of agents.list()) {
    const turnOpen = agent.status === 'running'
    let goal
    try {
      goal = goals === undefined ? undefined : goals.get(agent)
    } catch {
      goal = undefined
    }
    const goalActive = goal !== undefined && goal.phase === 'active'
    if (!turnOpen && !goalActive) continue
    records.push({
      sessionId: agent.id,
      turnOpen,
      ...goal === undefined ? {} : {
        goalId: goal.id,
        goalPhase: goal.phase,
        goalRevision: goal.revision,
        roundsStarted: goal.roundsStarted,
        maxGoalRounds: goal.maxGoalRounds,
      },
    })
  }
  return records
}

/**
 * Append one line to the resume journal.
 *
 * `ctx.logger` routes through whatever exporter the deployment composes, and a
 * bare console exporter shows nothing at the default level; the journal is the
 * durable record an operator reads after a restart.
 * @param ctx - Host context, for the optional logger mirror.
 * @param dir - snapshot directory.
 * @param level - severity recorded verbatim.
 * @param message - `%s`-free sentence; arguments are appended as JSON.
 * @param args - values named after the sentence.
 */
function journal(ctx, dir, level, message, ...args) {
  const line = `${new Date().toISOString()} ${level} ${message}${args.length === 0 ? '' : ` ${args.map(value => String(value)).join(' | ')}`}\n`
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'journal.log'), line)
  } catch {
    // The journal is diagnostics; a failure to write it must not block a resume.
  }
  ctx.logger?.info?.(`restart-button: ${message}`, ...args)
}

/** Write the snapshot through a temporary file so a partial write never parses. */
function writeSnapshot(dir, records) {
  const target = join(dir, 'state.json')
  const temporary = `${target}.${process.pid}.tmp`
  mkdirSync(dir, { recursive: true })
  writeFileSync(temporary, `${JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid, sessions: records }, null, 2)}\n`)
  renameSync(temporary, target)
  return target
}

/** Move a claimed snapshot out of the way so a later start cannot replay it. */
function archive(dir, prefix, keep) {
  const from = join(dir, 'state.json')
  if (!existsSync(from)) return undefined
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
  const to = join(dir, `${prefix}-${stamp}.json`)
  renameSync(from, to)
  const files = readdirSync(dir).filter(name => name.startsWith('processed-') || name.startsWith('stale-')).sort()
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      rmSync(join(dir, name))
    } catch {
      // A pruned archive is housekeeping; the next start prunes again.
    }
  }
  return to
}

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

/**
 * Build the one-shot notice that reopens a Session whose Turn was cut.
 *
 * The message is user-role with a producer-specific `source.kind`; consumers
 * fall through unknown kinds, so it renders as an ordinary request. Hand-built
 * because a linked plugin cannot import the Host's message helpers.
 * @param summary - the archived snapshot's path, for the model's own audit trail.
 * @returns an identified user message ready for `agent.followup`.
 */
function resumeNotice(summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: '上一轮因 DSH 重启被中断（本轮已按 interrupted 关闭，无法续跑原 Turn）。'
        + '未完成的工具调用结果未知：先核对工作区当前状态，再继续推进目标。'
        + `重启前快照：${summary}`,
    }],
    source: { kind: 'restart-resume' },
  }
}

/**
 * Reopen whitelisted Sessions, re-arm their goals, and queue the notice.
 *
 * Every Session is isolated: one failure is logged and the rest still run, and
 * nothing here can stop the application from starting.
 * @param ctx - Host context.
 * @param config - resolved configuration.
 * @param snapshotPath - archived snapshot path, for logging and the notice.
 * @param records - snapshot entries.
 */
async function restore(ctx, config, snapshotPath, records) {
  const controller = ctx.get('sessionController')
  const goals = ctx.get('goals')
  if (controller === undefined || goals === undefined) {
    journal(ctx, config.dir, 'warn', 'resume needs sessionController and goals; snapshot archived without resuming')
    return
  }
  for (const record of records) {
    const sessionId = record.sessionId
    if (!whitelisted(config.sessions, sessionId)) {
      journal(ctx, config.dir, 'info', 'recorded session is not whitelisted; not resumed', sessionId)
      continue
    }
    try {
      const resolved = await controller.resolveAgent(sessionId)
      if ('error' in resolved) {
        journal(ctx, config.dir, 'warn', 'session could not reopen', sessionId, resolved.error?.message ?? 'unknown error')
        continue
      }
      const agent = resolved.agent
      if (record.turnOpen) {
        agent.followup(resumeNotice(snapshotPath))
        journal(ctx, config.dir, 'info', 'queued the interrupted-work notice', sessionId)
      }
      const goal = goals.get(agent)
      if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'disarmed') {
        journal(ctx, config.dir, 'info', 'no disarmed active goal; nothing to re-arm', sessionId)
        continue
      }
      goals.resume(agent, { id: goal.id, revision: goal.revision })
      journal(ctx, config.dir, 'info', 're-armed goal', goal.id, `revision ${String(goal.revision)}`, sessionId)
    } catch (error) {
      // A round cap, a stale revision, or a writer conflict on one Session must
      // never affect the others or the startup path.
      journal(ctx, config.dir, 'warn', 'session was not resumed', sessionId, String(error))
    }
  }
}

/**
 * Claim the previous run's snapshot and resume it. Runs once per process.
 * @param ctx - Host context.
 * @param config - resolved configuration.
 */
async function claimAndRestore(ctx, config) {
  const target = join(config.dir, 'state.json')
  if (!existsSync(target)) return
  let state
  try {
    state = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    archive(config.dir, 'stale', config.keepArchives)
    journal(ctx, config.dir, 'warn', 'the restart snapshot was unreadable', String(error))
    return
  }
  const createdAt = Date.parse(state?.createdAt ?? '')
  const records = Array.isArray(state?.sessions) ? state.sessions : []
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > config.maxAgeMs) {
    const archived = archive(config.dir, 'stale', config.keepArchives)
    journal(ctx, config.dir, 'info', 'restart snapshot is stale; archived without resuming', archived)
    return
  }
  if (records.length === 0) {
    archive(config.dir, 'processed', config.keepArchives)
    return
  }
  const archived = archive(config.dir, 'processed', config.keepArchives)
  journal(ctx, config.dir, 'info', 'resuming recorded sessions', `${String(records.length)} session(s)`, archived)
  await restore(ctx, config, archived, records)
}

/**
 * Mount the restart route and the post-restart resume pass.
 * @param ctx - Host context.
 * @param config - optional plugin configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  let resumed = false

  /**
   * Snapshot before leaving. Synchronous on purpose: `process.exit` follows the
   * response by 150 ms, so an awaited write could lose the race.
   */
  function snapshot() {
    try {
      const records = collect(ctx)
      const target = writeSnapshot(resolved.dir, records)
      journal(ctx, resolved.dir, 'info', 'recorded sessions', `${String(records.length)} session(s)`, target)
      return records.length
    } catch (error) {
      journal(ctx, resolved.dir, 'warn', 'could not record the restart snapshot', String(error))
      return 0
    }
  }

  // systemctl restart sends SIGTERM: record the same snapshot without taking
  // over shutdown, which the launcher owns. The write is synchronous so it
  // still lands while the launcher's own handler starts teardown.
  ctx.effect(() => {
    const record = () => { snapshot() }
    process.once('SIGTERM', record)
    return () => { process.removeListener('SIGTERM', record) }
  }, 'restart-button: SIGTERM snapshot')

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
        res.end(JSON.stringify({
          ok: true,
          supervisor: supervisor() ?? null,
          pid: process.pid,
          resume: {
            sessions: resolved.sessions.length,
            pending: existsSync(join(resolved.dir, 'state.json')),
          },
        }))
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
        const recorded = snapshot()
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, supervisor: detected, recorded }))
        /* Reply first, then leave. The response must flush before the listener
           closes, otherwise the browser sees a network error instead of the
           acknowledgement it needs to render "restarting". */
        setTimeout(() => {
          ctx.logger?.info?.('restart requested; exiting for %s to relaunch', detected)
          process.exit(0)
        }, 150)
      },
    }), 'restart-button: route')

    host.logger?.info?.('restart route ready at %s (supervisor: %s, resume whitelist: %d)',
      PATH, supervisor() ?? 'none', resolved.sessions.length)

    /* Resume after the application is ready, not during composition: reopening
       Sessions mounts plugins and wakes Agents, which must not race startup. */
    const start = () => {
      if (resumed) return
      resumed = true
      setTimeout(() => {
        void claimAndRestore(ctx, resolved).catch((error) => {
          ctx.logger?.warn?.('restart-button: resume pass failed: %s', String(error))
        })
      }, resolved.startDelayMs)
    }
    const ready = ctx.get('appReady')
    if (ready === undefined) start()
    else host.effect(() => ready.onReady(start), 'restart-button: resume after readiness')
  })
}

/** Test seam: the pure pieces, driven by a fake context in `test/`. */
export const __test = { collect, restore, whitelisted, resolveConfig, resumeNotice }
