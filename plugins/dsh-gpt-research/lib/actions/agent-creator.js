/**
 * Agent selection.
 *
 * One-to-one port of `gpt_researcher/actions/agent_creator.py`: the automatic
 * agent/role choice, the tolerant JSON recovery ladder (json_repair → regex →
 * hard-coded default), and the greedy `{.*}` extraction whose greediness the
 * source documents as a bug fix.
 *
 * @module @yf-river/dsh-gpt-research/actions/agent-creator
 */

import { PromptFamily } from '../prompts.js'
import { createChatCompletion } from '../utils/llm.js'
import { jsonRepairLoads } from '../utils/json-repair.js'

const logger = {
  warning: (...args) => console.warn(...args),
  info: (...args) => console.log(...args),
  debug: (...args) => {},
}

/** Fallback agent used when the model will not produce usable JSON. */
export const DEFAULT_AGENT = Object.freeze({
  server: 'Default Agent',
  agentRolePrompt: 'You are an AI critical thinker research assistant. Your sole purpose is to write well written, '
    + 'critically acclaimed, objective and structured reports on given text.',
})

/**
 * Extract the first JSON object from text using the source's greedy pattern.
 *
 * Greedy `{.*}` so the match spans from the first `{` to the LAST `}`: a
 * non-greedy `{.*?}` stops at the first `}`, truncating any object with more
 * than one key or with a `}` inside a string value into invalid JSON.
 *
 * @param {string | null} response - the model reply.
 * @returns {string | null} the matched object text, or `null`.
 */
export function extractJsonWithRegex(response) {
  if (!response) return null
  const match = /\{[\s\S]*\}/.exec(response)
  return match === null ? null : match[0]
}

/**
 * Return an agent pair only for a complete payload.
 * @param {unknown} payload - parsed value.
 * @returns {[string, string] | null} `[server, agentRolePrompt]`, or `null`.
 */
function agentPairFromPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const server = payload.server
  const role = payload.agent_role_prompt
  if (server && role) return [server, role]
  return null
}

/**
 * Recover agent information from a malformed response.
 *
 * @param {string | null} response - the model reply that failed the first parse.
 * @returns {[string, string]} `[server, agentRolePrompt]`, falling back to the default agent.
 */
export function handleJsonError(response) {
  if (response !== null && response !== undefined) {
    try {
      const recovered = agentPairFromPayload(jsonRepairLoads(response))
      if (recovered !== null) return recovered
    } catch (error) {
      logger.warning(`Failed to parse agent JSON with json_repair: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`)
      if (response) logger.debug(`LLM response that failed to parse: ${String(response).slice(0, 500)}...`)
    }
  }

  const jsonString = extractJsonWithRegex(response)
  if (jsonString) {
    try {
      const recovered = agentPairFromPayload(JSON.parse(jsonString))
      if (recovered !== null) return recovered
    } catch (error) {
      logger.warning(`Failed to decode JSON from regex extraction: ${error?.message ?? error}`)
    }
  }

  logger.info('No valid JSON found in LLM response. Falling back to default agent.')
  return [DEFAULT_AGENT.server, DEFAULT_AGENT.agentRolePrompt]
}

/**
 * Choose the agent automatically.
 *
 * @param {string} query - the query.
 * @param {object} cfg - resolved config.
 * @param {string | null} [parentQuery] - the parent query, when this is a subtopic.
 * @param {Function | null} [costCallback] - cost sink.
 * @param {Record<string, string> | null} [_headers] - request headers (unused here, kept for parity).
 * @param {object} [promptFamily] - the prompt family instance.
 * @param {object} options - required seams.
 * @param {object} options.provider - the model-call seam.
 * @param {Record<string, string|undefined>} [options.env] - environment map.
 * @returns {Promise<[string, string]>} `[server, agentRolePrompt]`.
 */
export async function chooseAgent(
  query,
  cfg,
  parentQuery = null,
  costCallback = null,
  _headers = null,
  promptFamily = PromptFamily,
  options = {},
) {
  const effectiveQuery = parentQuery ? `${parentQuery} - ${query}` : `${query}`
  const family = promptFamily ?? PromptFamily
  let response = null

  try {
    response = await createChatCompletion({
      model: cfg.smart_llm_model,
      messages: [
        { role: 'system', content: `${family.auto_agent_instructions()}` },
        { role: 'user', content: `task: ${effectiveQuery}` },
      ],
      temperature: 0.15,
      llmProvider: cfg.smart_llm_provider,
      llmKwargs: cfg.llm_kwargs,
      costCallback,
      provider: options.provider,
      env: options.env,
    })

    // Prefer the repair path so fenced or lightly broken JSON succeeds on the
    // hot path instead of always falling through exception handling.
    let agentDict = null
    try {
      agentDict = response !== null && response !== undefined ? jsonRepairLoads(response) : null
    } catch {
      agentDict = null
    }
    if (agentDict === null || typeof agentDict !== 'object' || Array.isArray(agentDict)) {
      agentDict = JSON.parse(response)
    }
    if (agentDict === null || typeof agentDict !== 'object' || Array.isArray(agentDict)) {
      throw new Error('agent JSON was not an object')
    }
    return [agentDict.server, agentDict.agent_role_prompt]
  } catch {
    return handleJsonError(response)
  }
}
