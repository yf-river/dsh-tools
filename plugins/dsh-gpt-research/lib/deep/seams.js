/**
 * Host seams for the two-layer graph: a tool-calling model and a batch search.
 *
 * The gpt-researcher family needs a text-only chat seam, which `createLlmSeam` in
 * the package entry provides. The two-layer graph needs two things that seam does
 * not expose: the model's **tool calls** (a supervisor decides by emitting
 * `ConductResearch` / `ResearchComplete`, not by returning text) and a **structured
 * output** mode (the brief and clarification steps). Both are here.
 *
 * The host's `ctx.llm.stream` reports tool calls as `tool-call-delta` chunks that
 * accumulate into a `tool-call` block, so this collects those alongside text. The
 * search seam batches queries into `ctx.web.search`, because the graph's search
 * tool takes a query list by contract.
 *
 * @module @yf-river/dsh-gpt-research/deep/seams
 */

/** Monotonic id source for the request messages this seam synthesizes. */
let messageId = 0

/** Retries for one model call, matching the gpt-researcher seam's budget. */
const RETRY_PER_CALL = 2

/** Backoff base in milliseconds. */
const BACKOFF_MS = 500

/**
 * Create a model seam that records tool calls.
 *
 * @param {object} llm - the host's `ctx.llm`.
 * @param {{provider?: string, model?: string}} route - fallback route.
 * @param {(message: string) => void} [onWarn] - diagnostic sink.
 * @returns {(messages: object[], options: object) => Promise<{text: string, toolCalls: Array<object>, usage?: object}>}
 *   one collected completion.
 */
export function createCompletionSeam(llm, route = {}, onWarn) {
  return async function complete(messages, options = {}) {
    const provider = options.provider ?? route.provider
    const model = options.model ?? route.model
    if (provider === undefined || model === undefined) {
      throw new Error('deep research: no model route is configured')
    }

    const attempts = 1 + RETRY_PER_CALL
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await streamOnce()
      } catch (error) {
        lastError = error
        // A refusal is deterministic; retrying it only burns the budget.
        if (isRefusal(error)) throw error
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** (attempt - 1)))
        }
      }
    }
    throw lastError

    /** Stream one call and collect text, tool calls, and usage. */
    async function streamOnce() {
      const request = {
        provider,
        model,
        // History must reconstruct the provider's own vocabulary, not a flattened
        // transcript: an assistant turn that called a tool has to carry its
        // `tool-call` blocks, and a tool result has to carry `tool-call-result`
        // with the matching id. Collapsing both to text makes the adapter see an
        // orphaned tool result, which surfaces as a provider rejection.
        messages: messages.map(toRequestMessage),
        // A structured-output call still needs a tool table on adapters that reject
        // a prompt-only request, so the schema is expressed as a single tool whose
        // arguments the model must fill.
        ...(Array.isArray(options.tools) && options.tools.length > 0
          ? { tools: options.tools }
          : options.responseSchema === undefined ? { tools: [STRUCTURED_NOOP] } : { tools: [schemaTool(options.responseSchema)] }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.responseSchema === undefined ? {} : { toolChoice: 'required' }),
      }

      let text = ''
      const blocks = new Map()
      const calls = new Map()
      let usage
      /** A `finish` carrying `error`; raised only after the stream is fully drained. */
      let refusal

      for await (const chunk of llm.stream(request)) {
        if (chunk.type === 'text-delta') {
          text += chunk.text
          continue
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          blocks.set(chunk.index, chunk.block.text)
          continue
        }
        if (chunk.type === 'tool-call-delta') {
          const current = calls.get(chunk.index) ?? { id: chunk.id, name: chunk.name ?? '', arguments: '' }
          if (chunk.name !== undefined && chunk.name !== '') current.name = chunk.name
          current.arguments += chunk.argumentsDelta ?? ''
          calls.set(chunk.index, current)
          continue
        }
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          calls.set(chunk.index, {
            id: chunk.block.id ?? chunk.block.callId,
            name: chunk.block.name,
            arguments: typeof chunk.block.arguments === 'string'
              ? chunk.block.arguments
              : JSON.stringify(chunk.block.arguments ?? {}),
          })
          continue
        }
        if (chunk.type === 'usage') {
          usage = chunk.usage
          continue
        }
        if (chunk.type === 'finish') {
          // Record the refusal and keep draining instead of throwing here: throwing
          // out of `for await` abandons the adapter's generator mid-flight, leaving
          // its provider worker unreleased, and the NEXT call then fails with an
          // unrelated internal error. The refusal is raised after the stream ends.
          if (chunk.reason?.kind === 'error') {
            refusal = chunk.reason.failure
          }
        }
      }

      if (refusal !== undefined) {
        throw new Error(`模型调用被拒绝：${refusal.message ?? 'unknown'}`
          + `${refusal.code === undefined ? '' : ` [${String(refusal.code)}]`}`)
      }

      const finalText = [...blocks.entries()]
        .sort((left, right) => left[0] - right[0])
        .map((entry) => entry[1])
        .join('')
      const text_ = finalText.length > 0 ? finalText : text

      const toolCalls = [...calls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, value]) => ({ id: value.id, name: value.name, arguments: value.arguments }))
        .filter((call) => call.name !== '' && call.name !== STRUCTURED_TOOL_NAME)

      // A structured-output call answers through the schema tool; its arguments
      // ARE the object the caller wanted. This is checked before the empty-response
      // guard because such a reply carries no prose by design.
      const structuredCall = [...calls.values()].find((call) => call.name === STRUCTURED_TOOL_NAME)
      if (structuredCall !== undefined) {
        return { text: structuredCall.arguments, toolCalls: [], usage }
      }

      if (toolCalls.length === 0 && text_.trim() === '') {
        // Neither content nor a call: adapters report this as a bare finish, and
        // treating it as success would silently end a research branch with nothing.
        throw new Error('模型返回了空响应（既无文本也无工具调用）')
      }

      if (options.responseSchema !== undefined && toolCalls.length === 0 && text_.trim() !== '') {
        onWarn?.('deep research: model answered a structured request with text instead of a tool call')
      }

      return { text: text_, toolCalls, usage }
    }
  }
}

/**
 * Convert one graph message into a request message with DSH content blocks.
 *
 * The graph keeps messages in a flat `{role, content, toolCalls, toolCallId}` form
 * because that is what a provider-agnostic agent loop needs. DSH adapters require
 * the block form, so this is the one place the two vocabularies meet.
 *
 * @param {{role: string, content?: unknown, toolCalls?: Array<object>, toolCallId?: string}} message
 *   one graph message.
 * @returns {{role: string, content: object[]}} the request message.
 */
function toRequestMessage(message) {
  // `id` and `source` are required, not decorative: the adapter reads the answered
  // call id from `source.callId`, and DSH messages are identified by `id`. A
  // message without them survives the first turn but corrupts the adapter's
  // internal state, which then surfaces as an unrelated error on the next call.
  const id = `deep-${messageId++}`
  const text = String(message.content ?? '')

  if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return {
      id,
      role: 'assistant',
      source: { kind: 'model' },
      content: [
        ...(text === '' ? [] : [{ type: 'text', text }]),
        ...message.toolCalls.map((call) => ({
          type: 'tool-call',
          id: call.id,
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        })),
      ],
    }
  }
  if (message.role === 'tool') {
    return {
      id,
      role: 'tool',
      source: { kind: 'tool', callId: message.toolCallId },
      toolCallId: message.toolCallId,
      content: [{ type: 'text', text }],
    }
  }
  if (message.role === 'assistant') {
    return { id, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }
  }
  if (message.role === 'system') {
    return { id, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] }
  }
  return { id, role: message.role, source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** Name of the synthetic tool that carries a structured-output schema. */
const STRUCTURED_TOOL_NAME = 'respond_with_schema'

/** A no-op tool used when the caller supplied neither tools nor a schema. */
const STRUCTURED_NOOP = Object.freeze({
  name: 'noop',
  description: 'No action is needed. Do not call this tool; answer in plain text.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
})

/**
 * Express a JSON schema as a single required tool.
 *
 * Adapters that refuse a prompt-only request still accept a tool table, so a
 * structured-output call declares one tool whose parameters are the schema and
 * requires the model to call it.
 *
 * @param {object} schema - the JSON schema the reply must satisfy.
 * @returns {object} the tool declaration.
 */
function schemaTool(schema) {
  return {
    name: STRUCTURED_TOOL_NAME,
    description: 'Return the answer by calling this tool with the required fields.',
    parameters: schema,
  }
}

/**
 * Whether an error is a deterministic refusal.
 * @param {unknown} error - the failure.
 * @returns {boolean} `true` when retrying cannot help.
 */
function isRefusal(error) {
  const message = String(error?.message ?? '')
  return message.includes('模型调用被拒绝') || message.includes('no model route')
}

/**
 * Create a batch search seam over the host's `ctx.web`.
 *
 * The graph's search tool takes a query list, so one call fans out; `ctx.web.search`
 * takes one query, so this loops. A failing query yields an empty batch rather than
 * failing the whole tool call, matching `execute_tool_safely`.
 *
 * @param {object} web - the host's `ctx.web`.
 * @param {{maxResults?: number}} [defaults] - fallback result count.
 * @returns {(queries: string[], options: object) => Promise<Array<object>>} the seam.
 */
export function createSearchSeam(web, defaults = {}) {
  return async function search(queries, options = {}) {
    const maxResults = Number.isInteger(options.maxResults) ? options.maxResults : (defaults.maxResults ?? 5)
    /** How many results per query get their page fetched. */
    const fetchTop = Number.isInteger(options.fetchTop) ? options.fetchTop : (defaults.fetchTop ?? 3)
    /** Per-page character cap; a research note does not need the whole article. */
    const pageChars = Number.isInteger(options.pageChars) ? options.pageChars : (defaults.pageChars ?? 12000)

    const batches = []
    for (const query of queries) {
      try {
        const result = await web.search({ query, maxResults })
        const sources = Array.isArray(result?.sources) ? result.sources : []
        // A search provider may return titles and URLs with an empty summary —
        // the deep engine's whole loop is only as good as the text it can read, so
        // the top results have their page fetched. Without this the researcher
        // reasons over bare titles, which is exactly what produced a report whose
        // own first section warned that it could not read the sources.
        const enriched = await Promise.all(sources.map(async (source, index) => {
          const summary = String(source.summary ?? source.content ?? '')
          if (summary !== '' || index >= fetchTop || typeof web.fetch !== 'function') {
            return { url: source.url, title: source.title ?? source.url, content: summary }
          }
          try {
            const page = await web.fetch({ url: source.url })
            const body = page?.body ?? {}
            const raw = String(body.content ?? '')
            const text = body.kind === 'html' ? htmlToText(raw) : raw
            return {
              url: source.url,
              title: source.title ?? source.url,
              content: text.slice(0, pageChars),
            }
          } catch (error) {
            // A dead link is one unreadable source, not a failed search.
            return { url: source.url, title: source.title ?? source.url, content: '', error: String(error?.message ?? error) }
          }
        }))
        batches.push({ query, results: enriched })
      } catch (error) {
        batches.push({ query, results: [], error: String(error?.message ?? error) })
      }
    }
    return batches
  }
}

/**
 * Strip tags from HTML and collapse whitespace.
 *
 * The fetch seam returns HTML for most pages and the model needs prose. Script and
 * style bodies are dropped because they carry no evidence and consume context.
 *
 * @param {string} html - page source.
 * @returns {string} readable text.
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
