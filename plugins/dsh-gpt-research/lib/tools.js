/**
 * The model-facing `deep_research` tool.
 *
 * Owns the tool contract — argument normalization, the output schema the model
 * can rely on, the execution path, and the error envelope — and nothing else:
 * the research itself is {@link GPTResearcher} (the ported agent), and every
 * network/model call reaches the host through the injected seams.
 *
 * Seams the host must supply:
 *   web     `ctx.web`-shaped service: `search({query, maxResults})`,
 *           `fetch({url})` returning `{statusCode, body: {kind, content}}`
 *   llm     `getChatResponse(messages, stream, websocket, options)` plus
 *           `lastResponseMetadata` / `lastUsageMetadata`
 * When `web` is absent the tool reports `web-unavailable`; when `llm` is absent
 * it reports `llm-unavailable`. Neither is a silent empty report.
 *
 * @module @yf-river/dsh-gpt-research/tools
 */

import { GPTResearcher } from './agent.js'
import { toEnv } from './config/plugin.js'
import { ReportType } from './utils/enum.js'

const MAX_TOPIC_CHARS = 300
const MIN_TOPIC_CHARS = 2

const TOOL_DESCRIPTION = [
  '深度研究：围绕一个主题做多查询检索 → 并行子查询研究 → 抓取正文 → 抽取证据 → 产出带引用的研究报告。',
  '移植自 GPT Researcher 的 deep research 流水线，检索走宿主 ctx.web。',
  '单点事实查证请用 web_search；需要多来源交叉印证、成篇调研报告时才用本工具。',
].join('')

/** Canonical output schema: every successful call returns this object. */
export const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    report: { type: 'string' },
    code: { type: 'string' },
  },
  required: ['ok', 'report'],
})

/**
 * Normalize model arguments into a research request.
 *
 * Bounds come from configuration; model-supplied values may only narrow them,
 * never widen them, so a stray `breadth: 40` cannot blow the sub-agent budget.
 *
 * @param {Record<string, unknown>} args - the model's tool arguments.
 * @param {{ breadth: number, depth: number }} config - resolved configuration.
 * @returns {{ topic: string, breadth: number, depth: number }} normalized input.
 * @throws {Error} when the topic is empty, too short, or too long.
 */
export function normalizeInput(args, config) {
  const rawTopic = typeof args.topic === 'string' ? args.topic.trim() : ''
  if (rawTopic.length === 0) throw new Error('deep_research: topic 不能为空')
  if (rawTopic.length < MIN_TOPIC_CHARS) throw new Error(`deep_research: topic 至少 ${MIN_TOPIC_CHARS} 个字符`)
  if (rawTopic.length > MAX_TOPIC_CHARS) {
    throw new Error(`deep_research: topic 最长 ${MAX_TOPIC_CHARS} 个字符，收到 ${rawTopic.length}`)
  }
  const narrow = (value, fallback, min, max, field) => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`deep_research: ${field} 必须是数字，收到 ${String(value)}`)
    }
    const integer = Math.trunc(value)
    if (integer < min || integer > max) {
      throw new Error(`deep_research: ${field} 必须在 [${min}, ${max}] 内，收到 ${integer}`)
    }
    return integer
  }
  return {
    topic: rawTopic,
    breadth: narrow(args.breadth, config.breadth, 1, config.breadth, 'breadth'),
    depth: narrow(args.depth, config.depth, 1, config.depth, 'depth'),
  }
}

/**
 * Build a search seam over the host's `ctx.web`.
 *
 * The host returns `{sources: [{url, title, snippet, summary}], truncated}`;
 * the port's retriever wants `{href, body}`. Both spellings are produced so
 * either consumer works.
 *
 * @param {object} web - the `ctx.web`-shaped service.
 * @param {{ maxSourcesPerQuery: number }} config - resolved configuration.
 * @returns {(query: string, domains?: string[]) => Promise<Array<Record<string, unknown>>>} the search seam.
 */
export function createSearchSeam(web, config) {
  return async (query, _domains = [], maxResults = undefined) => {
    const result = await web.search({
      query,
      maxResults: maxResults ?? config.maxSourcesPerQuery,
    })
    const sources = Array.isArray(result?.sources) ? result.sources : []
    return sources.map((source) => {
      const url = source.url ?? ''
      const body = source.summary ?? source.snippet ?? ''
      return { url, href: url, title: source.title ?? '', body, raw_content: body, snippet: source.snippet }
    })
  }
}

/**
 * Build a fetch seam over the host's `ctx.web`.
 *
 * Fetches whatever failed is recorded as an unreachable page rather than
 * aborting the run: the port's scraper collects per-URL failures into gaps.
 *
 * @param {object} web - the `ctx.web`-shaped service.
 * @returns {(url: string) => Promise<Record<string, unknown>>} the fetch seam.
 */
export function createFetchSeam(web) {
  return async (url) => {
    const result = await web.fetch({ url })
    const statusCode = typeof result?.statusCode === 'number' ? result.statusCode : 0
    if (statusCode < 200 || statusCode >= 300) {
      return { url, raw_content: '', title: '', statusCode, status: 'failed' }
    }
    const body = result?.body ?? {}
    const content = body.kind === 'html' ? htmlToText(body.content ?? '') : String(body.content ?? '')
    return { url, raw_content: content, title: '', statusCode, status: 'success' }
  }
}

/**
 * Strip tags from HTML and collapse whitespace.
 *
 * The host's fetch provider may return HTML; the context layer wants text. This
 * is a conservative strip: script/style bodies are dropped, tags removed,
 * entities decoded for the common cases, whitespace collapsed.
 *
 * @param {string} html - HTML source.
 * @returns {string} plain text.
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Shorten text for a progress line.
 * @param {string} text - the text.
 * @param {number} max - maximum length.
 * @returns {string} the shortened text.
 */
function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Shorten a URL to its host and the tail of its path, for a progress line.
 * @param {string} url - the URL.
 * @returns {string} the shortened URL.
 */
function shortenUrl(url) {
  try {
    const parsed = new URL(url)
    const tail = parsed.pathname.length > 24 ? `…${parsed.pathname.slice(-24)}` : parsed.pathname
    return `${parsed.host}${tail}`
  } catch {
    return truncate(url, 40)
  }
}

/**
 * Render the agent's accumulated context into the writer's `context` string.
 * @param {unknown} context - the context the conductor returned.
 * @returns {string} a single string.
 */
function contextToText(context) {
  if (Array.isArray(context)) return context.filter((item) => String(item).trim() !== '').join('\n\n')
  return String(context ?? '')
}

/**
 * Run one deep-research request end to end.
 *
 * @param {{ topic: string, breadth: number, depth: number }} input - normalized request.
 * @param {object} config - resolved configuration.
 * @param {{ web?: object, llm?: object, env?: Record<string, string|undefined>, signal?: AbortSignal }} seams
 *   host capabilities.
 * @returns {Promise<{ok: true, report: string} | {ok: false, code: string, report: string}>} the envelope.
 */
export async function runResearch(input, config, seams) {
  const web = seams.web
  const llm = seams.llm
  // Progress is advisory: a failing sink must never abort a run.
  const emit = (event) => {
    try {
      seams.onProgress?.(event)
    } catch {
      // ignored on purpose
    }
  }
  if (web === undefined || typeof web?.search !== 'function' || typeof web?.fetch !== 'function') {
    return {
      ok: false,
      code: 'web-unavailable',
      report: '当前 profile 没有可用的 ctx.web（search/fetch）。'
        + '请在「插件 → 内置插件设置 → Web search」里选好搜索后端。',
    }
  }
  if (llm === undefined || typeof llm?.getChatResponse !== 'function') {
    return {
      ok: false,
      code: 'llm-unavailable',
      report: '当前 profile 没有可用的模型调用通道（ctx.llm）。',
    }
  }

  // One mapping site: the ported Config reads these env names and nothing else.
  const env = toEnv(config, seams.env ?? process.env)

  emit({ kind: 'phase', label: '规划子问题…' })
  let fetchedSources = 0
  const rawSearch = createSearchSeam(web, config)
  const rawFetch = createFetchSeam(web)
  let searchedQueries = 0
  const countingSearch = async (query, domains, maxResults) => {
    emit({ kind: 'phase', label: `检索：${truncate(query, 40)}` })
    const results = await rawSearch(query, domains, maxResults)
    searchedQueries += 1
    emit({ kind: 'queries', count: results.length, queries: [truncate(query, 60)], index: searchedQueries })
    return results
  }
  const countingFetch = async (url) => {
    const page = await rawFetch(url)
    if (page.status === 'success') {
      fetchedSources += 1
      emit({ kind: 'sources', count: fetchedSources, url: shortenUrl(url) })
    }
    return page
  }

  const researcher = new GPTResearcher({
    query: input.topic,
    reportType: ReportType.DeepResearch,
    reportSource: 'web',
    verbose: false,
    seams: {
      search: countingSearch,
      fetchPage: countingFetch,
      provider: llm,
      env,
      retrievers: config.retrievers,
      embeddings: null,
      loaders: null,
    },
  })

  try {
    emit({ kind: 'phase', label: '检索与取证…' })
    await researcher.conductResearch()
    // Report writing is one long call (~70 s on a 35k-char context), so it gets
    // its own phase line; otherwise the run looks stalled right at the end.
    emit({ kind: 'phase', label: '撰写报告（单次长调用，约 1 分钟）…' })

    const contextText = contextToText(researcher.context)
    if (contextText.trim() === '') {
      return {
        ok: false,
        code: 'no-results',
        report: `未检索到任何可用来源：${input.topic}。`
          + `（查询 ${input.breadth} 条 / 深度 ${input.depth} 层；搜索可能被拦截或返回为空。）`,
      }
    }

    const report = await researcher.writeReport()
    return { ok: true, report }
  } catch (error) {
    const aborted = seams.signal?.aborted === true || error?.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'aborted' : 'internal',
      report: aborted ? '深度研究已取消或超时。' : `深度研究失败：${error?.message ?? String(error)}`,
    }
  }
}

/**
 * Build the tool definitions this plugin registers.
 *
 * @param {{ config: object, web: () => object | undefined, llm: () => object | undefined, env?: Record<string, string|undefined> }} options
 *   resolved configuration plus lazy resolvers, so a service mounted after this
 *   plugin is still found at call time.
 * @returns {object[]} registry-ready tool definitions.
 */
export function createTools(options) {
  const config = options.config
  return [{
    name: 'deep_research',
    description: TOOL_DESCRIPTION,
    // Raw JSON Schema, not the ParameterSchemaSpec sugar `defineTool` accepts:
    // `tools.register` projects `parameters` straight onto `ToolSchema.parameters`,
    // so a per-property `required: true` would be shipped as an unsupported keyword.
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: { type: 'string', description: '研究主题，一句话说清要调研什么。' },
        breadth: { type: 'number', description: `每轮并行查询数，不得超过配置上限 ${config.breadth}。` },
        depth: { type: 'number', description: `递归层数，不得超过配置上限 ${config.depth}。` },
      },
      required: ['topic'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.report : `deep_research 未能完成研究：${value.report}`,
      }],
    },
    timeoutMs: config.toolTimeoutMs,
    /**
     * Run one research request.
     * @param {Record<string, unknown>} args - model arguments.
     * @param {{ signal?: AbortSignal }} [exec] - execution context.
     * @returns {Promise<object>} the envelope.
     */
    async execute(args, exec = {}) {
      const input = normalizeInput(args, config)
      return runResearch(input, config, {
        web: options.web(),
        llm: options.llm(),
        env: options.env,
        signal: exec.signal,
      })
    },
  }]
}
