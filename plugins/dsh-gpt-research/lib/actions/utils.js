/**
 * Streaming output helpers and per-run cost arithmetic.
 *
 * One-to-one port of `gpt_researcher/actions/utils.py`. The source talked to a
 * WebSocket; DSH reports progress through the workflow engine, so
 * `streamOutput` writes to the injected sink instead and keeps the source's
 * logging rule (log unless the frame is an image and `outputLog` is false).
 *
 * @module @yf-river/dsh-gpt-research/actions/utils
 */

import { getFormattedLogger } from '../utils/logger.js'

const logger = getFormattedLogger()

/**
 * Emit one progress frame.
 *
 * @param {string} type - frame type.
 * @param {unknown} content - short content or identifier.
 * @param {string} output - human-readable output.
 * @param {object | null} [websocket] - sink with `sendJson`, when streaming.
 * @param {boolean} [outputLog] - log the output.
 * @param {unknown} [metadata] - extra metadata.
 * @returns {Promise<void>} fulfillment after the frame is emitted.
 */
export async function streamOutput(type, content, output, websocket = null, outputLog = true, metadata = null) {
  if ((!websocket || outputLog) && type !== 'images') {
    try {
      logger.info(`${output}`)
    } catch {
      // Source retried with a cp1252 round-trip for unencodable output; the
      // port's logger already tolerates any string, so nothing to recover.
      logger.error(String(output))
    }
  }

  if (websocket) {
    await websocket.sendJson({ type, content, output, metadata })
  }
}

/**
 * Send JSON, logging rather than propagating a transport failure.
 * @param {object | null} websocket - sink with `sendJson`.
 * @param {Record<string, unknown>} data - payload.
 * @returns {Promise<void>} fulfillment after the attempt.
 */
export async function safeSendJson(websocket, data) {
  if (!websocket) return
  try {
    await websocket.sendJson(data)
  } catch (error) {
    logger.error(`Error sending JSON through WebSocket: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`)
    const message = String(error?.message ?? error).toLowerCase()
    if (message.includes('closed') || message.includes('connection')) {
      logger.warning('WebSocket connection appears to be closed. Client may have disconnected.')
    } else if (message.includes('timeout')) {
      logger.warning('WebSocket send operation timed out. The client may be unresponsive.')
    }
  }
}

/** Per-1k-token costs, copied from the source's table. */
const COST_PER_1K = Object.freeze({
  'gpt-3.5-turbo': 0.002,
  'gpt-4': 0.03,
  'gpt-4-32k': 0.06,
  'gpt-4o': 0.00001,
  'gpt-4o-mini': 0.000001,
  'o3-mini': 0.0000005,
  // Add more models and their costs as needed
})

/**
 * Compute API cost from token counts.
 *
 * Sanitising is part of the source's behaviour: negative or non-numeric counts
 * become 0, an unknown model warns and returns the flat default.
 *
 * @param {number} promptTokens - prompt token count.
 * @param {number} completionTokens - completion token count.
 * @param {string} model - model name.
 * @returns {number} USD cost.
 */
export function calculateCost(promptTokens, completionTokens, model) {
  let prompt = Number.parseInt(String(promptTokens ?? 0), 10)
  let completion = Number.parseInt(String(completionTokens ?? 0), 10)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
    logger.warning(`Invalid token counts for cost calculation (prompt=${String(promptTokens)}, completion=${String(completionTokens)}); treating as 0.`)
    prompt = 0
    completion = 0
  }
  if (prompt < 0) prompt = 0
  if (completion < 0) completion = 0
  let modelName = typeof model === 'string' && model !== '' ? model : ''

  modelName = modelName.toLowerCase()
  if (!(modelName in COST_PER_1K)) {
    logger.warning(`Unknown model: ${modelName}. Cost calculation may be inaccurate.`)
    return 0.0001 // Default avg cost if model is unknown
  }

  const costPer1k = COST_PER_1K[modelName]
  const totalTokens = prompt + completion
  return (totalTokens / 1000) * costPer1k
}

/**
 * Format a token count with thousands separators.
 * @param {number} count - the count.
 * @returns {string} formatted count, `"0"` for unusable input.
 */
export function formatTokenCount(count) {
  const value = Number.parseInt(String(count ?? 0), 10)
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('en-US')
}

/**
 * Emit a cost frame.
 * @param {number} promptTokens - prompt tokens.
 * @param {number} completionTokens - completion tokens.
 * @param {string} model - model name.
 * @param {object | null} websocket - sink.
 * @returns {Promise<void>} fulfillment after the attempt.
 */
export async function updateCost(promptTokens, completionTokens, model, websocket) {
  let prompt = Number.parseInt(String(promptTokens ?? 0), 10)
  let completion = Number.parseInt(String(completionTokens ?? 0), 10)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
    prompt = 0
    completion = 0
  }
  if (prompt < 0) prompt = 0
  if (completion < 0) completion = 0

  const cost = calculateCost(prompt, completion, model)
  const totalTokens = prompt + completion

  await safeSendJson(websocket, {
    type: 'cost',
    data: {
      total_tokens: formatTokenCount(totalTokens),
      prompt_tokens: formatTokenCount(prompt),
      completion_tokens: formatTokenCount(completion),
      total_cost: `$${cost.toFixed(4)}`,
    },
  })
}
