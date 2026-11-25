/**
 * Worker pool with concurrency and global rate limiting.
 *
 * One-to-one port of `gpt_researcher/utils/workers.py`. The Python version held
 * both a `ThreadPoolExecutor` and an `asyncio.Semaphore`; the executor was never
 * used by `throttle()` — only the semaphore and the global limiter were — so the
 * port keeps the semaphore and the limiter and drops the unused thread pool.
 *
 * @module @yf-river/dsh-gpt-research/utils/workers
 */

import { getGlobalRateLimiter } from './rate-limiter.js'

/**
 * Run work with bounded concurrency and a shared global rate limit.
 */
export class WorkerPool {
  /**
   * @param {number} maxWorkers - maximum concurrent workers.
   * @param {number} [rateLimitDelay] - minimum seconds between requests globally.
   */
  constructor(maxWorkers, rateLimitDelay = 0.0) {
    /** @type {number} */
    this.maxWorkers = maxWorkers
    /** @type {number} */
    this.rateLimitDelay = rateLimitDelay
    /** @type {number} in-flight count */
    this.active = 0
    /** @type {Array<() => void>} queued waiters */
    this.waiters = []

    // All pools share the one limiter instance.
    getGlobalRateLimiter().configure(rateLimitDelay)
  }

  /** Acquire one concurrency slot, queueing while the pool is full. */
  async #acquire() {
    if (this.active < this.maxWorkers) {
      this.active += 1
      return
    }
    await new Promise((resolve) => { this.waiters.push(resolve) })
    this.active += 1
  }

  /** Release one concurrency slot, waking the next waiter. */
  #release() {
    this.active -= 1
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }

  /**
   * Run one unit of work under both limits.
   *
   * The global limiter controls request frequency across every pool; the
   * semaphore here controls concurrency within this pool. Both apply, matching
   * the source's `throttle()` context manager.
   *
   * @template T
   * @param {() => Promise<T>} work - the work to run.
   * @returns {Promise<T>} the work's result.
   */
  async throttle(work) {
    await this.#acquire()
    try {
      await getGlobalRateLimiter().waitIfNeeded()
      return await work()
    } finally {
      this.#release()
    }
  }
}
