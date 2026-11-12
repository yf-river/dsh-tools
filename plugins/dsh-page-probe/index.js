/**
 * Page probe, host half.
 *
 * Records why the browser page went away and why a slot entry disappeared, so a
 * self-refresh that leaves no server-side trace becomes observable.
 *
 * Two channels:
 * - A `<script>` tap injected into every served index.html collects browser facts
 *   (`beforeunload`, slot crashes, navigation type) and posts them to a route.
 * - The route appends one NDJSON line per report under the configured log file.
 *
 * The probe never changes page behaviour: the injected script only listens. It
 * records and returns.
 */

import { appendFileSync } from 'node:fs'

/** Route receiving browser reports; relative so it rides the page's own origin. */
const REPORT_PATH = '/plugin/page-probe/report'

/** Largest accepted report body, in bytes. */
const MAX_BODY_BYTES = 16 * 1024

/** Browser half, served as an inline script by the index tap. */
const INJECTED = String.raw`(function () {
  if (window.__dshPageProbe) return
  window.__dshPageProbe = true

  var ENDPOINT = ${JSON.stringify(REPORT_PATH)}
  var bootAt = Date.now()
  var sent = Object.create(null)

  /* Post one report; duplicates within a page are dropped so a loop cannot
     flood the log. */
  function send(kind, detail) {
    if (sent[kind]) return
    sent[kind] = true
    try {
      var body = JSON.stringify({
        kind: kind,
        at: new Date().toISOString(),
        bootAt: bootAt,
        href: location.href,
        navigationType: (function () {
          try {
            var nav = performance.getEntriesByType('navigation')[0]
            return nav === undefined ? null : nav.type
          } catch (e) { return null }
        })(),
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

  /* Why the page is leaving. A reload, a navigation, and a tab close all reach
     here; the recorded navigation type tells them apart afterwards. */
  window.addEventListener('beforeunload', function () {
    send('unload', { visibility: document.visibilityState })
  })
  window.addEventListener('pagehide', function (event) {
    send('pagehide', { persisted: event.persisted === true })
  })

  /* A crashed slot entry is retired from its cell and leaves an empty marker
     with no visible message; that marker is the only DOM evidence. */
  function reportMarkers(root) {
    var nodes = root.querySelectorAll ? root.querySelectorAll('[data-slot-error], [data-factory-error]') : []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      var slot = node.getAttribute('data-slot-error')
      var factory = node.getAttribute('data-factory-error')
      if (slot) send('slot-error', { slot: slot })
      if (factory) send('factory-error', { name: factory })
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
    send('boot', null)
  })

  /* The renderer writes this console line before any DOM change is observable,
     so it can carry a slot key the marker has not appeared for yet. */
  var originalError = console.error
  console.error = function () {
    try {
      var first = arguments[0]
      if (typeof first === 'string' && first.indexOf('slot entry crashed in ') === 0) {
        send('slot-console', { text: first })
      }
    } catch (e) {}
    return originalError.apply(console, arguments)
  }
})()`

/**
 * Mount the index tap and the report route.
 * @param ctx - host plugin context; the probe injects `webServer`.
 * @param config - optional `logPath` override.
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
