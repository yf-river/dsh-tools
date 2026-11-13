/**
 * Agent eyes — a Client-side observer that lets the agent see the live page.
 *
 * The agent runs in the Host process and reaches the browser only through
 * `cordis_inspect_query`. Everything the shipped providers expose there is
 * structural (slot trees, service signatures, theme tokens), so a plugin that
 * renders the wrong thing — or throws while rendering — looks identical to one
 * that works. This bundle closes that gap by registering one extra inspect
 * provider that reports what the page actually did:
 *
 * - `errors`:   uncaught errors and console failures captured since load.
 * - `dom`:      a compact, attributed snapshot of what is on screen.
 * - `events`:   a rolling log of interaction events (drag, drop, click).
 * - `probe`:    run a read-only expression against the page and return a value.
 *
 * It observes only. It never mutates application state, and it persists nothing.
 */
window.__ModuleLoader__.load({
  id: '@yf-river/dsh-agent-eyes',
  factory(require) {
    /** Inspect provider id, addressed as `cordis_inspect_query(provider: ...)`. */
    const PROVIDER = 'agent-eyes'
    /** Rolling caps so a long-lived page cannot grow this bundle's memory. */
    const MAX_ERRORS = 80
    const MAX_EVENTS = 200
    /** Attribute written on the captured elements so a snapshot can be traced. */
    const ATTR = 'data-agent-eyes'

    /** Captured failures, newest last. */
    const errors = []
    /** Rolling interaction log, newest last. */
    const events = []
    /** Installed once; a reload re-runs apply on a fresh realm, so no flag needed. */
    let installed = false

    /**
     * Record one failure, trimming the oldest entries past the cap.
     * @param entry - kind, message, and optional stack/source.
     */
    function recordError(entry) {
      errors.push({ at: Date.now(), ...entry })
      if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
    }

    /**
     * Record one interaction event.
     * @param entry - type, target summary, and any extra detail.
     */
    function recordEvent(entry) {
      events.push({ at: Date.now(), ...entry })
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    }

    /**
     * Describe an element the way a person would point at it: tag, the plugin
     * classes that identify it, and a trimmed text sample. Kept short because a
     * snapshot has to fit in a tool result.
     * @param node - element to describe.
     * @returns a compact descriptor.
     */
    function describeNode(node) {
      if (node === null || node === undefined || typeof node !== 'object') return null
      if (node.nodeType !== 1) return { text: String(node).slice(0, 120) }
      const classes = typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean).slice(0, 4) : []
      return {
        tag: node.tagName.toLowerCase(),
        classes,
        text: (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
      }
    }

    /**
     * Whether an element is actually painted: not display:none, not
     * visibility:hidden, and has a non-zero box. This is the check that catches
     * "rendered but invisible", which a plain DOM query cannot see.
     * @param node - element to test.
     * @returns true when the element occupies space on screen.
     */
    function isPainted(node) {
      if (typeof node.getBoundingClientRect !== 'function') return false
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      const view = node.ownerDocument?.defaultView
      if (view === undefined || view === null) return true
      const style = view.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      return true
    }

    /**
     * Install the capture hooks. Idempotent per realm.
     */
    function install() {
      if (installed || typeof window === 'undefined') return
      installed = true

      // Uncaught failures. `error` catches thrown values; `unhandledrejection`
      // catches async ones, which is where most React render failures surface.
      window.addEventListener('error', (event) => {
        recordError({
          kind: 'uncaught',
          message: event.message ?? String(event.error ?? 'unknown error'),
          source: event.filename === undefined ? undefined : `${event.filename}:${event.lineno}:${event.colno}`,
          stack: typeof event.error?.stack === 'string' ? event.error.stack.split('\n').slice(0, 6).join('\n') : undefined,
        })
      })
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason
        recordError({
          kind: 'rejection',
          message: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error && typeof reason.stack === 'string' ? reason.stack.split('\n').slice(0, 6).join('\n') : undefined,
        })
      })

      // Console failures. Wrapped rather than replaced: the original still runs
      // so the browser console keeps behaving exactly as before.
      for (const level of ['error', 'warn']) {
        const original = console[level]
        if (typeof original !== 'function') continue
        console[level] = function patched(...args) {
          try {
            recordError({
              kind: `console.${level}`,
              message: args.map((value) => {
                if (typeof value === 'string') return value
                if (value instanceof Error) return value.message
                try {
                  return JSON.stringify(value).slice(0, 200)
                } catch {
                  return String(value)
                }
              }).join(' ').slice(0, 400),
            })
          } catch {
            /* A capture failure must never break the page's own logging. */
          }
          return original.apply(this, args)
        }
      }

      // Interaction capture in the capture phase, so a handler that stops
      // propagation upstream still gets logged.
      for (const type of ['click', 'dragstart', 'dragover', 'drop', 'dragend', 'keydown']) {
        window.addEventListener(type, (event) => {
          recordEvent({
            type,
            target: describeNode(event.target),
            defaultPrevented: event.defaultPrevented,
            detail: type === 'keydown' ? event.key : undefined,
          })
        }, true)
      }
    }

    /**
     * Collect the page's failures.
     * @returns captured error entries and the current document title.
     */
    function readErrors() {
      return {
        title: typeof document === 'undefined' ? undefined : document.title,
        count: errors.length,
        errors: errors.slice(-MAX_ERRORS),
      }
    }

    /**
     * Snapshot what is visible, attributed to the bundle that owns each node.
     *
     * Attribution works from CSS class prefixes: this harness and its plugins
     * all namespace their classes (`psb-`, `bhn1Oq_`, `YDXeBa_`), so grouping by
     * prefix answers "which plugin painted this" without any cooperation from
     * that plugin.
     * @param input - optional `selector` to narrow the snapshot, `limit` for size.
     * @returns visible nodes grouped by owning prefix, plus totals.
     */
    function readDom(input) {
      const selector = typeof input?.selector === 'string' && input.selector !== '' ? input.selector : 'body *'
      const limit = Number.isFinite(input?.limit) ? Math.min(Math.max(1, input.limit), 400) : 120
      const root = typeof document === 'undefined' ? undefined : document.querySelector(selector === 'body *' ? 'body' : selector)
      if (root === undefined || root === null) {
        return { found: false, selector, nodes: [], owners: {}, totals: { matched: 0, painted: 0 } }
      }
      const all = [root, ...(root.querySelectorAll === undefined ? [] : [...root.querySelectorAll('*')])]
      let painted = 0
      const owners = {}
      const nodes = []
      for (const node of all) {
        if (node.nodeType !== 1) continue
        if (!isPainted(node)) continue
        painted += 1
        const classes = typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean) : []
        const prefix = classes.length === 0 ? '(none)' : (classes[0].split('_')[0] || classes[0]).slice(0, 24)
        owners[prefix] = (owners[prefix] ?? 0) + 1
        if (nodes.length < limit) {
          nodes.push({
            tag: node.tagName.toLowerCase(),
            prefix,
            classes: classes.slice(0, 3),
            text: (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
            box: (() => {
              const rect = node.getBoundingClientRect()
              return [Math.round(rect.width), Math.round(rect.height)]
            })(),
          })
        }
      }
      return {
        found: true,
        selector,
        totals: { matched: all.length, painted },
        owners,
        nodes,
      }
    }

    /**
     * Read the rolling interaction log, filtered.
     * @param input - optional `type` filter and `limit`.
     * @returns the matching events and per-type counts.
     */
    function readEvents(input) {
      const type = typeof input?.type === 'string' && input.type !== '' ? input.type : undefined
      const limit = Number.isFinite(input?.limit) ? Math.min(Math.max(1, input.limit), MAX_EVENTS) : 50
      const matching = type === undefined ? events : events.filter((entry) => entry.type === type)
      const counts = {}
      for (const entry of events) counts[entry.type] = (counts[entry.type] ?? 0) + 1
      return {
        total: events.length,
        counts,
        events: matching.slice(-limit),
      }
    }

    /**
     * Run a small read-only expression against the page.
     *
     * This is the escape hatch for questions the fixed methods do not cover:
     * "how many rows are inside the pinned section", "what is this element's
     * computed color". It is deliberately read-only by contract — see README —
     * and it returns a JSON-safe projection rather than live nodes.
     * @param input - `expression` to evaluate in page scope.
     * @returns the JSON-safe result, or the error message.
     */
    function readProbe(input) {
      const expression = typeof input?.expression === 'string' ? input.expression : ''
      if (expression === '') return { ok: false, error: 'expression is required' }
      try {
        // eslint-disable-next-line no-new-func -- page-scope evaluation is the point.
        const value = new Function(`"use strict"; return (${expression});`).call(window)
        let serialized
        try {
          serialized = JSON.parse(JSON.stringify(value ?? null))
        } catch {
          serialized = String(value)
        }
        return { ok: true, value: serialized }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** Provider manifest: four read-only methods, each with a JSON schema. */
    const MANIFEST = {
      id: PROVIDER,
      description: 'Live page observation: captured failures, a visible-DOM snapshot attributed by owning plugin, the interaction event log, and a read-only expression probe.',
      methods: [
        {
          name: 'errors',
          description: 'Captured uncaught errors, unhandled rejections, and console.error/warn entries since page load.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: { type: 'object' },
        },
        {
          name: 'dom',
          description: 'Snapshot of painted elements, with counts grouped by the class prefix of the plugin that owns them.',
          inputSchema: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector to scope the snapshot; defaults to the whole body.' },
              limit: { type: 'number', description: 'Maximum nodes to return, 1 to 400. Defaults to 120.' },
            },
            additionalProperties: false,
          },
          outputSchema: { type: 'object' },
        },
        {
          name: 'events',
          description: 'Rolling log of interaction events (click, dragstart, dragover, drop, dragend, keydown) with defaultPrevented.',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Only return this event type.' },
              limit: { type: 'number', description: 'Maximum events to return. Defaults to 50.' },
            },
            additionalProperties: false,
          },
          outputSchema: { type: 'object' },
        },
        {
          name: 'probe',
          description: 'Evaluate a read-only JavaScript expression in page scope and return its JSON-safe value.',
          inputSchema: {
            type: 'object',
            properties: { expression: { type: 'string', description: 'Expression to evaluate, e.g. document.querySelectorAll(".psb-group-block").length' } },
            required: ['expression'],
            additionalProperties: false,
          },
          outputSchema: { type: 'object' },
        },
      ],
    }

    return {
      inject: ['cordisInspect'],
      apply(ctx) {
        install()
        const inspect = ctx.get('cordisInspect')
        if (inspect === undefined) return
        ctx.effect(() => inspect.register({
          manifest: MANIFEST,
          query(method, input) {
            switch (method) {
              case 'errors':
                return Promise.resolve(readErrors())
              case 'dom':
                return Promise.resolve(readDom(input))
              case 'events':
                return Promise.resolve(readEvents(input))
              case 'probe':
                return Promise.resolve(readProbe(input))
              default:
                return Promise.reject(new Error(`unknown agent-eyes inspect method "${method}"`))
            }
          },
        }), 'agent-eyes: inspect provider')
      },
    }
  },
})
