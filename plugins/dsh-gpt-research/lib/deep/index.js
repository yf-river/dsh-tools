/**
 * The two-layer deep-research engine, as one call.
 *
 * Wraps the graph with the host seams so a caller passes services and a topic and
 * gets a report. This is the module the plugin's public surface re-exports; the
 * graph, state, tools, prompts and config stay separate files so each matches its
 * counterpart in `open_deep_research` one-for-one.
 *
 * @module @yf-river/dsh-gpt-research/deep
 */

import { createDeepConfig, parseDeepResearchConfig } from './config.js'
import { runDeepResearch } from './run.js'
import { createCompletionSeam, createSearchSeam } from './seams.js'

/**
 * Run the two-layer engine.
 *
 * @param {object} input - the request.
 * @param {string} input.topic - what to research.
 * @param {object} [input.config] - plugin config (camelCase keys accepted).
 * @param {object} input.llm - the host's `ctx.llm`.
 * @param {object} input.web - the host's `ctx.web`.
 * @param {{provider?: string, model?: string}} [input.route] - default model route.
 * @param {(event: object) => void} [input.onProgress] - progress sink.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<{ok: boolean, report: string, clarified: boolean, question: string, notes: string[]}>}
 *   the outcome; `clarified` means the run stopped to ask a question.
 */
export async function runDeep(input) {
  const pluginConfig = parseDeepResearchConfig(input.config ?? {})
  const config = createDeepConfig({
    ...pluginConfig,
    // The engine's four model roles all default to the caller's route; a caller
    // that wants a stronger supervisor can pass per-role models in `input.models`.
    research_model: input.models?.research ?? input.route?.model ?? '',
    compression_model: input.models?.compression ?? input.route?.model ?? '',
    final_report_model: input.models?.finalReport ?? input.route?.model ?? '',
    summarization_model: input.models?.summarization ?? input.route?.model ?? '',
  })

  const complete = createCompletionSeam(input.llm, input.route ?? {}, input.onWarn)
  const search = createSearchSeam(input.web)

  const result = await runDeepResearch({
    messages: [{ role: 'user', content: input.topic }],
    complete,
    search,
    config: { ...config, ...(input.route?.provider === undefined ? {} : { provider: input.route.provider }) },
    onProgress: input.onProgress,
    signal: input.signal,
  })

  return {
    ok: result.clarified ? false : result.finalReport !== '',
    report: result.finalReport,
    clarified: result.clarified,
    question: result.question,
    notes: result.notes,
  }
}

export { createDeepConfig, parseDeepResearchConfig } from './config.js'
export { runDeepResearch } from './run.js'
export { NODE } from './graph.js'
export { createCompletionSeam, createSearchSeam } from './seams.js'
