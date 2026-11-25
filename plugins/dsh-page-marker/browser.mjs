/**
 * A controlled Chromium for the sidebar.
 *
 * Why this exists: an iframe can neither be scripted when cross-origin nor
 * loaded at all when the site sends `X-Frame-Options`. A browser we launch
 * ourselves has neither limitation — the sidebar shows its pixels, and every
 * pick reads the DOM directly through the DevTools protocol.
 *
 * Transport choices, both deliberate:
 * - Output is MJPEG over HTTP (`multipart/x-mixed-replace`). An `<img>` tag
 *   already knows how to render that stream, so no WebSocket framing code is
 *   needed on either side.
 * - Input is ordinary `POST` requests. Clicks are rare and low-rate; a stream
 *   would add reconnection logic for no gain.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Annotation layer injected before any page script runs. */
const ANNOTATE_SCRIPT = fileURLToPath(new URL('./annotate.js', import.meta.url))

/**
 * Remember the DSH tokens the reviewer has pasted, keyed by origin.
 *
 * A controlled browser starts with an empty profile, so it has none of the
 * reviewer's cookies: opening a DSH instance from it hits the login fence. A
 * token the reviewer already pasted once is enough to lift that fence for the
 * rest of the session, without them pasting it again.
 * @param {string} url - the address being opened.
 * @returns {string} the address, carrying a known token when there is one.
 */
function withKnownToken(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const existing = parsed.searchParams.get('token')
  if (typeof existing === 'string' && existing !== '') {
    KNOWN_TOKENS.set(parsed.origin, existing)
    return url
  }
  const known = KNOWN_TOKENS.get(parsed.origin)
  if (known === undefined) return url
  parsed.searchParams.set('token', known)
  return parsed.toString()
}

/** Tokens seen in pasted addresses, keyed by origin. */
const KNOWN_TOKENS = new Map()

/** Chromium binaries tried in order; first existing wins. */
const CHROMIUM_CANDIDATES = [
  process.env.DSH_CUA_CHROME,
  '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  '/root/.cache/ms-playwright/chromium-1134/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean)

/** JPEG quality for pushed and captured frames; lower is faster to encode. */
const FRAME_QUALITY = 55
/** How long a pushed frame stays usable before a fresh capture replaces it. */
const FRAME_FRESH_MS = 60

/** Viewport used until a client asks for another size. */
const DEFAULT_VIEWPORT = { width: 1280, height: 860 }

/**
 * @returns {string} the first Chromium binary that exists.
 */
function findChromium() {
  const found = CHROMIUM_CANDIDATES.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`page-marker: no Chromium found; set DSH_CUA_CHROME (tried ${CHROMIUM_CANDIDATES.join(', ')})`)
  }
  return found
}

/**
 * Minimal DevTools-protocol client over one page target.
 */
class CdpSession {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()
  #ready

  /**
   * @param {string} webSocketDebuggerUrl - page target endpoint from /json/list.
   */
  constructor(webSocketDebuggerUrl) {
    this.#socket = new WebSocket(webSocketDebuggerUrl)
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp: open timed out')), 15000)
      this.#socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
      this.#socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp: socket error')) })
    })
    this.#socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id)
        if (waiter === undefined) return
        this.#pending.delete(message.id)
        if (message.error !== undefined) waiter.reject(new Error(`cdp: ${message.error.message}`))
        else waiter.resolve(message.result)
        return
      }
      for (const listener of this.#listeners) listener(message)
    })
  }

  /** @returns {Promise<void>} resolves once the socket is open. */
  ready() { return this.#ready }

  /**
   * @param {string} method - CDP method name.
   * @param {object} [params] - method parameters.
   * @returns {Promise<any>} the result payload.
   */
  async send(method, params = {}) {
    await this.#ready
    const id = this.#nextId++
    const result = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`cdp: ${method} timed out`))
      }, 20000)
    })
    this.#socket.send(JSON.stringify({ id, method, params }))
    return result
  }

  /** @param {(message: any) => void} listener - receives every non-response message. */
  onEvent(listener) { this.#listeners.add(listener) }

  close() {
    try { this.#socket.close() } catch { /* already gone */ }
  }
}

/**
 * Poll a debugging endpoint until one page target is listed.
 * @param {number} port - debugging port.
 * @returns {Promise<{ webSocketDebuggerUrl: string, id: string }>} the page target.
 */
async function waitForPageTarget(port) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(target => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error('page-marker: Chromium did not expose a page target')
}

/**
 * One owned browser: process, CDP session, and the current frame.
 */
export class ControlledBrowser {
  #process
  #cdp
  #profileDir
  #port
  #viewport = { ...DEFAULT_VIEWPORT }
  #closed = false
  /** Latest screencast frame, base64 JPEG, with the time it arrived. */
  #liveFrame = undefined
  #liveFrameAt = 0
  /** Whether the annotation layer was injected into the current document. */
  #annotateInstalled = false

  /**
   * @param {string} url - first address to open.
   * @returns {Promise<ControlledBrowser>} a ready browser.
   */
  static async launch(url) {
    const browser = new ControlledBrowser()
    await browser.#start(url)
    return browser
  }

  /**
   * @param {string} url - first address to open.
   * @returns {Promise<void>} resolves when the first frame is available.
   */
  async #start(url) {
    this.#profileDir = await mkdtemp(join(tmpdir(), 'dsh-page-marker-'))
    this.#port = 20000 + Math.floor(Math.random() * 20000)
    const args = [
      '--headless=new',
      `--remote-debugging-port=${this.#port}`,
      `--user-data-dir=${this.#profileDir}`,
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      `--window-size=${this.#viewport.width},${this.#viewport.height}`,
      url,
    ]
    this.#process = spawn(findChromium(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.#process.stderr.on('data', () => { /* Chromium is chatty; frames matter, logs do not. */ })
    this.#process.on('exit', () => { this.#closed = true })

    const target = await waitForPageTarget(this.#port)
    this.#cdp = new CdpSession(target.webSocketDebuggerUrl)
    await this.#cdp.ready()
    await this.#cdp.send('Page.enable')
    // The layer must exist before the page's own script, and again in every
    // later navigation, so it is registered as a new-document script.
    const source = await readFile(ANNOTATE_SCRIPT, 'utf8')
    await this.#cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
    // A screencast pushes frames as the page paints, which is what makes hover
    // feedback immediate. The viewport is fixed for the life of this browser,
    // so the frame size never drifts away from the coordinate space.
    this.#cdp.onEvent((message) => {
      if (message.method !== 'Page.screencastFrame') return
      this.#liveFrame = message.params.data
      this.#liveFrameAt = Date.now()
      void this.#cdp.send('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => undefined)
    })
    await this.#cdp.send('Page.startScreencast', { format: 'jpeg', quality: FRAME_QUALITY, everyNthFrame: 1 })
  }

  /** @returns {{ width: number, height: number }} the current viewport. */
  get viewport() { return { ...this.#viewport } }

  /**
   * The viewport the page actually reports, which is what coordinates use.
   * @returns {Promise<{ width: number, height: number }>} page-reported size.
   */
  async realViewport() {
    const size = await this.probe('JSON.stringify([innerWidth, innerHeight])')
    try {
      const [width, height] = JSON.parse(size)
      if (typeof width === 'number' && typeof height === 'number') return { width, height }
    } catch {
      /* fall through to the configured value */
    }
    return { ...this.#viewport }
  }

  /** @returns {boolean} whether the browser process is still alive. */
  get alive() { return !this.#closed }

  /**
   * Capture the current viewport as one JPEG.
   *
   * A single request rather than a stream: a stream keeps a frame size from
   * when it started, so a resize would leave the picture and the coordinates
   * disagreeing, and it fails silently when it dies.
   * @returns {Promise<string>} base64 JPEG bytes.
   */
  async frame() {
    // A pushed frame is only usable while it is fresh. The screencast pauses
    // whenever the page stops painting — or when Chromium throttles a
    // backgrounded tab — and serving a stale frame freezes the picture.
    if (this.#liveFrame !== undefined && Date.now() - this.#liveFrameAt < FRAME_FRESH_MS) return this.#liveFrame
    const shot = await this.#cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: FRAME_QUALITY, captureBeyondViewport: false,
    })
    return shot.data
  }

  /**
   * Wait until the page has committed at least one document.
   *
   * A launch returns before the first paint: capturing too early makes CDP wait
   * for a frame that does not exist yet, which stalls the whole request.
   * @param {number} timeoutMs - how long to wait.
   * @returns {Promise<boolean>} whether a document is ready.
   */
  async ready(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.#closed) return false
      const state = await this.probe('document.readyState').catch(() => undefined)
      if (state === 'interactive' || state === 'complete') return true
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    return false
  }

  /**
   * Open one address in this browser.
   * @param {string} url - address to open.
   * @returns {Promise<void>} resolves once the new document is ready, so the
   *   next frame belongs to the new page rather than the old one.
   */
  async navigate(url) {
    await this.#cdp.send('Page.navigate', { url: withKnownToken(url) })
    // The new document has no annotation layer until the registered script runs.
    this.#annotateInstalled = false
    await this.ready(10000)
  }

  /**
   * @param {number} width - pixels.
   * @param {number} height - pixels.
   * @returns {Promise<void>} resolves after the viewport change.
   */
  async resize(width, height) {
    this.#viewport = { width, height }
    await this.#cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })



  }

  /**
   * Install the annotation layer into the current document when it is absent.
   * @returns {Promise<void>} resolves once the layer answers.
   */
  async #ensureAnnotate() {
    if (this.#annotateInstalled === true) return
    const source = await readFile(ANNOTATE_SCRIPT, 'utf8')
    const result = await this.#cdp.send('Runtime.evaluate', {
      expression: `${source}\n;(window.__dshAnnotate.setEnabled(false), true)`,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) throw new Error(`page-marker: ${result.exceptionDetails.text}`)
    this.#annotateInstalled = true
  }

  /**
   * Turn the hover outline on or off.
   * @param {boolean} enabled - the new state.
   * @returns {Promise<void>} resolves when the page applied it.
   */
  async setAnnotating(enabled) {
    // The new-document registration covers later navigations; the first
    // document of a launched browser predates it. The script returns early
    // when already installed, so running it again is harmless.
    await this.#ensureAnnotate()
    const result = await this.#cdp.send('Runtime.evaluate', {
      expression: `window.__dshAnnotate.setEnabled(${enabled === true})`,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) throw new Error(`page-marker: ${result.exceptionDetails.text}`)
  }

  /**
   * Read the annotation layer's own state, for verification.
   * @returns {Promise<object>} whether the layer exists and what it is drawing.
   */
  async annotateState() {
    const result = await this.#cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const layer = window.__dshAnnotate
        const outline = document.getElementById('__dsh-annotate-outline')
        const badge = document.getElementById('__dsh-annotate-badge')
        return {
          installed: layer !== undefined,
          enabled: layer === undefined ? false : layer.enabled,
          outline: outline === null ? null : { display: outline.style.display, width: outline.style.width, left: outline.style.left },
          badge: badge === null ? null : { display: badge.style.display, text: badge.textContent },
        }
      })()`,
      returnByValue: true,
    })
    return result.result?.value ?? {}
  }

  /**
   * Dispatch one pointer event at viewport coordinates.
   * @param {string} kind - 'move', 'down', 'up', or 'click'.
   * @param {number} x - viewport x.
   * @param {number} y - viewport y.
   * @returns {Promise<void>} resolves when Chromium accepted the event.
   */
  async pointer(kind, x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 }
    if (kind === 'move') {
      await this.#cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
      return
    }
    if (kind === 'down' || kind === 'click') {
      await this.#cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
    }
    if (kind === 'up' || kind === 'click') {
      await this.#cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    }
  }

  /**
   * Scroll the page under one point, as a wheel over that spot would.
   * @param {number} x - viewport x.
   * @param {number} y - viewport y.
   * @param {number} deltaX - horizontal wheel delta.
   * @param {number} deltaY - vertical wheel delta.
   * @returns {Promise<void>} resolves when Chromium accepted the event.
   */
  async wheel(x, y, deltaX, deltaY) {
    await this.#cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: Math.round(deltaX), deltaY: Math.round(deltaY),
      button: 'none', buttons: 0,
    })
  }

  /**
   * Read one element's facts at viewport coordinates.
   * @param {number} x - viewport x.
   * @param {number} y - viewport y.
   * @returns {Promise<object|null>} the descriptor, or null when nothing is there.
   */
  async pick(x, y) {
    await this.#ensureAnnotate()
    const result = await this.#cdp.send('Runtime.evaluate', {
      expression: `window.__dshAnnotate.pick(${Math.round(x)}, ${Math.round(y)})`,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) throw new Error(`page-marker: ${result.exceptionDetails.text}`)
    return result.result?.value ?? null
  }

  /**
   * Evaluate one expression in the page and return its value.
   * @param {string} expression - JavaScript source.
   * @returns {Promise<any>} the evaluated value.
   */
  async probe(expression) {
    const result = await this.#cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails !== undefined) return `error: ${result.exceptionDetails.text}`
    return result.result?.value
  }

  /**
   * @returns {Promise<string>} the page title, for tab labels.
   */
  async title() {
    const result = await this.#cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    return typeof result.result?.value === 'string' ? result.result.value : ''
  }

  /** @returns {Promise<string>} the current page URL. */
  async url() {
    const result = await this.#cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
    return typeof result.result?.value === 'string' ? result.result.value : ''
  }

  /** @returns {Promise<void>} resolves after the process and profile are gone. */
  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#cdp?.close()
    try { this.#process?.kill('SIGKILL') } catch { /* already gone */ }
    if (this.#profileDir !== undefined) {
      await rm(this.#profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * Registry of the browsers this plugin owns, one per tab.
 */
export class BrowserRegistry {
  #browsers = new Map()
  #nextId = 1

  /**
   * @param {string} url - first address to open.
   * @returns {Promise<{ id: string, title: string, url: string }>} the new browser.
   */
  async open(url) {
    const browser = await ControlledBrowser.launch(withKnownToken(url))
    const id = `pmb-${this.#nextId++}`
    this.#browsers.set(id, browser)
    // Wait for a document, not for a frame: the first paint may be several
    // seconds away for a remote site, and the caller only needs an id it can
    // start polling.
    const ready = await browser.ready(12000)
    return {
      id,
      ready,
      title: await browser.title().catch(() => ''),
      url: await browser.url().catch(() => url),
    }
  }

  /**
   * @param {string} id - browser identity.
   * @returns {ControlledBrowser | undefined} the browser, when it exists and is alive.
   */
  get(id) {
    const browser = this.#browsers.get(id)
    if (browser === undefined || !browser.alive) return undefined
    return browser
  }

  /** @returns {Array<{ id: string, viewport: object }>} the live browsers. */
  list() {
    return [...this.#browsers].filter(([, browser]) => browser.alive).map(([id, browser]) => ({ id, viewport: browser.viewport }))
  }

  /**
   * @param {string} id - browser identity.
   * @returns {Promise<void>} resolves after teardown.
   */
  async close(id) {
    const browser = this.#browsers.get(id)
    if (browser === undefined) return
    this.#browsers.delete(id)
    await browser.close()
  }

  /** @returns {Promise<void>} resolves after every browser is closed. */
  async closeAll() {
    const all = [...this.#browsers.values()]
    this.#browsers.clear()
    await Promise.all(all.map(browser => browser.close()))
  }
}
