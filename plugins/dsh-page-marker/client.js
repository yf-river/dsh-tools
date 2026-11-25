/**
 * Page marker, browser half.
 *
 * Renders a controlled Chromium inside a right-sidebar tab: frames arrive as
 * MJPEG, clicks are forwarded over HTTP, and the annotation outline is drawn by
 * a layer injected into the page so it appears in the frame itself.
 *
 * The mode belongs to the tab, so its control exists only while a browser does.
 * An iframe cannot be scripted across origins, and many sites refuse to be
 * framed at all; a browser we launch has neither limitation.
 */
window.__ModuleLoader__.load({
  id: '@yf-river/dsh-page-marker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback, useRef } = React

    /** Locale namespace for this plugin's copy. */
    const NS = 'page-marker'
    /** Controlled-browser API prefix, served by this plugin's Host half. */
    const API = '/plugin/page-marker/browser'
    /**
     * Kind this plugin serves.
     *
     * It is the built-in Browser kind on purpose: Chat opens an HTTP link with
     * `openTab('browser', …)` when the reviewer chose the sidebar destination,
     * so serving that kind is what makes a link land here instead of the system
     * browser. An `extension` may take over a `builtin` kind.
     */
    const KIND = 'browser'
    /** The tab type's identity in the tab registry. */
    const TAB_ID = '@yf-river/dsh-page-marker/browser'

    const zh = {
      'tab.title': '浏览器',
      'tip.title': '标记元素',
      'action.address': '输入网址',
      'action.note': '说明你看到的问题…',
      'action.save': '记下',
      'action.cancel': '取消',
      'action.list': '已标注',
      'action.remove': '删除',
      'action.insert': '插入输入框',
      'state.noNote': '（无说明）',
      'action.go': '打开',
      'state.picked': '已插入会话输入框',
      'state.starting': '正在启动浏览器…',
      'state.failed': '浏览器启动失败',
      'state.empty': '输入网址开始浏览',
    }
    const en = {
      'tab.title': 'Browser',
      'tip.title': 'Mark element',
      'action.address': 'Enter a URL',
      'action.note': 'Describe what looks wrong…',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.list': 'Annotations',
      'action.remove': 'Remove',
      'action.insert': 'Insert into composer',
      'state.noNote': '(no note)',
      'action.go': 'Open',
      'state.picked': 'Inserted into the composer',
      'state.starting': 'Starting the browser…',
      'state.failed': 'The browser failed to start',
      'state.empty': 'Enter a URL to start browsing',
    }

    /** Stylesheet using host tokens only. */
    const CSS = `
.pgm-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background 120ms ease,color 120ms ease}
.pgm-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pgm-bar{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.pgm-input{flex:1;min-width:0;height:26px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.pgm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.pgm-btn{height:26px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;font-size:12px;cursor:pointer}
.pgm-btn[data-ghost='true']{background:transparent;color:var(--dsw-alias-label-secondary)}
.pgm-btn[data-ghost='true']:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pgm-view{position:relative;flex:1;min-height:0;overflow:auto;background:#fff;display:block}
.pgm-frame{width:100%;height:auto;display:block}
.pgm-view[data-marking='true'] .pgm-frame{cursor:crosshair}
.pgm-tool{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pgm-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.pgm-tool[data-active='true']{background:var(--dsw-alias-brand-primary);color:#fff}
.pgm-tool[data-count]::after{content:attr(data-count);position:absolute;top:-4px;right:-4px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:#e5484d;color:#fff;font:600 10px/14px sans-serif;text-align:center}
.pgm-view[data-marking='true'] .pgm-frame{cursor:crosshair}
.pgm-card{position:absolute;z-index:8;width:250px;padding:8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:6px}
.pgm-card-head{font:600 11px/1.4 -apple-system,system-ui,sans-serif;color:var(--dsw-alias-label-secondary)}
.pgm-card-note{width:100%;box-sizing:border-box;resize:none;padding:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.pgm-card-note:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.pgm-card-actions{display:flex;gap:6px;justify-content:flex-end}
.pgm-list{position:absolute;right:8px;top:44px;z-index:9;width:260px;max-height:60%;overflow:auto;padding:8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);box-shadow:0 6px 20px rgba(0,0,0,.18)}
.pgm-list-row{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px}
.pgm-list-ref{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pgm-list-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.pgm-hint{font-size:12px;color:var(--dsw-alias-label-secondary);padding:12px;text-align:center}
.pgm-notice{position:absolute;left:50%;bottom:60px;transform:translateX(-50%);padding:6px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-primary);z-index:6}
`

    /**
     * Turn one saved annotation into prompt text.
     * @param item - one saved annotation.
     * @param index - its 1-based position.
     * @returns Markdown the model can read directly.
     */
    function formatOne(item, index) {
      const element = item.element
      const box = element.box ?? {}
      const styles = element.styles ?? {}
      const styleLine = Object.entries(styles).map(([key, value]) => `${key}: ${value}`).join('; ')
      const lines = [
        `### ${index}. \`${element.selector}\``,
        item.note === '' ? undefined : `- 问题：${item.note}`,
        `- 元素：\`<${element.tag}>\` x=${box.x} y=${box.y} w=${box.width} h=${box.height}`,
        element.offsetInParent
          ? `- 相对父元素留白：left=${element.offsetInParent.left} top=${element.offsetInParent.top} right=${element.offsetInParent.right} bottom=${element.offsetInParent.bottom}`
          : undefined,
        element.parent?.selector ? `- 父元素：\`${element.parent.selector}\`（display: ${element.parent.display ?? '?'}, gap: ${element.parent.gap ?? '?'}）` : undefined,
        element.previousSibling
          ? `- 同级前一项对照：\`${element.previousSibling.selector}\` width=${element.previousSibling.box?.width ?? '?'} left=${element.previousSibling.offsetInParent?.left ?? '?'} margin-left=${element.previousSibling.styles?.['margin-left'] ?? '?'}`
          : undefined,
        styleLine ? `- 关键样式：${styleLine}` : undefined,
      ]
      return lines.filter(line => line !== undefined).join('\n')
    }

    /**
     * Turn a batch of annotations into one prompt.
     * @param items - the saved annotations, in the order the reviewer made them.
     * @returns Markdown the model can read directly.
     */
    function formatBatch(items) {
      if (!Array.isArray(items) || items.length === 0) return '(没有选中任何元素)'
      const page = items[0].element.page ?? {}
      const head = [
        `我在页面上标注了 ${items.length} 处，请逐条核对并修复：`,
        '',
        `- 页面：${page.title ?? ''} — ${page.url ?? ''}`,
        `- 视口：${page.viewport?.width ?? '?'}×${page.viewport?.height ?? '?'}`,
        '',
      ].join('\n')
      return `${head}${items.map((item, index) => formatOne(item, index + 1)).join('\n\n')}`
    }

    /**
     * POST one JSON command to the browser API.
     * @param path - path after the API prefix.
     * @param body - JSON-serializable payload.
     * @returns the parsed response.
     */
    async function call(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return response.json()
    }

    /**
     * Invisible owner of pick reports: it holds the Session's input actions, so
     * whichever surface produced a pick can be written into the composer.
     * @param props - the Session's input actions.
     * @returns null.
     */
    function PickSink({ inputActions }) {
      const inputRef = useRef(inputActions)
      inputRef.current = inputActions
      useEffect(() => {
        const onPick = (event) => {
          const actions = inputRef.current
          if (actions === undefined) return
          const text = formatBatch(event.detail)
          try {
            actions.insertText(text, actions.captureInsertion())
          } catch (error) {
            actions.setDraft(text)
          }
        }
        window.addEventListener('dsh-page-marker-annotations', onPick)
        return () => window.removeEventListener('dsh-page-marker-annotations', onPick)
      }, [])
      return null
    }

    /**
     * The browser tab body: frames in, input out.
     *
     * Annotation mode is this tab's own state, so the control that starts it
     * exists only while a browser does — there is no global trigger.
     * @param props - tab navigation parameters and translator.
     * @returns the pane.
     */
    function BrowserBody(props) {
      const { useTabInfo, t } = props
      const { tab } = useTabInfo()
      const initial = tab.navigation.params?.url
      const [browserId, setBrowserId] = useState(null)
      const [address, setAddress] = useState(initial ?? '')
      const [current, setCurrent] = useState(initial ?? '')
      const [annotating, setAnnotating] = useState(false)
      const [status, setStatus] = useState(initial === undefined ? 'empty' : 'starting')
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState(null)
      const [annotations, setAnnotations] = useState([])
      const [listOpen, setListOpen] = useState(false)
      const [frameSrc, setFrameSrc] = useState(null)
      const viewRef = useRef(null)
      const imgRef = useRef(null)
      const viewportRef = useRef({ width: 1280, height: 860 })
      const lastMove = useRef(0)
      const liveRef = useRef(null)
      liveRef.current = { browserId, annotating }

      /**
       * Poll the current frame.
       *
       * The picture lives in React state, not in the element: writing `src`
       * imperatively loses to any re-render, which is what left the pane blank.
       */
      useEffect(() => {
        if (browserId === null) return undefined
        let cancelled = false
        let timer
        const load = async () => {
          const abort = new AbortController()
          const cutoff = window.setTimeout(() => abort.abort(), 5000)
          try {
            const response = await fetch(`${API}/${browserId}/frame?t=${Date.now()}`, { cache: 'no-store', signal: abort.signal })
            // A 204 means "no frame yet"; keeping the previous picture beats
            // replacing it with an empty one.
            const usable = response.ok && response.status === 200
            if (usable && !cancelled) {
              const bytes = await response.arrayBuffer()
              if (bytes.byteLength > 0) {
                setFrameSrc(URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })))
              }
            }
          } catch {
            /* a slow or missing frame is retried on the next tick */
          } finally {
            clearTimeout(cutoff)
          }
          // A screencast source is already throttled; polling faster only
          // reduces the delay between a paint and what the reviewer sees.
          // Poll just behind the encoder: faster only queues requests.
          if (!cancelled) timer = window.setTimeout(load, liveRef.current.annotating ? 25 : 60)
        }
        void load()
        return () => { cancelled = true; clearTimeout(timer) }
      }, [browserId])

      // Release the previous object URL only after the element has switched.
      // Revoking inside the state updater is unsafe: React may replay the
      // updater, and the second pass would revoke the URL just created.
      const previousFrameRef = useRef(null)
      useEffect(() => {
        const previous = previousFrameRef.current
        previousFrameRef.current = frameSrc
        if (previous === null || previous === frameSrc) return
        const timer = window.setTimeout(() => URL.revokeObjectURL(previous), 1500)
        return () => window.clearTimeout(timer)
      }, [frameSrc])

      const notify = useCallback((text) => {
        setNotice(text)
        window.setTimeout(() => setNotice(null), 2200)
      }, [])

      // Start the browser once the tab opens with an address.
      useEffect(() => {
        if (initial === undefined || initial === '') return undefined
        let cancelled = false
        setStatus('starting')
        call('/open', { url: initial }).then((opened) => {
          if (cancelled) return
          if (opened.id === undefined) { setStatus('failed'); return }
          setBrowserId(opened.id)
          // Ready means the browser exists; the first frame is polled, so the
          // pane shows a picture as soon as one is available.
          setStatus('ready')
        }).catch(() => { if (!cancelled) setStatus('failed') })
        return () => { cancelled = true }
      }, [initial])

      // Close the browser when the tab goes away.
      useEffect(() => () => {
        const id = liveRef.current.browserId
        if (id !== null) void call(`/${id}/close`, {}).catch(() => undefined)
      }, [])

      // The browser viewport stays at its launch size. Resizing it would
      // restart the frame stream mid-session, and the scaled image maps clicks
      // by fraction anyway, so a fixed viewport keeps coordinates exact.
      useEffect(() => {
        if (browserId === null) return
        void call(`/${browserId}/meta`, {}).then((meta) => {
          if (meta.viewport?.width > 0) viewportRef.current = meta.viewport
        }).catch(() => undefined)
      }, [browserId])

      // The outline is drawn by the page's own layer, so what the reviewer
      // sees is part of the frame rather than a box over a video.
      useEffect(() => {
        if (browserId === null) return
        void call(`/${browserId}/annotate`, { enabled: annotating }).catch(() => undefined)
      }, [browserId, annotating])

      const openAddress = useCallback(() => {
        const target = address.trim()
        if (target === '') return
        const withScheme = /^https?:\/\//.test(target) ? target : `http://${target}`
        setCurrent(withScheme)
        setAnnotations([])
        setDraft(null)
        if (browserId === null) {
          setStatus('starting')
          void call('/open', { url: withScheme }).then((opened) => {
            if (opened.id === undefined) { setStatus('failed'); return }
            setBrowserId(opened.id)
            setStatus('ready')
          })
          return
        }
        void call(`/${browserId}/navigate`, { url: withScheme }).catch(() => undefined)
      }, [address, browserId])

      /**
       * Map a pointer position over the frame to page coordinates.
       * @param event - the pointer event.
       * @returns page coordinates plus the position inside the pane.
       */
      const toPage = useCallback((event) => {
        const img = imgRef.current
        const rect = img.getBoundingClientRect()
        const viewport = viewportRef.current
        return {
          x: ((event.clientX - rect.left) / rect.width) * viewport.width,
          y: ((event.clientY - rect.top) / rect.height) * viewport.height,
          left: event.clientX - rect.left,
          top: event.clientY - rect.top,
        }
      }, [])

      // Forward every pointer move: the page's own hover styles, cursor shape
      // and the annotation outline all depend on where the real pointer is.
      const onFrameMove = useCallback((event) => {
        const id = liveRef.current.browserId
        if (id === null) return
        const now = Date.now()
        if (now - lastMove.current < 24) return
        lastMove.current = now
        const point = toPage(event)
        void call(`/${id}/pointer`, { kind: 'move', x: point.x, y: point.y }).catch(() => undefined)
      }, [toPage])

      // A wheel over the frame scrolls the page, not the pane.
      const onFrameWheel = useCallback((event) => {
        const id = liveRef.current.browserId
        if (id === null) return
        event.preventDefault()
        const point = toPage(event)
        void call(`/${id}/wheel`, {
          x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY,
        }).catch(() => undefined)
      }, [toPage])

      // Drag to select and copy text from the page.
      const onFrameDown = useCallback((event) => {
        const id = liveRef.current.browserId
        if (id === null || liveRef.current.annotating) return
        const point = toPage(event)
        void call(`/${id}/pointer`, { kind: 'down', x: point.x, y: point.y }).catch(() => undefined)
      }, [toPage])

      const onFrameUp = useCallback((event) => {
        const id = liveRef.current.browserId
        if (id === null || liveRef.current.annotating) return
        const point = toPage(event)
        void call(`/${id}/pointer`, { kind: 'up', x: point.x, y: point.y }).catch(() => undefined)
      }, [toPage])

      const onFrameClick = useCallback((event) => {
        const id = liveRef.current.browserId
        if (id === null) return
        const point = toPage(event)
        if (liveRef.current.annotating) {
          void call(`/${id}/pick`, { x: point.x, y: point.y }).then((result) => {
            if (result.element === null || result.element === undefined) return
            setDraft({ element: result.element, note: '', left: point.left, top: point.top })
          })
          return
        }
        void call(`/${id}/pointer`, { kind: 'click', x: point.x, y: point.y }).catch(() => undefined)
      }, [toPage])

      const saveDraft = useCallback(() => {
        if (draft === null) return
        setAnnotations(items => [...items, { element: draft.element, note: draft.note.trim() }])
        setDraft(null)
      }, [draft])

      const toComposer = useCallback(() => {
        if (annotations.length === 0) return
        window.dispatchEvent(new CustomEvent('dsh-page-marker-annotations', { detail: annotations }))
        notify(t('state.picked'))
        setAnnotations([])
        setListOpen(false)
      }, [annotations, notify, t])


      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        h('div', { className: 'pgm-bar' },
          h('input', {
            className: 'pgm-input',
            value: address,
            placeholder: t('action.address'),
            onChange: event => setAddress(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') openAddress() },
          }),
          h('button', { type: 'button', className: 'pgm-btn', onClick: openAddress }, t('action.go')),
          browserId === null ? null : h('button', {
            type: 'button',
            className: 'pgm-tool',
            'data-active': annotating ? 'true' : undefined,
            title: t('tip.title'),
            'aria-label': t('tip.title'),
            onClick: () => { setAnnotating(value => !value); setDraft(null) },
          }, cursorIcon()),
          browserId === null ? null : h('button', {
            type: 'button',
            className: 'pgm-tool',
            'data-count': annotations.length > 0 ? String(annotations.length) : undefined,
            title: t('action.list'),
            'aria-label': t('action.list'),
            onClick: () => setListOpen(value => !value),
          }, listIcon()),
        ),
        h('div', {
          className: 'pgm-view',
          ref: viewRef,
          'data-marking': annotating ? 'true' : undefined,
        },
        status === 'starting'
          ? h('div', { className: 'pgm-hint' }, t('state.starting'))
          : status === 'failed'
            ? h('div', { className: 'pgm-hint' }, t('state.failed'))
            : status === 'empty'
              ? h('div', { className: 'pgm-hint' }, t('state.empty'))
              : h('img', {
                ref: imgRef,
                className: 'pgm-frame',
                src: frameSrc ?? undefined,
                // Collapse before the first frame so the pane never reserves
                // space for an image that has no source yet.
                style: frameSrc === null ? { display: 'none' } : undefined,
                'data-browser-id': browserId ?? undefined,
                alt: current,
                onMouseMove: onFrameMove,
                onWheel: onFrameWheel,
                onMouseDown: onFrameDown,
                onMouseUp: onFrameUp,
                onClick: onFrameClick,
                onMouseLeave: () => { lastMove.current = 0 },
                onError: () => {
                  // A revoked or half-written blob shows the alt text; ask for
                  // the next frame instead of leaving a broken image.
                  lastMove.current = 0
                },
              }),
        draft === null ? null : h('div', {
          className: 'pgm-card',
          style: {
            left: Math.min(draft.left + 8, Math.max(8, viewportRef.current.width - 260)),
            top: Math.min(draft.top + 8, Math.max(8, viewportRef.current.height - 140)),
          },
        },
        h('div', { className: 'pgm-card-head' }, `${draft.element.tag} · ${draft.element.box.width}×${draft.element.box.height}`),
        h('textarea', {
          className: 'pgm-card-note',
          autoFocus: true,
          rows: 2,
          placeholder: t('action.note'),
          value: draft.note,
          onChange: event => setDraft({ ...draft, note: event.target.value }),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); saveDraft() }
            if (event.key === 'Escape') setDraft(null)
          },
        }),
        h('div', { className: 'pgm-card-actions' },
          h('button', { type: 'button', className: 'pgm-btn', onClick: saveDraft }, t('action.save')),
          h('button', { type: 'button', className: 'pgm-btn', 'data-ghost': 'true', onClick: () => setDraft(null) }, t('action.cancel')),
        ),
        ),
        listOpen && annotations.length > 0 ? h('div', { className: 'pgm-list' },
          annotations.map((item, index) => h('div', { className: 'pgm-list-row', key: index },
            h('span', { className: 'pgm-list-ref' }, `${item.element.tag} ${item.element.box.width}×${item.element.box.height}`),
            h('span', { className: 'pgm-list-note' }, item.note === '' ? t('state.noNote') : item.note),
            h('button', {
              type: 'button', className: 'pgm-btn', 'data-ghost': 'true',
              onClick: () => setAnnotations(items => items.filter((_, i) => i !== index)),
            }, t('action.remove')),
          )),
          h('button', { type: 'button', className: 'pgm-btn', onClick: toComposer }, t('action.insert')),
        ) : null,
        notice === null ? null : h('div', { className: 'pgm-notice' }, notice),
        ),
      )
    }

    /**
     * Pointer glyph for annotation mode.
     * @returns an inline SVG.
     */
    function cursorIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 2.5 L4 12.2 L6.6 9.7 L8.4 13.4 L10.3 12.5 L8.5 8.9 L12 8.6 Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }))
    }

    /**
     * List glyph for saved annotations.
     * @returns an inline SVG.
     */
    function listIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 4h11M2.5 8h11M2.5 12h11', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    /**
     * The header globe: one press opens a browser tab for this Session.
     * @param props - translator.
     * @returns the icon button.
     */
    function BrowserShortcut() {
      const press = useCallback(() => {
        const api = window.__dshPageMarkerHost
        if (api !== undefined) api.openBrowser()
      }, [])
      return h('button', {
        type: 'button',
        className: 'pgm-icon',
        'aria-label': 'Browser',
        title: 'Browser',
        onClick: press,
      }, globeIcon())
    }

    /**
     * The globe glyph.
     * @returns an inline SVG.
     */
    function globeIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M8 14.0887C11.3626 14.0887 14.0886 11.3627 14.0886 7.99998C14.0886 4.63727 11.3626 1.91125 8 1.91125C4.63715 1.91125 1.91125 4.63727 1.91125 7.99998C1.91125 11.3627 4.63715 14.0887 8 14.0887Z', stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { d: 'M2.34619 8H13.6538', stroke: 'currentColor', strokeLinecap: 'square' }),
        h('path', { d: 'M8 14.0889C9.23509 14.0889 10.1743 11.3629 10.1743 8.00006C10.1743 4.63739 9.23509 1.91138 8 1.91138', stroke: 'currentColor' }),
        h('path', { d: 'M8 14.0889C6.76445 14.0889 5.8252 11.3629 5.8252 8.00006C5.8252 4.63739 6.76445 1.91138 8 1.91138', stroke: 'currentColor' }))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'page-marker: dictionaries')

        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const id = '@yf-river/dsh-page-marker/page.css'
          if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = '@yf-river/dsh-page-marker'
          tag.dataset.pluginCss = id
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'page-marker: stylesheet')

        window.__dshPageMarkerHost = {
          /**
           * Open a browser tab. The address bar inside the tab takes the target.
           * @param url - optional address to open immediately.
           */
          openBrowser(url) {
            ctx.sidebarRight.openTab(KIND, url === undefined ? {} : { params: { url } })
          },
        }

        ctx.slots.inject('conversation.session.header.utilities', () => {
          return ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: '@yf-river/dsh-page-marker/header',
        }, BrowserShortcut)
        })

        const t = ctx.locale.bind(NS)
        // The tab registry is created by ui-sidebar-right through a reflected
        // key, so it is read through its own injection rather than the static
        // `inject` list; waiting on it there would stall every other seat.
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            multiple: true,
            // A hidden tab keeps its browser: remounting would launch another
            // Chromium and abandon the first one's scroll and session state.
            keepMounted: true,
            priority: 'extension',
            title: () => t('tab.title'),
          }), 'page-marker: tab type')

          scope.slots.inject('sidebar.right.pane.tab', () => {
            const bound = ctx.locale.bind(NS)
            return scope.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              locale: NS,
              inject: () => ({ t: bound }),
            }, BrowserBody)
          })
        })

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: '@yf-river/dsh-page-marker/sink',
        }, PickSink))

      },
    }
  },
})
