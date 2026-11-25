/**
 * LLM chat-completion utility.
 *
 * One-to-one port of `gpt_researcher/utils/llm.py` for everything that decides
 * *what* is sent: the `max_tokens` sanity guard, the reasoning-effort gate, the
 * temperature gate with its `None` fallback, the `llm_kwargs` / `LLM_KWARGS`
 * override precedence, the `OPENAI_BASE_URL` handling, and the 10-attempt
 * retry loop with exponential backoff capped at 8 seconds.
 *
 * One seam is necessarily different. The source calls
 * `GenericLLMProvider.get_chat_response` (LangChain). DSH owns model routing, so
 * the port calls an injected `provider` object with the same two-method surface:
 *
 *     provider.getChatResponse(messages, stream, websocket, **kwargs) → string
 *     provider.lastResponseMetadata  → provider response metadata
 *     provider.lastUsageMetadata     → standardized usage metadata
 *
 * `createChatCompletion` validates and builds exactly the same option object, so
 * a caller-provided provider sees the same arguments LangChain would have.
 *
 * @module @yf-river/dsh-gpt-research/utils/llm
 */

import { ReasoningEfforts } from '../config/providers.js'
import { SUPPORT_REASONING_EFFORT_MODELS, supportsTemperature } from './models.js'
import { calculateLlmCost } from './costs.js'

const logger = {
  warning: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}

/** Largest output limit any currently available model enforces. */
const MAX_OUTPUT_LIMIT = 200000

/** Retry backoff cap, seconds. */
const MAX_BACKOFF_SECONDS = 8

/** Total attempts for a non-streaming call. */
const MAX_ATTEMPTS = 10

/**
 * Build the provider option object for one call.
 *
 * Order matters and is preserved from the source: model, reasoning effort,
 * temperature (or `undefined` so the key is omitted), `max_tokens`, then caller
 * overrides last so they win.
 *
 * @param {{ model: string, temperature?: number | null, maxTokens?: number | null, reasoningEffort?: string | null, llmKwargs?: Record<string, unknown> | null, env?: Record<string, string|undefined> }} params
 *   call parameters.
 * @returns {Record<string, unknown>} provider options.
 */
export function buildProviderKwargs(params) {
  const env = params.env ?? process.env
  const model = params.model
  const providerKwargs = { model }

  if (SUPPORT_REASONING_EFFORT_MODELS.includes(model)) {
    providerKwargs.reasoning_effort = params.reasoningEffort ?? ReasoningEfforts.Medium
  }

  if (supportsTemperature(model)) {
    providerKwargs.temperature = params.temperature ?? 0.4
  } else {
    // These models enforce their default temperature, but output limits still
    // apply. `undefined` keeps the key out of the request, which is what the
    // source's `temperature = None` amounts to for LangChain.
    providerKwargs.temperature = undefined
  }
  providerKwargs.max_tokens = params.maxTokens ?? 4000

  // Caller/env overrides win over the computed defaults above, applied last on
  // purpose: before this the unconditional temperature assignment clobbered a
  // temperature passed through `llm_kwargs` — the documented escape hatch.
  // The route is part of the request, not just the model: a DSH deployment
  // registers adapters per provider name, so the seam needs both halves to pick
  // one. The source did not need this because its provider was a Python SDK.
  if (params.llmProvider !== undefined && params.llmProvider !== null) {
    providerKwargs.provider = params.llmProvider
  }

  if (params.llmKwargs && Object.keys(params.llmKwargs).length > 0) {
    Object.assign(providerKwargs, params.llmKwargs)
  } else if (env.LLM_KWARGS) {
    try {
      Object.assign(providerKwargs, JSON.parse(env.LLM_KWARGS))
    } catch {
      // Source ignores a malformed LLM_KWARGS; kept identical.
    }
  }

  return providerKwargs
}

/**
 * Create one chat completion.
 *
 * @param {object} params - call parameters.
 * @param {Array<{role: string, content: string}>} params.messages - chat messages.
 * @param {string | null} params.model - model id; required.
 * @param {number | null} [params.temperature] - sampling temperature.
 * @param {number | null} [params.maxTokens] - output token limit.
 * @param {string | null} [params.llmProvider] - provider id.
 * @param {boolean} [params.stream] - stream the response.
 * @param {unknown} [params.websocket] - stream sink, when streaming.
 * @param {Record<string, unknown> | null} [params.llmKwargs] - caller overrides.
 * @param {((cost: number) => void) | null} [params.costCallback] - cost sink.
 * @param {string | null} [params.reasoningEffort] - reasoning effort.
 * @param {{getChatResponse: Function, lastResponseMetadata?: unknown, lastUsageMetadata?: unknown}} params.provider
 *   the model-call seam.
 * @param {Record<string, string|undefined>} [params.env] - environment map.
 * @param {(ms: number) => Promise<void>} [params.sleep] - backoff hook.
 * @param {{ tokenizer?: (text: string) => number }} [params.costOptions] - tokenizer hook.
 * @returns {Promise<string>} the response text.
 * @throws {Error} when the model is missing, the token limit is absurd, or every attempt fails.
 */
export async function createChatCompletion(params) {
  const env = params.env ?? process.env
  const sleep = params.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  if (params.model === null || params.model === undefined) {
    throw new Error('Model cannot be None')
  }
  // Sanity guard against absurd values (e.g. env var typos). The actual
  // per-model output limits are enforced by the upstream provider.
  const maxTokens = params.maxTokens ?? 4000
  if (maxTokens > MAX_OUTPUT_LIMIT) {
    throw new Error(
      `max_tokens=${maxTokens} exceeds the largest output limit of `
      + 'any currently available model (128k as of late 2025). '
      + 'Check your FAST_TOKEN_LIMIT / SMART_TOKEN_LIMIT / '
      + 'STRATEGIC_TOKEN_LIMIT env vars for typos.',
    )
  }

  const providerKwargs = buildProviderKwargs({
    model: params.model,
    temperature: params.temperature,
    maxTokens,
    reasoningEffort: params.reasoningEffort,
    llmKwargs: params.llmKwargs,
    llmProvider: params.llmProvider,
    env,
  })

  if (params.llmProvider === 'openai') {
    const baseUrl = env.OPENAI_BASE_URL
    if (baseUrl) providerKwargs.openai_api_base = baseUrl
  }

  const maxAttempts = (params.stream === true && params.websocket !== null && params.websocket !== undefined)
    ? 1
    : MAX_ATTEMPTS
  let lastException = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response
    try {
      // The seam receives the built option object, not the caller's parameter
      // bag: `providerKwargs` is what the source handed its provider, and what
      // carries model / temperature / max_tokens / reasoning_effort / provider.
      response = await params.provider.getChatResponse(
        params.messages,
        params.stream === true,
        params.websocket ?? null,
        providerKwargs,
      )
    } catch (error) {
      lastException = error
      // First failure prints the full cause: a rejected parameter or a route
      // problem is actionable, and ten identical "empty response" lines are not.
      const detail = attempt === 1
        ? `${error?.message ?? String(error)}${error?.code === undefined ? '' : ` [${String(error.code)}]`}`
        : (error?.message ?? String(error))
      logger.warning(`LLM request failed (attempt ${attempt}/${maxAttempts}): ${detail}`)
      if (attempt < maxAttempts) {
        await sleep(Math.min(2 ** (attempt - 1), MAX_BACKOFF_SECONDS) * 1000)
        continue
      }
      break
    }

    // A provider can bill a completed request that returns empty content after
    // spending its budget on reasoning, so account for every call.
    if (typeof params.costCallback === 'function') {
      const cost = calculateLlmCost(
        params.llmProvider ?? null,
        params.model,
        String(params.messages),
        response ?? '',
        params.provider.lastResponseMetadata,
        params.provider.lastUsageMetadata,
        providerKwargs,
        params.costOptions,
      )
      params.costCallback(cost)
    }

    if (!response) {
      lastException = new Error('Empty response from LLM provider')
      logger.warning(`LLM returned empty response (attempt ${attempt}/${maxAttempts})`)
      if (attempt < maxAttempts) {
        await sleep(Math.min(2 ** (attempt - 1), MAX_BACKOFF_SECONDS) * 1000)
        continue
      }
      break
    }

    return response
  }

  // Name the route, not "openai": a DSH deployment routes through whichever
  // adapter it registered, and the provider is the actionable part.
  const route = `${params.llmProvider ?? '(unset)'}:${params.model ?? '(unset)'}`
  logger.error(`LLM call failed after ${maxAttempts} attempts on route ${route}`)
  throw new Error(`LLM call failed after ${maxAttempts} attempts on route ${route}`, { cause: lastException })
}

/**
 * Generate research subtopics with a structured-output call.
 *
 * Port of `construct_subtopics`. The source used LangChain's
 * `PydanticOutputParser` + `PromptTemplate` chain; the port asks the provider
 * for the same prompt text and parses the reply with {@link parseSubtopics},
 * returning the caller's existing list on any failure exactly as the source did.
 *
 * @param {object} params - parameters.
 * @param {string} params.task - the main task or topic.
 * @param {string} params.data - context for the task.
 * @param {object} params.config - resolved {@link import('../config/index.js').Config}.
 * @param {Array<object>} [params.subtopics] - existing subtopics, returned on failure.
 * @param {Function} params.buildPrompt - `(task, data, subtopics, maxSubtopics, formatInstructions) => string`.
 * @param {object} params.provider - the model-call seam.
 * @param {Record<string, string|undefined>} [params.env] - environment map.
 * @returns {Promise<Array<object>>} parsed subtopics, or the input list on failure.
 */
export async function constructSubtopics(params) {
  const { config } = params
  try {
    const prompt = params.buildPrompt(
      params.task,
      params.data,
      params.subtopics ?? [],
      config.max_subtopics,
      params.formatInstructions ?? '',
    )

    const providerKwargs = { model: config.smart_llm_model }
    if (config.llm_kwargs && Object.keys(config.llm_kwargs).length > 0) {
      Object.assign(providerKwargs, config.llm_kwargs)
    }

    if (SUPPORT_REASONING_EFFORT_MODELS.includes(config.smart_llm_model)) {
      providerKwargs.reasoning_effort = ReasoningEfforts.High
    } else if (supportsTemperature(config.smart_llm_model)) {
      providerKwargs.temperature = config.temperature
    } else {
      // undefined, not the configured value: these models reject a temperature,
      // and leaving the key out lets some clients fill in their own default.
      providerKwargs.temperature = undefined
    }
    providerKwargs.max_tokens = config.smart_token_limit

    const response = await params.provider.getChatResponse(
      [{ role: 'user', content: prompt }],
      false,
      null,
      providerKwargs,
    )
    return parseSubtopics(response)
  } catch (error) {
    logger.error(`Exception in parsing subtopics: ${error?.message ?? String(error)}`)
    return params.subtopics ?? []
  }
}

/**
 * Parse a `{"subtopics": [{"task": "..."}]}` reply.
 *
 * Lenient in the same places the source's output parser was: bare arrays and a
 * fenced code block are both accepted; anything else yields an empty list.
 *
 * @param {string} response - model reply.
 * @returns {Array<object>} parsed subtopics.
 */
export function parseSubtopics(response) {
  const text = String(response ?? '')
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? text).trim()
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.subtopics
  if (!Array.isArray(list)) return []
  return list
    .filter((item) => item !== null && typeof item === 'object' && typeof item.task === 'string' && item.task.length > 0)
    .map((item) => ({ task: item.task }))
}
