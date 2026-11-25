/**
 * Vector store wrapper.
 *
 * One-to-one port of `gpt_researcher/vector_store/vector_store.py`: the CLI-style
 * wrapper that converts scraper dicts into documents, splits them, and leaves
 * the store unchanged when a batch has nothing to add.
 *
 * The source converted to LangChain `Document` and called
 * `vector_store.add_documents`. The port uses its own {@link Document} and calls
 * the same `addDocuments` on the injected store, so the contract
 * (`addDocuments(documents)`, `asimilaritySearch(query, k, filter)`) is what a
 * caller must satisfy.
 *
 * @module @yf-river/dsh-gpt-research/vector-store
 */

import { Document } from './documents.js'
import { RecursiveCharacterTextSplitter } from './text-splitter.js'

/** A wrapper for a vector store, handling the researcher's document shape. */
export class VectorStoreWrapper {
  /**
   * @param {{addDocuments?: Function, asimilaritySearch?: Function}} vectorStore - the store.
   */
  constructor(vectorStore) {
    /** @type {object} */
    this.vectorStore = vectorStore
  }

  /**
   * Load documents into the store.
   *
   * Converts to documents, splits into chunks, and skips an empty batch so the
   * store is left unchanged.
   *
   * @param {Array<Record<string, string>>} documents - scraper dicts.
   */
  load(documents) {
    const converted = this.createDocuments(documents)
    const chunks = this.splitDocuments(converted)
    if (chunks.length === 0) return
    this.vectorStore.addDocuments?.(chunks)
  }

  /**
   * Convert researcher documents into documents.
   *
   * The source read `raw_content` with `content` as the fallback, and `url` with
   * `source` as the fallback, because scrapers and loaders disagree on the keys.
   *
   * @param {Array<Record<string, string>>} data - researcher documents.
   * @returns {Document[]} documents.
   */
  createDocuments(data) {
    return (data ?? []).map((item) => new Document({
      pageContent: item.raw_content ?? item.content ?? '',
      metadata: {
        source: item.url ?? item.source ?? '',
        title: item.title ?? '',
      },
    }))
  }

  /**
   * Split documents into chunks for storage.
   *
   * The source used default splitter settings here (1000/200), unlike the
   * context layer's 1000/100: that difference is in the reference and is kept.
   *
   * @param {Document[]} documents - documents.
   * @returns {Document[]} chunks.
   */
  splitDocuments(documents) {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 })
    return splitter.splitDocuments(documents).filter((chunk) => chunk.pageContent.trim() !== '')
  }

  /**
   * Similarity search.
   *
   * @param {string} query - the query.
   * @param {number} [k] - results to return.
   * @param {Record<string, unknown> | null} [filter] - store filter.
   * @returns {Promise<Document[]>} matching documents.
   */
  async asimilaritySearch(query, k = 4, filter = null) {
    if (typeof this.vectorStore.asimilaritySearch !== 'function') {
      throw new Error('VectorStoreWrapper: the injected store has no asimilaritySearch method')
    }
    return this.vectorStore.asimilaritySearch(query, k, filter)
  }
}
