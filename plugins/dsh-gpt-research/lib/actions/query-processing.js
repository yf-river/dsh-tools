/**
 * Query planning.
 *
 * One-to-one port of `gpt_researcher/actions/query_processing.py`: the
 * sub-query normalization (four accepted shapes), the search call, sub-query
 * generation with its three-tier model fallback, and the outline planner with
 * its MCP short-circuit.
 *
 * Retriever dispatch differs by necessity: the source's `get_search_results`
 * instantiated a concrete retriever class and ran its blocking `search` in a
 * thread. The port takes a `search` function that returns a promise (see
 * `actions/retriever.js`), so the same call site works against `ctx.web`.
 *
 * @module @yf-river/dsh-gpt-research/actions/query-processing
 */

import { ReasoningEfforts } from '../config/providers.js'
import { PromptFamily } from '../prompts.js'
import { createChatCompletion } from '../utils/llm.js'
import { jsonRepairLoads } from '../utils/json-repair.js'

const logger = {
  warning: (...args) => console.warn(...args),
  info: (...args) => console.log(...args),
}

/**
 * Coerce a parsed LLM response into a flat list of query strings.
 *
 * `jsonRepairLoads` may return a list, a dict (`{"queries": [...]}`, a
 * `{"sub_queries": [...]}` alias, or a single `{"query": "..."}`), a bare string,
 * or throw when the model does not return clean JSON. Callers expect a
 * `string[]` and otherwise crash on iteration, so normalization happens here.
 *
 * @param {unknown} parsed - the parsed value.
 * @param {string} fallbackQuery - the query to use when nothing usable is parsed.
 * @returns {string[]} the queries.
 */
export function normalizeSubQueries(parsed, fallbackQuery) {
  let value = parsed

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    let matched = false
    for (const key of ['queries', 'sub_queries', 'subQueries', 'items']) {
      const candidate = value[key]
      if (Array.isArray(candidate)) {
        value = candidate
        matched = true
        break
      }
    }
    if (!matched) {
      // Single-query dict like {"query": "..."} or unrecognized shape.
      const single = value.query
      value = typeof single === 'string' ? [single] : []
    }
  }

  if (typeof value === 'string') {
    value = value.trim() !== '' ? [value] : []
  }

  if (!Array.isArray(value)) value = []

  const queries = value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())

  if (queries.length === 0 && String(fallbackQuery).trim() !== '') {
    return [String(fallbackQuery).trim()]
  }
  return queries
}

/**
 * Get web search results for one query.
 *
 * @param {string} query - the search query.
 * @param {Function} retriever - retriever class (`new retriever(query, {...})`).
 * @param {string[]} [queryDomains] - domains to restrict to.
 * @param {object | null} [researcher] - calling researcher, for context-aware retrievers.
 * @param {number | null} [maxResults] - result cap.
 * @param {Function | null} [search] - the search implementation the retriever wraps.
 * @returns {Promise<Array<Record<string, unknown>>>} search results.
 */
export async function getSearchResults(query, retriever, queryDomains = [], researcher = null, maxResults = null, search = null) {
  const searchRetriever = new retriever(query, {
    queryDomains,
    researcher,
    search: search ?? researcher?.search,
  })

  const searchKwargs = maxResults === null ? {} : { max_results: maxResults }
  return await searchRetriever.search(searchKwargs)
}

/**
 * Generate sub-queries with the configured strategic model.
 *
 * The source's three attempts are reproduced exactly: first with no explicit
 * token limit, then with `strategic_token_limit`, then falling back to the smart
 * model with its own limit and temperature. The final failure propagates.
 *
 * @param {string} query - the original query.
 * @param {string} parentQuery - the parent query.
 * @param {string} reportType - report type value.
 * @param {Array<Record<string, unknown>>} context - initial search results.
 * @param {object} cfg - resolved config.
 * @param {Function | null} [costCallback] - cost sink.
 * @param {object} [promptFamily] - the prompt family instance.
 * @param {object} options - required seams.
 * @param {object} options.provider - the model-call seam.
 * @param {Record<string, string|undefined>} [options.env] - environment map.
 * @param {Date} [options.now] - clock for the date line.
 * @returns {Promise<string[]>} sub-queries.
 * @throws {Error} when all three attempts fail.
 */
export async function generateSubQueries(
  query,
  parentQuery,
  reportType,
  context,
  cfg,
  costCallback = null,
  promptFamily = PromptFamily,
  options = {},
) {
  const family = promptFamily ?? PromptFamily
  const genQueriesPrompt = family.generate_search_queries_prompt(
    query,
    parentQuery,
    reportType,
    cfg.max_iterations || 3,
    context,
    options.now,
  )

  let response
  try {
    response = await createChatCompletion({
      model: cfg.strategic_llm_model,
      messages: [{ role: 'user', content: genQueriesPrompt }],
      llmProvider: cfg.strategic_llm_provider,
      maxTokens: null,
      llmKwargs: cfg.llm_kwargs,
      reasoningEffort: ReasoningEfforts.Medium,
      costCallback,
      provider: options.provider,
      env: options.env,
    })
  } catch (error) {
    logger.warning(`Error with strategic LLM: ${error?.message ?? error}. Retrying with max_tokens=${cfg.strategic_token_limit}.`)
    logger.warning('See https://github.com/assafelovic/gpt-researcher/issues/1022')
    try {
      response = await createChatCompletion({
        model: cfg.strategic_llm_model,
        messages: [{ role: 'user', content: genQueriesPrompt }],
        maxTokens: cfg.strategic_token_limit,
        llmProvider: cfg.strategic_llm_provider,
        llmKwargs: cfg.llm_kwargs,
        costCallback,
        provider: options.provider,
        env: options.env,
      })
      logger.warning(`Retrying with max_tokens=${cfg.strategic_token_limit} successful.`)
    } catch (retryError) {
      logger.warning(`Retrying with max_tokens=${cfg.strategic_token_limit} failed.`)
      logger.warning(`Error with strategic LLM: ${retryError?.message ?? retryError}. Falling back to smart LLM.`)
      response = await createChatCompletion({
        model: cfg.smart_llm_model,
        messages: [{ role: 'user', content: genQueriesPrompt }],
        temperature: cfg.temperature,
        maxTokens: cfg.smart_token_limit,
        llmProvider: cfg.smart_llm_provider,
        llmKwargs: cfg.llm_kwargs,
        costCallback,
        provider: options.provider,
        env: options.env,
      })
    }
  }

  let parsed
  try {
    parsed = jsonRepairLoads(response)
  } catch {
    parsed = null
  }
  return normalizeSubQueries(parsed, query)
}

/**
 * Plan the research outline by generating sub-queries.
 *
 * Kept from the source: when MCP is the only retriever, sub-query generation is
 * skipped and the original query is returned, so no extra search rounds run.
 *
 * @param {string} query - original query.
 * @param {Array<Record<string, unknown>>} searchResults - initial search results.
 * @param {string} agentRolePrompt - agent role prompt.
 * @param {object} cfg - resolved config.
 * @param {string} parentQuery - parent query.
 * @param {string} reportType - report type value.
 * @param {Function | null} [costCallback] - cost sink.
 * @param {string[]} [retrieverNames] - names of the retrievers in use.
 * @param {object} [options] - seams forwarded to {@link generateSubQueries}.
 * @returns {Promise<string[]>} sub-queries.
 */
export async function planResearchOutline(
  query,
  searchResults,
  agentRolePrompt,
  cfg,
  parentQuery,
  reportType,
  costCallback = null,
  retrieverNames = [],
  options = {},
) {
  if ((retrieverNames ?? []).some((name) => name === 'mcp' || name === 'MCPRetriever')) {
    const mcpOnly = retrieverNames.length === 1
    if (mcpOnly) {
      logger.info('Using MCP retriever only - skipping sub-query generation')
      return [query]
    }
    logger.info('Using MCP with other retrievers - generating sub-queries for non-MCP retrievers')
  }

  return generateSubQueries(
    query,
    parentQuery,
    reportType,
    searchResults,
    cfg,
    costCallback,
    options.promptFamily ?? PromptFamily,
    options,
  )
}
