/**
 * Configuration for the two-layer deep-research agent.
 *
 * One-to-one port of `open_deep_research/configuration.py`, minus the fields that
 * only exist because the source ships as a LangGraph Platform deployment: the
 * `x_oap_ui_config` presentation metadata, the MCP server block, and the
 * per-provider API-key lookup. Those describe how the hosted product renders and
 * authenticates settings, not how the algorithm behaves.
 *
 * Model selection is split by role exactly as in the source — `research_model`
 * drives the supervisor and both loop nodes, `compression_model` distills each
 * sub-researcher, `final_report_model` writes the report, `summarization_model`
 * condenses long pages — because the roles have very different call volumes.
 *
 * @module @yf-river/dsh-gpt-research/deep/config
 */

/** Defaults copied field by field from `configuration.py`. */
export const DEEP_RESEARCH_DEFAULTS = Object.freeze({
  max_structured_output_retries: 3,
  allow_clarification: true,
  max_concurrent_research_units: 5,
  max_researcher_iterations: 6,
  max_react_tool_calls: 10,
  summarization_model_max_tokens: 8192,
  max_content_length: 50000,
  research_model_max_tokens: 10000,
  compression_model_max_tokens: 8192,
  final_report_model_max_tokens: 10000,
})

/**
 * The shape every node reads.
 *
 * Kept as a plain object with documented fields rather than a validator: the
 * caller builds it once from plugin config, and every field is an operator knob
 * whose bounds are stated here rather than enforced at runtime.
 */
export function createDeepConfig(overrides = {}) {
  const config = { ...DEEP_RESEARCH_DEFAULTS }
  /** Per-role model routes, filled by the caller from the host's model settings. */
  config.research_model = ''
  config.compression_model = ''
  config.final_report_model = ''
  config.summarization_model = ''
  /** Output language for the final report; the prompts only speak of "same as the user". */
  config.language = 'chinese'
  /** Injectable clock so prompt dates are testable. */
  config.now = () => new Date()

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) config[key] = value
  }

  // Bounds from the source's slider metadata, enforced here because a value past
  // them would make the loop unable to terminate or exceed the host's budget.
  config.max_researcher_iterations = clamp(config.max_researcher_iterations, 1, 10)
  config.max_react_tool_calls = clamp(config.max_react_tool_calls, 1, 30)
  config.max_concurrent_research_units = clamp(config.max_concurrent_research_units, 1, 20)
  config.max_structured_output_retries = clamp(config.max_structured_output_retries, 1, 10)
  config.max_content_length = clamp(config.max_content_length, 1000, 200000)

  return config
}

/**
 * Clamp an integer into a closed range.
 * @param {number} value - candidate.
 * @param {number} low - minimum.
 * @param {number} high - maximum.
 * @returns {number} the clamped integer.
 */
function clamp(value, low, high) {
  const number = Number.isFinite(value) ? Math.trunc(value) : low
  return Math.min(Math.max(number, low), high)
}

/**
 * Validate host-facing plugin config.
 *
 * The plugin has no schema library, so this is a hand-written check with the same
 * contract: unknown keys are rejected (the source's `.strict()`), each bounded
 * integer is range-checked, and absent fields take the source defaults. A bad
 * value throws here, at load, rather than silently clamping mid-run.
 *
 * @param {Record<string, unknown>} input - raw plugin config.
 * @returns {object} normalized config with camelCase fields.
 * @throws {TypeError} when a field is unknown or out of range.
 */
export function parseDeepResearchConfig(input = {}) {
  const KNOWN = {
    allow_clarification: 'boolean',
    max_concurrent_research_units: [1, 20],
    max_researcher_iterations: [1, 10],
    max_react_tool_calls: [1, 30],
    max_content_length: [1000, 200000],
    language: 'string',
  }
  // Keys are snake_case to match `createDeepConfig` and the upstream field names,
  // so a value read here is used verbatim by every node.
  const out = {
    allow_clarification: DEEP_RESEARCH_DEFAULTS.allow_clarification,
    max_concurrent_research_units: DEEP_RESEARCH_DEFAULTS.max_concurrent_research_units,
    max_researcher_iterations: DEEP_RESEARCH_DEFAULTS.max_researcher_iterations,
    max_react_tool_calls: DEEP_RESEARCH_DEFAULTS.max_react_tool_calls,
    max_content_length: DEEP_RESEARCH_DEFAULTS.max_content_length,
    language: 'chinese',
  }
  for (const [key, value] of Object.entries(input ?? {})) {
    const rule = KNOWN[key]
    if (rule === undefined) throw new TypeError(`deep research config: unknown field "${key}"`)
    if (rule === 'boolean') {
      if (typeof value !== 'boolean') throw new TypeError(`deep research config: "${key}" must be a boolean`)
      out[key] = value
    } else if (rule === 'string') {
      if (typeof value !== 'string') throw new TypeError(`deep research config: "${key}" must be a string`)
      out[key] = value
    } else {
      if (!Number.isInteger(value)) throw new TypeError(`deep research config: "${key}" must be an integer`)
      const [low, high] = rule
      if (value < low || value > high) {
        throw new RangeError(`deep research config: "${key}" must be between ${low} and ${high}`)
      }
      out[key] = value
    }
  }
  return out
}
