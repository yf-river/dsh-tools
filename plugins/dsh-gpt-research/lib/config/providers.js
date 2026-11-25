/**
 * Provider allow-lists and the reasoning-effort enum.
 *
 * `Config` imports these from two modules outside the config folder; the port
 * keeps them here unchanged so `parse_llm` / `parse_embedding` /
 * `parse_reasoning_effort` validate against exactly the same sets.
 *
 * Provenance:
 * - `ReasoningEfforts`, `LLM_PROVIDERS` ← `gpt_researcher/llm_provider/generic/base.py`
 * - `EMBEDDING_PROVIDERS` ← `gpt_researcher/memory/embeddings.py`
 *
 * The source sets are `set` literals with no ordering contract; iteration order
 * only affects the text of an error message, so an array preserves behaviour.
 *
 * @module @yf-river/dsh-gpt-research/config/providers
 */

/** Reasoning effort levels. Source: `class ReasoningEfforts(Enum)`. */
export const ReasoningEfforts = Object.freeze({
  High: 'high',
  Medium: 'medium',
  Low: 'low',
})

/** Every `ReasoningEfforts` value, in declaration order. */
export const REASONING_EFFORT_VALUES = Object.freeze([
  ReasoningEfforts.High,
  ReasoningEfforts.Medium,
  ReasoningEfforts.Low,
])

/**
 * LLM provider names accepted by `SMART_LLM` / `FAST_LLM`.
 *
 * The source's `_SUPPORTED_PROVIDERS` list, plus the providers a DSH deployment
 * can register through `ctx.llm.registerAdapter`. A DSH provider is not a
 * Python vendor SDK, so the source's list alone would reject the only route a
 * DSH install actually has.
 */
export const LLM_PROVIDERS = Object.freeze([
  'openai',
  'anthropic',
  'azure_openai',
  'cohere',
  'google_vertexai',
  'google_genai',
  'fireworks',
  'ollama',
  'together',
  'mistralai',
  'huggingface',
  'groq',
  'bedrock',
  'dashscope',
  'xai',
  'deepseek',
  'litellm',
  'gigachat',
  'openrouter',
  'vllm_openai',
  'aimlapi',
  'netmind',
  'forge',
  'avian',
  'minimax',
  'minimax_anthropic',
  'atlascloud',
  'nebius',
  // DSH-side routes: adapters registered with `ctx.llm.registerAdapter(name)`.
  'codebuddy',
  'deepseek-account',
])

/** Embedding provider names accepted by `EMBEDDING`. Source: `_SUPPORTED_PROVIDERS`. */
export const EMBEDDING_PROVIDERS = Object.freeze([
  'openai',
  'azure_openai',
  'cohere',
  'gigachat',
  'google_vertexai',
  'google_genai',
  'fireworks',
  'ollama',
  'together',
  'mistralai',
  'huggingface',
  'nomic',
  'voyageai',
  'dashscope',
  'custom',
  'bedrock',
  'aimlapi',
  'netmind',
  'openrouter',
  'minimax',
  'nebius',
])
