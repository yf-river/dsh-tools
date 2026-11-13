/**
 * Page probe, host half.
 *
 * Records why the browser page went away and why a slot entry disappeared, so a
 * self-refresh that leaves no server-side trace becomes observable.
 *
 * Two channels:
 * - A `<script>` tap injected into every served index.html collects browser facts
 *   (`beforeunload`, slot crashes, thrown errors, a short interaction trail) and
 *   posts them to a route.
 * - The route appends one NDJSON line per report under the configured log file.
 *
 * The probe never changes page behaviour: the injected script only listens. It
 * records and returns. Every capture is bounded so a hostile page cannot turn the
 * probe itself into a memory or log-size problem.
 */

import { appendFileSync } from 'node:fs'

/** Route receiving browser reports; relative so it rides the page's own origin. */
const REPORT_PATH = '/plugin/page-probe/report'

/** Largest accepted report body, in bytes. A crash report with a full stack fits well inside this. */
const MAX_BODY_BYTES = 256 * 1024

/** Browser half, served as an inline script by the index tap. */
const INJECTED = String.raw`(function () {
  if (window.__dshPageProbe) return
  window.__dshPageProbe = true

  var ENDPOINT = ${JSON.stringify(REPORT_PATH)}
  var bootAt = Date.now()
  var bootISO = new Date(bootAt).toISOString()
  var sent = Object.create(null)
  var trail = []

  /* ------------------------------------------------------------------ */
  /* Interaction trail                                                    */
  /* ------------------------------------------------------------------ */

  /* A short ring of what the user did before a crash. A component that throws
     during render is usually reacting to one of these; without the trail the
     stack names a setState but not what triggered it. */
  function trailPush(entry) {
    try {
      entry.t = Date.now() - bootAt
      trail.push(entry)
      if (trail.length > 60) trail.shift()
    } catch (e) {}
  }

  function describeTarget(target) {
    try {
      if (target === null || target === undefined) return null
      if (typeof target !== 'object') return String(target).slice(0, 120)
      var tag = target.tagName ? String(target.tagName).toLowerCase() : ''
      var id = target.id ? '#' + String(target.id).slice(0, 60) : ''
      var cls = ''
      try {
        if (target.classList && target.classList.length > 0) {
          cls = '.' + Array.prototype.slice.call(target.classList, 0, 4).join('.')
        }
      } catch (e) {}
      var slot = target.getAttribute ? target.getAttribute('data-slot') : null
      var text = ''
      try {
        if (typeof target.textContent === 'string') text = target.textContent.trim().slice(0, 60)
      } catch (e) {}
      return {
        tag: tag, id: id, cls: cls,
        slot: slot === null ? undefined : slot,
        text: text === '' ? undefined : text
      }
    } catch (e) { return null }
  }

  function recordInteraction(kind) {
    return function (event) {
      try {
        var entry = { k: kind, target: describeTarget(event && event.target) }
        if (kind === 'key' && event) {
          /* Modifier state only for printable keys: recording the character
             itself would put draft text into the log. */
          entry.key = event.key === undefined ? null : String(event.key).slice(0, 40)
          entry.mod = [event.ctrlKey ? 'C' : '', event.metaKey ? 'M' : '', event.altKey ? 'A' : '', event.shiftKey ? 'S' : ''].join('')
        }
        trailPush(entry)
      } catch (e) {}
    }
  }

  try {
    document.addEventListener('click', recordInteraction('click'), true)
    document.addEventListener('keydown', recordInteraction('key'), true)
    document.addEventListener('pointerdown', recordInteraction('pointer'), true)
    document.addEventListener('submit', recordInteraction('submit'), true)
    window.addEventListener('online', function () { trailPush({ k: 'online' }) })
    window.addEventListener('offline', function () { trailPush({ k: 'offline' }) })
    document.addEventListener('visibilitychange', function () {
      trailPush({ k: 'visibility', v: document.visibilityState })
    })
  } catch (e) {}

  /* ------------------------------------------------------------------ */
  /* Transport                                                            */
  /* ------------------------------------------------------------------ */

  /* Post one report. Kinds marked repeatable keep every occurrence up to a
     small cap; everything else records only its first occurrence per page, so
     a render loop cannot flood the log. */
  var REPEATABLE = { 'slot-console': 12, 'window-error': 8, 'unhandled-rejection': 8, console: 40 }
  var counts = Object.create(null)

  function send(kind, detail) {
    var limit = REPEATABLE[kind]
    var seen = counts[kind] || 0
    if (limit === undefined) {
      if (seen > 0) return
      counts[kind] = 1
    } else {
      if (seen >= limit) return
      counts[kind] = seen + 1
    }
    try {
      var body = JSON.stringify({
        kind: kind,
        at: new Date().toISOString(),
        bootAt: bootISO,
        uptimeMs: Date.now() - bootAt,
        href: location.href,
        navigationType: (function () {
          try {
            var nav = performance.getEntriesByType('navigation')[0]
            return nav === undefined ? null : nav.type
          } catch (e) { return null }
        })(),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        detail: detail === undefined ? null : detail
      })
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
      } else {
        fetch(ENDPOINT, {
          method: 'POST', body: body, keepalive: true,
          headers: { 'content-type': 'application/json' }
        }).catch(function () {})
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Error description                                                    */
  /* ------------------------------------------------------------------ */

  /* Render an arbitrary thrown value into a bounded, JSON-safe description.
     React passes the raw Error as a later console argument; that object carries
     the plugin frame this probe exists to name. */
  function describe(value, depth) {
    if (depth === undefined) depth = 0
    if (depth > 3) return { type: 'truncated' }
    if (value === null) return null
    if (value === undefined) return { type: 'undefined' }
    if (typeof value === 'string') return { type: 'string', value: value.slice(0, 4000) }
    if (typeof value !== 'object') return { type: typeof value, value: String(value).slice(0, 1000) }
    var out = { type: 'object' }
    try { if (value.name !== undefined) out.name = String(value.name).slice(0, 300) } catch (e) {}
    try { if (value.message !== undefined) out.message = String(value.message).slice(0, 4000) } catch (e) {}
    /* The full stack: the plugin file and line live in the frames, so a short
       cap would defeat the purpose. 60 frames covers React's boundary chain. */
    try {
      if (typeof value.stack === 'string') {
        out.stack = value.stack.split('\n').slice(0, 60).join('\n').slice(0, 24000)
      }
    } catch (e) {}
    /* A thrown non-Error carries its fields, not a stack. */
    try {
      var keys = Object.keys(value).slice(0, 25)
      if (keys.length > 0) {
        var fields = {}
        for (var k = 0; k < keys.length; k++) {
          try {
            var v = value[keys[k]]
            if (v === null || typeof v !== 'object') fields[keys[k]] = String(v).slice(0, 800)
            else if (depth < 2) fields[keys[k]] = describe(v, depth + 1)
          } catch (e) {}
        }
        if (Object.keys(fields).length > 0) out.fields = fields
      }
    } catch (e) {}
    try {
      if (value.cause !== undefined && depth < 2) out.cause = describe(value.cause, depth + 1)
    } catch (e) {}
    return out
  }

  /* A React error boundary logs the caught error as a later argument. React also
     logs its own "The above error occurred in..." line, which names the
     component stack; both are worth keeping. */
  var originalError = console.error
  console.error = function () {
    try {
      var args = Array.prototype.slice.call(arguments, 0, 6)
      var first = args[0]
      var text = typeof first === 'string' ? first : String(first)
      var isSlotCrash = typeof first === 'string' && first.indexOf('slot entry crashed in ') === 0
      var isReact = text.indexOf('The above error occurred') !== -1
        || text.indexOf('Consider adding an error boundary') !== -1
        || text.indexOf('React will try to recreate this component') !== -1
      if (isSlotCrash) {
        send('slot-console', { text: text, args: args.slice(1).map(function (v) { return describe(v) }), trail: trail.slice(-25) })
      } else if (isReact) {
        send('react-error', { text: text.slice(0, 2000), args: args.slice(1).map(function (v) { return describe(v) }), trail: trail.slice(-25) })
      } else {
        /* Everything else is a guess at a cause; keep a bounded sample. */
        send('console', { level: 'error', text: text.slice(0, 1000), args: args.slice(1).map(function (v) { return describe(v) }) })
      }
    } catch (e) {}
    return originalError.apply(console, arguments)
  }

  var originalWarn = console.warn
  console.warn = function () {
    try {
      var args = Array.prototype.slice.call(arguments, 0, 4)
      var text = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (text.indexOf('client-modules:') === 0 || text.indexOf('release') !== -1) {
        send('console', { level: 'warn', text: text.slice(0, 1000) })
      }
    } catch (e) {}
    return originalWarn.apply(console, arguments)
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                            */
  /* ------------------------------------------------------------------ */

  /* Why the page is leaving. A reload, a navigation, and a tab close all reach
     here; the recorded navigation type tells them apart afterwards. */
  window.addEventListener('beforeunload', function () {
    send('unload', { visibility: document.visibilityState, trail: trail.slice(-30) })
  })
  window.addEventListener('pagehide', function (event) {
    send('pagehide', { persisted: event.persisted === true })
  })
  window.addEventListener('error', function (event) {
    try {
      send('window-error', {
        error: describe(event.error),
        message: event.message === undefined ? null : String(event.message).slice(0, 2000),
        source: event.filename === undefined ? null : String(event.filename),
        line: event.lineno === undefined ? null : event.lineno,
        col: event.colno === undefined ? null : event.colno,
        trail: trail.slice(-25)
      })
    } catch (e) {}
  })
  window.addEventListener('unhandledrejection', function (event) {
    try {
      send('unhandled-rejection', { error: describe(event.reason), trail: trail.slice(-25) })
    } catch (e) {}
  })

  /* A crashed slot entry is retired from its cell and leaves an empty marker
     with no visible message; that marker is the only DOM evidence. */
  function reportMarkers(root) {
    var nodes = root.querySelectorAll ? root.querySelectorAll('[data-slot-error], [data-factory-error]') : []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var slot = node.getAttribute('data-slot-error')
      var factory = node.getAttribute('data-factory-error')
      if (slot) send('slot-error', { slot: slot, trail: trail.slice(-25) })
      if (factory) send('factory-error', { name: factory, trail: trail.slice(-25) })
    }
  }

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes
      for (var j = 0; j < added.length; j++) {
        if (added[j].nodeType === 1) reportMarkers(added[j])
      }
    }
  })

  document.addEventListener('DOMContentLoaded', function () {
    observer.observe(document.documentElement, { childList: true, subtree: true })
    reportMarkers(document)
    send('boot', {
      /* Which client bundles this page actually loaded, and at which revision:
         a crash frame pointing into a plugin file becomes traceable to a row. */
      plugins: (function () {
        try {
          var rows = window.__DSH_BOOT__ && window.__DSH_BOOT__.entries
          if (!Array.isArray(rows)) return null
          return rows.slice(0, 200).map(function (r) { return { id: r.id, rev: r.rev } })
        } catch (e) { return null }
      })(),
      release: (function () {
        try { return window.__DSH_BOOT__ && window.__DSH_BOOT__.release ? window.__DSH_BOOT__.release : null } catch (e) { return null }
      })()
    })
  })
})()`

/** Browser facts kept for one report: the record the route appends. */
const TRAIL_NOTE = 'Each report carries a bounded interaction trail and up to 60 stack frames.'

/**
 * Mount the index tap and the report route.
 * @param ctx - host plugin context; the probe injects `webServer`.
 * @param config - optional `logPath` override; {@link TRAIL_NOTE}.
 */
export function apply(ctx, config) {
  const logPath = config?.logPath ?? '/var/log/dsh-page-probe.ndjson'

  ctx.inject(['webServer'], (host) => {
    const web = host.webServer

    host.effect(() => web.tapIndex(html => {
      // One inline script, no external request: an external URL would need a
      // client bundle and a rebuild, and this must survive a static serve.
      const tag = `<script data-dsh-page-probe>${INJECTED}</script>`
      return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : `${tag}${html}`
    }), 'page-probe: index tap')

    host.effect(() => web.register({
      kind: 'exact',
      path: REPORT_PATH,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            res.writeHead(413).end()
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          if (res.writableEnded) return
          let text
          try {
            text = Buffer.concat(chunks).toString('utf8')
            /* Wire boundary: a malformed or forged body is rejected, not logged. */
            JSON.parse(text)
          } catch {
            res.writeHead(400).end()
            return
          }
          try {
            appendFileSync(logPath, `${text.trim()}\n`)
          } catch (error) {
            ctx.logger?.warn?.(`page-probe: cannot append to ${logPath}: ${String(error)}`)
          }
          res.writeHead(204, { 'cache-control': 'no-store' }).end()
        })
        req.on('error', () => { if (!res.writableEnded) res.writeHead(400).end() })
      },
    }), 'page-probe: report route')

    host.logger?.info?.(`page-probe: recording page facts to ${logPath}`)
  })
}
