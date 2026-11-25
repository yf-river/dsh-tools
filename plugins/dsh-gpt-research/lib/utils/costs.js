/**
 * Cost estimation for LLM and embedding usage.
 *
 * One-to-one port of `gpt_researcher/utils/costs.py`: the pricing tables, the
 * Anthropic cache-aware split, the OpenAI cached-input discount, and the
 * usage-metadata extraction are copied value for value.
 *
 * One implementation gap: the source counts tokens with `tiktoken`
 * (`o200k_base`). Node has no built-in equivalent and the plugin ships no
 * dependencies, so {@link countTokens} delegates to an injected tokenizer and
 * otherwise uses {@link approximateTokenCount}. Every caller that needs exact
 * accounting can pass `{ tokenizer }`; the fallback keeps the shape of the
 * number (monotone in length, ~8% high on English prose) so cost figures stay
 * comparable instead of silently reading zero.
 *
 * @module @yf-river/dsh-gpt-research/utils/costs
 */

/** Encoding used by the source for token counts. */
export const ENCODING_MODEL = 'o200k_base'

/** Fallback input price per token, USD. */
export const INPUT_COST_PER_TOKEN = 0.000005
/** Fallback output price per token, USD. */
export const OUTPUT_COST_PER_TOKEN = 0.000015
/** Per-image inference cost, USD. */
export const IMAGE_INFERENCE_COST = 0.003825
/** Embedding price per token, USD (assumes ada-3-small). */
export const EMBEDDING_COST = 0.02 / 1000000

/**
 * OpenAI bills the cached portion of input at this fraction of the input rate.
 * Kept as one constant because OpenAI has used a flat 50% discount across every
 * cached model so far.
 */
export const OPENAI_CACHED_INPUT_DISCOUNT = 0.5

const logger = {
  warning: (...args) => console.warn(...args),
}

/**
 * Approximate token count for one string.
 *
 * Splits on the token-ish boundaries o200k_base uses for Latin text (word
 * starts, punctuation, CJK characters) and adds one token per remaining
 * character run. Documented approximation, not a byte-exact tokenizer.
 *
 * @param {string} text - input text.
 * @returns {number} approximate token count.
 */
export function approximateTokenCount(text) {
  if (!text) return 0
  const matches = String(text).match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)
  return matches === null ? 0 : matches.length
}

/**
 * Count tokens with the injected tokenizer, else the fallback.
 * @param {string} text - input text.
 * @param {{ tokenizer?: (text: string) => number }} [options] - tokenizer hook.
 * @returns {number} token count.
 */
function countTokens(text, options = {}) {
  if (typeof options.tokenizer === 'function') return options.tokenizer(text)
  return approximateTokenCount(text)
}

/**
 * Estimate the cost of one LLM call from raw text (tiktoken fallback path).
 *
 * @param {string | null} inputContent - serialized request content.
 * @param {string | null} outputContent - response content.
 * @param {{ tokenizer?: (text: string) => number }} [options] - tokenizer hook.
 * @returns {number} estimated USD cost.
 */
export function estimateLlmCost(inputContent, outputContent, options = {}) {
  // Callbacks and stream paths may pass null before content exists.
  let input = inputContent === null || inputContent === undefined ? '' : inputContent
  let output = outputContent === null || outputContent === undefined ? '' : outputContent
  if (typeof input !== 'string') input = String(input)
  if (typeof output !== 'string') output = String(output)
  const inputCosts = countTokens(input, options) * INPUT_COST_PER_TOKEN
  const outputCosts = countTokens(output, options) * OUTPUT_COST_PER_TOKEN
  return inputCosts + outputCosts
}

/**
 * Normalize a mapping-like value (plain object, `Map`, or `{model_dump()}`) to a plain object.
 * @param {unknown} value - candidate mapping.
 * @returns {Record<string, unknown>} plain object, `{}` when not a mapping.
 */
function mappingToDict(value) {
  if (value === null || value === undefined) return {}
  if (value instanceof Map) return Object.fromEntries(value)
  if (typeof value === 'object' && 'model_dump' in value && typeof value.model_dump === 'function') {
    return { ...value.model_dump() }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value }
  return {}
}

/** (model-name substrings, input $/MTok, output $/MTok); first match wins. */
export const OPENAI_MODEL_PRICING = Object.freeze([
  [['gpt-6.1-sol'], 2.0, 10.0],
  [['gpt-6.1-terra'], 1.0, 5.0],
  [['gpt-6-astra'], 10.0, 50.0],
  [['gpt-6-sol'], 2.0, 10.0],
  [['gpt-6-luna'], 0.1, 0.5],
  [['gpt-5.6-sol'], 4.0, 20.0],
  [['gpt-5.6-terra'], 2.0, 12.0],
  [['gpt-5.6-luna'], 0.2, 1.2],
  [['gpt-5.5-pro'], 30.0, 180.0],
  [['gpt-5.5'], 5.0, 30.0],
  [['gpt-5.4-pro'], 30.0, 180.0],
  [['gpt-5.4-mini'], 0.75, 4.5],
  [['gpt-5.4-nano'], 0.2, 1.25],
  [['gpt-5.4'], 2.5, 15.0],
  [['gpt-5-mini'], 0.25, 2.0],
  [['gpt-5-nano'], 0.05, 0.4],
  [['gpt-5'], 1.25, 10.0],
  [['gpt-4.1-mini'], 0.4, 1.6],
  [['gpt-4.1-nano'], 0.1, 0.4],
  [['gpt-4.1'], 2.0, 8.0],
  [['gpt-4o-mini'], 0.15, 0.6],
  [['gpt-4o'], 2.5, 10.0],
  [['o4-mini'], 1.1, 4.4],
  [['o3-mini'], 1.1, 4.4],
  [['o3'], 2.0, 8.0],
])

/** Anthropic pricing table, first match wins. */
export const ANTHROPIC_MODEL_PRICING = Object.freeze([
  [['claude-opus-4-7'], 5.0, 25.0],
  [['claude-opus-4-6'], 5.0, 25.0],
  [['claude-opus-4-5', 'claude-4-opus'], 5.0, 25.0],
  [['claude-opus-4-1'], 15.0, 75.0],
  [['claude-opus-4'], 15.0, 75.0],
  [['claude-sonnet-4-6'], 3.0, 15.0],
  [['claude-sonnet-4-5', 'claude-4-sonnet'], 3.0, 15.0],
  [['claude-sonnet-4'], 3.0, 15.0],
  [['claude-haiku-4-5'], 1.0, 5.0],
  [['claude-3-5-haiku'], 0.8, 4.0],
])

/** Models that bill a US-inference premium on Anthropic. */
export const ANTHROPIC_US_INFERENCE_GEO_MODELS = Object.freeze([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
])

/**
 * Resolve the model name to price, preferring response metadata over the request.
 * @param {string | null} model - configured model.
 * @param {unknown} [responseMetadata] - provider response metadata.
 * @returns {string} lowercased model name, possibly empty.
 */
function resolveAnthropicModelName(model, responseMetadata = undefined) {
  const metadata = mappingToDict(responseMetadata)
  return String(
    metadata.model
    || metadata.model_name
    || model
    || '',
  ).toLowerCase()
}

/**
 * Coerce a token count to an integer, defaulting to 0 on nonsense.
 * @param {unknown} value - reported value.
 * @returns {number} integer count.
 */
function coerceTokenCount(value) {
  if (value === null || value === undefined) return 0
  const parsed = Number.parseInt(String(value), 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Extract Anthropic usage, including prompt-cache fields.
 *
 * `input_tokens` excludes cached input; cache creation and cache read are
 * reported separately and billed at 1.25x and 0.1x the input rate.
 *
 * @param {unknown} [responseMetadata] - provider response metadata.
 * @param {unknown} [usageMetadata] - standardized usage metadata.
 * @returns {{input_tokens: number, output_tokens: number, cache_creation_input_tokens: number, cache_read_input_tokens: number} | null}
 *   usage, or `null` when the response did not report token counts.
 */
function extractAnthropicUsage(responseMetadata = undefined, usageMetadata = undefined) {
  const metadata = mappingToDict(responseMetadata)
  const usage = mappingToDict(metadata.usage)

  const fromUsage = (usageDict) => {
    const inputTokens = usageDict.input_tokens
    const outputTokens = usageDict.output_tokens
    if (inputTokens === null || inputTokens === undefined) return null
    if (outputTokens === null || outputTokens === undefined) return null
    return {
      input_tokens: Number.parseInt(String(inputTokens), 10),
      output_tokens: Number.parseInt(String(outputTokens), 10),
      cache_creation_input_tokens: coerceTokenCount(usageDict.cache_creation_input_tokens),
      cache_read_input_tokens: coerceTokenCount(usageDict.cache_read_input_tokens),
    }
  }

  if (Object.keys(usage).length > 0) {
    const parsed = fromUsage(usage)
    if (parsed !== null) return parsed
  }

  return fromUsage(mappingToDict(usageMetadata))
}

/**
 * Look up Anthropic pricing for one model.
 * @param {string} modelName - lowercased model name.
 * @returns {[number, number] | null} `[input, output]` $/MTok, or `null`.
 */
function getAnthropicPricing(modelName) {
  const normalized = modelName.toLowerCase()
  for (const [patterns, inputPrice, outputPrice] of ANTHROPIC_MODEL_PRICING) {
    if (patterns.some((pattern) => normalized.includes(pattern))) return [inputPrice, outputPrice]
  }
  return null
}

/**
 * Geographic pricing multiplier for Anthropic.
 * @param {string} modelName - lowercased model name.
 * @param {unknown} [requestOptions] - options the request was made with.
 * @returns {number} multiplier, 1.0 unless US inference applies.
 */
function getAnthropicPricingMultiplier(modelName, requestOptions = undefined) {
  if (!requestOptions || Object.keys(mappingToDict(requestOptions)).length === 0) return 1.0
  const inferenceGeo = String(mappingToDict(requestOptions).inference_geo ?? '').toLowerCase()
  if (inferenceGeo !== 'us') return 1.0
  if (ANTHROPIC_US_INFERENCE_GEO_MODELS.some((pattern) => modelName.includes(pattern))) return 1.1
  return 1.0
}

/**
 * Compute Anthropic cost from reported usage.
 *
 * @param {string | null} model - configured model.
 * @param {unknown} [responseMetadata] - provider response metadata.
 * @param {unknown} [usageMetadata] - standardized usage metadata.
 * @param {unknown} [requestOptions] - options the request was made with.
 * @returns {number | null} USD cost, or `null` when usage or pricing is missing.
 */
export function calculateAnthropicCost(model, responseMetadata = undefined, usageMetadata = undefined, requestOptions = undefined) {
  const usage = extractAnthropicUsage(responseMetadata, usageMetadata)
  if (usage === null) return null

  const modelName = resolveAnthropicModelName(model, responseMetadata)
  const pricing = getAnthropicPricing(modelName)
  if (pricing === null) {
    logger.warning(`Missing Anthropic pricing rule for model '${modelName || model}'; falling back to token estimator.`)
    return null
  }

  const [inputPrice, outputPrice] = pricing
  const multiplier = getAnthropicPricingMultiplier(modelName, requestOptions)
  // Anthropic prompt caching: cache writes ~1.25x input, cache reads ~0.1x input.
  const cacheWritePrice = inputPrice * 1.25
  const cacheReadPrice = inputPrice * 0.1
  const inputCost = usage.input_tokens * inputPrice / 1000000
  const cacheWriteCost = usage.cache_creation_input_tokens * cacheWritePrice / 1000000
  const cacheReadCost = usage.cache_read_input_tokens * cacheReadPrice / 1000000
  const outputCost = usage.output_tokens * outputPrice / 1000000
  return (inputCost + cacheWriteCost + cacheReadCost + outputCost) * multiplier
}

/**
 * Extract OpenAI usage counts.
 *
 * `cache_read_tokens` is the portion of `input_tokens` that hit the prompt
 * cache; it is a subset, not additional tokens, and defaults to 0 when the
 * response omits cache details.
 *
 * @param {unknown} usageMetadata - standardized usage metadata.
 * @returns {[number, number, number] | null} `[input, output, cacheRead]`, or `null`.
 */
function extractUsageTokens(usageMetadata) {
  const usage = mappingToDict(usageMetadata)
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (inputTokens === null || inputTokens === undefined) return null
  if (outputTokens === null || outputTokens === undefined) return null
  const details = mappingToDict(usage.input_token_details)
  const cacheReadTokens = Number.parseInt(String(details.cache_read ?? 0), 10) || 0
  return [
    Number.parseInt(String(inputTokens), 10),
    Number.parseInt(String(outputTokens), 10),
    cacheReadTokens,
  ]
}

/**
 * Look up OpenAI pricing for one model.
 * @param {string | null} model - model id.
 * @returns {[number, number] | null} `[input, output]` $/MTok, or `null`.
 */
function getOpenaiPricing(model) {
  const normalized = (model ?? '').toLowerCase()
  for (const [patterns, inputPrice, outputPrice] of OPENAI_MODEL_PRICING) {
    if (patterns.some((pattern) => normalized.includes(pattern))) return [inputPrice, outputPrice]
  }
  return null
}

/**
 * Compute the cost of one LLM call.
 *
 * Prefers provider-reported usage over text estimation: the text path
 * overcounts input and misses reasoning tokens entirely.
 *
 * @param {string | null} llmProvider - provider id.
 * @param {string | null} model - model id.
 * @param {string} inputContent - serialized request content (fallback path).
 * @param {string} outputContent - response content (fallback path).
 * @param {unknown} [responseMetadata] - provider response metadata.
 * @param {unknown} [usageMetadata] - standardized usage metadata.
 * @param {unknown} [requestOptions] - options the request was made with.
 * @param {{ tokenizer?: (text: string) => number }} [options] - tokenizer hook for the fallback path.
 * @returns {number} USD cost.
 */
export function calculateLlmCost(
  llmProvider,
  model,
  inputContent,
  outputContent,
  responseMetadata = undefined,
  usageMetadata = undefined,
  requestOptions = undefined,
  options = {},
) {
  if (llmProvider === 'anthropic') {
    const anthropicCost = calculateAnthropicCost(model, responseMetadata, usageMetadata, requestOptions)
    if (anthropicCost !== null) return anthropicCost
  }

  const usageTokens = extractUsageTokens(usageMetadata)
  if (usageTokens !== null) {
    const [inputTokens, outputTokens, cacheReadTokens] = usageTokens
    const nonCachedInputTokens = inputTokens - cacheReadTokens
    const pricing = getOpenaiPricing(model)
    if (pricing !== null) {
      const [inputPrice, outputPrice] = pricing
      const nonCachedCost = nonCachedInputTokens * inputPrice
      const cachedCost = cacheReadTokens * inputPrice * OPENAI_CACHED_INPUT_DISCOUNT
      const outputCost = outputTokens * outputPrice
      return (nonCachedCost + cachedCost + outputCost) / 1000000
    }
    const cachedCost = cacheReadTokens * INPUT_COST_PER_TOKEN * OPENAI_CACHED_INPUT_DISCOUNT
    const nonCachedCost = nonCachedInputTokens * INPUT_COST_PER_TOKEN
    return nonCachedCost + cachedCost + outputTokens * OUTPUT_COST_PER_TOKEN
  }

  return estimateLlmCost(inputContent, outputContent, options)
}

/**
 * Estimate the cost of embedding documents.
 *
 * Non-OpenAI embedding model names raise in the source's `tiktoken` lookup; the
 * port has no model-specific encodings, so it counts with the same fallback for
 * every model. The cost arithmetic is identical.
 *
 * @param {string} model - embedding model name.
 * @param {unknown} docs - documents, or a single document.
 * @param {{ tokenizer?: (text: string) => number }} [options] - tokenizer hook.
 * @returns {number} estimated USD cost.
 */
export function estimateEmbeddingCost(model, docs, options = {}) {
  let list = docs
  if (list === null || list === undefined) return 0.0
  if (typeof list === 'string' || !(Symbol.iterator in Object(list))) list = [list]
  const items = [...list]
  if (items.length === 0) return 0.0

  let totalTokens = 0
  for (const doc of items) totalTokens += countTokens(String(doc), options)
  return totalTokens * EMBEDDING_COST
}
