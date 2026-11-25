/**
 * Optional, failure-isolated research lifecycle events.
 *
 * One-to-one port of `gpt_researcher/observability.py`. The core researcher
 * deliberately does not interpret or persist these events; a consumer supplies
 * either a callable or an object exposing `onEvent`. Observer failures must
 * never change research results.
 *
 * Python's `inspect.isawaitable` check becomes "the handler returned a
 * thenable", which covers async handlers and synchronous ones alike.
 *
 * @module @yf-river/dsh-gpt-research/observability
 */

const logger = {
  debug: (...args) => {},
}

/**
 * Notify an observer without allowing telemetry to affect research.
 *
 * @param {object | Function | null} observer - object with `onEvent`, or a function.
 * @param {string} event - event name.
 * @param {Record<string, unknown>} [fields] - event fields.
 * @returns {Promise<void>} fulfillment after the observer settles, success or not.
 */
export async function emitResearchEvent(observer, event, fields = {}) {
  if (observer === null || observer === undefined) return

  try {
    const handler = typeof observer.onEvent === 'function' ? observer.onEvent : observer
    const result = handler(event, fields)
    if (result !== null && result !== undefined && typeof result.then === 'function') {
      await result
    }
  } catch (error) {
    // Observers must never affect research.
    logger.debug(`Research observer failed for ${event}: ${error?.constructor?.name ?? 'Error'}`)
  }
}
