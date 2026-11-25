/**
 * Keyword (BM25) relevance filtering of scraped content.
 *
 * One-to-one port of `gpt_researcher/context/lexical.py`: the regex tokenizer,
 * the stopword list, the light plural stemmer, the BM25 variant that takes IDF
 * from the passages themselves, and the relative-threshold selection are copied
 * verbatim. Only the document/chunker types changed (see `../documents.js` and
 * `../text-splitter.js`).
 *
 * @module @yf-river/dsh-gpt-research/context/lexical
 */

import { prettyPrintDocs } from '../prompts.js'
import { RecursiveCharacterTextSplitter } from '../text-splitter.js'
import { SearchAPIRetriever } from './retriever.js'

/**
 * Token pattern.
 *
 * Python's `\w` under `re.UNICODE` matches any alphanumeric character, so a CJK
 * run is one token. JS `\w` is ASCII-only even with the `u` flag, so the
 * equivalent character class is spelled out: Unicode letters, numbers and
 * underscore. Getting this wrong silently drops every CJK query term.
 */
const TOKEN_RE = /[\p{L}\p{N}_]+/gu

const STOPWORDS = new Set(`
a about above after again against all am an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have
having he her here hers herself him himself his how i if in into is it its itself just me more most
my myself no nor not now of off on once only or other our ours ourselves out over own same she should
so some such than that the their theirs them themselves then there these they this those through to
too under until up very was we were what when where which while who whom why will with would you your
yours yourself yourselves
`.trim().split(/\s+/))

/**
 * Light plural stripping so "batteries" matches "battery" and "costs" matches "cost".
 * @param {string} token - lowercased token.
 * @returns {string} the stemmed token.
 */
function stem(token) {
  if (token.length <= 4 || token.endsWith('ss')) return token
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (['sses', 'xes', 'zes', 'ches', 'shes'].some((suffix) => token.endsWith(suffix))) {
    return token.slice(0, -2)
  }
  if (token.endsWith('s')) return token.slice(0, -1)
  return token
}

/**
 * Tokenize text into stemmed, stopword-filtered terms.
 * @param {string} text - input text.
 * @returns {string[]} tokens.
 */
export function tokenize(text) {
  return (String(text).toLowerCase().match(TOKEN_RE) ?? [])
    .filter((term) => term.length > 1 && !STOPWORDS.has(term))
    .map(stem)
}

/**
 * Term frequencies for one string.
 * @param {string} text - input text.
 * @returns {Map<string, number>} term → count.
 */
function termFrequencies(text) {
  const counts = new Map()
  for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1)
  return counts
}

/**
 * BM25 score of every passage for `query`, with IDF taken from the passages themselves.
 *
 * @param {string} query - the query text.
 * @param {string[]} passages - passage texts.
 * @param {number} [k1] - term-frequency saturation.
 * @param {number} [b] - length normalisation.
 * @returns {number[]} one score per passage, in input order.
 */
export function bm25Scores(query, passages, k1 = 1.5, b = 0.75) {
  const docs = passages.map(termFrequencies)
  if (docs.length === 0) return []
  const avgLen = docs.reduce((sum, doc) => sum + [...doc.values()].reduce((inner, count) => inner + count, 0), 0) / docs.length || 1.0
  const queryTerms = new Set(tokenize(query))
  const df = new Map()
  for (const term of queryTerms) {
    df.set(term, docs.filter((doc) => doc.has(term)).length)
  }
  const idf = new Map()
  for (const [term, n] of df) {
    idf.set(term, Math.log((docs.length - n + 0.5) / (n + 0.5) + 1))
  }
  const scores = []
  for (const doc of docs) {
    const length = [...doc.values()].reduce((sum, count) => sum + count, 0)
    let score = 0.0
    for (const term of queryTerms) {
      const tf = doc.get(term) ?? 0
      if (tf) {
        score += idf.get(term) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / avgLen))
      }
    }
    scores.push(score)
  }
  return scores
}

/**
 * Keeps the chunks with the highest BM25 score for the query.
 *
 * `relativeThreshold` drops chunks scoring below that fraction of the best
 * chunk, so a page with one relevant paragraph does not pull in its filler just
 * to fill the budget.
 */
export class LexicalContextCompressor {
  /**
   * @param {object} [init] - constructor fields.
   * @param {Array<Record<string, unknown>>} [init.documents] - scraper page dicts.
   * @param {number} [init.relativeThreshold] - minimum fraction of the best score.
   * @param {number} [init.chunkSize] - splitter chunk size.
   * @param {object} [init.promptFamily] - prompt renderer (defaults to `prettyPrintDocs`).
   */
  constructor(init = {}) {
    /** @type {Array<Record<string, unknown>>} */
    this.documents = init.documents ?? []
    /** @type {number} */
    this.relativeThreshold = init.relativeThreshold ?? 0.0
    /** @type {number} */
    this.chunkSize = init.chunkSize ?? 1000
    /** @type {{pretty_print_docs: Function}} */
    this.promptFamily = init.promptFamily ?? { pretty_print_docs: prettyPrintDocs }
  }

  /**
   * Split the pages into non-empty chunks.
   * @returns {import('../documents.js').Document[]} chunks.
   */
  chunks() {
    const pages = new SearchAPIRetriever({ pages: this.documents }).invoke('')
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.chunkSize,
      chunkOverlap: Math.floor(this.chunkSize / 10),
    })
    return splitter.splitDocuments(pages).filter((chunk) => chunk.pageContent.trim() !== '')
  }

  /**
   * Select the chunks that best match `query`.
   * @param {string} query - the sub-query.
   * @param {number} maxResults - maximum chunks to keep.
   * @returns {import('../documents.js').Document[]} selected chunks.
   */
  select(query, maxResults) {
    const chunks = this.chunks()
    const scores = bm25Scores(query, chunks.map((chunk) => chunk.pageContent))
    const best = scores.length > 0 ? Math.max(...scores) : 0.0
    if (best <= 0) {
      // No keyword overlap at all: fall back to the pages' opening chunks.
      return chunks.slice(0, maxResults)
    }
    const ranked = chunks
      .map((_chunk, index) => index)
      .sort((left, right) => scores[right] - scores[left] || left - right)
    const keep = ranked
      .filter((index) => scores[index] >= this.relativeThreshold * best)
      .slice(0, maxResults)
    return keep.map((index) => chunks[index])
  }

  /**
   * Render the selected chunks as model context.
   * @param {string} query - the sub-query.
   * @param {number} [maxResults] - maximum chunks to keep.
   * @param {((cost: number) => void) | null} [_costCallback] - unused; keyword mode is free.
   * @returns {Promise<string>} rendered context.
   */
  async asyncGetContext(query, maxResults = 10, _costCallback = null) {
    return this.promptFamily.pretty_print_docs(this.select(query, maxResults), maxResults)
  }

  /**
   * LangChain-compatible alias.
   * @param {string} query - the sub-query.
   * @param {number} [maxResults] - maximum chunks.
   * @param {((cost: number) => void) | null} [costCallback] - cost sink.
   * @returns {Promise<string>} rendered context.
   */
  async async_get_context(query, maxResults = 10, costCallback = null) {
    return this.asyncGetContext(query, maxResults, costCallback)
  }
}

/**
 * Previously written report sections most related to `query`.
 *
 * The keyword counterpart of `WrittenContentCompressor`, used when no embedding
 * model is available. `sections` are `{section_title, written_content}` dicts.
 *
 * @param {string} query - the section query.
 * @param {Array<{section_title?: string, written_content?: string}>} sections - written sections.
 * @param {number} [maxResults] - maximum sections.
 * @param {number} [relativeThreshold] - minimum fraction of the best score.
 * @returns {string[]} formatted sections.
 */
export function rankWrittenSections(query, sections, maxResults = 10, relativeThreshold = 0.5) {
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 100 })
  const chunks = []
  for (const section of sections) {
    for (const chunk of splitter.splitText(section.written_content ?? '')) {
      if (chunk.trim() === '') continue
      chunks.push([section.section_title ?? '', chunk])
    }
  }
  const scores = bm25Scores(query, chunks.map(([title, text]) => `${title}\n${text}`))
  const best = scores.length > 0 ? Math.max(...scores) : 0.0
  if (best <= 0) return []
  const ranked = chunks
    .map((_chunk, index) => index)
    .sort((left, right) => scores[right] - scores[left] || left - right)
  return ranked
    .filter((index) => scores[index] >= relativeThreshold * best)
    .slice(0, maxResults)
    .map((index) => `Title: ${chunks[index][0]}\nContent: ${chunks[index][1]}\n`)
}
