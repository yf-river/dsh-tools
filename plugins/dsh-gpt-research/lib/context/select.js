/**
 * Turns pages of text into LLM context, the same way everywhere.
 *
 * One-to-one port of `gpt_researcher/context/select.py`. Research sub-queries
 * (scraped pages) and report chat (the finished report) both call
 * `selectContext`. `CONTEXT_FILTER` picks how chunks are chosen:
 *
 *   auto        jev when TYPESAFE_API_KEY is set, otherwise keyword
 *   jev         TypeSafe's Jev scores each chunk's usefulness (needs a key)
 *   keyword     BM25 keyword ranking: local, no API, no model, no embeddings
 *   embeddings  embedding similarity (needs an embedding provider)
 *   none        no filtering: every page, in full
 *
 * Anything that fails degrades to `keyword`, so no mode can leave a run without
 * context. Benchmarks: `evals/context_filter`.
 *
 * @module @yf-river/dsh-gpt-research/context/select
 */

import { Document } from '../documents.js'
import { prettyPrintDocs } from '../prompts.js'
import { ContextCompressor } from './compression.js'
import { JevContextCompressor, JevError } from './jev-filter.js'
import { LexicalContextCompressor } from './lexical.js'
import { SearchAPIRetriever } from './retriever.js'

const logger = {
  warning: (...args) => console.warn(...args),
}

/** Accepted `CONTEXT_FILTER` values. */
export const CONTEXT_FILTERS = Object.freeze(['auto', 'jev', 'keyword', 'embeddings', 'none'])

/**
 * Keyword chunks must score at least this fraction of the best chunk, and up to
 * this many are kept. Chosen by `evals/context_filter`: the threshold is what
 * beats embeddings; plain top-10 BM25 loses to them.
 */
function keywordRelativeThreshold(env = process.env) {
  return Number.parseFloat(env.KEYWORD_RELATIVE_THRESHOLD ?? '0.5')
}

/** @param {Record<string, string|undefined>} [env] - environment map. */
function keywordMaxResults(env = process.env) {
  return Number.parseInt(env.KEYWORD_MAX_RESULTS ?? '25', 10)
}

/**
 * The filter to use; `auto` means Jev when a TypeSafe key is set, else keyword.
 * @param {string | null} setting - the `CONTEXT_FILTER` value.
 * @param {Record<string, string|undefined>} [env] - environment map.
 * @returns {string} one of `jev` / `keyword` / `embeddings` / `none`.
 */
export function resolveContextFilter(setting, env = process.env) {
  let mode = (setting ?? 'auto').trim().toLowerCase()
  if (!CONTEXT_FILTERS.includes(mode)) {
    logger.warning(`Unknown CONTEXT_FILTER ${JSON.stringify(setting)}; expected one of ${CONTEXT_FILTERS.join(', ')}. Using 'auto'.`)
    mode = 'auto'
  }
  if (mode === 'auto') return env.TYPESAFE_API_KEY ? 'jev' : 'keyword'
  return mode
}

/**
 * Convert page dicts into documents.
 * @param {Array<Record<string, unknown>>} pages - scraper page dicts.
 * @returns {Document[]} documents.
 */
function asDocuments(pages) {
  return new SearchAPIRetriever({ pages }).invoke('')
}

/**
 * Select context for `query` from `pages`.
 *
 * @param {string} query - the sub-query.
 * @param {Array<Record<string, unknown>>} pages - page dicts with `raw_content`, `url`, `title`.
 * @param {object} cfg - resolved config (reads `context_filter`, `similarity_threshold`).
 * @param {object} [options] - call options.
 * @param {number} [options.maxResults] - maximum chunks.
 * @param {object} [options.promptFamily] - prompt renderer.
 * @param {((cost: number) => void) | null} [options.costCallback] - cost sink.
 * @param {(() => object) | null} [options.embeddings] - zero-argument embedding factory,
 *   called only in embeddings mode so nothing builds a model unless that mode is chosen.
 * @param {Record<string, string|undefined>} [options.env] - environment map.
 * @returns {Promise<string>} rendered context.
 */
export async function selectContext(query, pages, cfg, options = {}) {
  const env = options.env ?? process.env
  const maxResults = options.maxResults ?? 10
  const promptFamily = options.promptFamily ?? { pretty_print_docs: prettyPrintDocs }
  const mode = resolveContextFilter(cfg?.context_filter ?? null, env)

  if (mode === 'none') {
    return promptFamily.pretty_print_docs(asDocuments(pages))
  }

  // Little content needs no filtering, whatever the mode.
  const totalChars = pages.reduce((sum, page) => sum + String(page.raw_content ?? '').length, 0)
  if (totalChars < Number.parseInt(env.COMPRESSION_THRESHOLD ?? '8000', 10) && pages.length <= maxResults) {
    return promptFamily.pretty_print_docs(asDocuments(pages).slice(0, maxResults), maxResults)
  }

  if (mode === 'jev') {
    try {
      return await new JevContextCompressor({
        documents: pages,
        promptFamily,
        env,
      }).asyncGetContext(query, maxResults, options.costCallback ?? null)
    } catch (error) {
      if (!(error instanceof JevError)) throw error
      logger.warning(`Jev context filter unavailable (${error.message}); using keyword ranking`)
    }
  }

  if (mode === 'embeddings') {
    try {
      return await new ContextCompressor({
        documents: pages,
        embeddings: typeof options.embeddings === 'function' ? options.embeddings() : null,
        similarityThreshold: cfg?.similarity_threshold ?? null,
        promptFamily,
        env,
      }).asyncGetContext(query, maxResults, options.costCallback ?? null)
    } catch (error) {
      logger.warning(`Embedding context filter unavailable (${error.message}); using keyword ranking`)
    }
  }

  return new LexicalContextCompressor({
    documents: pages,
    relativeThreshold: keywordRelativeThreshold(env),
    promptFamily,
  }).asyncGetContext(query, keywordMaxResults(env))
}
