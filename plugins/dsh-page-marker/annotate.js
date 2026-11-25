/**
 * In-page annotation layer.
 *
 * Runs inside the controlled Chromium, injected before any document script.
 * It draws the hover outline and the size badge directly in the page, so the
 * marking a reviewer sees is part of the page's own pixels — exactly what the
 * MJPEG frames carry — rather than an overlay drawn over a video.
 *
 * It never takes over the page: the outline has `pointer-events: none`, and a
 * click still reaches the page unless annotation mode is on, in which case the
 * Host cancels the click and asks for the element instead.
 */
(() => {
  if (window.__dshAnnotate !== undefined) return

  /** Outline element drawn around the hovered candidate. */
  let outline
  /** Size badge pinned to the outline's top-left corner. */
  let badge
  /** Whether hover tracing is on. */
  let enabled = false
  /** Element currently outlined. */
  let current = null

  /** Colours match the toolbar's accent so the layer reads as one control. */
  const ACCENT = '#2f6bff'

  /**
   * @param {string} tag - element name for the node.
   * @param {string} css - inline style.
   * @returns {HTMLElement} the node, appended to the body.
   */
  function make(tag, css) {
    const node = document.createElement(tag)
    node.setAttribute('style', css)
    node.style.display = 'none'
    return node
  }

  /** @returns {void} */
  function ensureNodes() {
    if (outline !== undefined && outline.isConnected) return
    outline = make('div', [
      'position:fixed', 'pointer-events:none', 'z-index:2147483647',
      `border:2px solid ${ACCENT}`, 'background:rgba(47,107,255,.08)',
      'box-shadow:0 0 0 1px rgba(255,255,255,.9)',
      'transition:all 30ms linear', 'border-radius:2px',
    ].join(';'))
    outline.id = '__dsh-annotate-outline'
    badge = make('div', [
      'position:fixed', 'pointer-events:none', 'z-index:2147483647',
      `background:${ACCENT}`, 'color:#fff', 'border-radius:3px',
      'padding:1px 6px', 'font:500 11px/1.6 -apple-system,system-ui,sans-serif',
      'white-space:nowrap', 'box-shadow:0 1px 4px rgba(0,0,0,.25)',
    ].join(';'))
    badge.id = '__dsh-annotate-badge'
    document.documentElement.appendChild(outline)
    document.documentElement.appendChild(badge)
  }

  /**
   * Draw the outline around one element and label its size.
   * @param {Element | null} element - candidate, or null to clear.
   * @returns {void}
   */
  function paint(element) {
    ensureNodes()
    if (element === null || element === document.body || element === document.documentElement) {
      current = null
      outline.style.display = 'none'
      badge.style.display = 'none'
      return
    }
    current = element
    const rect = element.getBoundingClientRect()
    outline.style.display = 'block'
    outline.style.left = `${rect.left}px`
    outline.style.top = `${rect.top}px`
    outline.style.width = `${rect.width}px`
    outline.style.height = `${rect.height}px`
    badge.style.display = 'block'
    badge.textContent = `${element.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}`
    badge.style.left = `${rect.left}px`
    // Sit the badge above the outline unless that would leave the viewport.
    badge.style.top = `${rect.top > 22 ? rect.top - 20 : rect.bottom + 2}px`
  }

  /**
   * @param {MouseEvent} event - hover event.
   * @returns {void}
   */
  function onMove(event) {
    if (!enabled) return
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (hit === outline || hit === badge) return
    paint(hit)
  }

  /** @returns {void} */
  function onLeave() {
    paint(null)
  }

  window.__dshAnnotate = {
    /**
     * Turn hover tracing on or off.
     * @param {boolean} value - the new state.
     * @returns {void}
     */
    setEnabled(value) {
      enabled = value === true
      if (enabled) {
        ensureNodes()
        window.addEventListener('mousemove', onMove, true)
        window.addEventListener('mouseleave', onLeave, true)
        document.documentElement.style.cursor = 'crosshair'
        return
      }
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseleave', onLeave, true)
      document.documentElement.style.cursor = ''
      paint(null)
    },
    /** @returns {boolean} whether tracing is on. */
    get enabled() { return enabled },
    /**
     * Describe the element under one point.
     * @param {number} x - viewport x.
     * @param {number} y - viewport y.
     * @returns {object | null} the descriptor, or null when nothing is there.
     */
    pick(x, y) {
      const element = document.elementFromPoint(x, y)
      if (element === null || element === outline || element === badge) {
        return current === null ? null : describe(current)
      }
      return describe(element)
    },
    /** @returns {object | null} the outlined element, when there is one. */
    current() { return current === null ? null : describe(current) },
  }

  /** Style keys worth carrying: layout, spacing, colour, type, borders. */
  const STYLE_KEYS = [
    'display', 'position', 'flex-direction', 'gap',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'width', 'height', 'border-top-width', 'border-radius', 'box-sizing',
    'font-size', 'font-weight', 'line-height', 'color', 'background-color',
    'opacity', 'text-align', 'overflow',
  ]

  /**
   * Build a selector that resolves to this element and nothing else.
   * @param {Element} element - target.
   * @returns {string} a CSS selector.
   */
  function selectorFor(element) {
    if (element.id !== '') return `#${CSS.escape(element.id)}`
    const parts = []
    let node = element
    while (node !== null && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase()
      if (node.classList.length > 0) {
        part += `.${[...node.classList].map(name => CSS.escape(name)).join('.')}`
      }
      const parent = node.parentElement
      if (parent !== null) {
        const sameTag = [...parent.children].filter(child => child.tagName === node.tagName)
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
      }
      parts.unshift(part)
      if (node.id !== '') { parts[0] = `#${CSS.escape(node.id)}`; break }
      node = parent
    }
    return parts.join(' > ')
  }

  /**
   * @param {Element} element - target.
   * @param {string} key - computed style property.
   * @returns {string} the computed value.
   */
  function style(element, key) {
    return getComputedStyle(element).getPropertyValue(key)
  }

  /**
   * Collect everything a fix needs to know about one element.
   * @param {Element} element - target.
   * @returns {object} the descriptor.
   */
  function describe(element) {
    const box = element.getBoundingClientRect()
    const parent = element.parentElement
    const parentBox = parent === null ? null : parent.getBoundingClientRect()
    const previous = element.previousElementSibling
    const styles = {}
    for (const key of STYLE_KEYS) {
      const value = style(element, key)
      if (value !== '' && value !== 'normal' && value !== 'auto' && value !== 'none') styles[key] = value
    }
    return {
      tag: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      id: element.id,
      classes: [...element.classList],
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      box: {
        x: Math.round(box.left), y: Math.round(box.top),
        width: Math.round(box.width), height: Math.round(box.height),
        pageX: Math.round(box.left + window.scrollX),
        pageY: Math.round(box.top + window.scrollY),
      },
      offsetInParent: parentBox === null ? null : {
        left: Math.round(box.left - parentBox.left),
        top: Math.round(box.top - parentBox.top),
        right: Math.round(parentBox.right - box.right),
        bottom: Math.round(parentBox.bottom - box.bottom),
      },
      styles,
      parent: parent === null ? null : {
        tag: parent.tagName.toLowerCase(), selector: selectorFor(parent),
        box: { width: Math.round(parentBox.width), height: Math.round(parentBox.height) },
        display: style(parent, 'display'), gap: style(parent, 'gap'),
      },
      previousSibling: previous === null ? null : {
        tag: previous.tagName.toLowerCase(), selector: selectorFor(previous),
        box: { width: Math.round(previous.getBoundingClientRect().width) },
        offsetInParent: { left: Math.round(previous.getBoundingClientRect().left - parentBox.left) },
        styles: { 'margin-left': style(previous, 'margin-left') },
      },
      childCount: element.children.length,
      page: {
        title: document.title, url: location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dpr: window.devicePixelRatio,
      },
    }
  }
})()
