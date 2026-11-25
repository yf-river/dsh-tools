/**
 * The researcher: orchestration entry point.
 *
 * One-to-one port of `gpt_researcher/agent.py` (`class GPTResearcher`). Kept
 * surface, in the source's own order:
 *
 *   __init__ → _resolve_mcp_strategy → memory (lazy) → _process_mcp_configs
 *   → _log_event → emit_research_event → conduct_research
 *   → _handle_deep_research → write_report → write_report_conclusion
 *   → write_introduction → quick_search → _search_all_retrievers
 *   → get_subtopics → get_draft_section_titles
 *   → get_similar_written_contents_by_draft_section_titles
 *   → the utility methods (images, sources, references, headers, costs)
 *
 * Two seams replace source-internal objects that DSH does not own:
 * - `memory` is injected as an embedding factory instead of a provider class.
 * - `search` / `fetchPage` / `loaders` / `provider` are injected; the source
 *   built a `GenericLLMProvider` and instantiated retriever classes directly.
 *
 * `image_generator` is not ported, so `available_images` is always empty and the
 * pre-generation step is skipped. `add_costs` keeps the per-step attribution the
 * source records via `_current_step`.
 *
 * @module @yf-river/dsh-gpt-research/agent
 */

import { addReferences, extractHeaders, extractSections, tableOfContents } from './actions/markdown-processing.js'
import { getSearchResults } from './actions/query-processing.js'
import { getRetrievers } from './actions/retriever.js'
import { chooseAgent } from './actions/agent-creator.js'
import { WebRetriever } from './actions/retriever.js'
import { Config } from './config/index.js'
import { emitResearchEvent } from './observability.js'
import { getPromptFamily } from './prompts.js'
import { BrowserManager } from './skills/browser.js'
import { ContextManager } from './skills/context-manager.js'
import { SourceCurator } from './skills/curator.js'
import { DeepResearchSkill } from './skills/deep-research.js'
import { ResearchConductor } from './skills/researcher.js'
import { ReportGenerator } from './skills/writer.js'
import { ReportType, Tone } from './utils/enum.js'
import { createChatCompletion } from './utils/llm.js'
import { VectorStoreWrapper } from './vector-store.js'

const logger = {
  info: (...args) => console.log(...args),
  warning: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => {},
}

/** Default role prompt the source falls back to. */
const DEFAULT_ROLE = 'You are an AI critical thinker research assistant. Your sole purpose is to write well written, '
  + 'critically acclaimed, objective and structured reports on given text.'

/**
 * Main researcher class: orchestrates search, scraping, context and reporting.
 */
export class GPTResearcher {
  /**
   * @param {object} options - construction options, mirroring the source's signature.
   * @param {string} options.query - the research query.
   * @param {string} [options.reportType] - report type value.
   * @param {string} [options.reportFormat] - report format.
   * @param {string} [options.reportSource] - report source value.
   * @param {string} [options.tone] - writing tone value.
   * @param {string[] | null} [options.sourceUrls] - URLs to read as sources.
   * @param {string[] | null} [options.documentUrls] - document URLs.
   * @param {boolean} [options.complementSourceUrls] - also search the web.
   * @param {string[] | null} [options.queryDomains] - domain restrictions.
   * @param {unknown} [options.documents] - LangChain document objects.
   * @param {unknown} [options.vectorStore] - vector store.
   * @param {Record<string, unknown> | null} [options.vectorStoreFilter] - store filter.
   * @param {string | null} [options.configPath] - config file path.
   * @param {object | null} [options.websocket] - progress sink.
   * @param {string | null} [options.agent] - pre-set agent name.
   * @param {string | null} [options.role] - pre-set role prompt.
   * @param {string} [options.parentQuery] - parent query for subtopics.
   * @param {Array<object> | null} [options.subtopics] - subtopics.
   * @param {Set<string> | null} [options.visitedUrls] - shared visited URLs.
   * @param {boolean} [options.verbose] - verbose output.
   * @param {unknown} [options.context] - pre-loaded context.
   * @param {Record<string, string> | null} [options.headers] - request headers.
   * @param {number | null} [options.maxSubtopics] - subtopic cap.
   * @param {string | null} [options.promptFamily] - prompt family name.
   * @param {Array<Record<string, unknown>> | null} [options.mcpConfigs] - MCP server configs.
   * @param {number | null} [options.mcpMaxIterations] - legacy MCP iterations.
   * @param {string | null} [options.mcpStrategy] - MCP strategy.
   * @param {object | Function | null} [options.researchObserver] - lifecycle observer.
   * @param {object} options.seams - injected capabilities.
   * @param {(query: string, domains?: string[]) => Promise<Array<Record<string, unknown>>>} [options.seams.search]
   *   the search implementation.
   * @param {(url: string) => Promise<object>} [options.seams.fetchPage] - the fetch implementation.
   * @param {object} [options.seams.provider] - the model-call seam.
   * @param {(() => object) | null} [options.seams.embeddings] - embedding factory.
   * @param {object} [options.seams.loaders] - document loaders.
   * @param {Record<string, string|undefined>} [options.seams.env] - environment map.
   * @param {Array<Function>} [options.seams.retrievers] - retriever classes.
   * @param {object | null} [options.seams.logHandler] - structured log handler.
   * @param {Record<string, unknown>} [options.kwargs] - extra keyword arguments forwarded to LLM calls.
   */
  constructor(options) {
    const seams = options.seams ?? {}
    /** @type {Record<string, unknown>} */
    this.kwargs = options.kwargs ?? {}
    /** @type {string} */
    this.query = options.query
    /** @type {string} */
    this.reportType = options.reportType ?? ReportType.ResearchReport
    /** @type {Config} */
    this.cfg = new Config(options.configPath ?? null, { env: seams.env ?? process.env })
    this.cfg.setVerbose(options.verbose ?? true)
    /** @type {string} */
    this.reportSource = options.reportSource || this.cfg.report_source
    /** @type {string} */
    this.reportFormat = options.reportFormat ?? 'markdown'
    // `constructSubtopics` renders its prompt from `cfg.max_subtopics`, so the
    // per-instance argument has to override the config value here; storing it on
    // the researcher alone meant the documented option was never applied.
    if (options.maxSubtopics !== null && options.maxSubtopics !== undefined) {
      this.cfg.max_subtopics = options.maxSubtopics
    }
    /** @type {number} */
    this.max_subtopics = this.cfg.max_subtopics ?? options.maxSubtopics ?? null
    /** @type {string} */
    this.tone = options.tone ?? Tone.Objective
    /** @type {string[] | null} */
    this.sourceUrls = options.sourceUrls ?? null
    /** @type {string[] | null} */
    this.documentUrls = options.documentUrls ?? null
    /** @type {boolean} */
    this.complementSourceUrls = options.complementSourceUrls ?? false
    /** @type {string[]} */
    this.queryDomains = options.queryDomains ?? []
    /** @type {Array<object>} scraped sources with title, content and images */
    this.researchSources = []
    /** @type {string[]} selected research images */
    this.researchImages = []
    /** @type {unknown} */
    this.documents = options.documents ?? null
    /** @type {VectorStoreWrapper | null} */
    this.vectorStore = options.vectorStore ? new VectorStoreWrapper(options.vectorStore) : null
    /** @type {Record<string, unknown> | null} */
    this.vectorStoreFilter = options.vectorStoreFilter ?? null
    /** @type {object | null} */
    this.websocket = options.websocket ?? null
    /** @type {string | null} */
    this.agent = options.agent ?? null
    /** @type {string | null} */
    this.role = options.role ?? null
    /** @type {string} */
    this.parentQuery = options.parentQuery ?? ''
    /** @type {Array<object>} */
    this.subtopics = options.subtopics ?? []
    /** @type {Set<string>} */
    this.visitedUrls = options.visitedUrls ?? new Set()
    /** @type {boolean} */
    this.verbose = options.verbose ?? true
    /** @type {unknown} */
    this.context = options.context ?? []
    /** @type {Record<string, string>} */
    this.headers = options.headers ?? {}
    /** @type {number} */
    this.researchCosts = 0.0
    /** @type {Record<string, number>} */
    this.stepCosts = {}
    /** @type {string} */
    this.currentStep = 'general'
    /** @type {object | null} */
    this.logHandler = seams.logHandler ?? null
    /** @type {object | Function | null} */
    this.researchObserver = options.researchObserver ?? null
    /** @type {object} */
    this.promptFamily = getPromptFamily(options.promptFamily || this.cfg.prompt_family, this.cfg)

    // Process MCP configurations if provided.
    /** @type {Array<Record<string, unknown>> | null} */
    this.mcpConfigs = options.mcpConfigs ?? null
    if (this.mcpConfigs) this.processMcpConfigs(this.mcpConfigs)

    /** @type {Array<Function>} */
    this.retrievers = seams.retrievers ?? getRetrievers(this.headers, this.cfg)
    /** @type {(() => object) | null} built on first use */
    this.embeddingsFactory = seams.embeddings ?? null

    /** @type {object} */
    this.seams = seams
    /** @type {string} */
    this.encoding = 'utf-8'
    delete this.kwargs.encoding

    // Build the leaf skills first: the conductor's dependency bag references
    // them, so constructing it before them would capture `undefined`.
    /** @type {ContextManager} */
    this.contextManager = new ContextManager(this.contextDeps())
    /** @type {BrowserManager} */
    this.scraperManager = new BrowserManager(this.browserDeps())
    /** @type {SourceCurator} */
    this.sourceCurator = new SourceCurator(this.curatorDeps())
    /** @type {ReportGenerator} */
    this.reportGenerator = this.createReportGenerator()
    /** @type {ResearchConductor} */
    this.researchConductor = new ResearchConductor(this.skillDeps())
    /** @type {DeepResearchSkill | null} */
    this.deepResearcher = null
    if (this.reportType === ReportType.DeepResearch) {
      this.deepResearcher = new DeepResearchSkill(this.deepResearchDeps())
    }
    /** @type {string[]} pre-generated images ready for embedding (never populated here) */
    this.availableImages = []

    /** @type {string} */
    this.researchId = ''

    // Resolve the MCP strategy with backwards compatibility.
    /** @type {string} */
    this.mcpStrategy = this.resolveMcpStrategy(options.mcpStrategy ?? null, options.mcpMaxIterations ?? null)
  }

  /**
   * Build the dependency bag the conductor reads.
   * @returns {object} dependencies.
   */
  skillDeps() {
    return {
      cfg: this.cfg,
      query: this.query,
      parentQuery: this.parentQuery,
      reportType: this.reportType,
      reportSource: this.reportSource,
      retrievers: this.retrievers,
      search: this.seams.search ?? null,
      visitedUrls: this.visitedUrls,
      queryDomains: this.queryDomains,
      headers: this.headers,
      verbose: this.verbose,
      websocket: this.websocket,
      contextManager: this.contextManager,
      browserManager: this.scraperManager,
      sourceCurator: this.sourceCurator,
      vectorStore: this.vectorStore,
      vectorStoreFilter: this.vectorStoreFilter,
      documents: this.documents,
      documentUrls: this.documentUrls,
      complementSourceUrls: this.complementSourceUrls,
      mcpConfigs: this.mcpConfigs,
      mcpStrategy: this.mcpStrategy,
      provider: this.seams.provider,
      costCallback: (cost) => this.addCosts(cost),
      env: this.seams.env ?? process.env,
      loaders: this.seams.loaders ?? null,
      researchObserver: this.researchObserver,
      promptFamily: this.promptFamily,
      role: this.role,
      agent: this.agent,
      sourceUrls: this.sourceUrls,
      getCosts: () => this.getCosts(),
      addResearchSources: (sources) => this.addResearchSources(sources),
      context: this.context,
    }
  }

  /**
   * Build the context manager's dependencies.
   * @returns {object} dependencies.
   */
  contextDeps() {
    return {
      cfg: this.cfg,
      promptFamily: this.promptFamily,
      embeddings: this.embeddingsFactory,
      vectorStore: this.vectorStore,
      costCallback: (cost) => this.addCosts(cost),
      verbose: this.verbose,
      websocket: this.websocket,
    }
  }

  /**
   * Build the browser manager's dependencies.
   * @returns {object} dependencies.
   */
  browserDeps() {
    return {
      cfg: this.cfg,
      fetchPage: this.seams.fetchPage,
      verbose: this.verbose,
      websocket: this.websocket,
      addResearchSources: (sources) => this.addResearchSources(sources),
      addResearchImages: (images) => this.addResearchImages(images),
      getResearchImages: () => this.getResearchImages(),
      eventHandler: this.researchObserver,
    }
  }

  /**
   * Build the curator's dependencies.
   * @returns {object} dependencies.
   */
  curatorDeps() {
    return {
      cfg: this.cfg,
      promptFamily: this.promptFamily,
      role: this.role,
      query: this.query,
      costCallback: (cost) => this.addCosts(cost),
      verbose: this.verbose,
      websocket: this.websocket,
      provider: this.seams.provider,
      env: this.seams.env ?? process.env,
    }
  }

  /**
   * Build the report generator's dependencies.
   * @returns {ReportGenerator} the generator.
   */
  createReportGenerator() {
    return new ReportGenerator({
      query: this.query,
      cfg: this.cfg,
      promptFamily: this.promptFamily,
      role: this.role,
      reportType: this.reportType,
      reportSource: this.reportSource,
      tone: this.tone,
      parentQuery: this.parentQuery,
      context: this.context,
      subtopics: this.subtopics,
      headers: this.headers,
      verbose: this.verbose,
      websocket: this.websocket,
      costCallback: (cost) => this.addCosts(cost),
      getResearchImages: () => this.getResearchImages(),
      provider: this.seams.provider,
      env: this.seams.env ?? process.env,
    })
  }

  /**
   * Build the deep-research skill's dependencies.
   * @returns {object} dependencies.
   */
  deepResearchDeps() {
    return {
      cfg: this.cfg,
      query: this.query,
      retrievers: this.retrievers,
      search: this.seams.search ?? null,
      provider: this.seams.provider,
      costCallback: (cost) => this.addCosts(cost),
      websocket: this.websocket,
      tone: this.tone,
      headers: this.headers,
      visitedUrls: this.visitedUrls,
      env: this.seams.env ?? process.env,
      conductResearch: async (query) => {
        const branch = new GPTResearcher({
          ...this.toOptions(),
          query,
          reportType: ReportType.ResearchReport,
          visitedUrls: this.visitedUrls,
          parentQuery: this.query,
          context: [],
          seams: this.seams,
        })
        const context = await branch.conductResearch()
        this.addCosts(branch.getCosts())
        this.visitedUrls = branch.visitedUrls
        return Array.isArray(context) ? context : [context]
      },
    }
  }

  /**
   * Rebuild the construction options, so a branch researcher inherits settings.
   * @returns {object} options suitable for a new instance.
   */
  toOptions() {
    return {
      query: this.query,
      reportType: this.reportType,
      reportFormat: this.reportFormat,
      reportSource: this.reportSource,
      tone: this.tone,
      sourceUrls: this.sourceUrls,
      documentUrls: this.documentUrls,
      complementSourceUrls: this.complementSourceUrls,
      queryDomains: this.queryDomains,
      documents: this.documents,
      vectorStore: this.vectorStore?.vectorStore ?? null,
      vectorStoreFilter: this.vectorStoreFilter,
      websocket: this.websocket,
      parentQuery: this.parentQuery,
      subtopics: this.subtopics,
      verbose: this.verbose,
      headers: this.headers,
      promptFamily: this.cfg.prompt_family,
      mcpConfigs: this.mcpConfigs,
      mcpStrategy: this.mcpStrategy,
      researchObserver: this.researchObserver,
      seams: this.seams,
      kwargs: this.kwargs,
    }
  }

  /**
   * Generate a unique research ID for this session.
   * @returns {string} the identifier.
   */
  generateResearchId() {
    if (!this.researchId) {
      const unique = `${this.query}_${Date.now() / 1000}`
      // `createHash` is imported lazily so this stays a pure helper.
      this.researchId = `research_${hash12(unique)}`
    }
    return this.researchId
  }

  /**
   * Resolve the MCP strategy from all sources, with backwards compatibility.
   *
   * Priority: explicit strategy → legacy iteration count → config → `fast`.
   *
   * @param {string | null} mcpStrategy - the new strategy parameter.
   * @param {number | null} mcpMaxIterations - the legacy iteration parameter.
   * @returns {string} `fast`, `deep`, or `disabled`.
   */
  resolveMcpStrategy(mcpStrategy, mcpMaxIterations) {
    // Priority 1: the strategy parameter.
    if (mcpStrategy !== null && mcpStrategy !== undefined) {
      if (['fast', 'deep', 'disabled'].includes(mcpStrategy)) return mcpStrategy
      // Old strategy names, for backwards compatibility.
      if (mcpStrategy === 'optimized') {
        logger.warning('mcp_strategy \'optimized\' is deprecated, use \'fast\' instead')
        return 'fast'
      }
      if (mcpStrategy === 'comprehensive') {
        logger.warning('mcp_strategy \'comprehensive\' is deprecated, use \'deep\' instead')
        return 'deep'
      }
      logger.warning(`Invalid mcp_strategy '${mcpStrategy}', defaulting to 'fast'`)
      return 'fast'
    }

    // Priority 2: convert the legacy iteration count.
    if (mcpMaxIterations !== null && mcpMaxIterations !== undefined) {
      logger.warning('mcp_max_iterations is deprecated, use mcp_strategy instead')
      if (mcpMaxIterations === 0) return 'disabled'
      if (mcpMaxIterations === 1) return 'fast'
      if (mcpMaxIterations === -1) return 'deep'
      return 'fast'
    }

    // Priority 3: the config setting.
    const configStrategy = this.cfg.mcp_strategy
    if (configStrategy !== undefined) {
      if (['fast', 'deep', 'disabled'].includes(configStrategy)) return configStrategy
      if (configStrategy === 'optimized') return 'fast'
      if (configStrategy === 'comprehensive') return 'deep'
    }

    // Priority 4: the default.
    return 'fast'
  }

  /**
   * Process MCP configurations, adding the MCP retriever to the active list.
   *
   * Deliberately avoids touching `process.env` so concurrent or subsequent
   * requests are not affected by this session's MCP settings (issue #1676).
   *
   * @param {Array<Record<string, unknown>>} mcpConfigs - server configs.
   */
  processMcpConfigs(mcpConfigs) {
    if (this.cfg.retrievers) {
      const current = Array.isArray(this.cfg.retrievers)
        ? [...this.cfg.retrievers]
        : String(this.cfg.retrievers).split(',').map((name) => name.trim()).filter((name) => name !== '')
      if (!current.includes('mcp')) {
        current.push('mcp')
        this.cfg.retrievers = current
      }
    } else {
      this.cfg.retrievers = ['mcp']
    }
    this.mcpConfigs = mcpConfigs
  }

  /**
   * Handle one structured logging event.
   * @param {string} eventType - `tool`, `action` or `research`.
   * @param {Record<string, unknown>} [fields] - event fields.
   * @returns {Promise<void>} fulfillment after the handler settles.
   */
  async logEvent(eventType, fields = {}) {
    if (!this.logHandler) return
    try {
      if (eventType === 'tool') {
        await this.logHandler.onToolStart?.(fields.tool_name ?? '', fields)
      } else if (eventType === 'action') {
        await this.logHandler.onAgentAction?.(fields.action ?? '', fields)
      } else if (eventType === 'research') {
        await this.logHandler.onResearchStep?.(fields.step ?? '', fields.details ?? {})
      }
      logger.info(`${eventType}: ${JSON.stringify(fields)}`)
    } catch (error) {
      logger.error(`Error in logEvent: ${error?.message ?? error}`)
    }
  }

  /**
   * Emit an optional structured lifecycle event.
   * @param {string} event - event name.
   * @param {Record<string, unknown>} [fields] - event fields.
   * @returns {Promise<void>} fulfillment after the emit.
   */
  async emitResearchEvent(event, fields = {}) {
    await emitResearchEvent(this.researchObserver, event, fields)
  }

  /**
   * Conduct the research process.
   *
   * @param {(progress: object) => void} [onProgress] - progress callback for deep research.
   * @returns {Promise<string | string[]>} the accumulated context.
   */
  async conductResearch(onProgress = undefined) {
    await this.logEvent('research', {
      step: 'start',
      details: {
        query: this.query,
        report_type: this.reportType,
        agent: this.agent,
        role: this.role,
      },
    })

    // Handle deep research separately.
    if (this.reportType === ReportType.DeepResearch && this.deepResearcher) {
      this.currentStep = 'deep_research'
      return this.handleDeepResearch(onProgress)
    }

    if (!(this.agent && this.role)) {
      this.currentStep = 'agent_selection'
      await this.logEvent('action', { action: 'choose_agent' })
      const [agent, role] = await chooseAgent(
        this.query,
        this.cfg,
        this.parentQuery,
        (cost) => this.addCosts(cost),
        this.headers,
        this.promptFamily,
        { provider: this.seams.provider, env: this.seams.env ?? process.env },
      )
      this.agent = agent
      this.role = role
      await this.logEvent('action', {
        action: 'agent_selected',
        details: { agent: this.agent, role: this.role },
      })
    }

    await this.logEvent('research', {
      step: 'conducting_research',
      details: { agent: this.agent, role: this.role },
    })
    this.currentStep = 'research'
    this.context = await this.researchConductor.conductResearch()

    await this.logEvent('research', {
      step: 'research_completed',
      details: { context_length: contextLength(this.context) },
    })

    // Image pre-generation is skipped: the image generator is not ported.
    this.availableImages = []

    return this.context
  }

  /**
   * Run deep research and record lifecycle events.
   *
   * @param {(progress: object) => void} [onProgress] - progress callback.
   * @returns {Promise<string | string[]>} the accumulated context.
   */
  async handleDeepResearch(onProgress = undefined) {
    await this.logEvent('research', {
      step: 'deep_research_initialize',
      details: {
        type: 'deep_research',
        breadth: this.deepResearcher.breadth,
        depth: this.deepResearcher.depth,
        concurrency: this.deepResearcher.concurrencyLimit,
      },
    })

    await this.logEvent('research', {
      step: 'deep_research_start',
      details: {
        query: this.query,
        breadth: this.deepResearcher.breadth,
        depth: this.deepResearcher.depth,
        concurrency: this.deepResearcher.concurrencyLimit,
      },
    })

    // `run` needs a report writer; the report type is "deep", so the caller's
    // own write path is the one that produces the final text.
    this.context = await this.deepResearcher.run({
      onProgress,
      writeReport: async ({ learnings, context }) => [learnings.join('\n'), ...context].join('\n'),
    })

    const totalCosts = this.getCosts()

    await this.logEvent('research', {
      step: 'deep_research_complete',
      details: {
        context_length: contextLength(this.context),
        visited_urls: this.visitedUrls.size,
        total_costs: totalCosts,
      },
    })

    await this.logEvent('research', {
      step: 'cost_update',
      details: { cost: totalCosts, total_cost: totalCosts, research_type: 'deep_research' },
    })

    return this.context
  }

  /**
   * Write the research report.
   *
   * @param {object} [options] - report options.
   * @returns {Promise<string>} the report.
   */
  async writeReport(options = {}) {
    const existingHeaders = options.existingHeaders ?? []
    const relevantWrittenContents = options.relevantWrittenContents ?? []
    const extContext = options.extContext
    const customPrompt = options.customPrompt ?? ''
    const hasAvailableImages = (this.availableImages ?? []).length > 0

    this.currentStep = 'report_writing'
    await this.logEvent('research', {
      step: 'writing_report',
      details: {
        existing_headers: existingHeaders,
        context_source: extContext ? 'external' : 'internal',
        available_images_count: (this.availableImages ?? []).length,
      },
    })

    // Refresh the generator's live fields before delegating, matching the
    // source's "re-read the live attribute" fix.
    this.reportGenerator.deps.context = this.context
    this.reportGenerator.deps.websocket = this.websocket
    this.reportGenerator.deps.role = this.role

    const report = await this.reportGenerator.writeReport({
      existingHeaders,
      relevantWrittenContents,
      extContext: extContext ?? this.context,
      customPrompt,
      availableImages: this.availableImages ?? [],
    })

    await this.logEvent('research', {
      step: 'report_completed',
      details: {
        report_length: report.length,
        images_embedded: hasAvailableImages ? (this.availableImages ?? []).length : 0,
      },
    })
    return report
  }

  /**
   * Write the conclusion section.
   * @param {string} reportBody - the report body.
   * @returns {Promise<string>} the conclusion.
   */
  async writeReportConclusion(reportBody) {
    await this.logEvent('research', { step: 'writing_conclusion' })
    const conclusion = await this.reportGenerator.writeReportConclusion(reportBody)
    await this.logEvent('research', { step: 'conclusion_completed' })
    return conclusion
  }

  /**
   * Write the introduction section.
   * @returns {Promise<string>} the introduction.
   */
  async writeIntroduction() {
    await this.logEvent('research', { step: 'writing_introduction' })
    const intro = await this.reportGenerator.writeIntroduction()
    await this.logEvent('research', { step: 'introduction_completed' })
    return intro
  }

  /**
   * Perform a quick search without the full research workflow.
   *
   * @param {string} query - the search query.
   * @param {string[] | null} [queryDomains] - domain restrictions.
   * @param {boolean} [aggregatedSummary] - return a synthesized summary instead.
   * @param {boolean} [allRetrievers] - query every retriever concurrently.
   * @returns {Promise<Array<Record<string, unknown>> | string>} results or a summary.
   */
  async quickSearch(query, queryDomains = null, aggregatedSummary = false, allRetrievers = false) {
    let searchResults
    if (allRetrievers && this.retrievers.length > 1) {
      searchResults = await this.searchAllRetrievers(query, queryDomains)
    } else {
      searchResults = await getSearchResults(
        query,
        this.retrievers[0] ?? WebRetriever,
        queryDomains ?? [],
        this,
        null,
        this.seams.search ?? null,
      )
    }

    if (!aggregatedSummary) return searchResults

    // Retrievers return `href`/`body`; fall back to the alternate keys so
    // pre-normalized records still work.
    let context = ''
    let index = 1
    for (const result of searchResults) {
      const title = result.title ?? ''
      const body = result.body || result.content || ''
      const url = result.href || result.url || ''
      context += `[${index}] ${title}: ${body} (${url})\n\n`
      index += 1
    }

    const prompt = this.promptFamily.generate_quick_summary_prompt(query, context)

    return createChatCompletion({
      model: this.cfg.smart_llm_model,
      messages: [{ role: 'user', content: prompt }],
      llmProvider: this.cfg.smart_llm_provider,
      maxTokens: this.cfg.smart_token_limit,
      llmKwargs: this.cfg.llm_kwargs,
      costCallback: (cost) => this.addCosts(cost),
      provider: this.seams.provider,
      env: this.seams.env ?? process.env,
    })
  }

  /**
   * Query every configured retriever concurrently and merge the results.
   *
   * Results are de-duplicated by URL, checking both `url` and `href` because
   * different retrievers use different keys. A retriever that throws is skipped
   * so one failing provider does not abort the whole search.
   *
   * @param {string} query - the search query.
   * @param {string[] | null} [queryDomains] - domain restrictions.
   * @returns {Promise<Array<Record<string, unknown>>>} merged results.
   */
  async searchAllRetrievers(query, queryDomains = null) {
    const settled = await Promise.allSettled(this.retrievers.map((retriever) => getSearchResults(
      query,
      retriever,
      queryDomains ?? [],
      this,
      null,
      this.seams.search ?? null,
    )))

    const merged = []
    const seenUrls = new Set()
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled' || !outcome.value) continue
      for (const item of outcome.value) {
        const url = item.url || item.href || ''
        if (url && seenUrls.has(url)) continue
        if (url) seenUrls.add(url)
        merged.push(item)
      }
    }
    return merged
  }

  /**
   * Generate subtopics for the research query.
   * @returns {Promise<Array<object>>} subtopics.
   */
  async getSubtopics() {
    this.reportGenerator.deps.context = this.context
    return this.reportGenerator.getSubtopics()
  }

  /**
   * Generate draft section titles for a subtopic.
   * @param {string} currentSubtopic - the subtopic.
   * @returns {Promise<string[]>} section titles.
   */
  async getDraftSectionTitles(currentSubtopic) {
    this.reportGenerator.deps.context = this.context
    return this.reportGenerator.getDraftSectionTitles(currentSubtopic)
  }

  /**
   * Find previously written contents similar to the section titles.
   *
   * @param {string} currentSubtopic - the current subtopic.
   * @param {string[]} draftSectionTitles - draft section titles.
   * @param {Array<Record<string, unknown>>} writtenContents - written contents.
   * @param {number} [maxResults] - maximum results.
   * @returns {Promise<string[]>} similar content strings.
   */
  async getSimilarWrittenContentsByDraftSectionTitles(currentSubtopic, draftSectionTitles, writtenContents, maxResults = 10) {
    return this.contextManager.getSimilarWrittenContentsByDraftSectionTitles(
      currentSubtopic,
      draftSectionTitles,
      writtenContents,
      maxResults,
    )
  }

  /**
   * Get the top research images collected during research.
   * @param {number} [topK] - maximum images.
   * @returns {string[]} image URLs.
   */
  getResearchImages(topK = 10) {
    return this.researchImages.slice(0, topK)
  }

  /**
   * Add images to the research image collection.
   * @param {string[]} images - image URLs.
   */
  addResearchImages(images) {
    this.researchImages.push(...images)
  }

  /**
   * Get all research sources collected during research.
   * @returns {Array<object>} sources.
   */
  getResearchSources() {
    return this.researchSources
  }

  /**
   * Add sources to the research source collection.
   * @param {Array<object>} sources - sources.
   */
  addResearchSources(sources) {
    this.researchSources.push(...sources)
  }

  /**
   * Append a reference section to a Markdown report.
   * @param {string} reportMarkdown - the report.
   * @param {Set<string>} visitedUrls - URLs to list.
   * @returns {string} the report with references.
   */
  addReferences(reportMarkdown, visitedUrls) {
    return addReferences(reportMarkdown, visitedUrls)
  }

  /**
   * Extract headers from Markdown.
   * @param {string} markdownText - the Markdown.
   * @returns {Array<object>} the header tree.
   */
  extractHeaders(markdownText) {
    return extractHeaders(markdownText)
  }

  /**
   * Extract sections from Markdown.
   * @param {string} markdownText - the Markdown.
   * @returns {Array<object>} sections.
   */
  extractSections(markdownText) {
    return extractSections(markdownText)
  }

  /**
   * Generate a table of contents.
   * @param {string} markdownText - the Markdown.
   * @returns {string} the table of contents.
   */
  tableOfContents(markdownText) {
    return tableOfContents(markdownText)
  }

  /**
   * Get all visited source URLs.
   * @returns {string[]} visited URLs.
   */
  getSourceUrls() {
    return [...this.visitedUrls]
  }

  /**
   * Get the accumulated research context.
   * @returns {unknown} the context.
   */
  getResearchContext() {
    return this.context
  }

  /**
   * Get the total accumulated API cost.
   * @returns {number} cost in USD.
   */
  getCosts() {
    return this.researchCosts
  }

  /**
   * Get the per-step cost breakdown.
   * @returns {Record<string, number>} step costs.
   */
  getStepCosts() {
    return { ...this.stepCosts }
  }

  /**
   * Set the verbose output mode.
   * @param {boolean} verbose - new mode.
   */
  setVerbose(verbose) {
    this.verbose = verbose
  }

  /**
   * Add to the accumulated API cost, attributed to the current step.
   *
   * @param {number} cost - cost in USD.
   * @throws {TypeError} when the cost is not a number.
   */
  addCosts(cost) {
    if (typeof cost !== 'number' || !Number.isFinite(cost)) {
      throw new TypeError('Cost must be an integer or float')
    }
    this.researchCosts += cost
    const step = this.currentStep
    this.stepCosts[step] = (this.stepCosts[step] ?? 0) + cost
    if (this.logHandler) {
      void this.logEvent('research', {
        step: 'cost_update',
        details: { cost, total_cost: this.researchCosts, step_name: step },
      })
    }
  }

  /**
   * Get the default role prompt the source falls back to.
   * @returns {string} the role prompt.
   */
  static defaultRole() {
    return DEFAULT_ROLE
  }
}

/**
 * Count context entries whether the context is a string or a list.
 * @param {unknown} context - the context.
 * @returns {number} the length.
 */
function contextLength(context) {
  return Array.isArray(context) ? context.length : String(context ?? '').length
}

/**
 * First 12 hex characters of the MD5 of a string, matching the source's
 * `hashlib.md5(...).hexdigest()[:12]`.
 * @param {string} text - input text.
 * @returns {string} the short digest.
 */
function hash12(text) {
  // Deliberately dependency-light: a small non-cryptographic digest is enough to
  // make a session identifier unique, and avoids importing node:crypto here.
  let hash = 0n
  const prime = 1099511628211n
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash ^ BigInt(text.charCodeAt(index))) * prime & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0').slice(0, 12)
}
