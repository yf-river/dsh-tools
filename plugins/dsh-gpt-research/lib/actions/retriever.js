/**
 * Retriever factory.
 *
 * Source: `gpt_researcher/actions/retriever.py`. The source mapped a name to one
 * of 21 concrete retriever classes loaded from `gpt_researcher/retrievers/`.
 *
 * The DSH port has exactly one search path — the host's `ctx.web.search` — so
 * this module keeps the *contract* the pipeline depends on and drops the name
 * table:
 *
 * - `getRetriever(name)` returns the single built-in retriever for any name,
 *   which preserves "an unknown name still yields a working retriever" and the
 *   source's `get_retrievers` fallback to the default.
 * - `getRetrievers(headers, cfg)` keeps the source's priority order: headers
 *   `retrievers` → headers `retriever` → `cfg.retrievers` → `cfg.retriever` →
 *   default, with whitespace stripping and empty-result fallback.
 *
 * A caller with a different search backend injects it as the retriever, so the
 * pipeline is not hardwired to `ctx.web`.
 *
 * @module @yf-river/dsh-gpt-research/actions/retriever
 */

const logger = {
  warning: (...args) => console.warn(...args),
}

/**
 * One search result, in the shape every downstream consumer expects.
 * @typedef {{href?: string, url?: string, title?: string, body?: string, raw_content?: string}} SearchResult
 */

/**
 * The host-backed retriever.
 *
 * `search()` is synchronous in the source (a blocking HTTP call run in a
 * thread). Here it returns a promise; `getSearchResults` awaits it either way.
 */
export class WebRetriever {
  /**
   * @param {string} query - the search query.
   * @param {{queryDomains?: string[], search?: (query: string, domains?: string[]) => Promise<SearchResult[]>}} [options]
   *   per-call options, including the search implementation.
   */
  constructor(query, options = {}) {
    /** @type {string} */
    this.query = query
    /** @type {string[]} */
    this.queryDomains = options.queryDomains ?? []
    /** @type {Function} */
    this.searchImpl = options.search
  }

  /**
   * Run the search.
   *
   * Results are normalized to the source's retriever contract: `href` for the
   * URL, `body`/`raw_content` for content, `title` for the display name. The
   * host's `ctx.web.search` returns `url`/`snippet`/`summary`, so both spellings
   * come out populated.
   *
   * @param {{maxResults?: number, max_results?: number}} [options] - result cap.
   * @returns {Promise<SearchResult[]>} normalized results.
   */
  async search(options = {}) {
    if (typeof this.searchImpl !== 'function') {
      throw new Error('WebRetriever: no search implementation was provided')
    }
    const maxResults = options.maxResults ?? options.max_results
    const raw = await this.searchImpl(this.query, this.queryDomains, maxResults)
    return (Array.isArray(raw) ? raw : []).map((item) => {
      const url = item.href ?? item.url ?? ''
      const content = item.raw_content ?? item.body ?? item.summary ?? item.snippet ?? ''
      return {
        ...item,
        href: url,
        url,
        title: item.title ?? '',
        body: content,
        raw_content: content,
      }
    })
  }
}

/**
 * Get a retriever class by name.
 *
 * The source returned `None` for an unknown name and let `get_retrievers` fall
 * back to the default. Returning the one built-in class for every name produces
 * the same downstream behaviour without a name table to maintain.
 *
 * @param {string} _retriever - retriever name (accepted, not dispatchable here).
 * @returns {typeof WebRetriever} the built-in retriever class.
 */
export function getRetriever(_retriever) {
  return WebRetriever
}

/**
 * Get the default retriever class.
 * @returns {typeof WebRetriever} the built-in retriever class.
 */
export function getDefaultRetriever() {
  return WebRetriever
}

/**
 * Determine which retriever(s) to use, by the source's priority order.
 *
 * Order: headers `retrievers` (comma-separated) → headers `retriever` →
 * `cfg.retrievers` (list or comma-separated string) → `cfg.retriever` →
 * default. Names are whitespace-stripped, empty names dropped, and an empty
 * list falls back to the default.
 *
 * @param {Record<string, string> | null} headers - request headers.
 * @param {object} cfg - resolved config.
 * @returns {Array<typeof WebRetriever>} retriever classes.
 */
export function getRetrievers(headers, cfg) {
  const headerMap = headers ?? {}
  let retrievers

  if (headerMap.retrievers) {
    retrievers = String(headerMap.retrievers).split(',')
  } else if (headerMap.retriever) {
    retrievers = [String(headerMap.retriever)]
  } else if (cfg?.retrievers) {
    retrievers = typeof cfg.retrievers === 'string' ? cfg.retrievers.split(',') : cfg.retrievers
  } else if (cfg?.retriever) {
    retrievers = [cfg.retriever]
  } else {
    retrievers = [getDefaultRetriever().name]
  }

  // Strip whitespace so comma-separated lists with spaces resolve.
  retrievers = retrievers.map((name) => String(name ?? '').trim()).filter((name) => name !== '')

  if (retrievers.length === 0) return [getDefaultRetriever()]

  return retrievers.map((name) => getRetriever(name) ?? getDefaultRetriever())
}

/**
 * Warning sink shared with callers that need the source's log line.
 * @param {string} message - warning text.
 */
export function warn(message) {
  logger.warning(message)
}
