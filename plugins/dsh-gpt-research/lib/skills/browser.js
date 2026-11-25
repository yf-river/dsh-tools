/**
 * Browser manager skill.
 *
 * One-to-one port of `gpt_researcher/skills/browser.py`: the worker pool built
 * from `max_scraper_workers` and `scraper_rate_limit_delay`, the scrape call,
 * and the image de-duplication that hashes each URL and keeps the top `k`.
 *
 * The source's pool also closed an `requests.Session` in a `finally`; the port
 * has no such session (fetch is injected), so there is nothing to close.
 *
 * @module @yf-river/dsh-gpt-research/skills/browser
 */

import { streamOutput } from '../actions/utils.js'
import { scrapeUrls } from '../actions/web-scraping.js'
import { getImageHash } from '../utils/image-hash.js'
import { WorkerPool } from '../utils/workers.js'

/**
 * Manages web browsing and content scraping.
 */
export class BrowserManager {
  /**
   * @param {object} deps - the parent researcher's collaborating pieces.
   * @param {object} deps.cfg - resolved config.
   * @param {(url: string) => Promise<object>} deps.fetchPage - the fetch implementation.
   * @param {boolean} [deps.verbose] - whether to stream progress.
   * @param {object | null} [deps.websocket] - progress sink.
   * @param {(pages: Array<object>) => void} [deps.addResearchSources] - source sink.
   * @param {(images: string[]) => void} [deps.addResearchImages] - image sink.
   * @param {() => string[]} [deps.getResearchImages] - current images.
   * @param {object | null} [deps.eventHandler] - progress observer.
   */
  constructor(deps) {
    /** @type {object} */
    this.deps = deps
    /** @type {WorkerPool} */
    this.workerPool = new WorkerPool(
      deps.cfg.max_scraper_workers,
      deps.cfg.scraper_rate_limit_delay,
    )
  }

  /**
   * Scrape content from a list of URLs.
   *
   * @param {string[]} urls - URLs to scrape.
   * @returns {Promise<Array<Record<string, unknown>>>} scraped content.
   */
  async browseUrls(urls) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'scraping_urls',
        `🌐 Scraping content from ${urls.length} URLs...`,
        this.deps.websocket ?? null,
      )
    }

    const [scrapedContent, images] = await scrapeUrls(
      urls,
      this.deps.cfg,
      this.workerPool,
      this.deps.fetchPage,
      this.deps.eventHandler ?? null,
    )
    this.deps.addResearchSources?.(scrapedContent)
    const newImages = this.selectTopImages(images, 4) // Select top 4 images
    this.deps.addResearchImages?.(newImages)

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'scraping_content',
        `📄 Scraped ${scrapedContent.length} pages of content`,
        this.deps.websocket ?? null,
      )
      await streamOutput(
        'logs',
        'scraping_images',
        `🖼️ Selected ${newImages.length} new images from ${images.length} total images`,
        this.deps.websocket ?? null,
        true,
        newImages,
      )
      await streamOutput(
        'logs',
        'scraping_complete',
        '🌐 Scraping complete',
        this.deps.websocket ?? null,
      )
    }

    return scrapedContent
  }

  /**
   * Select the most relevant images, de-duplicated by content hash.
   *
   * @param {Array<{url: string, score: number}>} images - candidate images.
   * @param {number} [k] - how many to keep.
   * @returns {string[]} selected image URLs.
   */
  selectTopImages(images, k = 2) {
    const uniqueImages = []
    const seenHashes = new Set()
    const currentResearchImages = new Set(this.deps.getResearchImages?.() ?? [])

    // Process images in descending score order.
    const sorted = [...images].sort((left, right) => right.score - left.score)
    for (const image of sorted) {
      const imageHash = getImageHash(image.url)
      if (imageHash && !seenHashes.has(imageHash) && !currentResearchImages.has(image.url)) {
        seenHashes.add(imageHash)
        uniqueImages.push(image.url)
        if (uniqueImages.length === k) break
      }
    }

    return uniqueImages
  }
}
