/**
 * Page marker, node half.
 *
 * Serves the demo page and the HTTP face of a controlled Chromium: the sidebar
 * renders the browser's pixels and forwards clicks, while element facts are
 * read straight from the DOM over the DevTools protocol.
 *
 * A browser we launch is the only arrangement that satisfies both requirements
 * at once — any site loads (no frame policy applies), and any page is readable
 * (there is no origin boundary to cross).
 */
import { BrowserRegistry } from './browser.mjs'

/** Demo page path. */
const DEMO_PATH = '/plugin/page-marker/demo'
/** API prefix for the controlled browser. */
const API_PREFIX = '/plugin/page-marker/browser'
/** Answers this process's own login address to other local DSH instances. */
const SELF_URL_PATH = '/plugin/page-marker/self-url'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'connection'], (host) => {
    const web = host.webServer

    host.effect(() => web.register({
      kind: 'exact',
      path: DEMO_PATH,
      resource: () => serveDemo(),
    }), 'page-marker: demo route')

    host.effect(() => web.register({
      kind: 'exact',
      path: SELF_URL_PATH,
      handler: (req, res) => {
        // Only a request from this machine may learn this process's login
        // address: a token answers any request the holder makes, so it never
        // leaves loopback.
        const remote = req.socket.remoteAddress ?? ''
        const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
        const origin = host.webServer.getOrigin()
        if (!local) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"error":"loopback only"}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ url: host.connection.authenticatedUrl(origin) }))
      },
    }), 'page-marker: self url')

    const browsers = new BrowserRegistry()
    host.effect(() => () => browsers.closeAll(), 'page-marker: browsers')

    host.effect(() => web.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => handleApi(req, res, browsers, host),
    }), 'page-marker: browser api')

    host.logger?.info?.('page marker ready (demo: %s, api: %s)', DEMO_PATH, API_PREFIX)
  })
}

/**
 * One request against the controlled-browser API.
 *
 * Routes, all under {@link API_PREFIX}:
 * - `POST /open` `{ url }` → `{ id, title, url }`
 * - `POST /<id>/navigate` `{ url }`
 * - `POST /<id>/pointer` `{ kind, x, y }`
 * - `POST /<id>/resize` `{ width, height }`
 * - `POST /<id>/pick` `{ x, y }` → element facts
 * - `GET /<id>/frame` → one JPEG
 * - `POST /<id>/close`
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @param {import('node:http').ServerResponse} res - HTTP response.
 * @param {BrowserRegistry} browsers - owned browsers.
 * @returns {Promise<void>} resolves when the response is complete.
 */
async function handleApi(req, res, browsers, host) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const rest = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
  const [head, action] = rest.split('/')

  /** @param {number} status - HTTP status. @param {object} body - JSON payload. */
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /**
   * @returns {Promise<object>} the parsed JSON body, or an empty object.
   */
  const readBody = async () => {
    if (req.method !== 'POST') return {}
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
  }

  /**
   * Add this process's own login token when the address targets this DSH.
   *
   * The controlled browser starts with an empty profile, so it carries none of
   * the reviewer's cookies. Opening a DSH instance from it would otherwise stop
   * at the login fence, and the reviewer has no reason to know the token.
   * @param {string} raw - the address the reviewer typed.
   * @returns {string} the address, tokenized when it names a local DSH origin.
   */
  const authenticate = async (raw) => {
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      return raw
    }
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
    if (!loopback) return raw
    // A token belongs to one process, so another local DSH has its own. Ask it
    // for the address it would hand to its own browser instead of guessing.
    const own = host.webServer.port
    if (Number(parsed.port) === Number(own)) return host.connection.authenticatedUrl(parsed.href)
    if (parsed.searchParams.get('token') !== null) return raw
    try {
      const response = await fetch(new URL(SELF_URL_PATH, parsed.origin), {
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) return raw
      const answer = await response.json()
      return typeof answer.url === 'string' ? answer.url : raw
    } catch {
      // Not a DSH instance, or an older one: leave the address untouched.
      return raw
    }
  }

  try {
    if (head === 'open') {
      const body = await readBody()
      if (typeof body.url !== 'string' || body.url === '') return json(400, { error: 'url is required' })
      const opened = await browsers.open(await authenticate(body.url))
      return json(200, opened)
    }

    const browser = browsers.get(head ?? '')
    if (browser === undefined) return json(404, { error: 'no such browser' })

    if (action === 'frame') {
      // One JPEG, no multipart: a plain image request either succeeds or fails,
      // with no stream lifetime to keep alive. A mid-navigation page can make
      // the capture wait, so give up quickly and let the client retry.
      const captured = await Promise.race([
        browser.frame().catch(() => undefined),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 4000)),
      ])
      if (captured === undefined) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return undefined
      }
      const binary = Buffer.from(captured, 'base64')
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': binary.length,
        'cache-control': 'no-store, no-transform',
      })
      res.end(binary)
      return undefined
    }

    const body = await readBody()
    if (action === 'navigate') {
      await browser.navigate(await authenticate(String(body.url ?? '')))
      return json(200, { ok: true })
    }
    if (action === 'pointer') {
      await browser.pointer(String(body.kind ?? 'click'), Number(body.x ?? 0), Number(body.y ?? 0))
      return json(200, { ok: true })
    }
    if (action === 'wheel') {
      await browser.wheel(Number(body.x ?? 0), Number(body.y ?? 0), Number(body.deltaX ?? 0), Number(body.deltaY ?? 0))
      return json(200, { ok: true })
    }
    if (action === 'resize') {
      await browser.resize(Number(body.width ?? 1280), Number(body.height ?? 860))
      return json(200, { ok: true })
    }
    if (action === 'annotate') {
      await browser.setAnnotating(body.enabled === true)
      return json(200, await browser.annotateState())
    }
    if (action === 'pick') {
      return json(200, { element: await browser.pick(Number(body.x ?? 0), Number(body.y ?? 0)) })
    }
    if (action === 'probe') {
      // Read-only evaluation, used by verification to locate elements without
      // guessing coordinates. It cannot type, click, or navigate.
      return json(200, { value: await browser.probe(String(body.expression ?? 'null')) })
    }
    if (action === 'meta') {
      return json(200, { title: await browser.title(), url: await browser.url(), viewport: await browser.realViewport() })
    }
    if (action === 'close') {
      await browsers.close(head ?? '')
      return json(200, { ok: true })
    }
    return json(404, { error: 'unknown action' })
  } catch (error) {
    return json(500, { error: String(error) })
  }
}

/**
 * A page with a few deliberately imperfect cards, so picking one produces
 * ranges and offsets worth comparing instead of uniform numbers.
 * @returns {Promise<Response>} the demo page response.
 */
async function serveDemo() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Page marker demo</title>
<style>
  body{margin:0;padding:32px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f6f8;color:#1d2129}
  h1{font-size:18px;margin:0 0 4px}
  p.hint{margin:0 0 24px;color:#646a73}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;max-width:960px}
  .card{background:#fff;border:.5px solid #e5e6eb;border-radius:10px;padding:16px}
  .card h2{font-size:14px;margin:0 0 8px;color:#1d2129}
  .card p{margin:0;color:#646a73;font-size:13px}
  .card.off{transform:translateY(-6px)}
  .card.tight{padding:16px 16px 16px 8px}
  .card.wide{margin-left:14px}
  .swatches{display:flex;gap:8px;margin-top:24px}
  .swatch{width:64px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff}
</style>
</head>
<body>
  <h1>Page marker demo</h1>
  <p class="hint">这里故意留了三处不一致，用来看标注结果是否指得准。</p>
  <div class="cards">
    <div class="card"><h2>正常卡片</h2><p>与其他卡片对齐，用于对照。</p></div>
    <div class="card wide"><h2>左边距多 14px</h2><p>margin-left 明显不同。</p></div>
    <div class="card tight"><h2>左内边距少 8px</h2><p>padding-left 与其他不一致。</p></div>
  </div>
  <div class="swatches">
    <div class="swatch" style="background:#2f6bff">#2f6bff</div>
    <div class="swatch" style="background:#00b42a">#00b42a</div>
    <div class="swatch" style="background:#ff7d00">#ff7d00</div>
  </div>
</body>
</html>`
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}
