/**
 * Model-facing tools for the two-layer deep-research agent.
 *
 * One-to-one port of `open_deep_research/utils.py` for the tool definitions the
 * algorithm actually depends on: `think_tool`, plus the supervisor's
 * `ConductResearch` and `ResearchComplete`. In the source these are LangChain
 * `@tool` objects or Pydantic models passed to `bind_tools`; here they are plain
 * declarations plus a dispatcher, because the host's `ctx.llm` takes a tool table
 * and reports calls back as `tool-call` chunks.
 *
 * `tavily_search` is not ported: the search capability comes from the host's
 * `ctx.web` seam, which the caller passes in as `search`. The tool's *contract*
 * (queries in, summarized results out) is preserved by {@link createSearchTool}.
 *
 * @module @yf-river/dsh-gpt-research/deep/tools
 */

/**
 * `think_tool`: a no-op that records a reflection.
 *
 * Its whole value is the forced pause: the model must produce a reflection before
 * it is allowed to delegate or search again, and the tool result echoes the text
 * back so the reflection stays in context. Ported verbatim from the source,
 * including the `Reflection recorded:` prefix the prompts echo back.
 *
 * @param {{reflection: string}} args - the model's reflection.
 * @returns {string} the confirmation the model sees.
 */
export function thinkTool(args) {
  return `Reflection recorded: ${String(args?.reflection ?? '')}`
}

/** Declaration of `think_tool`, as the supervisor and researcher see it. */
export const THINK_TOOL = Object.freeze({
  name: 'think_tool',
  description: 'Strategic reflection tool for research planning',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      reflection: {
        type: 'string',
        description: 'Your detailed reflection on research progress, findings, gaps, and next steps',
      },
    },
    required: ['reflection'],
    additionalProperties: false,
  }),
})

/** Declaration of `ConductResearch`, the supervisor's delegation tool. */
export const CONDUCT_RESEARCH_TOOL = Object.freeze({
  name: 'ConductResearch',
  description: 'Call this tool to conduct research on a specific topic.',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      research_topic: {
        type: 'string',
        description: 'The topic to research. Should be a single topic, and should be described in high detail (at least a paragraph).',
      },
    },
    required: ['research_topic'],
    additionalProperties: false,
  }),
})

/** Declaration of `ResearchComplete`, the supervisor's termination signal. */
export const RESEARCH_COMPLETE_TOOL = Object.freeze({
  name: 'ResearchComplete',
  description: 'Call this tool to indicate that the research is complete.',
  parameters: Object.freeze({
    type: 'object',
    properties: {},
    additionalProperties: false,
  }),
})

/** The supervisor's complete tool table, in the source's order. */
export const SUPERVISOR_TOOLS = Object.freeze([CONDUCT_RESEARCH_TOOL, RESEARCH_COMPLETE_TOOL, THINK_TOOL])

/**
 * The search tool declaration for a researcher.
 *
 * The source's `tavily_search` takes a list of queries so the model can fan out in
 * one call; keeping that arity means the researcher prompt's "call these tools in
 * series or in parallel" instruction still means what it says.
 */
export const SEARCH_TOOL = Object.freeze({
  name: 'tavily_search',
  description: 'Fetch and summarize search results from a web search API.',
  parameters: Object.freeze({
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Search queries to execute.',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of results to return per query.',
      },
      topic: {
        type: 'string',
        enum: ['general', 'news', 'finance'],
        description: 'Topic filter for the search.',
      },
    },
    required: ['queries'],
    additionalProperties: false,
  }),
})

/** A researcher's tool table: search plus reflection, matching the source. */
export const RESEARCHER_TOOLS = Object.freeze([SEARCH_TOOL, THINK_TOOL])

/**
 * Group tool declarations by name for dispatch.
 * @param {ReadonlyArray<{name: string}>} tools - declarations.
 * @returns {Map<string, {name: string}>} lookup by name.
 */
export function toolsByName(tools) {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

/**
 * Read a tool call's arguments, tolerating a missing or malformed payload.
 *
 * Adapters report arguments as a JSON string. A parse failure yields `{}` so the
 * dispatcher can still answer the call with an error string instead of aborting
 * the whole loop, which is what `execute_tool_safely` buys the source.
 *
 * @param {string | Record<string, unknown> | undefined} raw - argument payload.
 * @returns {Record<string, unknown>} parsed arguments.
 */
export function parseToolArguments(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Format one search batch for the model.
 *
 * Mirrors `tavily_search`'s output: each unique URL once, tagged with the query
 * that found it, followed by its summary. Deduplication is the source's behavior
 * and matters because parallel queries overlap heavily.
 *
 * @param {Array<{query: string, results: Array<{url: string, title?: string, content?: string}>}>} batches
 *   one entry per query.
 * @returns {string} the formatted result text.
 */
export function formatSearchResults(batches) {
  const seen = new Set()
  const sections = []
  for (const batch of batches) {
    const lines = []
    for (const result of batch.results ?? []) {
      const url = String(result.url ?? '')
      if (url === '' || seen.has(url)) continue
      seen.add(url)
      lines.push(`<title>${String(result.title ?? '')}</title>\n<url>${url}</url>\n<content>${String(result.content ?? '')}</content>`)
    }
    if (lines.length > 0) sections.push(`Query: ${batch.query}\n\n${lines.join('\n\n')}`)
  }
  return sections.join('\n\n---\n\n')
}
