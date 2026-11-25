/**
 * Deep research skill.
 *
 * One-to-one port of `gpt_researcher/skills/deep_research.py`: the four response
 * parsers with their JSON-first / line-based fallbacks, the word-budget trimmer,
 * the recursion with `new_breadth = max(2, breadth // 2)` and `new_depth = depth - 1`,
 * the concurrency semaphore, and the "no successful results stops the descent"
 * guard the source documents as issue #1579.
 *
 * One deliberate structural change: the source recursed
 * (`await self.deep_research(...)`), which needs a live `GPTResearcher` per
 * branch. The port exposes the same recursion through {@link DeepResearchSkill.runBranch}
 * over injected dependencies, so a caller can run branches as sub-agents or as
 * plain async calls without changing the algorithm.
 *
 * @module @yf-river/dsh-gpt-research/skills/deep-research
 */

import { getSearchResults } from '../actions/query-processing.js'
import { ReasoningEfforts } from '../config/providers.js'
import { ReportSource, ReportType } from '../utils/enum.js'
import { createChatCompletion } from '../utils/llm.js'
import { jsonRepairLoads } from '../utils/json-repair.js'

const logger = {
  warning: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => {},
  info: (...args) => console.log(...args),
}

/** Maximum words allowed in context (25k words for safety margin). */
export const MAX_CONTEXT_WORDS = 25000

/** Candidate JSON payloads inside a model reply, most specific first. */
const JSON_BLOCK_PATTERNS = [
  /```(?:json)?\s*([\s\S]*?)```/i,
  /(\[[\s\S]*\])/,
  /(\{[\s\S]*\})/,
]

const QUERY_LINE_PATTERN = /^(?:[-*]|\d+[.)])?\s*Query:\s*(.+)$/i
const GOAL_LINE_PATTERN = /^(?:[-*]|\d+[.)])?\s*(?:Goal|Research Goal):\s*(.+)$/i
const QUESTION_LINE_PATTERN = /^(?:[-*]|\d+[.)])?\s*(?:Question:\s*)?(.+\?)$/i
const LEARNING_LINE_PATTERN = /^(?:[-*]|\d+[.)])?\s*Learning(?:\s*\[([^\]]+)\])?:\s*(.+)$/i
const URL_PATTERN = /https?:\/\/[^\s\]),;"]+/g

/**
 * Collect distinct JSON payload candidates from a reply.
 * @param {string} response - the model reply.
 * @returns {string[]} candidate payloads, most specific first.
 */
function extractJsonPayloads(response) {
  const candidates = []
  const seen = new Set()
  for (const pattern of JSON_BLOCK_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const match of response.matchAll(global)) {
      const candidate = (match[1] ?? '').trim()
      if (candidate && !seen.has(candidate)) {
        candidates.push(candidate)
        seen.add(candidate)
      }
    }
  }
  return candidates
}

/**
 * Parse a reply, trying the raw text then each extracted payload.
 * @param {string} response - the model reply.
 * @returns {unknown} the parsed value, or `null` when nothing parses.
 */
function loadRepairedJson(response) {
  const candidates = [response.trim(), ...extractJsonPayloads(response)]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return jsonRepairLoads(candidate)
    } catch (error) {
      logger.debug(`json_repair failed on candidate (${candidate.length} chars): ${error?.message ?? error}`)
    }
  }
  return null
}

/**
 * Parse a search-queries reply.
 *
 * @param {string} response - the model reply.
 * @param {number} numQueries - maximum queries to return.
 * @returns {Array<{query: string, researchGoal: string}>} parsed queries.
 */
export function parseSearchQueriesResponse(response, numQueries) {
  const parsed = loadRepairedJson(response)
  let candidateQueries = parsed
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    candidateQueries = parsed.queries || parsed.searchQueries || parsed.items
  }

  if (Array.isArray(candidateQueries)) {
    const queries = []
    for (const item of candidateQueries) {
      if (item === null || typeof item !== 'object') continue
      const query = item.query
      const researchGoal = item.researchGoal
      if (typeof query !== 'string' || typeof researchGoal !== 'string') continue
      // Normalize before validating so whitespace-only values are rejected
      // instead of being accepted and then stripped down to "".
      const trimmedQuery = query.trim()
      const trimmedGoal = researchGoal.trim()
      if (trimmedQuery && trimmedGoal) {
        queries.push({ query: trimmedQuery, researchGoal: trimmedGoal })
      }
    }
    if (queries.length > 0) return queries.slice(0, numQueries)
  }

  const queries = []
  let currentQuery = {}
  for (const rawLine of response.replace('```json', '').replace('```', '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const queryMatch = QUERY_LINE_PATTERN.exec(line)
    const goalMatch = GOAL_LINE_PATTERN.exec(line)

    if (queryMatch) {
      if (currentQuery.query && currentQuery.researchGoal) queries.push(currentQuery)
      currentQuery = { query: queryMatch[1].trim() }
    } else if (goalMatch && currentQuery.query) {
      currentQuery.researchGoal = goalMatch[1].trim()
    }
  }

  if (currentQuery.query && currentQuery.researchGoal) queries.push(currentQuery)

  return queries.slice(0, numQueries)
}

/**
 * Read a list-of-strings shape without coercing invalid entries.
 * @param {unknown} value - candidate value.
 * @returns {string[]} the strings.
 */
function questionStrings(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
}

/**
 * Parse a follow-up-questions reply.
 *
 * @param {string} response - the model reply.
 * @param {number} numQuestions - maximum questions to return.
 * @returns {string[]} parsed questions.
 */
export function parseFollowUpQuestionsResponse(response, numQuestions) {
  const parsed = loadRepairedJson(response)
  let candidateQuestions = parsed
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    candidateQuestions = parsed.questions || parsed.followUpQuestions || parsed.items
  }

  if (Array.isArray(candidateQuestions)) {
    const questions = questionStrings(candidateQuestions)
    if (questions.length > 0) return questions.slice(0, numQuestions)
  }

  const questions = []
  for (const rawLine of response.replace('```json', '').replace('```', '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const questionMatch = QUESTION_LINE_PATTERN.exec(line)
    if (questionMatch) questions.push(questionMatch[1].trim())
  }

  return questions.slice(0, numQuestions)
}

/**
 * Parse a research-results reply into learnings, follow-up questions and citations.
 *
 * @param {string} response - the model reply.
 * @param {number} numLearnings - maximum entries to return.
 * @returns {{learnings: string[], followUpQuestions: string[], citations: Record<string, string>}} parsed results.
 */
export function parseResearchResultsResponse(response, numLearnings) {
  const parsed = loadRepairedJson(response)

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const learningsPayload = parsed.learnings ?? []
    const followUpPayload = parsed.followUpQuestions || parsed.questions || []
    const learnings = []
    const citations = {}

    if (Array.isArray(learningsPayload)) {
      for (const item of learningsPayload) {
        let learning
        let citation
        if (item !== null && typeof item === 'object') {
          learning = String(item.insight || item.learning || '').trim()
          citation = String(item.sourceUrl || item.citation || '').trim()
        } else {
          learning = String(item ?? '').trim()
          citation = ''
        }
        if (learning) {
          learnings.push(learning)
          if (citation) citations[learning] = citation
        }
      }
    }

    const questions = questionStrings(followUpPayload)
    if (learnings.length > 0 || questions.length > 0) {
      return {
        learnings: learnings.slice(0, numLearnings),
        followUpQuestions: questions.slice(0, numLearnings),
        citations,
      }
    }
  }

  const learnings = []
  const questions = []
  const citations = {}

  for (const rawLine of response.replace('```json', '').replace('```', '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const learningMatch = LEARNING_LINE_PATTERN.exec(line)
    const questionMatch = QUESTION_LINE_PATTERN.exec(line)

    if (learningMatch) {
      let learning = learningMatch[2].trim()
      let citation = (learningMatch[1] ?? '').trim()
      if (!citation) {
        const urlMatch = URL_PATTERN.exec(learning)
        URL_PATTERN.lastIndex = 0
        if (urlMatch) {
          citation = urlMatch[0]
          learning = learning.replace(citation, '').trim().replace(/^[- ]+|[- ]+$/g, '')
        }
      }
      if (learning) {
        learnings.push(learning)
        if (citation) citations[learning] = citation
      }
    } else if (questionMatch) {
      questions.push(questionMatch[1].trim())
    }
  }

  return {
    learnings: learnings.slice(0, numLearnings),
    followUpQuestions: questions.slice(0, numLearnings),
    citations,
  }
}

/**
 * Count whitespace-separated words, treating a list as its space-joined text.
 * @param {unknown} text - text or list of texts.
 * @returns {number} word count.
 */
export function countWords(text) {
  const value = Array.isArray(text) ? text.map((item) => String(item)).join(' ') : text
  return String(value).split(/\s+/).filter((word) => word !== '').length
}

/**
 * Trim context to a word budget, keeping the most recent items.
 *
 * @param {Array<string | string[]>} contextList - context entries.
 * @param {number} [maxWords] - word budget.
 * @returns {Array<string | string[]>} the trimmed list, in original order.
 */
export function trimContextToWordLimit(contextList, maxWords = MAX_CONTEXT_WORDS) {
  let totalWords = 0
  const trimmedContext = []

  // Process in reverse so the most recent items survive.
  for (let index = contextList.length - 1; index >= 0; index -= 1) {
    const item = contextList[index]
    const text = Array.isArray(item) ? item.map((part) => String(part)).join(' ') : String(item)
    const words = countWords(item)
    if (totalWords + words <= maxWords) {
      trimmedContext.unshift(item) // Keep the original order.
      totalWords += words
    } else if (trimmedContext.length === 0) {
      trimmedContext.unshift(text.split(/\s+/).filter((word) => word !== '').slice(0, maxWords).join(' '))
      break
    } else {
      break
    }
  }

  return trimmedContext
}

/** Progress snapshot for one deep-research run. */
export class ResearchProgress {
  /**
   * @param {number} totalDepth - rounds planned.
   * @param {number} totalBreadth - queries per round.
   */
  constructor(totalDepth, totalBreadth) {
    /** @type {number} starts at 1 and increments up to totalDepth */
    this.currentDepth = 1
    /** @type {number} */
    this.totalDepth = totalDepth
    /** @type {number} starts at 0 and counts up as queries complete */
    this.currentBreadth = 0
    /** @type {number} */
    this.totalBreadth = totalBreadth
    /** @type {string | null} */
    this.currentQuery = null
    /** @type {number} */
    this.totalQueries = 0
    /** @type {number} */
    this.completedQueries = 0
  }
}

/** Deep research pipeline. */
export class DeepResearchSkill {
  /**
   * @param {object} deps - run dependencies.
   * @param {object} deps.cfg - resolved config.
   * @param {Function[]} [deps.retrievers] - retriever classes.
   * @param {Function | null} [deps.search] - the search implementation.
   * @param {object} [deps.provider] - the model-call seam.
   * @param {((cost: number) => void) | null} [deps.costCallback] - cost sink.
   * @param {object | null} [deps.websocket] - progress sink.
   * @param {string | null} [deps.tone] - writing tone.
   * @param {object | null} [deps.headers] - request headers.
   * @param {Set<string>} [deps.visitedUrls] - shared visited-URL set.
   * @param {(query: string) => Promise<Array<Record<string, unknown>>>} [deps.conductResearch]
   *   one-branch research, so this skill does not own the researcher object.
   * @param {Record<string, string|undefined>} [deps.env] - environment map.
   * @param {Date} [deps.now] - clock.
   */
  constructor(deps) {
    /** @type {object} */
    this.deps = deps
    /** @type {number} breadth per round */
    this.breadth = deps.cfg?.deep_research_breadth ?? 4
    /** @type {number} recursion depth */
    this.depth = deps.cfg?.deep_research_depth ?? 2
    /** @type {number} concurrent branches */
    this.concurrencyLimit = deps.cfg?.deep_research_concurrency ?? 2
    /** @type {object | null} */
    this.websocket = deps.websocket ?? null
    /** @type {string | null} */
    this.tone = deps.tone ?? null
    /** @type {object | null} */
    this.headers = deps.headers ?? null
    /** @type {Set<string>} */
    this.visitedUrls = deps.visitedUrls ?? new Set()
    /** @type {string[]} */
    this.learnings = []
    /** @type {Array<Record<string, unknown>>} */
    this.researchSources = []
    /** @type {string[]} */
    this.context = []
  }

  /**
   * Generate search queries with research goals.
   *
   * @param {string} query - the topic.
   * @param {number} [numQueries] - how many queries to request.
   * @returns {Promise<Array<{query: string, researchGoal: string}>>} queries.
   */
  async generateSearchQueries(query, numQueries = 3) {
    const cfg = this.deps.cfg
    const messages = [
      {
        role: 'system',
        content: 'You are an expert researcher generating search queries. '
          + 'Return valid JSON only. Do not include markdown, code fences, bullets, numbering, or prose.',
      },
      {
        role: 'user',
        content: `Given the following prompt, generate ${numQueries} unique search queries to research the topic thoroughly. `
          + 'For each query, provide a research goal.\n\n'
          + 'Return ONLY a JSON array of objects using this exact schema:\n'
          + '[{"query": "<search query>", "researchGoal": "<research goal>"}]\n\n'
          + `Prompt: ${query}`,
      },
    ]

    const response = await createChatCompletion({
      messages,
      llmProvider: cfg.strategic_llm_provider,
      model: cfg.strategic_llm_model,
      reasoningEffort: cfg.reasoning_effort,
      temperature: 0.4,
      llmKwargs: cfg.llm_kwargs,
      costCallback: this.deps.costCallback ?? null,
      provider: this.deps.provider,
      env: this.deps.env,
    })

    return parseSearchQueriesResponse(response, numQueries)
  }

  /**
   * Generate follow-up questions that clarify the research direction.
   *
   * @param {string} query - the topic.
   * @param {number} [numQuestions] - how many questions to request.
   * @returns {Promise<string[]>} questions.
   */
  async generateResearchPlan(query, numQuestions = 3) {
    const cfg = this.deps.cfg
    // Get initial search results from all retrievers to inform query generation.
    const allSearchResults = []
    for (const retriever of this.deps.retrievers ?? []) {
      try {
        const results = await getSearchResults(query, retriever, [], null, null, this.deps.search ?? null)
        allSearchResults.push(...results)
      } catch (error) {
        const name = retriever?.name ?? String(retriever)
        logger.warning(`Error with retriever ${name}: ${error?.message ?? error}`)
      }
    }
    const searchResults = allSearchResults
    logger.info(`Initial web knowledge obtained: ${searchResults.length} results`)

    const now = this.deps.now ?? new Date()
    const currentTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
      + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

    const messages = [
      {
        role: 'system',
        content: 'You are an expert researcher. Your task is to analyze the original query and search results, '
          + 'then generate targeted questions that explore different aspects and time periods of the topic. '
          + 'Return valid JSON only.',
      },
      {
        role: 'user',
        content: `Original query: ${query}

Current time: ${currentTime}

Search results:
${searchResults}

Based on these results, the original query, and the current time, generate ${numQuestions} unique questions. Each question should explore a different aspect or time period of the topic, considering recent developments up to ${currentTime}.

Return ONLY a JSON object using this exact schema:
{"questions": ["<question 1>", "<question 2>"]}`,
      },
    ]

    const response = await createChatCompletion({
      messages,
      llmProvider: cfg.strategic_llm_provider,
      model: cfg.strategic_llm_model,
      reasoningEffort: ReasoningEfforts.High,
      temperature: 0.4,
      llmKwargs: cfg.llm_kwargs,
      costCallback: this.deps.costCallback ?? null,
      provider: this.deps.provider,
      env: this.deps.env,
    })

    return parseFollowUpQuestionsResponse(response, numQuestions)
  }

  /**
   * Extract learnings, follow-up questions and citations from one branch's results.
   *
   * @param {string} query - the branch query.
   * @param {string} context - the gathered context.
   * @param {number} [numLearnings] - maximum learnings.
   * @returns {Promise<{learnings: string[], followUpQuestions: string[], citations: Record<string, string>}>} parsed results.
   */
  async processResearchResults(query, context, numLearnings = 3) {
    const cfg = this.deps.cfg
    const messages = [
      {
        role: 'system',
        content: 'You are an expert researcher analyzing search results. '
          + 'Return valid JSON only.',
      },
      {
        role: 'user',
        content: `Given the following research results for the query '${query}', extract key learnings and suggest `
          + 'follow-up questions. For each learning, include a citation to the source URL if available.\n\n'
          + 'Return ONLY a JSON object using this exact schema:\n'
          + '{"learnings": [{"insight": "<insight>", "sourceUrl": "<url or empty string>"}], '
          + '"followUpQuestions": ["<question 1>", "<question 2>"]}\n\n'
          + `Research results:\n${context}`,
      },
    ]

    const response = await createChatCompletion({
      messages,
      llmProvider: cfg.strategic_llm_provider,
      model: cfg.strategic_llm_model,
      temperature: 0.4,
      reasoningEffort: ReasoningEfforts.High,
      // Needs headroom for reasoning tokens on reasoning models.
      maxTokens: cfg.strategic_token_limit ?? 8000,
      llmKwargs: cfg.llm_kwargs,
      costCallback: this.deps.costCallback ?? null,
      provider: this.deps.provider,
      env: this.deps.env,
    })

    return parseResearchResultsResponse(response, numLearnings)
  }

  /**
   * Run one research round and descend recursively.
   *
   * @param {object} params - branch parameters.
   * @param {string} params.query - the branch query.
   * @param {number} params.breadth - queries this round.
   * @param {number} params.depth - remaining rounds.
   * @param {string[]} [params.learnings] - accumulated learnings.
   * @param {Record<string, string>} [params.citations] - accumulated citations.
   * @param {Set<string>} [params.visitedUrls] - accumulated visited URLs.
   * @param {(progress: ResearchProgress) => void} [params.onProgress] - progress sink.
   * @returns {Promise<{learnings: string[], visitedUrls: string[], citations: Record<string, string>, context: Array<string|string[]>, sources: Array<object>}>}
   *   accumulated results.
   */
  async deepResearch(params) {
    const breadth = params.breadth
    const depth = params.depth
    let allLearnings = [...(params.learnings ?? [])]
    const allCitations = { ...(params.citations ?? {}) }
    const allVisitedUrls = new Set(params.visitedUrls ?? [])
    const allContext = []
    const allSources = []

    const progress = new ResearchProgress(depth, breadth)
    params.onProgress?.(progress)

    const serpQueries = await this.generateSearchQueries(params.query, breadth)
    progress.totalQueries = serpQueries.length
    if (serpQueries.length === 0) {
      logger.warning('Deep research generated zero search queries; stopping descent.')
      return {
        learnings: allLearnings,
        visitedUrls: [...allVisitedUrls],
        citations: allCitations,
        context: allContext,
        sources: allSources,
      }
    }

    // Process queries with a concurrency limit.
    let active = 0
    const waiters = []
    const acquire = async () => {
      if (active < this.concurrencyLimit) {
        active += 1
        return
      }
      await new Promise((resolve) => waiters.push(resolve))
      active += 1
    }
    const release = () => {
      active -= 1
      const next = waiters.shift()
      if (next !== undefined) next()
    }

    const processQuery = async (serpQuery) => {
      await acquire()
      try {
        progress.currentQuery = serpQuery.query
        params.onProgress?.(progress)

        if (typeof this.deps.conductResearch !== 'function') {
          throw new Error('deepResearch: conductResearch dependency is required')
        }
        const branch = await this.deps.conductResearch(serpQuery.query)
        allVisitedUrls.add(serpQuery.query)

        const results = await this.processResearchResults(serpQuery.query, branch)
        progress.completedQueries += 1
        progress.currentBreadth += 1
        params.onProgress?.(progress)

        return {
          learnings: results.learnings,
          visitedUrls: [...allVisitedUrls],
          followUpQuestions: results.followUpQuestions,
          researchGoal: serpQuery.researchGoal,
          citations: results.citations,
          context: Array.isArray(branch) ? branch.join('\n') : String(branch ?? ''),
          sources: [],
        }
      } catch (error) {
        logger.error(`Error processing query '${serpQuery.query}': ${error?.message ?? error}`)
        return null
      } finally {
        release()
      }
    }

    const settled = await Promise.all(serpQueries.map(processQuery))
    const results = settled.filter((item) => item !== null)
    progress.currentBreadth = results.length
    params.onProgress?.(progress)

    // Issue #1579: if every branch at this level failed (bad API key, offline
    // retriever, …), stop instead of endlessly generating follow-ups from empty
    // goals and learnings.
    if (results.length === 0) {
      logger.warning(`Deep research produced no successful query results at depth=${depth}; stopping descent.`)
      return {
        learnings: allLearnings,
        visitedUrls: [...allVisitedUrls],
        citations: allCitations,
        context: allContext,
        sources: allSources,
      }
    }

    for (const result of results) {
      allLearnings.push(...result.learnings)
      result.visitedUrls.forEach((url) => allVisitedUrls.add(url))
      Object.assign(allCitations, result.citations)
      if (result.context) {
        // Extend, not append: with source curation on, `context` is a list, and
        // appending it would nest a list inside the list.
        if (Array.isArray(result.context)) allContext.push(...result.context)
        else allContext.push(result.context)
      }
      if (result.sources.length > 0) allSources.push(...result.sources)

      // Continue deeper if needed.
      if (depth > 1) {
        const newBreadth = Math.max(2, Math.floor(breadth / 2))
        const newDepth = depth - 1
        progress.currentDepth += 1

        const nextQuery = `
                Previous research goal: ${result.researchGoal}
                Follow-up questions: ${result.followUpQuestions.join(' ')}
                `

        const deeper = await this.deepResearch({
          query: nextQuery,
          breadth: newBreadth,
          depth: newDepth,
          learnings: allLearnings,
          citations: allCitations,
          visitedUrls: allVisitedUrls,
          onProgress: params.onProgress,
        })

        allLearnings = deeper.learnings
        deeper.visitedUrls.forEach((url) => allVisitedUrls.add(url))
        Object.assign(allCitations, deeper.citations)
        if (deeper.context && deeper.context.length > 0) allContext.push(...deeper.context)
        if (deeper.sources && deeper.sources.length > 0) allSources.push(...deeper.sources)
      }
    }

    this.context.push(...allContext)
    this.researchSources.push(...allSources)

    const trimmedContext = trimContextToWordLimit(allContext)
    logger.info(`Trimmed context from ${allContext.length} items to ${trimmedContext.length} items to stay within word limit`)

    return {
      learnings: [...new Set(allLearnings)],
      visitedUrls: [...allVisitedUrls],
      citations: allCitations,
      context: trimmedContext,
      sources: allSources,
    }
  }

  /**
   * Run the whole deep-research process and produce the final report text.
   *
   * @param {object} [options] - run options.
   * @param {(progress: ResearchProgress) => void} [options.onProgress] - progress sink.
   * @param {(params: {query: string, learnings: string[], citations: Record<string,string>, context: Array<string|string[]>, sources: Array<object>}) => Promise<string>} [options.writeReport]
   *   report writer; required to produce output.
   * @returns {Promise<string>} the report.
   */
  async run(options = {}) {
    logger.info(`DEEP RESEARCH: Starting with breadth=${this.breadth}, depth=${this.depth}, concurrency=${this.concurrencyLimit}`)

    const followUpQuestions = await this.generateResearchPlan(this.deps.query)
    const answers = Array.from({ length: followUpQuestions.length }, () => 'Automatically proceeding with research')

    const qaPairs = followUpQuestions.map((question, index) => `Q: ${question}\nA: ${answers[index]}`)
    const combinedQuery = `
        Initial Query: ${this.deps.query}\nFollow - up Questions and Answers:\n
        ${qaPairs.join('\n')}`

    const results = await this.deepResearch({
      query: combinedQuery,
      breadth: this.breadth,
      depth: this.depth,
      onProgress: options.onProgress,
    })

    const finalContext = [results.learnings.join('\n'), ...results.context].filter((item) => String(item).trim() !== '')

    if (typeof options.writeReport !== 'function') {
      throw new Error('deepResearch.run: writeReport dependency is required')
    }
    return options.writeReport({
      query: this.deps.query,
      learnings: results.learnings,
      citations: results.citations,
      context: finalContext,
      sources: results.sources,
    })
  }
}

export { ReportType, ReportSource }
