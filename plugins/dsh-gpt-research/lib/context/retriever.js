/**
 * Page and section retrievers.
 *
 * Port of `gpt_researcher/context/retriever.py`. The source subclassed
 * LangChain's `BaseRetriever` and implemented `_get_relevant_documents`; the port
 * keeps the same two classes with the same field names and the same
 * `invoke(query)` entry point, minus the LangChain callback plumbing that only
 * existed to feed its tracer.
 *
 * @module @yf-river/dsh-gpt-research/context/retriever
 */

import { Document } from '../documents.js'

/**
 * Maximum characters of `raw_content` carried into one document.
 *
 * Large documents (e.g. scraped PDFs) can exceed embedding API token limits
 * (OpenAI's 300 000 token-per-request cap) when all chunks are sent at once.
 * Defaults to 50 000 chars (~12 500 tokens); override with `MAX_CONTENT_CHARS`.
 */
function maxContentChars() {
  return Number.parseInt(process.env.MAX_CONTENT_CHARS ?? '50000', 10)
}

/** Turns scraper page dicts into documents. */
export class SearchAPIRetriever {
  /**
   * @param {{pages?: Array<Record<string, unknown>>}} [init] - page dicts.
   */
  constructor(init = {}) {
    /** @type {Array<Record<string, unknown>>} */
    this.pages = init.pages ?? []
  }

  /**
   * Convert pages into documents.
   *
   * `raw_content` may be explicitly null (the scraper sets it to null for pages
   * that failed to scrape), and slicing null raises in the source too; both
   * coerce to `''` before truncating.
   *
   * @param {string} [_query] - unused; kept for signature parity.
   * @returns {Document[]} documents.
   */
  getRelevantDocuments(_query) {
    const limit = maxContentChars()
    return this.pages.map((page) => new Document({
      pageContent: String(page.raw_content ?? '').slice(0, limit),
      metadata: {
        title: page.title ?? '',
        source: page.source || page.url || '',
      },
    }))
  }

  /**
   * LangChain-compatible entry point.
   * @param {string} [query] - unused.
   * @returns {Document[]} documents.
   */
  invoke(query) {
    return this.getRelevantDocuments(query)
  }
}

/** Turns previously written report sections into documents. */
export class SectionRetriever {
  /**
   * @param {{sections?: Array<{section_title?: string, written_content?: string}>}} [init]
   *   section dicts, each `{section_title, written_content}`.
   */
  constructor(init = {}) {
    /** @type {Array<{section_title?: string, written_content?: string}>} */
    this.sections = init.sections ?? []
  }

  /**
   * Convert sections into documents.
   * @param {string} [_query] - unused; kept for signature parity.
   * @returns {Document[]} documents.
   */
  getRelevantDocuments(_query) {
    return this.sections.map((page) => new Document({
      pageContent: page.written_content ?? '',
      metadata: {
        section_title: page.section_title ?? '',
      },
    }))
  }

  /**
   * LangChain-compatible entry point.
   * @param {string} [query] - unused.
   * @returns {Document[]} documents.
   */
  invoke(query) {
    return this.getRelevantDocuments(query)
  }
}
