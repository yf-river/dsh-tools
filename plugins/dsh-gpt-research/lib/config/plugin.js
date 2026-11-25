/**
 * Plugin configuration.
 *
 * Two layers meet here:
 *
 * 1. The **host-facing** knobs a deployment sets in `cordis.patch.yml`
 *    (`breadth`, `depth`, `concurrency`, timeouts, language, report format).
 *    These are validated at load, because a bad value that surfaces mid-run
 *    wastes a whole research call.
 * 2. The **ported** GPT Researcher `Config`, which owns 43 keys and reads the
 *    environment. {@link toEnv} maps the host knobs onto the environment names
 *    that config reads, so there is exactly one place each value can come from
 *    and the ported code never grows a second defaulting path.
 *
 * @module @yf-river/dsh-gpt-research/config/plugin
 */

import { WebRetriever } from '../actions/retriever.js'

/** Effective defaults. `breadth`/`depth`/`concurrency` match `DEEP_RESEARCH_*`. */
export const DEFAULT_CONFIG = Object.freeze({
  // Defaults are the interactive budget, not the source's CLI defaults.
  // Measured on the test profile: breadth=2/depth=1 completes in ~130 s with 10
  // model calls; breadth=3/depth=2 expands to 25 sub-queries and 40+ calls and
  // had not finished after 16 minutes. A slash command runs inside a live
  // session, so minutes matter here in a way they do not for a CLI batch run.
  breadth: 2,
  depth: 1,
  concurrency: 4,
  maxSourcesPerQuery: 5,
  compressionThreshold: 8000,
  maxResultsPerQuery: 10,
  language: 'chinese',
  reportFormat: 'APA',
  minReportWords: 1200,
  curateSources: false,
  maxSubtopics: 3,
  maxIterations: 3,
  provider: undefined,
  model: undefined,
  searchTimeoutMs: 20000,
  fetchTimeoutMs: 30000,
  toolTimeoutMs: 600000,
})

/** Inclusive bounds per numeric field. */
const BOUNDS = Object.freeze({
  breadth: [1, 10],
  depth: [1, 4],
  concurrency: [1, 8],
  maxSourcesPerQuery: [1, 30],
  compressionThreshold: [0, 200000],
  maxResultsPerQuery: [1, 50],
  minReportWords: [0, 10000],
  maxSubtopics: [1, 20],
  maxIterations: [1, 10],
  searchTimeoutMs: [1000, 120000],
  fetchTimeoutMs: [1000, 180000],
  toolTimeoutMs: [10000, 3600000],
})

/**
 * Validate and freeze the effective configuration.
 *
 * A bad value throws at load rather than degrading silently mid-run.
 *
 * @param {Record<string, unknown>} [raw] - the patch row's `config`.
 * @returns {Readonly<typeof DEFAULT_CONFIG & {retrievers: Function[]}>} resolved configuration.
 * @throws {Error} when a numeric field is out of bounds or a value has the wrong type.
 */
export function resolveConfig(raw = {}) {
  const resolved = { ...DEFAULT_CONFIG }
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`dsh-gpt-research: config.${key} must be a finite number, got ${String(value)}`)
    }
    const integer = Math.trunc(value)
    if (integer < min || integer > max) {
      throw new Error(`dsh-gpt-research: config.${key} must be within [${min}, ${max}], got ${integer}`)
    }
    resolved[key] = integer
  }
  if (raw.language !== undefined) {
    if (typeof raw.language !== 'string' || raw.language.trim() === '') {
      throw new Error(`dsh-gpt-research: config.language must be a non-empty string, got ${String(raw.language)}`)
    }
    resolved.language = raw.language
  }
  if (raw.reportFormat !== undefined) {
    if (typeof raw.reportFormat !== 'string' || raw.reportFormat.trim() === '') {
      throw new Error(`dsh-gpt-research: config.reportFormat must be a non-empty string, got ${String(raw.reportFormat)}`)
    }
    resolved.reportFormat = raw.reportFormat
  }
  if (raw.curateSources !== undefined) {
    if (typeof raw.curateSources !== 'boolean') {
      throw new Error(`dsh-gpt-research: config.curateSources must be a boolean, got ${String(raw.curateSources)}`)
    }
    resolved.curateSources = raw.curateSources
  }
  for (const key of ['provider', 'model']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || raw[key].trim() === '') {
        throw new Error(`dsh-gpt-research: config.${key} must be a non-empty string, got ${String(raw[key])}`)
      }
      resolved[key] = raw[key]
    }
  }
  // The one built-in retriever: DSH has a single search path, so the source's
  // 21-name table collapses to this class.
  resolved.retrievers = [WebRetriever]
  return Object.freeze(resolved)
}

/**
 * Render a configured language into a prompt directive.
 *
 * The source interpolated the bare name (`- Write in ${language}`), which reads
 * as a suggestion: a Chinese topic with `language: chinese` produced a report
 * that was 63% English. This spells the requirement out and names the script, so
 * the model cannot treat English as an acceptable target.
 *
 * @param {string} language - configured language name.
 * @returns {string} the directive text placed in the prompt.
 */
export function languageDirective(language) {
  const name = String(language ?? '').trim()
  if (name === '') return ''
  const lower = name.toLowerCase()
  if (lower === 'chinese' || lower === 'zh' || lower === 'cn') {
    return 'Simplified Chinese (简体中文). The entire report, including headings, '
      + 'table cells and bullet text, MUST be written in Simplified Chinese. '
      + 'Keep proper nouns, product names, benchmark names and quoted source titles '
      + 'in their original language, and translate any English quotation into Chinese '
      + 'with the original in parentheses.'
  }
  if (lower === 'english' || lower === 'en') {
    return 'English. The entire report, including headings and table cells, MUST be written in English.'
  }
  return `${name}. The entire report, including headings and table cells, MUST be written in ${name}.`
}

/**
 * Map host-facing configuration onto the ported `Config`'s environment names.
 *
 * The ported config reads `process.env` names like `DEEP_RESEARCH_BREADTH`;
 * mapping here keeps that single source of truth instead of adding setters.
 *
 * @param {typeof DEFAULT_CONFIG} config - resolved configuration.
 * @param {Record<string, string|undefined>} [base] - base environment.
 * @returns {Record<string, string|undefined>} the environment for one run.
 */
export function toEnv(config, base = process.env) {
  const mapped = {
    ...base,
    DEEP_RESEARCH_BREADTH: String(config.breadth),
    DEEP_RESEARCH_DEPTH: String(config.depth),
    DEEP_RESEARCH_CONCURRENCY: String(config.concurrency),
    MAX_SEARCH_RESULTS_PER_QUERY: String(config.maxSourcesPerQuery),
    COMPRESSION_THRESHOLD: String(config.compressionThreshold),
    TOTAL_WORDS: String(config.minReportWords),
    LANGUAGE: languageDirective(config.language),
    REPORT_FORMAT: config.reportFormat,
    REPORT_SOURCE: 'web',
    CURATE_SOURCES: String(config.curateSources),
    MAX_SUBTOPICS: String(config.maxSubtopics),
    MAX_ITERATIONS: String(config.maxIterations),
  }
  // The model route is one `<provider>:<model>` string per role. The ported
  // Config parses it into provider/model pairs, so mapping it here keeps the
  // single-source rule: a route comes from plugin config or not at all.
  if (config.provider !== undefined && config.model !== undefined) {
    const route = `${config.provider}:${config.model}`
    mapped.SMART_LLM = route
    mapped.FAST_LLM = route
    mapped.STRATEGIC_LLM = route
  }
  return mapped
}
