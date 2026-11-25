/**
 * GPT Researcher port — host half.
 *
 * Registers one `deep_research` tool. Retrieval and scraping go through the
 * host's `ctx.web` seam and completions through `ctx.llm`, so the plugin holds
 * no API keys: the deployment chooses the search/fetch provider and the model.
 *
 * Both services are resolved at call time, not at mount time: `ctx.web` and
 * `ctx.llm` may be mounted after this plugin, and a profile may recompose them.
 *
 * @module @yf-river/dsh-gpt-research
 */

import { DEFAULT_CONFIG, resolveConfig } from './lib/config/plugin.js'
import { registerCommand } from './lib/command.js'

/**
 * Adapt the host's LLM service to the chat-completion seam the port expects.
 *
 * DSH's `ctx.llm` exposes `stream(options)` — one async iterable of chunks per
 * request — while the ported pipeline calls
 * `getChatResponse(messages, stream, websocket, options)` and reads
 * `lastResponseMetadata` / `lastUsageMetadata`, because that is the surface
 * `gpt_researcher` called. This adapter owns that translation so the pipeline
 * stays unchanged.
 *
 * @param {object} llm - the host's `ctx.llm` service.
 * @param {{ provider?: string, model?: string }} [route] - optional route override.
 * @returns {{getChatResponse: Function, lastResponseMetadata?: unknown, lastUsageMetadata?: unknown}}
 *   the seam.
 */
export function createLlmSeam(llm, route = {}) {
  const seam = {
    lastResponseMetadata: undefined,
    lastUsageMetadata: undefined,
    /**
     * One chat completion, collected from the host's chunk stream.
     * @param {Array<{role: string, content: string}>} messages - chat messages.
     * @param {boolean} [_stream] - the host always streams; collected here.
     * @param {unknown} [_websocket] - progress sink (unused).
     * @param {Record<string, unknown>} [options] - model options.
     * @returns {Promise<string>} the assistant text.
     */
    async getChatResponse(messages, _stream = false, _websocket = null, options = {}) {
      const provider = options.provider ?? route.provider
      const model = options.model ?? route.model
      if (provider === undefined || model === undefined) {
        throw new Error('dsh-gpt-research: no model route is configured (set config.provider and config.model)')
      }

      // Retry this one call, not the whole run: a deep-research pass issues a
      // dozen-plus calls, so any single transient failure used to discard every
      // completed step. `retryPerCall` is the count of extra attempts.
      const attempts = 1 + Math.max(0, options.retryPerCall ?? RETRY_PER_CALL)
      let lastError
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          return await streamOnce()
        } catch (error) {
          lastError = error
          // A refusal is deterministic: the same request will be refused again.
          if (isRefusal(error)) throw error
          if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)))
          }
        }
      }
      throw lastError

      /** Stream one call and return its text. */
      async function streamOnce() {

        // `temperature` and `stop` are deliberately not forwarded: DSH adapters are
        // free to reject parameters they have not verified, and the CodeBuddy
        // adapter throws on either. The source passed a temperature because its
        // provider was a Python SDK; on DSH the adapter owns sampling defaults.
        const request = {
          provider,
          model,
          // DSH messages carry `ContentBlock[]`, not a bare string.
          messages: messages.map((message) => ({
            role: message.role,
            content: [{ type: 'text', text: String(message.content) }],
          })),
          // An adapter may refuse a request that carries no tool table: CodeBuddy
          // throws `CODEBUDDY_NO_TOOLS` when the filtered list is empty. The
          // research pipeline never wants the model to call a tool — every step is
          // prompt-only — so it declares one no-op tool to satisfy that contract.
          tools: [NO_OP_TOOL],
          ...(options.max_tokens === undefined || options.max_tokens === null ? {} : { maxTokens: options.max_tokens }),
        }

        let text = ''
        const blocks = new Map()
        for await (const chunk of llm.stream(request)) {
          if (chunk.type === 'text-delta') {
            text += chunk.text
            continue
          }
          if (chunk.type === 'block-end' && chunk.block.type === 'text') {
            // Authoritative text for the block, replacing accumulated deltas.
            blocks.set(chunk.index, chunk.block.text)
            continue
          }
          if (chunk.type === 'usage') {
            seam.lastUsageMetadata = {
              input_tokens: chunk.usage.inputTokens,
              output_tokens: chunk.usage.outputTokens,
              input_token_details: { cache_read: chunk.usage.cacheReadTokens ?? 0 },
            }
            continue
          }
          if (chunk.type === 'finish') {
            seam.lastResponseMetadata = { model }
            // A `finish` whose reason is `error` is a failed call, not an empty
            // answer: DSH adapters report refusals this way (CodeBuddy says
            // `CODEBUDDY_NO_TOOLS` when the request carried no tool table).
            // Surfacing it here stops the retry loop from reporting a misleading
            // "empty response" ten times over.
            if (chunk.reason?.kind === 'error') {
              const failure = chunk.reason.failure
              throw new Error(`模型调用被拒绝：${failure?.message ?? 'unknown'}`
                + `${failure?.code === undefined ? '' : ` [${String(failure.code)}]`}`)
            }
          }
        }

        // A completed block is authoritative; fall back to the delta text when a
        // provider sent deltas without a closing block.
        const finalText = [...blocks.entries()]
          .sort((left, right) => left[0] - right[0])
          .map((entry) => entry[1])
          .join('')
        return finalText.length > 0 ? finalText : text
      }
    },
  }
  return seam
}

/**
 * The one tool every research request declares.
 *
 * Adapters that require a non-empty tool table reject a prompt-only request.
 * Declaring a tool with an empty parameter object makes the request valid while
 * giving the model nothing it can usefully call; the pipeline never reads a
 * tool call back.
 */
/** Extra attempts for one model call when it fails for a transient reason. */
const RETRY_PER_CALL = 2

/**
 * Whether an error is a deterministic refusal rather than a transient failure.
 *
 * A refusal means the request itself is unacceptable (a rejected parameter, an
 * unsupported route); retrying it wastes the budget and hides the cause.
 *
 * @param {unknown} error - the failure.
 * @returns {boolean} `true` when the call must not be retried.
 */
function isRefusal(error) {
  const message = String(error?.message ?? '')
  return message.includes('模型调用被拒绝') || message.includes('no model route')
}

const NO_OP_TOOL = Object.freeze({
  name: 'noop',
  description: 'No action is needed. Do not call this tool; answer in plain text.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
})

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - the patch row's `config` object.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? DEFAULT_CONFIG)

  // `/research` only. Deliberately a slash command and not a model-facing tool:
  // a deep-research run costs minutes and a full model budget, so a human starts
  // it explicitly rather than the model choosing it mid-conversation.
  registerCommand(
    ctx,
    resolved,
    () => ctx.get('web'),
    () => {
      const llm = ctx.get('llm')
      if (llm === undefined) return undefined
      return createLlmSeam(llm, { provider: resolved.provider, model: resolved.model })
    },
    (agent, text) => {
      // The factory in dsh-llm produces exactly this shape (content / source /
      // role / id), so the plugin builds it inline instead of importing a
      // package it does not depend on.
      try {
        // `followup` is the one that wakes the driver: its contract is "queue an
        // ordinary follow-up turn AND wake the driver", which is what a blank
        // session needs. `steer` only reaches the nearest existing step, so on a
        // session that never ran a turn it parks the message with no consumer —
        // measured: a fresh session delivered nothing until a normal message
        // started the first turn.
        agent.followup({
          id: globalThis.crypto.randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
      } catch (error) {
        // A delivery failure must not look like a research failure.
        ctx.logger?.warn?.(`dsh-gpt-research: 报告投递失败：${error?.message ?? error}`)
      }
    },
  )

}
