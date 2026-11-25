/**
 * Context manager skill.
 *
 * One-to-one port of `gpt_researcher/skills/context_manager.py`: the three
 * retrieval entry points, the `max_results=10` default for scraped pages, the
 * `max_results=8` default for the vector store, the per-query written-content
 * de-duplication, and both embedding-failure fallbacks to lexical ranking.
 *
 * The parent `researcher` object is replaced by an explicit dependency bag
 * (`cfg`, `promptFamily`, `embeddings`, `vectorStore`, `costCallback`, `verbose`,
 * `websocket`), because the DSH port has no `GPTResearcher` god object. Every
 * call the source made through `self.researcher.*` is a named field here.
 *
 * @module @yf-river/dsh-gpt-research/skills/context-manager
 */

import { streamOutput } from '../actions/utils.js'
import { rankWrittenSections } from '../context/lexical.js'
import { selectContext } from '../context/select.js'
import { VectorstoreCompressor, WrittenContentCompressor } from '../context/compression.js'

const logger = {
  warning: (...args) => console.warn(...args),
  info: (...args) => console.log(...args),
}

/**
 * Manages context retrieval and compression.
 */
export class ContextManager {
  /**
   * @param {object} deps - the parent researcher's collaborating pieces.
   * @param {object} deps.cfg - resolved config.
   * @param {object} [deps.promptFamily] - prompt renderer.
   * @param {(() => object) | null} [deps.embeddings] - embedding factory.
   * @param {object | null} [deps.vectorStore] - vector store seam.
   * @param {((cost: number) => void) | null} [deps.costCallback] - cost sink.
   * @param {boolean} [deps.verbose] - whether to stream progress.
   * @param {object | null} [deps.websocket] - progress sink.
   */
  constructor(deps) {
    /** @type {object} */
    this.deps = deps
  }

  /**
   * Get similar content from pages based on the query.
   *
   * @param {string} query - the search query.
   * @param {Array<Record<string, unknown>>} pages - page dicts to search.
   * @returns {Promise<string>} compressed context.
   */
  async getSimilarContentByQuery(query, pages) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'fetching_query_content',
        `📚 Getting relevant content based on query: ${query}...`,
        this.deps.websocket ?? null,
      )
    }

    return selectContext(query, pages, this.deps.cfg, {
      maxResults: 10,
      promptFamily: this.deps.promptFamily,
      costCallback: this.deps.costCallback ?? null,
      embeddings: typeof this.deps.embeddings === 'function' ? this.deps.embeddings : null,
    })
  }

  /**
   * Get similar content from the vector store.
   *
   * @param {string} query - the search query.
   * @param {Record<string, unknown> | null} filter - vector store filter.
   * @returns {Promise<string>} compressed context.
   */
  async getSimilarContentByQueryWithVectorstore(query, filter) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'fetching_query_format',
        ` Getting relevant content based on query: ${query}...`,
        this.deps.websocket ?? null,
      )
    }
    const compressor = new VectorstoreCompressor({
      vectorStore: this.deps.vectorStore,
      filter,
      promptFamily: this.deps.promptFamily,
    })
    return compressor.asyncGetContext(query, 8)
  }

  /**
   * Get written contents similar to the subtopic and its draft section titles.
   *
   * One failing query must not abort its siblings or the report write; each one
   * falls back to lexical ranking independently, then results are de-duplicated
   * in first-seen order.
   *
   * @param {string} currentSubtopic - the subtopic being written.
   * @param {string[]} draftSectionTitles - draft section titles.
   * @param {Array<Record<string, unknown>>} writtenContents - previously written sections.
   * @param {number} [maxResults] - maximum results.
   * @returns {Promise<string[]>} relevant written content strings.
   */
  async getSimilarWrittenContentsByDraftSectionTitles(
    currentSubtopic,
    draftSectionTitles,
    writtenContents,
    maxResults = 10,
  ) {
    const allQueries = [currentSubtopic, ...draftSectionTitles]

    const processQuery = async (query) => {
      try {
        return await this.getSimilarWrittenContentsByQuery(query, writtenContents, 0.5, maxResults)
      } catch (error) {
        logger.warning(`Written-content search failed for query '${query}' (${error?.message ?? error}); falling back to lexical ranking`)
        return rankWrittenSections(query, writtenContents, maxResults)
      }
    }

    const results = await Promise.all(allQueries.map(processQuery))
    const seen = new Set()
    const flattened = []
    for (const result of results) {
      for (const content of result) {
        if (seen.has(content)) continue
        seen.add(content)
        flattened.push(content)
      }
    }
    return flattened.slice(0, maxResults)
  }

  /**
   * Get written contents similar to one query.
   *
   * @param {string} query - the query.
   * @param {Array<Record<string, unknown>>} writtenContents - previously written sections.
   * @param {number} [similarityThreshold] - minimum similarity.
   * @param {number} [maxResults] - maximum results.
   * @returns {Promise<string[]>} similar written content strings.
   */
  async getSimilarWrittenContentsByQuery(query, writtenContents, similarityThreshold = 0.5, maxResults = 10) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'fetching_relevant_written_content',
        `🔎 Getting relevant written content based on query: ${query}...`,
        this.deps.websocket ?? null,
      )
    }

    let embeddings
    try {
      embeddings = typeof this.deps.embeddings === 'function' ? this.deps.embeddings() : null
      if (embeddings === null) throw new Error('no embedding model configured')
    } catch (error) {
      // No usable embedding model: rank the written sections by keywords instead.
      logger.info(`Embeddings unavailable (${error?.message ?? error}); ranking written content by keywords`)
      return rankWrittenSections(query, writtenContents, maxResults)
    }

    const compressor = new WrittenContentCompressor({
      documents: writtenContents,
      embeddings,
      similarityThreshold,
    })
    return compressor.asyncGetContext(query, maxResults, this.deps.costCallback ?? null)
  }
}
