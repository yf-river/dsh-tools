/**
 * Model capability lists shared by cost estimation and LLM option building.
 *
 * These live in `llm_provider/generic/base.py` in the source, but both
 * `utils/costs.py` and `utils/llm.py` import them, and the DSH port keeps them
 * under `utils/` so the config folder stays self-contained (config imports them
 * through `config/providers.js`, which re-exports {@link ReasoningEfforts}).
 *
 * Values are copied verbatim, including order: `supportsTemperature` and the
 * pricing lookups scan in list order, so reordering would change which rule
 * matches a model string that satisfies two.
 *
 * @module @yf-river/dsh-gpt-research/utils/models
 */

/** Models that reject a `temperature` parameter. */
export const NO_SUPPORT_TEMPERATURE_MODELS = Object.freeze([
  'deepseek/deepseek-reasoner',
  'o1-mini',
  'o1-mini-2024-09-12',
  'o1',
  'o1-2024-12-17',
  'o3-mini',
  'o3-mini-2025-01-31',
  'o1-preview',
  'o3',
  'o3-2025-04-16',
  'o4-mini',
  'o4-mini-2025-04-16',
  // GPT-5 family: OpenAI enforces default temperature only
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6.1-sol',
  // Claude 4.x family: Anthropic deprecates temperature on these models
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
])

/** Model-name prefixes that reject a `temperature` parameter. */
export const NO_SUPPORT_TEMPERATURE_MODEL_PREFIXES = Object.freeze([
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-5',
  'claude-fable',
  'claude-mythos',
])

/** Models that accept a `reasoning_effort` parameter. */
export const SUPPORT_REASONING_EFFORT_MODELS = Object.freeze([
  'o3-mini',
  'o3-mini-2025-01-31',
  'o3',
  'o3-2025-04-16',
  'o4-mini',
  'o4-mini-2025-04-16',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6.1-sol',
])

/**
 * Whether a model accepts a `temperature` parameter.
 *
 * Port of `supports_temperature`, including its normalisation: strip a
 * `vendor/` prefix (OpenRouter, LiteLLM), a Bedrock `anthropic.` infix, and a
 * `-v1:` suffix before prefix matching.
 *
 * @param {string} model - the model id.
 * @returns {boolean} `true` when a temperature may be sent.
 */
export function supportsTemperature(model) {
  const name = model
    .split('/')
    .pop()
    .split('anthropic.')
    .pop()
    .split('-v1:')[0]
  if (NO_SUPPORT_TEMPERATURE_MODELS.includes(model) || NO_SUPPORT_TEMPERATURE_MODELS.includes(name)) {
    return false
  }
  return !NO_SUPPORT_TEMPERATURE_MODEL_PREFIXES.some((prefix) => name.startsWith(prefix))
}
