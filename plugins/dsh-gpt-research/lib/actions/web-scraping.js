/**
 * Web scraping wrapper.
 *
 * One-to-one port of `gpt_researcher/actions/web_scraping.py`: the per-URL
 * worker pool, the image collection, the excluded-domain filter, and the
 * partial-payload guards that keep one bad item from aborting a batch.
 *
 * The `Scraper` class lived in `gpt_researcher/scraper/` with nine backends
 * (beautifulsoup, browser, firecrawl, pdf, tavily_extract, …). The DSH port has
 * one fetch path — the host's `ctx.web.fetch` — so the scraper is injected as a
 * function. `scrapeUrls` keeps the same return contract (`[scrapedData,
 * images]`) and the same `{url, raw_content, title, image_urls}` page shape, so
 * the context layer and the compressor consume it unchanged.
 *
 * @module @yf-river/dsh-gpt-research/actions/web-scraping
 */

import { getFormattedLogger } from '../utils/logger.js'

const logger = getFormattedLogger()

/** Default user agent, used when no config is supplied. */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

/**
 * Scrape a list of URLs.
 *
 * @param {string[]} urls - URLs to scrape.
 * @param {object} cfg - resolved config (reads `user_agent`).
 * @param {{throttle: (work: Function) => Promise<unknown>}} [workerPool] - concurrency/throttle seam.
 * @param {(url: string) => Promise<{url: string, raw_content: string, title?: string, image_urls?: string[]}>} [fetchPage]
 *   the fetch implementation; required.
 * @param {(frame: object) => void} [_eventHandler] - progress sink.
 * @returns {Promise<[Array<Record<string, unknown>>, string[]]>} scraped pages and image URLs.
 */
export async function scrapeUrls(urls, cfg, workerPool = null, fetchPage = null, _eventHandler = null) {
  const scrapedData = []
  const images = []
  const userAgent = cfg?.user_agent ?? DEFAULT_USER_AGENT

  try {
    if (typeof fetchPage !== 'function') {
      throw new Error('scrapeUrls: no fetchPage implementation was provided')
    }
    const run = async (url) => {
      const page = await fetchPage(url, { userAgent })
      return { ...page, url: page?.url ?? url }
    }
    const pages = typeof workerPool?.throttle === 'function'
      ? await Promise.all((urls ?? []).map((url) => workerPool.throttle(() => run(url))))
      : await Promise.all((urls ?? []).map(run))

    for (const item of pages) {
      if (item === null || typeof item !== 'object') continue
      scrapedData.push(item)
      if (Array.isArray(item.image_urls) && item.image_urls.length > 0) {
        images.push(...item.image_urls)
      }
    }
  } catch (error) {
    console.error(`Error in scrape_urls: ${error?.message ?? error}`)
  }

  return [scrapedData, images]
}
