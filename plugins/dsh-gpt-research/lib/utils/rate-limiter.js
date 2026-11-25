/**
 * Global rate limiter for scraper requests.
 *
 * One-to-one port of `gpt_researcher/utils/rate_limiter.py`, including the
 * singleton: every `WorkerPool` shares one limiter so `SCRAPER_RATE_LIMIT_DELAY`
 * is enforced across all researchers, not per pool.
 *
 * Python used `asyncio.Lock` created lazily inside an async context. JS has no
 * equivalent need — a promise chain serialises the same critical section — so
 * {@link GlobalRateLimiter.waitIfNeeded} uses a single tail promise. Behaviour
 * is identical: callers queue, each waits out the remaining delay, then stamps
 * the shared timestamp.
 *
 * @module @yf-river/dsh-gpt-research/utils/rate-limiter
 */

/**
 * Singleton global rate limiter.
 *
 * Ensures a minimum delay between any scraper requests across the whole host,
 * regardless of how many pools or researchers are active.
 */
export class GlobalRateLimiter {
  /** @type {GlobalRateLimiter | null} */
  static #instance = null

  /** @type {Promise<void>} tail of the wait queue */
  #tail = Promise.resolve()

  /** @returns {GlobalRateLimiter} the shared instance. */
  static instance() {
    if (GlobalRateLimiter.#instance === null) {
      GlobalRateLimiter.#instance = new GlobalRateLimiter()
    }
    return GlobalRateLimiter.#instance
  }

  /** */
  constructor() {
    if (GlobalRateLimiter.#instance !== null) return GlobalRateLimiter.#instance
    this.lastRequestTime = 0.0
    this.rateLimitDelay = 0.0
    GlobalRateLimiter.#instance = this
  }

  /**
   * Configure the global rate limit delay.
   * @param {number | null} rateLimitDelay - minimum seconds between requests (0 = no limit).
   * @throws {TypeError} when the value is not a number.
   * @throws {RangeError} when the value is negative.
   */
  configure(rateLimitDelay) {
    // Env/config may hand us strings; waitIfNeeded compares as a number.
    if (rateLimitDelay === null || rateLimitDelay === undefined) {
      this.rateLimitDelay = 0.0
      return
    }
    const delay = typeof rateLimitDelay === 'number' ? rateLimitDelay : Number(rateLimitDelay)
    if (!Number.isFinite(delay)) {
      throw new TypeError(`rate_limit_delay must be a number, got ${String(rateLimitDelay)}`)
    }
    if (delay < 0) throw new RangeError(`rate_limit_delay must be non-negative, got ${delay}`)
    this.rateLimitDelay = delay
  }

  /**
   * Wait as needed to enforce the global rate limit.
   * @returns {Promise<void>} fulfillment once this caller may proceed.
   */
  async waitIfNeeded() {
    if (this.rateLimitDelay <= 0) return // No rate limiting

    const previous = this.#tail
    let release
    this.#tail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      const currentTime = Date.now() / 1000
      const timeSinceLast = currentTime - this.lastRequestTime
      if (timeSinceLast < this.rateLimitDelay) {
        const sleepTime = this.rateLimitDelay - timeSinceLast
        await new Promise((resolve) => setTimeout(resolve, sleepTime * 1000))
      }
      this.lastRequestTime = Date.now() / 1000
    } finally {
      release()
    }
  }

  /** Reset the limiter state (useful for testing). */
  reset() {
    this.lastRequestTime = 0.0
  }
}

/** The shared limiter instance. */
const globalRateLimiter = GlobalRateLimiter.instance()

/**
 * Get the global rate limiter singleton.
 * @returns {GlobalRateLimiter} the shared instance.
 */
export function getGlobalRateLimiter() {
  return globalRateLimiter
}
