/**
 * Host half of the pinned-session board bundle.
 *
 * The board itself is a pure Client renderer, but its *layout* — which custom
 * groups exist and which pinned Session belongs to which group — used to live
 * in the browser's localStorage. That made every device disagree: the pin set
 * is Host-owned and shared, while the grouping built on top of it was not, so a
 * phone saw one "ungrouped" bucket where the desktop had several groups.
 *
 * This half gives that layout one Host-owned record, reachable from every
 * paired device. It owns exactly two things:
 *
 * - a versioned JSON file under `$DSH_HOME`, written atomically, and
 * - a small same-origin JSON route the Client reads and replaces.
 *
 * The record is layout only. Which Sessions are pinned stays with the Host's
 * Workspace store, and a group that names an unpinned Session is pruned on
 * read, so a deleted or unpinned Session cannot resurrect a stale row.
 *
 * @module @yf-river/dsh-pinned-sessions
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Route the Client reads and replaces the shared board layout through. */
const ROUTE_PATH = '/api/pinned-sessions/layout'

/** Bumped only when an older record cannot be read as the current one. */
const RECORD_VERSION = 1

/** Upper bounds keep one malformed record from becoming unbounded work. */
const MAX_GROUPS = 200
const MAX_GROUP_NAME = 80
const MAX_MEMBERS_PER_GROUP = 2000
const MAX_BODY_BYTES = 256 * 1024

/**
 * One custom group: a stable id, a display name and its collapsed flag.
 * @typedef {object} BoardGroup
 * @property {string} id
 * @property {string} name
 * @property {boolean} collapsed
 */

/**
 * The persisted board layout.
 * @typedef {object} BoardLayout
 * @property {number} version
 * @property {readonly BoardGroup[]} groups
 * @property {Readonly<Record<string, readonly string[]>>} members Group id -> ordered Session ids; the empty-string key holds ungrouped pins.
 * @property {Readonly<Record<string, number>>} slotMemory Session id -> the board slot it occupied before joining a group.
 */

/** An empty layout, used when the record is absent or unreadable. */
function emptyLayout() {
  return { version: RECORD_VERSION, pinboardGroups: [], pinboardGroupMembers: {}, pinboardSlotMemory: {} }
}

/**
 * Whether a value is a plain JSON object rather than an array or null.
 * @param value - the candidate.
 * @returns true for a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep only the characters a group name may carry, and bound its length.
 *
 * Control characters would corrupt a log line if the name is ever echoed, and
 * an unbounded name would widen the sidebar past the panel.
 * @param value - the raw name.
 * @returns the name to persist, or undefined when nothing usable remains.
 */
function readGroupName(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  if (cleaned === '') return undefined
  // Bound by code point so a surrogate pair is never split.
  return [...cleaned].slice(0, MAX_GROUP_NAME).join('')
}

/**
 * Validate one persisted group.
 * @param value - the candidate record.
 * @returns the group, or undefined when the record is malformed.
 */
function readGroup(value) {
  if (!isRecord(value)) return undefined
  const id = value.id
  const name = readGroupName(value.name)
  if (typeof id !== 'string' || id === '' || id.length > 64) return undefined
  if (name === undefined) return undefined
  return { id, name, collapsed: value.collapsed === true }
}

/**
 * Validate an id list, dropping anything that is not a bounded string.
 * @param value - the candidate list.
 * @returns the retained ids, de-duplicated in order.
 */
function readIdList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const kept = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || entry.length > 128) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    kept.push(entry)
    if (kept.length >= MAX_MEMBERS_PER_GROUP) break
  }
  return kept
}

/**
 * Validate a whole record read from disk or from a request body.
 *
 * Every field is optional so a record written by an older bundle — which had no
 * `slotMemory`, say — stays readable instead of being discarded.
 * @param value - the parsed candidate.
 * @returns a complete layout, or undefined when the value is not an object.
 */
function readLayout(value) {
  if (!isRecord(value)) return undefined
  const groups = []
  const seen = new Set()
  if (Array.isArray(value.pinboardGroups)) {
    for (const entry of value.pinboardGroups) {
      const group = readGroup(entry)
      if (group === undefined || seen.has(group.id)) continue
      seen.add(group.id)
      groups.push(group)
      if (groups.length >= MAX_GROUPS) break
    }
  }
  const members = {}
  if (isRecord(value.pinboardGroupMembers)) {
    for (const [key, entry] of Object.entries(value.pinboardGroupMembers)) {
      if (key.length > 64) continue
      const ids = readIdList(entry)
      if (ids.length > 0) members[key] = ids
    }
  }
  const slotMemory = {}
  if (isRecord(value.pinboardSlotMemory)) {
    for (const [key, entry] of Object.entries(value.pinboardSlotMemory)) {
      if (key.length > 128) continue
      if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) continue
      slotMemory[key] = entry
    }
  }
  return { version: RECORD_VERSION, pinboardGroups: groups, pinboardGroupMembers: members, pinboardSlotMemory: slotMemory }
}

/**
 * Serialize a layout for the wire and for disk.
 * @param layout - the layout to encode.
 * @returns the canonical JSON string with a trailing newline.
 */
function encodeLayout(layout) {
  return `${JSON.stringify(layout)}\n`
}

/**
 * Read a request body as JSON, bounded, and without trusting its shape.
 * @param request - the incoming request.
 * @returns the parsed value, or undefined when the body is absent or invalid.
 */
async function readJsonBody(request) {
  return await new Promise((resolve) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      if (settled) return
      total += chunk.byteLength
      if (total > MAX_BODY_BYTES) {
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      try {
        const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
        finish(JSON.parse(text))
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => { finish(undefined) })
  })
}

/**
 * Own the shared board layout: one file, one route.
 * @param ctx - the Host plugin context.
 */
export async function apply(ctx) {
  const file = ctx.dshHomePath('storages', 'pinned-sessions', 'layout.json')
  // Serialize writes: two devices saving at once must not interleave a rename.
  let writing = Promise.resolve()
  let cached
  let cachedAt = 0

  /**
   * Read the record, falling back to an empty layout.
   *
   * A missing file is the ordinary first run, not an error. An unreadable or
   * malformed one is reported once and replaced on the next save, so a corrupt
   * record degrades to "no groups" instead of failing every page load.
   * @returns the current layout.
   */
  const load = async () => {
    if (cached !== undefined) return cached
    try {
      const text = await readFile(file, 'utf8')
      const parsed = readLayout(JSON.parse(text))
      cached = parsed ?? emptyLayout()
      if (parsed === undefined) ctx.logger?.warn?.('pinned-sessions: ignoring an unreadable layout record')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger?.warn?.(`pinned-sessions: layout record unreadable: ${String(error?.code ?? 'unknown')}`)
      }
      cached = emptyLayout()
    }
    cachedAt = Date.now()
    return cached
  }

  /**
   * Persist a layout atomically: write a sibling temporary file, then rename.
   *
   * A crash mid-write leaves the previous record intact rather than a truncated
   * one, which matters because the Client replaces the whole record on save.
   * @param layout - the validated layout to store.
   */
  const save = async (layout) => {
    const run = async () => {
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
      try {
        await writeFile(temporary, encodeLayout(layout), { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      cached = layout
      cachedAt = Date.now()
    }
    // Chain onto the previous write so renames stay ordered.
    const next = writing.then(run, run)
    writing = next.then(() => undefined, () => undefined)
    await next
  }

  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (request, response) => {
        const send = (status, body) => {
          const payload = `${JSON.stringify(body)}\n`
          response.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(Buffer.byteLength(payload)),
          })
          response.end(payload)
        }
        try {
          if (request.method === 'GET') {
            send(200, await load())
            return
          }
          if (request.method === 'PUT' || request.method === 'POST') {
            const body = await readJsonBody(request)
            const layout = readLayout(body)
            if (layout === undefined) {
              send(400, { error: 'invalid layout' })
              return
            }
            await save(layout)
            send(200, layout)
            return
          }
          response.writeHead(405, { Allow: 'GET, PUT' })
          response.end()
        } catch {
          // The body never crosses the boundary on failure; the Client keeps its
          // current state and can retry the save.
          send(500, { error: 'layout unavailable' })
        }
      },
    })
    return () => { unregister() }
  })

  // Expose the read path to other Host plugins without adding another route.
  ctx.effect(() => ctx.reflect.provide('pinnedSessionLayout', {
    read: load,
    replace: save,
  }))
}

/** Services this half needs before it can mount its route. */
export const inject = ['webServer']
