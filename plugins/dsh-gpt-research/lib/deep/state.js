/**
 * Graph state and structured outputs for the two-layer deep-research agent.
 *
 * One-to-one port of `open_deep_research/state.py`: the five Pydantic models the
 * model returns as structured output (`ClarifyWithUser`, `ResearchQuestion`,
 * `ConductResearch`, `ResearchComplete`, `Summary`), the four graph states
 * (`AgentState`, `SupervisorState`, `ResearcherState`, `ResearcherOutputState`),
 * and the `override_reducer` merge rule.
 *
 * LangGraph holds state in `TypedDict` plus `Annotated[list, reducer]` and merges
 * each node's returned dict with the reducer. The state objects here are plain
 * classes with an explicit {@link applyUpdate} that reproduces the same merge:
 * `operator.add` for appended lists, and the `{type: 'override'}` escape hatch
 * that replaces instead of appending.
 *
 * @module @yf-river/dsh-gpt-research/deep/state
 */

/**
 * Merge an annotated list field.
 *
 * Mirrors `override_reducer` in the source: a value of the form
 * `{ type: 'override', value }` replaces the current list; anything else is
 * appended, which is what `Annotated[list, operator.add]` does.
 *
 * @param {unknown[]} current - the current field value.
 * @param {unknown} next - the node's returned value.
 * @returns {unknown[]} the merged list.
 */
export function overrideReducer(current, next) {
  if (next !== null && typeof next === 'object' && !Array.isArray(next) && next.type === 'override') {
    return Array.isArray(next.value) ? [...next.value] : []
  }
  if (Array.isArray(next)) return [...(Array.isArray(current) ? current : []), ...next]
  return Array.isArray(current) ? current : []
}

/**
 * Apply one node's update dict to a state object, using each field's reducer.
 *
 * LangGraph infers the reducer from the state schema; here the reducer set is
 * explicit. `researcher_messages` uses plain `operator.add` in the source, and
 * every `notes` / `raw_notes` / `supervisor_messages` field uses
 * `override_reducer`.
 *
 * @param {object} state - the state to update in place.
 * @param {Record<string, unknown>} update - the node's returned fields.
 * @returns {object} the same state, updated.
 */
export function applyUpdate(state, update) {
  const OVERRIDE = new Set(['supervisor_messages', 'notes', 'raw_notes', 'researcher_messages'])
  for (const [key, value] of Object.entries(update)) {
    if (OVERRIDE.has(key)) state[key] = overrideReducer(state[key], value)
    else state[key] = value
  }
  return state
}

/** Fields both graph states carry. */
const AGENT_FIELDS = () => ({
  /** Conversation with the user: the input messages plus our replies. */
  messages: [],
  /** Supervisor-only conversation (system prompt, brief, tool results). */
  supervisor_messages: [],
  /** The normalized research brief. */
  research_brief: '',
  /** Verbatim tool/AI output from each sub-researcher. */
  raw_notes: [],
  /** One compressed summary per completed sub-research task. */
  notes: [],
  /** The finished report. */
  final_report: '',
})

/**
 * Main agent state: the outer graph's state.
 * @param {object} [init] - initial fields.
 * @returns {object} a fresh agent state.
 */
export function createAgentState(init = {}) {
  return applyUpdate(AGENT_FIELDS(), init)
}

/**
 * Supervisor state: one instance per supervisor subgraph run.
 * @param {object} [init] - initial fields.
 * @returns {object} a fresh supervisor state.
 */
export function createSupervisorState(init = {}) {
  return applyUpdate({
    supervisor_messages: [],
    research_brief: '',
    notes: [],
    raw_notes: [],
    /** How many supervisor turns have run; the loop guard. */
    research_iterations: 0,
  }, init)
}

/**
 * Researcher state: one instance per delegated sub-research task.
 * @param {object} [init] - initial fields.
 * @returns {object} a fresh researcher state.
 */
export function createResearcherState(init = {}) {
  return applyUpdate({
    researcher_messages: [],
    /** How many tool-calling turns this researcher has run; the loop guard. */
    tool_call_iterations: 0,
    research_topic: '',
    compressed_research: '',
    raw_notes: [],
  }, init)
}

/** JSON Schema for `ClarifyWithUser`, sent to the model as a structured output contract. */
export const CLARIFY_WITH_USER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    need_clarification: {
      type: 'boolean',
      description: 'Whether the user needs to be asked a clarifying question.',
    },
    question: {
      type: 'string',
      description: 'A question to ask the user to clarify the report scope',
    },
    verification: {
      type: 'string',
      description: 'Verify message that we will start research after the user has provided the necessary information.',
    },
  },
  required: ['need_clarification', 'question', 'verification'],
  additionalProperties: false,
})

/** JSON Schema for `ResearchQuestion`. */
export const RESEARCH_QUESTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    research_brief: {
      type: 'string',
      description: 'A research question that will be used to guide the research.',
    },
  },
  required: ['research_brief'],
  additionalProperties: false,
})

/** JSON Schema for `Summary`, used by webpage summarization. */
export const SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    key_excerpts: { type: 'string' },
  },
  required: ['summary', 'key_excerpts'],
  additionalProperties: false,
})

/** JSON Schema for `ConductResearch`, the supervisor's delegation tool. */
export const CONDUCT_RESEARCH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    research_topic: {
      type: 'string',
      description: 'The topic to research. Should be a single topic, and should be described in high detail (at least a paragraph).',
    },
  },
  required: ['research_topic'],
  additionalProperties: false,
})

/** JSON Schema for `ResearchComplete`, an empty object by design. */
export const RESEARCH_COMPLETE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
})

/** JSON Schema for the `think_tool` reflection argument. */
export const THINK_TOOL_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    reflection: {
      type: 'string',
      description: 'Your detailed reflection on research progress, findings, gaps, and next steps',
    },
  },
  required: ['reflection'],
  additionalProperties: false,
})

/**
 * Extract notes from tool-call messages.
 *
 * Mirrors `get_notes_from_tool_calls`: every tool-role message's content, in
 * order. The supervisor's accumulated tool results ARE the notes when the
 * supervisor subgraph ends by iteration limit or by ResearchComplete.
 *
 * @param {Array<{role: string, content: unknown}>} messages - supervisor messages.
 * @returns {string[]} tool contents.
 */
export function getNotesFromToolCalls(messages) {
  return messages
    .filter((message) => message !== null && typeof message === 'object' && message.role === 'tool')
    .map((message) => String(message.content ?? ''))
}

/**
 * Today's date in the `%Y-%m-%d` form every prompt interpolates.
 * @param {Date} [now] - the clock.
 * @returns {string} the date.
 */
export function getTodayStr(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`
}
