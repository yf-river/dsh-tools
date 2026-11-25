/**
 * Relevance filtering with TypeSafe's Jev model.
 *
 * One-to-one port of `gpt_researcher/context/jev_filter.py`: the rubric, the
 * System One request body, the retry policy (only 429 and 529 are retried,
 * backoff `0.5 * 2**attempt`), the token accounting, the per-loop concurrency
 * cap (`JEV_CONCURRENCY`, default 64), and the same small-content shortcut as
 * `ContextCompressor`.
 *
 * The embedding pipeline keeps the chunks whose vectors are closest to the query.
 * Cosine similarity measures topical closeness, not whether a passage helps
 * answer the question, so on-topic filler ranks as high as the passage with the
 * answer. `JevContextCompressor` asks the question directly: every chunk is
 * scored on a four-level usefulness rubric and the best-scoring chunks become the
 * context.
 *
 * Platform difference: the source used `httpx.AsyncClient` and `asyncio.gather`;
 * the port uses `fetch` and `Promise.all`. The weakref-per-event-loop semaphore
 * becomes one process-wide counter, because a plugin has one event loop.
 *
 * @module @yf-river/dsh-gpt-research/context/jev-filter
 */

import { Document } from '../documents.js'
import { prettyPrintDocs } from '../prompts.js'
import { RecursiveCharacterTextSplitter } from '../text-splitter.js'
import { SearchAPIRetriever } from './retriever.js'

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai/v1'
export const SYSTEMONE_PATH = '/systemone'
/** USD per million input tokens; output tokens are free. */
export const JEV_INPUT_PRICE_PER_MTOK = 0.042

/** The four usefulness levels the score is computed over. */
export const RELEVANCE_LEVELS = Object.freeze([
  'Unrelated to the question',
  'Same topic, but does not help answer the question',
  'Partially answers the question or gives useful supporting facts',
  'Directly answers the question with specific facts',
])

const logger = {
  warning: (...args) => console.warn(...args),
}

/** One shared in-flight counter, so concurrent sub-queries do not each open a full pool. */
let inFlight = 0
/** @type {Array<() => void>} */
const waiters = []

/**
 * Acquire one slot of the shared Jev concurrency budget.
 * @param {Record<string, string|undefined>} [env] - environment map.
 * @returns {Promise<() => void>} the release function.
 */
async function acquireSlot(env = process.env) {
  const limit = Number.parseInt(env.JEV_CONCURRENCY ?? '64', 10)
  if (inFlight < limit) {
    inFlight += 1
    return () => { inFlight -= 1; const next = waiters.shift(); if (next !== undefined) next() }
  }
  await new Promise((resolve) => { waiters.push(resolve) })
  inFlight += 1
  return () => { inFlight -= 1; const next = waiters.shift(); if (next !== undefined) next() }
}

/** Jev could not score the chunks (missing key, API or network failure). */
export class JevError extends Error {
  /**
   * @param {string} message - failure reason.
   */
  constructor(message) {
    super(message)
    this.name = 'JevError'
  }
}

/** One chunk with its score and original position. */
export class ScoredChunk {
  /**
   * @param {Document} document - the chunk.
   * @param {number} score - Jev usefulness score, 0–3.
   * @param {number} position - position in the chunk list.
   */
  constructor(document, score, position) {
    /** @type {Document} */
    this.document = document
    /** @type {number} */
    this.score = score
    /** @type {number} */
    this.position = position
  }
}

/** Minimal async client for the System One endpoint. */
export class JevClient {
  /**
   * @param {object} [init] - client fields.
   * @param {string | null} [init.apiKey] - API key; defaults to `TYPESAFE_API_KEY`.
   * @param {string | null} [init.model] - model; defaults to `JEV_MODEL` or `jev-latest`.
   * @param {number} [init.timeout] - per-request timeout, seconds.
   * @param {number} [init.maxRetries] - retries beyond the first attempt.
   * @param {string | null} [init.baseUrl] - base URL override.
   * @param {Record<string, string|undefined>} [init.env] - environment map.
   * @param {typeof fetch} [init.fetchImpl] - fetch implementation, for tests.
   * @throws {JevError} when no API key is configured.
   */
  constructor(init = {}) {
    const env = init.env ?? process.env
    /** @type {string} */
    this.apiKey = init.apiKey ?? env.TYPESAFE_API_KEY ?? ''
    if (!this.apiKey) throw new JevError('TYPESAFE_API_KEY is not set')
    /** @type {string} */
    this.model = init.model ?? env.JEV_MODEL ?? 'jev-latest'
    /** @type {string} */
    this.baseUrl = (init.baseUrl ?? env.TYPESAFE_BASE_URL ?? TYPESAFE_BASE_URL).trim().replace(/\/+$/, '')
    /** @type {string} */
    this.apiUrl = `${this.baseUrl}${SYSTEMONE_PATH}`
    /** @type {number} */
    this.timeout = init.timeout ?? 30.0
    /** @type {number} */
    this.maxRetries = init.maxRetries ?? 3
    /** @type {number} */
    this.inputTokens = 0
    /** @type {Record<string, string|undefined>} */
    this.env = env
    /** @type {typeof fetch} */
    this.fetchImpl = init.fetchImpl ?? fetch
  }

  /**
   * Score one passage's usefulness for a query.
   * @param {string} query - the question.
   * @param {string} passage - the chunk text.
   * @returns {Promise<number>} probability-weighted usefulness in `[0, 3]`.
   * @throws {JevError} when every attempt fails.
   */
  async scoreRelevance(query, passage) {
    const payload = {
      state: passage,
      model: this.model,
      questions: {
        usefulness: {
          type: 'score',
          instructions: `How useful is this passage for answering the question: ${query}`,
          criteria: [...RELEVANCE_LEVELS],
        },
      },
    }
    const headers = { Authorization: `Bearer ${this.apiKey}` }
    let lastError
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const release = await acquireSlot(this.env)
      try {
        let response
        try {
          response = await this.fetchImpl(this.apiUrl, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(this.timeout * 1000),
          })
        } catch (error) {
          lastError = error
        }
        if (response !== undefined) {
          if (response.status === 200) {
            let body
            try {
              body = await response.json()
            } catch {
              throw new JevError(`Unexpected Jev response: ${(await response.text().catch(() => '')).slice(0, 200)}`)
            }
            const score = Number(body?.answers?.usefulness?.score)
            if (!Number.isFinite(score)) {
              throw new JevError(`Unexpected Jev response: ${JSON.stringify(body).slice(0, 200)}`)
            }
            this.inputTokens += Number(body?.usage?.input_tokens ?? 0)
            return score
          }
          const text = await response.text().catch(() => '')
          lastError = new JevError(`HTTP ${response.status} from ${this.apiUrl}: ${text.slice(0, 200)}`)
          // Only overload and rate limiting are worth retrying.
          if (response.status !== 429 && response.status !== 529) throw lastError
        }
      } finally {
        release()
      }
      if (attempt < this.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 0.5 * 2 ** attempt * 1000))
      }
    }
    // Only reached with a retryable status on the final attempt, or a transport error.
    throw new JevError(`Jev request failed after ${this.maxRetries + 1} attempts: ${lastError?.message ?? String(lastError)}`)
  }

  /** @returns {number} accumulated cost in USD. */
  get cost() {
    return this.inputTokens / 1000000 * JEV_INPUT_PRICE_PER_MTOK
  }
}

/** Selects the most useful chunks of scraped pages by asking Jev. */
export class JevContextCompressor {
  /**
   * @param {object} [init] - constructor fields.
   * @param {Array<Record<string, unknown>>} [init.documents] - scraper page dicts.
   * @param {number} [init.maxResults] - maximum chunks to keep.
   * @param {number | null} [init.minScore] - minimum score; defaults to `JEV_MIN_SCORE` or 1.5.
   * @param {object} [init.promptFamily] - prompt renderer.
   * @param {JevClient | null} [init.client] - Jev client override.
   * @param {number | null} [init.chunkSize] - splitter chunk size; defaults to `JEV_CHUNK_SIZE` or 1000.
   * @param {Record<string, string|undefined>} [init.env] - environment map.
   */
  constructor(init = {}) {
    const env = init.env ?? process.env
    /** @type {Array<Record<string, unknown>>} */
    this.documents = init.documents ?? []
    /** @type {number} */
    this.chunkSize = init.chunkSize ?? Number.parseInt(env.JEV_CHUNK_SIZE ?? '1000', 10)
    /** @type {number} */
    this.maxResults = init.maxResults ?? 5
    /** @type {number} */
    this.minScore = init.minScore ?? Number.parseFloat(env.JEV_MIN_SCORE ?? '1.5')
    /** @type {object} */
    this.promptFamily = init.promptFamily ?? { pretty_print_docs: prettyPrintDocs }
    /** @type {JevClient} */
    this.client = init.client ?? new JevClient({ env })
    /** @type {Record<string, string|undefined>} */
    this.env = env
  }

  /**
   * Split the pages into non-empty chunks.
   * @returns {Document[]} chunks.
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
   * Score every chunk, best first (ties keep page order).
   * @param {string} query - the question.
   * @returns {Promise<ScoredChunk[]>} ranked chunks.
   */
  async rank(query) {
    const chunks = this.chunks()
    const scores = await Promise.all(chunks.map((chunk) => this.client.scoreRelevance(query, chunk.pageContent)))
    const ranked = chunks.map((chunk, index) => new ScoredChunk(chunk, scores[index], index))
    return ranked.sort((left, right) => right.score - left.score || left.position - right.position)
  }

  /**
   * Get the most useful chunks as model context.
   *
   * Same shortcut as `ContextCompressor`: little content needs no filtering.
   *
   * @param {string} query - the question.
   * @param {number} [maxResults] - maximum chunks.
   * @param {((cost: number) => void) | null} [costCallback] - Jev cost sink.
   * @returns {Promise<string>} rendered context.
   */
  async asyncGetContext(query, maxResults = 5, costCallback = null) {
    const totalChars = this.documents
      .reduce((sum, doc) => sum + String(doc.raw_content ?? '').length, 0)
    const threshold = Number.parseInt(this.env.COMPRESSION_THRESHOLD ?? '8000', 10)
    if (totalChars < threshold && this.documents.length <= maxResults) {
      const docs = this.documents.slice(0, maxResults).map((doc) => new Document({
        pageContent: doc.raw_content ?? '',
        metadata: { title: doc.title ?? '', source: doc.source || doc.url || '' },
      }))
      return this.promptFamily.pretty_print_docs(docs, maxResults)
    }

    const ranked = await this.rank(query)
    if (typeof costCallback === 'function') costCallback(this.client.cost)
    const selected = ranked
      .filter((chunk) => chunk.score >= this.minScore)
      .slice(0, maxResults)
      .map((chunk) => chunk.document)
    return this.promptFamily.pretty_print_docs(selected, maxResults)
  }

  /**
   * LangChain-compatible alias.
   * @param {string} query - the question.
   * @param {number} [maxResults] - maximum chunks.
   * @param {((cost: number) => void) | null} [costCallback] - cost sink.
   * @returns {Promise<string>} rendered context.
   */
  async async_get_context(query, maxResults = 5, costCallback = null) {
    return this.asyncGetContext(query, maxResults, costCallback)
  }
}
