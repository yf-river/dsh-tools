/**
 * The two-layer research graph.
 *
 * One-to-one port of `open_deep_research/deep_researcher.py`. The source is a
 * LangGraph `StateGraph` with two compiled subgraphs; this is the same graph as
 * explicit async functions returning the next node's name, because the host has no
 * LangGraph and the graph is small and fixed.
 *
 * Node-for-node correspondence:
 *
 *   clarify_with_user → write_research_brief → [supervisor ⇄ supervisor_tools] → final_report_generation
 *                                                    ↓ ConductResearch (parallel)
 *                                              [researcher ⇄ researcher_tools] → compress_research
 *
 * Every termination condition is preserved: the supervisor stops on
 * `ResearchComplete`, on a turn with no tool calls, or after
 * `max_researcher_iterations`; a researcher stops on `ResearchComplete` or after
 * `max_react_tool_calls`. That adaptivity is the whole point — the loop count is a
 * guardrail, and the model's own completion signal is the primary exit.
 *
 * Three substitutions, each because the host has no LangGraph or no LangChain:
 * `Command[Literal[...]]` → a returned node name; `RunnableConfig` → a plain
 * arguments object; `bind_tools` → the host's tool table. The algorithm is
 * unchanged.
 *
 * @module @yf-river/dsh-gpt-research/deep/graph
 */

import { getTodayStr, applyUpdate, getNotesFromToolCalls } from './state.js'
import {
  formatPrompt,
  clarify_with_user_instructions,
  transform_messages_into_research_topic_prompt,
  lead_researcher_prompt,
  research_system_prompt,
  compress_research_system_prompt,
  compress_research_simple_human_message,
  final_report_generation_prompt,
} from './prompts.js'
import {
  SUPERVISOR_TOOLS,
  RESEARCHER_TOOLS,
  CONDUCT_RESEARCH_TOOL,
  THINK_TOOL,
  thinkTool,
  parseToolArguments,
  formatSearchResults,
} from './tools.js'

/** The supervisor subgraph's own entry node, distinct from the outer graph's node of the same role. */
export const SUPERVISOR_NODE = 'supervisor'

/** Node names, mirroring the source's graph nodes. */
export const NODE = Object.freeze({
  CLARIFY: 'clarify_with_user',
  BRIEF: 'write_research_brief',
  SUPERVISOR: 'research_supervisor',
  REPORT: 'final_report_generation',
  END: '__end__',
})

/**
 * Create the graph's node functions bound to one model/seam bundle.
 *
 * @param {object} deps - resolved dependencies.
 * @param {(messages: object[], options: object) => Promise<{text: string, toolCalls: Array<{id: string, name: string, arguments: string}>}>} deps.complete
 *   one model call with an optional tool table.
 * @param {(queries: string[], options: object) => Promise<Array<{query: string, results: object[]}>>} deps.search
 *   batch web search, batched per query.
 * @param {object} deps.config - a `createDeepConfig` result.
 * @param {(event: object) => void} [deps.onProgress] - progress sink.
 * @returns {object} the node functions, keyed by node name.
 */
export function createGraphNodes(deps) {
  const { complete, search, config } = deps
  const emit = (event) => {
    try {
      deps.onProgress?.(event)
    } catch {
      // Progress is advisory; a failing sink must not break a run.
    }
  }
  const today = () => getTodayStr(config.now())

  /**
   * Ask the model to return a JSON object, with the source's retry count.
   *
   * `.with_retry(stop_after_attempt=max_structured_output_retries)` in the source
   * covers both transport errors and unparseable payloads; both are retried here.
   */
  async function structured(prompt, schema, role) {
    const attempts = config.max_structured_output_retries
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await complete(
          [{ role: 'user', content: prompt }],
          { model: config[role], maxTokens: config[`${role}_max_tokens`], responseSchema: schema },
        )
        const parsed = extractJsonObject(response.text)
        if (parsed !== undefined) return parsed
        lastError = new Error(`structured output was not valid JSON: ${truncate(response.text, 160)}`)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('structured output failed')
  }

  return {
    /**
     * Ask the user a clarifying question when the scope is genuinely unclear.
     *
     * Ported from `clarify_with_user`: skipped when clarification is disabled,
     * ends the graph with the question when needed, otherwise proceeds and records
     * the verification message.
     */
    async clarifyWithUser(state) {
      if (!config.allow_clarification) return { goto: NODE.BRIEF, update: {} }
      emit({ kind: 'phase', label: '判断是否需要澄清…' })
      const prompt = formatPrompt(clarify_with_user_instructions, {
        messages: bufferString(state.messages),
        date: today(),
      })
      const response = await structured(prompt, CLARIFY_SCHEMA, 'research_model')
      if (response.need_clarification === true) {
        return {
          goto: NODE.END,
          update: { messages: [{ role: 'assistant', content: String(response.question ?? '') }] },
        }
      }
      return {
        goto: NODE.BRIEF,
        update: { messages: [{ role: 'assistant', content: String(response.verification ?? '') }] },
      }
    },

    /**
     * Turn the conversation into a normalized research brief.
     *
     * Ported from `write_research_brief`: one structured call produces
     * `research_brief`, then the supervisor's conversation is seeded with the lead
     * prompt and the brief. The `override` on `supervisor_messages` is the
     * source's `{"type": "override"}` payload.
     */
    async writeResearchBrief(state) {
      emit({ kind: 'phase', label: '拟定研究简报…' })
      const prompt = formatPrompt(transform_messages_into_research_topic_prompt, {
        messages: bufferString(state.messages),
        date: today(),
      })
      const response = await structured(prompt, BRIEF_SCHEMA, 'research_model')
      const brief = String(response.research_brief ?? '')
      return {
        goto: NODE.SUPERVISOR,
        update: {
          research_brief: brief,
          supervisor_messages: {
            type: 'override',
            value: [
              {
                role: 'system',
                content: formatPrompt(lead_researcher_prompt, {
                  date: today(),
                  max_concurrent_research_units: config.max_concurrent_research_units,
                  max_researcher_iterations: config.max_researcher_iterations,
                }),
              },
              { role: 'user', content: brief },
            ],
          },
        },
      }
    },

    /**
     * One supervisor turn: decide what to research next, or call it done.
     *
     * Ported from `supervisor`. The tool table is the source's three tools; the
     * iteration counter increments here, before the tools run, exactly as the
     * source does.
     */
    async supervisor(state) {
      const iteration = (state.research_iterations ?? 0) + 1
      emit({ kind: 'supervisor', label: `第 ${iteration} 轮：规划下一步`, iteration })
      const response = await complete(state.supervisor_messages, {
        model: config.research_model,
        maxTokens: config.research_model_max_tokens,
        tools: SUPERVISOR_TOOLS,
      })
      return {
        goto: 'supervisor_tools',
        update: {
          supervisor_messages: [{
            role: 'assistant',
            content: response.text,
            toolCalls: response.toolCalls,
          }],
          research_iterations: iteration,
        },
      }
    },

    /**
     * Execute the supervisor's calls, delegating research in parallel.
     *
     * Ported from `supervisor_tools`. The three exit conditions are the source's:
     * over the iteration cap, no tool calls at all, or `ResearchComplete`
     * anywhere in the batch. Parallelism is capped by
     * `max_concurrent_research_units`, and overflow calls receive the source's
     * error string verbatim so the model learns the limit.
     */
    async supervisorTools(state, runResearcher) {
      const messages = state.supervisor_messages ?? []
      const latest = messages.at(-1)
      const calls = Array.isArray(latest?.toolCalls) ? latest.toolCalls : []
      const iterations = state.research_iterations ?? 0

      const exceeded = iterations > config.max_researcher_iterations
      const noToolCalls = calls.length === 0
      const complete = calls.some((call) => call.name === 'ResearchComplete')
      if (exceeded || noToolCalls || complete) {
        emit({ kind: 'supervisor', label: '研究阶段结束，开始成稿' })
        return {
          goto: NODE.END,
          update: { notes: getNotesFromToolCalls(messages), research_brief: state.research_brief ?? '' },
        }
      }

      const toolMessages = []
      for (const call of calls.filter((candidate) => candidate.name === 'think_tool')) {
        const args = parseToolArguments(call.arguments)
        toolMessages.push({
          role: 'tool',
          name: 'think_tool',
          toolCallId: call.id,
          content: thinkTool(args),
        })
      }

      const delegations = calls.filter((candidate) => candidate.name === CONDUCT_RESEARCH_TOOL.name)
      if (delegations.length > 0) {
        const allowed = delegations.slice(0, config.max_concurrent_research_units)
        const overflow = delegations.slice(config.max_concurrent_research_units)
        emit({ kind: 'supervisor', label: `派发 ${allowed.length} 个研究任务`, tasks: allowed.length })

        // `asyncio.gather` with no exception isolation: one failing branch must not
        // discard the others' findings, so each is settled independently and a
        // failure becomes that branch's tool result.
        const settled = await Promise.allSettled(allowed.map(async (call) => {
          const topic = String(parseToolArguments(call.arguments).research_topic ?? '')
          return runResearcher(topic)
        }))

        const results = []
        settled.forEach((outcome, index) => {
          const call = allowed[index]
          const observation = outcome.status === 'fulfilled'
            ? outcome.value
            : { compressed_research: `Error synthesizing research report: ${outcome.reason?.message ?? outcome.reason}`, raw_notes: [] }
          results.push(observation)
          toolMessages.push({
            role: 'tool',
            name: call.name,
            toolCallId: call.id,
            content: observation.compressed_research ?? 'Error synthesizing research report: Maximum retries exceeded',
          })
        })

        for (const overflowCall of overflow) {
          toolMessages.push({
            role: 'tool',
            name: 'ConductResearch',
            toolCallId: overflowCall.id,
            content: `Error: Did not run this research as you have already exceeded the maximum number of concurrent research units. Please try again with ${config.max_concurrent_research_units} or fewer research units.`,
          })
        }

        const rawNotes = results.map((item) => (item.raw_notes ?? []).join('\n')).join('\n')
        const update = { supervisor_messages: answeredFor(calls, toolMessages) }
        if (rawNotes !== '') update.raw_notes = [rawNotes]
        return { goto: SUPERVISOR_NODE, update }
      }

      return { goto: SUPERVISOR_NODE, update: { supervisor_messages: answeredFor(calls, toolMessages) } }
    },

    /**
     * One researcher turn: search, reflect, or signal completion.
     *
     * Ported from `researcher`. The researcher's system prompt is rebuilt per turn
     * because the source formats `mcp_prompt` and the date into it each time.
     */
    async researcher(state) {
      const iteration = (state.tool_call_iterations ?? 0) + 1
      emit({ kind: 'researcher', label: `子研究第 ${iteration} 步：${truncate(state.research_topic, 40)}`, iteration })
      const messages = [
        { role: 'system', content: formatPrompt(research_system_prompt, { date: today(), mcp_prompt: '' }) },
        ...(state.researcher_messages ?? []),
      ]
      const response = await complete(messages, {
        model: config.research_model,
        maxTokens: config.research_model_max_tokens,
        tools: RESEARCHER_TOOLS,
      })
      return {
        goto: 'researcher_tools',
        update: {
          researcher_messages: [{ role: 'assistant', content: response.text, toolCalls: response.toolCalls }],
          tool_call_iterations: iteration,
        },
      }
    },

    /**
     * Execute a researcher's calls, then decide whether to loop or compress.
     *
     * Ported from `researcher_tools`. Exit happens before the tool calls when the
     * model asked for nothing, and after them when it hit the iteration cap or
     * asked for `ResearchComplete` — both checks exist in the source and both
     * matter: the first ends a researcher that simply stopped calling tools.
     */
    async researcherTools(state) {
      const messages = state.researcher_messages ?? []
      const latest = messages.at(-1)
      const calls = Array.isArray(latest?.toolCalls) ? latest.toolCalls : []
      if (calls.length === 0) return { goto: 'compress_research', update: {} }

      const outputs = answeredFor(calls, await Promise.all(calls.map(async (call) => ({
        role: 'tool',
        name: call.name,
        toolCallId: call.id,
        content: await executeToolSafely(call, { search, config }),
      }))))

      const exceeded = (state.tool_call_iterations ?? 0) >= config.max_react_tool_calls
      const complete = calls.some((call) => call.name === 'ResearchComplete')
      if (exceeded || complete) {
        return { goto: 'compress_research', update: { researcher_messages: outputs } }
      }
      return { goto: 'researcher', update: { researcher_messages: outputs } }
    },

    /**
     * Distill a researcher's whole conversation into one note.
     *
     * Ported from `compress_research`, including the three-attempt retry and the
     * `raw_notes` capture from every tool/AI message. This step is what lets the
     * graph drop the source gpt-researcher's 25k-word context cap: the supervisor
     * only ever sees these notes.
     */
    async compressResearch(state) {
      emit({ kind: 'phase', label: `压缩子研究：${truncate(state.research_topic, 30)}` })
      const conversation = [...(state.researcher_messages ?? []), {
        role: 'user',
        content: compress_research_simple_human_message,
      }]
      const rawNotes = conversation
        .filter((message) => message.role === 'tool' || message.role === 'assistant')
        .map((message) => String(message.content ?? ''))
        .join('\n')

      let attempts = 0
      while (attempts < 3) {
        try {
          const response = await complete(
            [
              { role: 'system', content: formatPrompt(compress_research_system_prompt, { date: today() }) },
              ...conversation,
            ],
            { model: config.compression_model, maxTokens: config.compression_model_max_tokens },
          )
          return {
            update: { compressed_research: String(response.text ?? ''), raw_notes: [rawNotes] },
          }
        } catch (error) {
          attempts += 1
          if (attempts >= 3) {
            return {
              update: {
                compressed_research: `Error synthesizing research report: Maximum retries exceeded (${error?.message ?? error})`,
                raw_notes: [rawNotes],
              },
            }
          }
        }
      }
      return { update: { compressed_research: 'Error synthesizing research report: Maximum retries exceeded', raw_notes: [rawNotes] } }
    },

    /**
     * Write the final report from the accumulated notes.
     *
     * Ported from `final_report_generation`. The source's token-limit retry loop
     * truncates `findings` by 10% per retry; that is preserved, but the model
     * context length comes from config rather than a provider lookup table, which
     * the host does not have.
     */
    async finalReportGeneration(state) {
      emit({ kind: 'phase', label: '撰写报告…' })
      const notes = state.notes ?? []
      let findings = notes.join('\n')
      let retry = 0
      let limit
      while (retry <= 3) {
        try {
          const prompt = formatPrompt(final_report_generation_prompt, {
            research_brief: state.research_brief ?? '',
            messages: bufferString(state.messages),
            findings,
            date: today(),
          })
          // The upstream prompt states the `[Title](URL)` rule in the middle of
          // several thousand words of formatting guidance, and the notes carry
          // bare URLs, so a fast model drops the links. Repeating the rule last —
          // and naming the shape — is what actually makes the citations appear;
          // measured: 29 URLs in the notes produced 0 in the report without this.
          + '\n\nIMPORTANT: Every factual claim must cite its source as a Markdown link '
          + '`[Title](https://full-url)`, using the URLs exactly as they appear in the findings above. '
          + 'End the report with a `### Sources` section listing every cited source as `[n] Title: URL`. '
          + 'A report with no links fails the reader\'s ability to verify it.'
          const response = await complete([{ role: 'user', content: prompt }], {
            model: config.final_report_model,
            maxTokens: config.final_report_model_max_tokens,
          })
          return { update: { final_report: String(response.text ?? ''), notes: { type: 'override', value: [] } } }
        } catch (error) {
          retry += 1
          if (!isTokenLimitExceeded(error)) {
            return {
              update: {
                final_report: `Error generating final report: ${error?.message ?? error}`,
                notes: { type: 'override', value: [] },
              },
            }
          }
          limit = limit === undefined ? config.max_content_length : Math.trunc(limit * 0.9)
          findings = findings.slice(0, limit)
        }
      }
      return {
        update: {
          final_report: 'Error generating final report: Maximum retries exceeded',
          notes: { type: 'override', value: [] },
        },
      }
    },
  }
}

/**
 * Guarantee one tool result per tool call.
 *
 * Providers reject an assistant turn whose tool calls are not all answered, and a
 * model may emit several calls in one turn (e.g. `think_tool` plus three
 * `ConductResearch`). Any call left without a result — including
 * `ResearchComplete`, whose result the graph never builds because it ends the
 * loop — is answered here with a neutral acknowledgment so the next request stays
 * valid. The source relies on LangGraph to pair these; without that runtime the
 * pairing has to be explicit.
 *
 * @param {Array<{id: string, name: string}>} calls - the turn's tool calls.
 * @param {Array<{toolCallId?: string}>} messages - results built so far.
 * @returns {Array<object>} results including any filler, in call order.
 */
function answeredFor(calls, messages) {
  const answered = new Set(messages.map((message) => message.toolCallId))
  const filler = calls
    .filter((call) => !answered.has(call.id))
    .map((call) => ({
      role: 'tool',
      name: call.name,
      toolCallId: call.id,
      content: call.name === 'ResearchComplete' ? 'Research marked complete.' : 'No result recorded.',
    }))
  return [...messages, ...filler]
}

/**
 * Run one tool call, converting a failure into the result string the model sees.
 *
 * Ported from `execute_tool_safely`: the model is told the error and continues,
 * rather than the loop dying on one bad query.
 *
 * @param {{name: string, arguments: string}} call - the tool call.
 * @param {{search: Function, config: object}} deps - search seam and config.
 * @returns {Promise<string>} the tool result text.
 */
async function executeToolSafely(call, deps) {
  try {
    if (call.name === THINK_TOOL.name) return thinkTool(parseToolArguments(call.arguments))
    if (call.name === 'tavily_search') {
      const args = parseToolArguments(call.arguments)
      const queries = Array.isArray(args.queries) ? args.queries.map(String) : []
      if (queries.length === 0) return 'Error executing tool: no queries were provided'
      const batches = await deps.search(queries, {
        maxResults: Number.isInteger(args.max_results) ? args.max_results : 5,
        topic: typeof args.topic === 'string' ? args.topic : 'general',
      })
      return formatSearchResults(batches)
    }
    return `Error executing tool: unknown tool "${call.name}"`
  } catch (error) {
    return `Error executing tool: ${error?.message ?? error}`
  }
}

/**
 * Whether an error looks like a context-length overflow.
 *
 * The source checks provider-specific strings through `is_token_limit_exceeded`;
 * the host normalizes adapter errors, so the same idea is applied to the message.
 *
 * @param {unknown} error - the failure.
 * @returns {boolean} `true` when truncating the findings may help.
 */
function isTokenLimitExceeded(error) {
  const message = String(error?.message ?? error).toLowerCase()
  return message.includes('token') && (message.includes('limit') || message.includes('exceed') || message.includes('context'))
}

/**
 * Render messages the way LangChain's `get_buffer_string` does.
 *
 * The prompts embed the conversation, and the source feeds it through this exact
 * format (`Human: …`, `AI: …`). Keeping the labels means the prompts read the same
 * as upstream.
 *
 * @param {Array<{role: string, content: unknown}>} messages - conversation.
 * @returns {string} the flattened transcript.
 */
export function bufferString(messages) {
  const label = (role) => role === 'user' ? 'Human' : role === 'assistant' ? 'AI' : role === 'system' ? 'System' : 'Tool'
  return (messages ?? [])
    .map((message) => `${label(message.role)}: ${String(message.content ?? '')}`)
    .join('\n')
}

/**
 * Pull the first JSON object out of a model reply.
 *
 * `.with_structured_output` makes providers return bare JSON; a weaker model may
 * wrap it in a fence or a sentence, so the same fallback the gpt-researcher family
 * already uses applies here.
 *
 * @param {string} text - the reply.
 * @returns {Record<string, unknown> | undefined} the parsed object.
 */
export function extractJsonObject(text) {
  const source = String(text ?? '')
  const candidates = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  if (fenced !== null) candidates.push(fenced[1])
  const braced = /\{[\s\S]*\}/.exec(source)
  if (braced !== null) candidates.push(braced[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/** Shorten text for a progress line. */
function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Schema for `ClarifyWithUser`, kept local to avoid importing state for one shape. */
const CLARIFY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    need_clarification: { type: 'boolean' },
    question: { type: 'string' },
    verification: { type: 'string' },
  },
  required: ['need_clarification', 'question', 'verification'],
  additionalProperties: false,
})

/** Schema for `ResearchQuestion`. */
const BRIEF_SCHEMA = Object.freeze({
  type: 'object',
  properties: { research_brief: { type: 'string' } },
  required: ['research_brief'],
  additionalProperties: false,
})

export { applyUpdate }
