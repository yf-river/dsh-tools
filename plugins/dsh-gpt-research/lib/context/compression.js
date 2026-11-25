/**
 * Embedding-based context compression.
 *
 * One-to-one port of `gpt_researcher/context/compression.py`: the three
 * compressors, the small-document fast path (`COMPRESSION_THRESHOLD`, 8000 chars
 * and `len(documents) <= max_results`), the 1000/100 splitter, the
 * `SIMILARITY_THRESHOLD` fallback (0.35), and the `pretty_print_docs` rendering.
 *
 * The LangChain pipeline (`ContextualCompressionRetriever` + `DocumentCompressorPipeline`
 * + `EmbeddingsFilter` + `EmbeddingsFilter`'s cosine maths) is reproduced inline:
 * split → drop chunks whose cosine similarity to the query vector is below the
 * threshold → keep the first `max_results`. That is exactly what the pipeline
 * does; keeping it as a pipeline object would only add indirection.
 *
 * Embeddings and the vector store are injected, because DSH does not own an
 * embedding model or a vector database. Callers pass:
 *
 *     embeddings: { embedDocuments(texts) → number[][], embedQuery(text) → number[] }
 *     vectorStore: { asimilaritySearch(query, k, filter) → Document[] }
 *
 * @module @yf-river/dsh-gpt-research/context/compression
 */

import { Document } from '../documents.js'
import { prettyPrintDocs } from '../prompts.js'
import { RecursiveCharacterTextSplitter } from '../text-splitter.js'
import { estimateEmbeddingCost } from '../utils/costs.js'
import { SearchAPIRetriever, SectionRetriever } from './retriever.js'

/** Embedding model the source prices against when reporting cost. */
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

/**
 * Cosine similarity between two equal-length vectors.
 * @param {number[]} left - first vector.
 * @param {number[]} right - second vector.
 * @returns {number} cosine similarity.
 */
function cosineSimilarity(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/**
 * Keep the chunks whose embedding is within `similarityThreshold` of the query.
 *
 * Port of LangChain's `EmbeddingsFilter`, which computes one query embedding and
 * one embedding per chunk, scores each pair, and keeps the passing pairs.
 *
 * @param {Document[]} documents - chunks to filter.
 * @param {string} query - the query text.
 * @param {{embedDocuments: Function, embedQuery: Function}} embeddings - embedding seam.
 * @param {number} similarityThreshold - minimum cosine similarity.
 * @returns {Promise<Document[]>} the documents that passed, in input order.
 */
async function embeddingsFilter(documents, query, embeddings, similarityThreshold) {
  if (documents.length === 0) return []
  const queryVector = await embeddings.embedQuery(query)
  const vectors = await embeddings.embedDocuments(documents.map((document) => document.pageContent))
  const kept = []
  for (let index = 0; index < documents.length; index += 1) {
    if (cosineSimilarity(queryVector, vectors[index]) >= similarityThreshold) {
      kept.push(documents[index])
    }
  }
  return kept
}

/**
 * Retrieves and compresses context from a vector store.
 *
 * Uses similarity search on an existing vector store to find relevant documents
 * for a given query.
 */
export class VectorstoreCompressor {
  /**
   * @param {object} [init] - constructor fields.
   * @param {{asimilaritySearch: Function}} [init.vectorStore] - vector store seam.
   * @param {number} [init.maxResults] - maximum results.
   * @param {Record<string, unknown> | null} [init.filter] - vector store filter.
   * @param {object} [init.promptFamily] - prompt renderer.
   */
  constructor(init = {}) {
    /** @type {{asimilaritySearch: Function} | null} */
    this.vectorStore = init.vectorStore ?? null
    /** @type {number} */
    this.maxResults = init.maxResults ?? 7
    /** @type {Record<string, unknown> | null} */
    this.filter = init.filter ?? null
    /** @type {object} */
    this.promptFamily = init.promptFamily ?? { pretty_print_docs: prettyPrintDocs }
  }

  /**
   * Get relevant context from the vector store.
   * @param {string} query - the search query.
   * @param {number | null} [maxResults] - maximum results; defaults to the constructor value.
   * @returns {Promise<string>} formatted document content.
   */
  async asyncGetContext(query, maxResults = null) {
    const limit = maxResults ?? this.maxResults
    const results = await this.vectorStore.asimilaritySearch(query, limit, this.filter)
    return this.promptFamily.pretty_print_docs(results)
  }

  /**
   * LangChain-compatible alias.
   * @param {string} query - the search query.
   * @param {number | null} [maxResults] - maximum results.
   * @returns {Promise<string>} formatted document content.
   */
  async async_get_context(query, maxResults = null) {
    return this.asyncGetContext(query, maxResults)
  }
}

/** Compresses raw documents to extract relevant context by embedding similarity. */
export class ContextCompressor {
  /**
   * @param {object} [init] - constructor fields.
   * @param {Array<Record<string, unknown>>} [init.documents] - scraper page dicts.
   * @param {{embedDocuments: Function, embedQuery: Function} | null} [init.embeddings] - embedding seam.
   * @param {number} [init.maxResults] - maximum results.
   * @param {number | null} [init.similarityThreshold] - minimum similarity; falls back to `SIMILARITY_THRESHOLD`.
   * @param {object} [init.promptFamily] - prompt renderer.
   * @param {Record<string, string|undefined>} [init.env] - environment map.
   */
  constructor(init = {}) {
    const env = init.env ?? process.env
    /** @type {number} */
    this.maxResults = init.maxResults ?? 5
    /** @type {Array<Record<string, unknown>>} */
    this.documents = init.documents ?? []
    /** @type {object | null} */
    this.embeddings = init.embeddings ?? null
    /** @type {number} */
    this.similarityThreshold = init.similarityThreshold
      ?? Number.parseFloat(env.SIMILARITY_THRESHOLD ?? '0.35')
    /** @type {object} */
    this.promptFamily = init.promptFamily ?? { pretty_print_docs: prettyPrintDocs }
    /** @type {Record<string, string|undefined>} */
    this.env = env
  }

  /**
   * Build the splitter the source's pipeline constructor used.
   * @returns {RecursiveCharacterTextSplitter} splitter.
   */
  #splitter() {
    return new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 100 })
  }

  /**
   * Get relevant context from documents.
   *
   * Optimization kept from the source: skip the expensive pipeline for small
   * document sets, when the documents are already concise.
   *
   * @param {string} query - the search query.
   * @param {number} [maxResults] - maximum results.
   * @param {((cost: number) => void) | null} [costCallback] - embedding cost sink.
   * @returns {Promise<string>} formatted document content.
   */
  async asyncGetContext(query, maxResults = 5, costCallback = null) {
    const totalChars = this.documents
      .reduce((sum, doc) => sum + String(doc.raw_content ?? '').length, 0)
    const chunkThreshold = Number.parseInt(this.env.COMPRESSION_THRESHOLD ?? '8000', 10)

    if (totalChars < chunkThreshold && this.documents.length <= maxResults) {
      // Fast path: no compression needed. Map scraper/retriever dict keys into
      // the metadata `pretty_print_docs` expects (`url` → `source`).
      const directDocs = this.documents.slice(0, maxResults).map((doc) => new Document({
        pageContent: doc.raw_content ?? '',
        metadata: {
          title: doc.title ?? '',
          source: doc.source || doc.url || '',
        },
      }))
      return this.promptFamily.pretty_print_docs(directDocs, maxResults)
    }

    const pages = new SearchAPIRetriever({ pages: this.documents }).invoke('')
    const chunks = this.#splitter().splitDocuments(pages)
    if (typeof costCallback === 'function') {
      costCallback(estimateEmbeddingCost(OPENAI_EMBEDDING_MODEL, this.documents))
    }
    const relevantDocs = await embeddingsFilter(chunks, query, this.embeddings, this.similarityThreshold)
    return this.promptFamily.pretty_print_docs(relevantDocs, maxResults)
  }

  /**
   * LangChain-compatible alias.
   * @param {string} query - the search query.
   * @param {number} [maxResults] - maximum results.
   * @param {((cost: number) => void) | null} [costCallback] - cost sink.
   * @returns {Promise<string>} formatted document content.
   */
  async async_get_context(query, maxResults = 5, costCallback = null) {
    return this.asyncGetContext(query, maxResults, costCallback)
  }
}

/** Compresses previously written content sections. */
export class WrittenContentCompressor {
  /**
   * @param {object} [init] - constructor fields.
   * @param {Array<{section_title?: string, written_content?: string}>} [init.documents] - written sections.
   * @param {{embedDocuments: Function, embedQuery: Function} | null} [init.embeddings] - embedding seam.
   * @param {number} [init.similarityThreshold] - minimum similarity.
   * @param {Record<string, string|undefined>} [init.env] - environment map.
   */
  constructor(init = {}) {
    const env = init.env ?? process.env
    /** @type {Array<{section_title?: string, written_content?: string}>} */
    this.documents = init.documents ?? []
    /** @type {object | null} */
    this.embeddings = init.embeddings ?? null
    /** @type {number} */
    this.similarityThreshold = init.similarityThreshold
      ?? Number.parseFloat(env.SIMILARITY_THRESHOLD ?? '0.35')
    /** @type {Record<string, string|undefined>} */
    this.env = env
  }

  /**
   * Format documents as title/content strings.
   * @param {Document[]} docs - documents.
   * @param {number} topN - maximum documents.
   * @returns {string[]} formatted strings.
   */
  #prettyDocsList(docs, topN) {
    return docs
      .filter((_doc, index) => index < topN)
      .map((doc) => `Title: ${doc.metadata.section_title}\nContent: ${doc.pageContent}\n`)
  }

  /**
   * Get relevant written content sections.
   * @param {string} query - the search query.
   * @param {number} [maxResults] - maximum results.
   * @param {((cost: number) => void) | null} [costCallback] - embedding cost sink.
   * @returns {Promise<string[]>} formatted section strings.
   */
  async asyncGetContext(query, maxResults = 5, costCallback = null) {
    const sections = new SectionRetriever({ sections: this.documents }).invoke('')
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 100 })
    const chunks = splitter.splitDocuments(sections)
    if (typeof costCallback === 'function') {
      costCallback(estimateEmbeddingCost(OPENAI_EMBEDDING_MODEL, this.documents))
    }
    const relevantDocs = await embeddingsFilter(chunks, query, this.embeddings, this.similarityThreshold)
    return this.#prettyDocsList(relevantDocs, maxResults)
  }

  /**
   * LangChain-compatible alias.
   * @param {string} query - the search query.
   * @param {number} [maxResults] - maximum results.
   * @param {((cost: number) => void) | null} [costCallback] - cost sink.
   * @returns {Promise<string[]>} formatted section strings.
   */
  async async_get_context(query, maxResults = 5, costCallback = null) {
    return this.asyncGetContext(query, maxResults, costCallback)
  }
}
