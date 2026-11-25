/**
 * Research conductor skill.
 *
 * One-to-one port of `gpt_researcher/skills/researcher.py`: the initial search,
 * the outline planning, the six report-source branches, the per-sub-query
 * pipeline (search → dedupe against visited URLs → scrape → compress → combine),
 * the MCP strategy handling with its cache, and the source-curation normalization.
 *
 * Deliberate structural changes, each forced by the missing `GPTResearcher`:
 * - The god object becomes a dependency bag (`deps`). Every field the source read
 *   as `self.researcher.x` is a named field here; `deps` is mutable so a caller
 *   can change `verbose`/`websocket` mid-run exactly as the source allowed.
 * - `DocumentLoader` / `AzureDocumentLoader` / `LangChainDocumentLoader` are
 *   injected loaders. The Port drops the document module (no local-document
 *   research), so those branches throw a named error when a loader is absent
 *   rather than silently returning empty context.
 * - `asyncio.to_thread` around the MCP search becomes a direct await, because
 *   the injected retriever is already async.
 *
 * @module @yf-river/dsh-gpt-research/skills/researcher
 */

import { chooseAgent } from '../actions/agent-creator.js'
import { getSearchResults, planResearchOutline } from '../actions/query-processing.js'
import { streamOutput } from '../actions/utils.js'
import { ReportSource, ReportType } from '../utils/enum.js'

const logger = {
  info: (...args) => console.log(...args),
  warning: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => {},
}

/** Report sources that need document loading. */
const DOCUMENT_SOURCES = new Set([
  ReportSource.Local,
  ReportSource.Hybrid,
  ReportSource.Azure,
  ReportSource.LangChainDocuments,
  ReportSource.LangChainVectorStore,
])

/**
 * Manages and coordinates the research process.
 */
export class ResearchConductor {
  /**
   * @param {object} deps - researcher state and seams.
   * @param {object} deps.cfg - resolved config.
   * @param {string} deps.query - the research query.
   * @param {string | null} [deps.parentQuery] - the parent query.
   * @param {string} [deps.reportType] - report type value.
   * @param {string} [deps.reportSource] - report source value.
   * @param {Function[]} [deps.retrievers] - retriever classes.
   * @param {Function | null} [deps.search] - the search implementation.
   * @param {Set<string>} [deps.visitedUrls] - visited URL set.
   * @param {string[]} [deps.queryDomains] - query domain restrictions.
   * @param {object | null} [deps.headers] - request headers.
   * @param {boolean} [deps.verbose] - whether to stream progress.
   * @param {object | null} [deps.websocket] - progress sink.
   * @param {object} [deps.contextManager] - context manager skill.
   * @param {object} [deps.browserManager] - browser manager skill.
   * @param {object} [deps.sourceCurator] - source curator skill.
   * @param {object | null} [deps.vectorStore] - vector store seam.
   * @param {Record<string, unknown> | null} [deps.vectorStoreFilter] - vector store filter.
   * @param {Array<unknown>} [deps.documents] - LangChain documents.
   * @param {string[]} [deps.documentUrls] - document URLs.
   * @param {boolean} [deps.complementSourceUrls] - also search the web for provided URLs.
   * @param {Array<object>} [deps.mcpConfigs] - MCP server configs.
   * @param {string | null} [deps.mcpStrategy] - MCP strategy override.
   * @param {object} [deps.provider] - the model-call seam.
   * @param {((cost: number) => void) | null} [deps.costCallback] - cost sink.
   * @param {Record<string, string|undefined>} [deps.env] - environment map.
   * @param {object} [deps.loaders] - document loaders for the non-web branches.
   * @param {object | null} [deps.researchObserver] - progress observer.
   */
  constructor(deps) {
    /** @type {object} */
    this.deps = deps
    /** @type {object} */
    this.logger = logger
    // No research-transcript writer: DSH already records every tool call and
    // model request in the Session log, so a second JSON transcript would
    // duplicate it. The source's `jsonHandler` guards are therefore gone.
    // Cache for MCP results, to avoid redundant calls.
    /** @type {Array<object> | null} */
    this.mcpResultsCache = null
    /** @type {Promise<void>} guards cache population under concurrent passes */
    this.mcpCacheTail = Promise.resolve()
    /** @type {number} MCP query count for balanced mode */
    this.mcpQueryCount = 0
  }

  /**
   * Emit through an optional observer without requiring a researcher object.
   * @param {string} event - event name.
   * @param {Record<string, unknown>} [fields] - event fields.
   * @returns {Promise<void>} fulfillment after the emit.
   */
  async emitResearchEvent(event, fields = {}) {
    const observer = this.deps.researchObserver
    if (!observer || typeof observer.emit !== 'function') return
    try {
      await observer.emit(event, fields)
    } catch {
      // Observers are advisory; a failing one must not abort research.
    }
  }

  /**
   * Run the first search that informs planning.
   *
   * @param {string} query - the query.
   * @param {string[]} [queryDomains] - domain restrictions.
   * @returns {Promise<Array<Record<string, unknown>>>} search results.
   */
  async getInitialSearchResults(query, queryDomains = []) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'planning_research',
        `🌐 Browsing the web to learn more about the task: ${query}...`,
        this.deps.websocket ?? null,
      )
    }

    const retriever = this.deps.retrievers?.[0]
    if (retriever === undefined) {
      throw new Error('ResearchConductor: no retriever is configured')
    }
    try {
      return await getSearchResults(
        query,
        retriever,
        queryDomains,
        this.deps,
        this.deps.cfg.max_search_results_per_query,
        this.deps.search ?? null,
      )
    } catch (error) {
      await this.emitResearchEvent('search_failed', {
        query,
        provider: retriever?.name ?? String(retriever),
        reason_code: error?.constructor?.name ?? 'Error',
      })
      throw error
    }
  }

  /**
   * Plan sub-queries, optionally using results already obtained for this pass.
   *
   * @param {string} query - the query.
   * @param {string[]} [queryDomains] - domain restrictions.
   * @param {{searchResults?: Array<Record<string, unknown>>}} [options] - pre-fetched results.
   * @returns {Promise<string[]>} planned sub-queries.
   */
  async planResearch(query, queryDomains = [], options = {}) {
    const searchResults = options.searchResults ?? await this.getInitialSearchResults(query, queryDomains)

    await streamOutput(
      'logs',
      'planning_research',
      '🤔 Planning the research strategy and subtasks...',
      this.deps.websocket ?? null,
    )

    const retrieverNames = (this.deps.retrievers ?? []).map((retriever) => retriever?.name ?? String(retriever))

    const outline = await planResearchOutline(
      query,
      searchResults,
      this.deps.role,
      this.deps.cfg,
      this.deps.parentQuery,
      this.deps.reportType,
      this.deps.costCallback ?? null,
      retrieverNames,
      {
        promptFamily: this.deps.promptFamily,
        provider: this.deps.provider,
        env: this.deps.env,
      },
    )
    let position = 1
    for (const plannedQuery of outline) {
      await this.emitResearchEvent('query_planned', { query: plannedQuery, position })
      position += 1
    }
    logger.info(`Research outline planned: ${outline}`)
    return outline
  }

  /**
   * Run the whole research pass for the configured report source.
   *
   * @returns {Promise<string | string[]>} the gathered context.
   */
  async conductResearch() {
    logger.info(`Starting research for query: ${this.deps.query}`)
    const retrieverNames = (this.deps.retrievers ?? []).map((retriever) => retriever?.name ?? String(retriever))
    logger.info(`Active retrievers: ${retrieverNames}`)

    // `visited_urls` is deliberately not cleared here: it may be shared with a
    // parent researcher, so already-scraped URLs are not fetched again.
    let researchData

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'starting_research',
        `🔍 Starting the research task for '${this.deps.query}'...`,
        this.deps.websocket ?? null,
      )
    }

    // Choose agent and role if not already defined.
    if (!this.deps.agent || !this.deps.role) {
      const [agent, role] = await chooseAgent(
        this.deps.query,
        this.deps.cfg,
        this.deps.parentQuery,
        this.deps.costCallback ?? null,
        this.deps.headers ?? null,
        this.deps.promptFamily,
        { provider: this.deps.provider, env: this.deps.env },
      )
      this.deps.agent = agent
      this.deps.role = role
    }

    if (this.deps.sourceUrls && this.deps.sourceUrls.length > 0) {
      logger.info('Using provided source URLs')
      researchData = await this.getContextByUrls(this.deps.sourceUrls)
      if ((!researchData || researchData.length === 0) && this.deps.verbose) {
        await streamOutput(
          'logs',
          'answering_from_memory',
          '🧐 I was unable to find relevant context in the provided sources...',
          this.deps.websocket ?? null,
        )
      }
      if (this.deps.complementSourceUrls) {
        logger.info('Complementing with web search')
        const additionalResearch = await this.getContextByWebSearch(this.deps.query, [], this.deps.queryDomains ?? [])
        researchData = [researchData, additionalResearch].filter((part) => part).join(' ')
      }
    } else if (this.deps.reportSource === ReportSource.Web) {
      logger.info('Using web search with all configured retrievers')
      researchData = await this.getContextByWebSearch(this.deps.query, [], this.deps.queryDomains ?? [])
    } else if (this.deps.reportSource === ReportSource.Local) {
      researchData = await this.conductLocal(this.deps.query, [])
    } else if (this.deps.reportSource === ReportSource.Hybrid) {
      const [docsContext, webContext] = await Promise.all([
        this.conductLocal(this.deps.query, []),
        this.getContextByWebSearch(this.deps.query, [], this.deps.queryDomains ?? []),
      ])
      // A pass that finds nothing returns []. Joining that would put "[]" in the
      // prompt, and a context made only of labels would defeat the empty-context
      // check when the report is written.
      if ((Array.isArray(docsContext) ? docsContext.length > 0 : docsContext) || (Array.isArray(webContext) ? webContext.length > 0 : webContext)) {
        researchData = this.deps.promptFamily.join_local_web_documents(docsContext || '', webContext || '')
      }
    } else if (this.deps.reportSource === ReportSource.Azure) {
      researchData = await this.conductAzure(this.deps.query)
    } else if (this.deps.reportSource === ReportSource.LangChainDocuments) {
      researchData = await this.conductLangChainDocuments(this.deps.query)
    } else if (this.deps.reportSource === ReportSource.LangChainVectorStore) {
      researchData = await this.getContextByVectorstore(this.deps.query, this.deps.vectorStoreFilter)
    }

    // Rank and curate the sources.
    this.deps.context = researchData
    if (this.deps.cfg.curate_sources) {
      logger.info('Curating sources')
      const curated = await this.deps.sourceCurator.curateSources(researchData)
      // curate_sources() returns a list of dicts with Title/Content/Source keys.
      // Normalize to a string so downstream code expecting a string does not crash.
      if (Array.isArray(curated)) {
        this.deps.context = curated
          .map((source) => (source !== null && typeof source === 'object' && !Array.isArray(source)
            ? `Title: ${source.Title ?? ''}\nContent: ${source.Content ?? ''}\nSource: ${source.Source ?? ''}`
            : String(source)))
          .join('\n\n')
      } else {
        this.deps.context = curated
      }
    }

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'research_step_finalized',
        `Finalized research step.\n💸 Total Research Costs: $${this.deps.getCosts?.() ?? 0}`,
        this.deps.websocket ?? null,
      )
    }

    logger.info(`Research completed. Context size: ${String(this.deps.context ?? '').length}`)
    return this.deps.context
  }

  /**
   * Local-document branch: load documents, then research with them.
   * @param {string} query - the query.
   * @param {Array<unknown>} _extra - reserved.
   * @returns {Promise<string | string[]>} context.
   */
  async conductLocal(query, _extra) {
    const loader = this.deps.loaders?.document
    if (typeof loader !== 'function') {
      throw new Error('ResearchConductor: report source "local" needs a document loader (deps.loaders.document)')
    }
    logger.info('Using local search')
    const documentData = await loader(this.deps.cfg.doc_path)
    logger.info(`Loaded ${documentData.length} documents`)
    this.deps.vectorStore?.load?.(documentData)
    return this.getContextByWebSearch(query, documentData, this.deps.queryDomains ?? [])
  }

  /**
   * Azure Blob branch: load documents from Azure, then research with them.
   * @param {string} query - the query.
   * @returns {Promise<string | string[]>} context.
   */
  async conductAzure(query) {
    const loader = this.deps.loaders?.azure
    const documentLoader = this.deps.loaders?.document
    if (typeof loader !== 'function' || typeof documentLoader !== 'function') {
      throw new Error('ResearchConductor: report source "azure" needs deps.loaders.azure and deps.loaders.document')
    }
    const azureFiles = await loader({
      containerName: this.deps.env?.AZURE_CONTAINER_NAME,
      connectionString: this.deps.env?.AZURE_CONNECTION_STRING,
    })
    const documentData = await documentLoader(azureFiles)
    return this.getContextByWebSearch(query, documentData)
  }

  /**
   * LangChain-documents branch.
   * @param {string} query - the query.
   * @returns {Promise<string | string[]>} context.
   */
  async conductLangChainDocuments(query) {
    const loader = this.deps.loaders?.langchainDocuments
    if (typeof loader !== 'function') {
      throw new Error('ResearchConductor: report source "langchain_documents" needs deps.loaders.langchainDocuments')
    }
    const data = await loader(this.deps.documents)
    this.deps.vectorStore?.load?.(data)
    return this.getContextByWebSearch(query, data, this.deps.queryDomains ?? [])
  }

  /**
   * Scrape and compress the context from the given URLs.
   *
   * @param {string[]} urls - URLs to read.
   * @returns {Promise<string>} compressed context.
   */
  async getContextByUrls(urls) {
    logger.info(`Getting context from URLs: ${urls}`)

    const newSearchUrls = await this.getNewUrls(urls)
    logger.info(`New URLs to process: ${newSearchUrls}`)

    const scrapedContent = await this.deps.browserManager.browseUrls(newSearchUrls)
    logger.info(`Scraped content from ${scrapedContent.length} URLs`)

    this.deps.vectorStore?.load?.(scrapedContent)

    return this.deps.contextManager.getSimilarContentByQuery(this.deps.query, scrapedContent)
  }

  /**
   * Vector-store branch.
   *
   * @param {string} query - the query.
   * @param {Record<string, unknown> | null} [filter] - vector store filter.
   * @returns {Promise<string[]>} context entries.
   */
  async getContextByVectorstore(query, filter = null) {
    logger.info(`Starting vectorstore search for query: ${query}`)
    const subQueries = await this.planResearch(query)
    // If this is not part of a sub researcher, add the original query too.
    if (this.deps.reportType !== ReportType.SubtopicReport) subQueries.push(query)

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'subqueries',
        `🗂️  I will conduct my research based on the following queries: ${subQueries}...`,
        this.deps.websocket ?? null,
        true,
        subQueries,
      )
    }

    return Promise.all(subQueries.map((subQuery) => this.processSubQueryWithVectorstore(subQuery, filter)))
  }

  /**
   * Web-search branch: plan, then research every sub-query.
   *
   * @param {string} query - the query.
   * @param {Array<Record<string, unknown>> | null} [scrapedData] - supplied documents.
   * @param {string[]} [queryDomains] - domain restrictions.
   * @returns {Promise<string | string[]>} combined context, or `[]` when nothing was gathered.
   */
  async getContextByWebSearch(query, scrapedData = null, queryDomains = []) {
    logger.info(`Starting web search for query: ${query}`)
    const documents = scrapedData ?? []
    const domains = queryDomains ?? []

    const mcpRetrievers = (this.deps.retrievers ?? []).filter((retriever) => (retriever?.name ?? String(retriever)).toLowerCase().includes('mcpretriever'))
    const mcpStrategy = this.getMcpStrategy()

    // Lock so concurrent passes populate the MCP cache once instead of racing.
    const previous = this.mcpCacheTail
    let release
    this.mcpCacheTail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      if (mcpRetrievers.length > 0 && this.mcpResultsCache === null) {
        if (mcpStrategy === 'disabled') {
          logger.info('MCP disabled by strategy, skipping MCP research')
          if (this.deps.verbose) {
            await streamOutput('logs', 'mcp_disabled', '⚡ MCP research disabled by configuration', this.deps.websocket ?? null)
          }
        } else if (mcpStrategy === 'fast' || mcpStrategy !== 'deep') {
          if (mcpStrategy !== 'fast') logger.warning(`Unknown MCP strategy '${mcpStrategy}', defaulting to fast`)
          else {
            logger.info('MCP fast strategy: Running once with original query')
            if (this.deps.verbose) {
              await streamOutput('logs', 'mcp_optimization', '🚀 MCP Fast: Running once for main query (performance mode)', this.deps.websocket ?? null)
            }
          }
          this.mcpResultsCache = await this.executeMcpResearchForQueries([query], mcpRetrievers)
          logger.info(`MCP results cached: ${this.mcpResultsCache.length} total context entries`)
        } else {
          logger.info('MCP deep strategy: Will run for all queries')
          if (this.deps.verbose) {
            await streamOutput('logs', 'mcp_comprehensive', '🔍 MCP Deep: Will run for each sub-query (thorough mode)', this.deps.websocket ?? null)
          }
        }
      }
    } finally {
      release()
    }

    const initialResults = await this.getInitialSearchResults(query, domains)
    const subQueries = await this.planResearch(query, domains, { searchResults: initialResults })
    logger.info(`Generated sub-queries: ${subQueries}`)

    // If this is not part of a sub researcher, add the original query too.
    if (this.deps.reportType !== ReportType.SubtopicReport) subQueries.push(query)

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'subqueries',
        `🗂️ I will conduct my research based on the following queries: ${subQueries}...`,
        this.deps.websocket ?? null,
        true,
        subQueries,
      )
    }

    try {
      // Read the sources that informed planning before later searches can lose
      // them. Keep supplied-document and MCP-only paths unchanged.
      let initialContext = ''
      if (documents.length === 0 && initialResults.length > 0) {
        initialContext = await this.getContextFromInitialResults(query, domains, initialResults)
      }
      const context = await Promise.all(subQueries.map((subQuery) => this.processSubQuery(subQuery, documents, domains)))
      logger.info(`Gathered context from ${context.length} sub-queries`)
      // Filter out empty results and join the context.
      const parts = [initialContext, ...context].filter((part) => part)
      if (parts.length > 0) {
        const combined = parts.join(' ')
        logger.info(`Combined context size: ${combined.length}`)
        return combined
      }
      return []
    } catch (error) {
      logger.error(`Error during web search: ${error?.message ?? error}`)
      return []
    }
  }

  /**
   * Resolve the MCP strategy: instance override, then config, then `fast`.
   * @returns {string} the strategy.
   */
  getMcpStrategy() {
    if (this.deps.mcpStrategy !== null && this.deps.mcpStrategy !== undefined) return this.deps.mcpStrategy
    if (this.deps.cfg.mcp_strategy !== undefined) return this.deps.cfg.mcp_strategy
    return 'fast'
  }

  /**
   * Research every query through every MCP retriever.
   *
   * @param {string[]} queries - the queries.
   * @param {Function[]} mcpRetrievers - MCP retriever classes.
   * @returns {Promise<Array<Record<string, unknown>>>} combined MCP context entries.
   */
  async executeMcpResearchForQueries(queries, mcpRetrievers) {
    const allMcpContext = []
    let index = 1
    for (const query of queries) {
      logger.info(`Executing MCP research for query ${index}/${queries.length}: ${query}`)
      for (const retriever of mcpRetrievers) {
        try {
          const mcpResults = await this.executeMcpResearch(retriever, query)
          if (mcpResults && mcpResults.length > 0) {
            for (const result of mcpResults) {
              const body = result.body ?? ''
              const href = result.href ?? ''
              const title = result.title ?? ''
              if (body) {
                allMcpContext.push({ content: body, url: href, title, query, source_type: 'mcp' })
              }
            }
            logger.info(`Added ${mcpResults.length} MCP results for query: ${query}`)
            if (this.deps.verbose) {
              await streamOutput(
                'logs',
                'mcp_results_cached',
                `✅ Cached ${mcpResults.length} MCP results from query ${index}/${queries.length}`,
                this.deps.websocket ?? null,
              )
            }
          }
        } catch (error) {
          logger.error(`Error in MCP research for query '${query}': ${error?.message ?? error}`)
          if (this.deps.verbose) {
            await streamOutput(
              'logs',
              'mcp_cache_error',
              `⚠️ MCP research error for query ${index}, continuing with other sources`,
              this.deps.websocket ?? null,
            )
          }
        }
      }
      index += 1
    }
    return allMcpContext
  }

  /**
   * Run one MCP research call.
   *
   * @param {Function} retriever - the MCP retriever class.
   * @param {string} query - the query.
   * @returns {Promise<Array<Record<string, unknown>>>} results, or `[]` on failure.
   */
  async executeMcpResearch(retriever, query) {
    const retrieverName = retriever?.name ?? String(retriever)
    logger.info(`Executing MCP research with ${retrieverName} for query: ${query}`)
    try {
      const instance = new retriever(query, {
        headers: this.deps.headers ?? null,
        queryDomains: this.deps.queryDomains ?? [],
        websocket: this.deps.websocket ?? null,
        researcher: this.deps,
      })

      if (this.deps.verbose) {
        await streamOutput(
          'logs',
          'mcp_retrieval_stage1',
          `🧠 Stage 1: Selecting optimal MCP tools for: ${query}`,
          this.deps.websocket ?? null,
        )
      }

      const results = await instance.search({ max_results: this.deps.cfg.max_search_results_per_query })

      if (results && results.length > 0) {
        logger.info(`MCP research completed: ${results.length} results from ${retrieverName}`)
        if (this.deps.verbose) {
          await streamOutput(
            'logs',
            'mcp_research_complete',
            `🎯 MCP research completed: ${results.length} intelligent results obtained`,
            this.deps.websocket ?? null,
          )
        }
        return results
      }

      logger.info(`No results returned from MCP research with ${retrieverName}`)
      if (this.deps.verbose) {
        await streamOutput(
          'logs',
          'mcp_no_results',
          `ℹ️ No relevant information found via MCP for: ${query}`,
          this.deps.websocket ?? null,
        )
      }
      return []
    } catch (error) {
      logger.error(`Error in MCP research with ${retrieverName}: ${error?.message ?? error}`)
      if (this.deps.verbose) {
        await streamOutput(
          'logs',
          'mcp_research_error',
          `⚠️ MCP research error: ${error?.message ?? error} - continuing with other sources`,
          this.deps.websocket ?? null,
        )
      }
      return []
    }
  }

  /**
   * Combine MCP context with web context.
   *
   * @param {Array<Record<string, unknown>>} mcpContext - MCP entries.
   * @param {string} webContext - web context.
   * @param {string} _subQuery - the sub-query being processed.
   * @returns {string} combined context.
   */
  combineMcpAndWebContext(mcpContext, webContext, _subQuery) {
    const combinedParts = []

    // Add web context first if available.
    if (webContext && webContext.trim() !== '') combinedParts.push(webContext.trim())

    // Add MCP context with the source's formatting.
    if (mcpContext && mcpContext.length > 0) {
      const mcpFormatted = []
      for (const item of mcpContext) {
        const content = item.content ?? ''
        const url = item.url ?? ''
        const title = item.title ?? ''
        if (!content) continue
        if (url) {
          mcpFormatted.push(`Source: ${url}\nTitle: ${title}\nContent: ${content}\n`)
        } else {
          mcpFormatted.push(`Source: MCP\nTitle: ${title}\nContent: ${content}\n`)
        }
      }
      // Read the source list that informed planning before later searches replace it.
      if (mcpFormatted.length > 0) combinedParts.push(mcpFormatted.join('\n'))
    }

    const finalContext = combinedParts.join('\n\n')
    if (finalContext) {
      logger.info(`Combined context for '${_subQuery}': ${finalContext.length} total chars`)
      return finalContext
    }
    logger.warning(`No context to combine for sub-query: ${_subQuery}`)
    return ''
  }

  /**
   * Research one vector-store sub-query.
   *
   * @param {string} subQuery - the sub-query.
   * @param {Record<string, unknown> | null} [filter] - vector store filter.
   * @returns {Promise<string>} context.
   */
  async processSubQueryWithVectorstore(subQuery, filter = null) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'running_subquery_with_vectorstore_research',
        `\n🔍 Running research for '${subQuery}'...`,
        this.deps.websocket ?? null,
      )
    }
    return this.deps.contextManager.getSimilarContentByQueryWithVectorstore(subQuery, filter)
  }

  /**
   * Keep only URLs not yet visited, recording them as visited.
   *
   * @param {Iterable<string>} urlSetInput - candidate URLs.
   * @returns {Promise<string[]>} the new URLs.
   */
  async getNewUrls(urlSetInput) {
    const newUrls = []
    for (const url of urlSetInput) {
      if (this.deps.visitedUrls.has(url)) continue
      this.deps.visitedUrls.add(url)
      newUrls.push(url)
      if (this.deps.verbose) {
        await streamOutput('logs', 'added_source_url', `✅ Added source url to research: ${url}\n`, this.deps.websocket ?? null, true, url)
      }
    }
    return newUrls
  }

  /**
   * Fetch the sources that informed planning, through normal retrieval.
   *
   * @param {string} query - the query.
   * @param {string[]} queryDomains - domain restrictions.
   * @param {Array<Record<string, unknown>>} initialResults - planning results.
   * @returns {Promise<string>} context, or `''` when unavailable.
   */
  async getContextFromInitialResults(query, queryDomains, initialResults) {
    const first = this.deps.retrievers?.[0]
    if (first !== undefined && (first?.name ?? String(first)).toLowerCase().includes('mcpretriever')) return ''
    try {
      const data = await this.scrapeDataByUrls(query, queryDomains, { initialResults })
      if (data && data.length > 0) {
        return await this.deps.contextManager.getSimilarContentByQuery(query, data)
      }
    } catch (error) {
      // An unavailable planning source must not prevent follow-up research.
      logger.warning(`Error reading initial search results: ${error?.message ?? error}`)
    }
    return ''
  }

  /**
   * Search the configured retrievers and scrape the resulting URLs.
   *
   * @param {string} query - the sub-query.
   * @param {string[]} [queryDomains] - domain restrictions.
   * @param {{initialResults?: Array<Record<string, unknown>>}} [options] - pre-fetched results.
   * @returns {Promise<{urls: string[], prefetched: Array<Record<string, unknown>>}>} candidate URLs and prefetched pages.
   */
  async searchRelevantSourceUrls(query, queryDomains = [], options = {}) {
    const newSearchUrls = []
    const prefetchedContent = []
    const initialResults = options.initialResults

    // Initial results came from the first retriever only; reuse its content
    // contract without issuing another search.
    const retrievers = initialResults === undefined
      ? (this.deps.retrievers ?? [])
      : (this.deps.retrievers ?? []).slice(0, 1)

    for (const retrieverClass of retrievers) {
      if ((retrieverClass?.name ?? String(retrieverClass)).toLowerCase().includes('mcpretriever')) continue
      const providerName = retrieverClass?.name ?? String(retrieverClass)
      try {
        const instance = new retrieverClass(query, {
          queryDomains,
          search: this.deps.search ?? null,
        })
        const searchResults = initialResults === undefined
          ? await instance.search({ max_results: this.deps.cfg.max_search_results_per_query })
          : initialResults

        if (!searchResults || searchResults.length === 0) {
          await this.emitResearchEvent('search_empty', { query, provider: providerName })
          continue
        }

        // Prefer an explicit declaration; fall back to the legacy length heuristic.
        const requiresScraping = instance.requiresScraping

        for (let rank = 1; rank <= searchResults.length; rank += 1) {
          const result = searchResults[rank - 1]
          const url = result.href ?? result.url
          const rawContent = result.raw_content

          if (!url) continue

          await this.emitResearchEvent('candidate_discovered', { query, provider: providerName, url, rank })

          if (requiresScraping === true) {
            // Declared: anything alongside the URL is a preview, so the page is
            // still fetched. This stops a long snippet being mistaken for text.
            newSearchUrls.push(url)
          } else if (requiresScraping === false) {
            // Declared: the retriever fetched the content itself.
            if (rawContent) {
              prefetchedContent.push({ url, raw_content: rawContent })
              this.deps.addResearchSources?.([{ url }])
              // Prefetched URLs must join visited_urls like scraped ones, or
              // repeats re-merge and references vanish.
              this.deps.visitedUrls.add(url)
              await this.emitResearchEvent('content_prefetched', {
                query,
                provider: providerName,
                url,
                rank,
                content_length: rawContent.length,
              })
            } else {
              newSearchUrls.push(url)
            }
          } else if (rawContent && rawContent.length > 100) {
            // Undeclared: legacy behaviour, unchanged.
            prefetchedContent.push({ url, raw_content: rawContent })
            this.deps.addResearchSources?.([{ url }])
            this.deps.visitedUrls.add(url)
            await this.emitResearchEvent('content_prefetched', {
              query,
              provider: providerName,
              url,
              rank,
              content_length: rawContent.length,
            })
          } else {
            newSearchUrls.push(url)
          }
        }
      } catch (error) {
        logger.error(`Error searching with ${providerName}: ${error?.message ?? error}`)
        await this.emitResearchEvent('search_failed', {
          query,
          provider: providerName,
          reason_code: error?.constructor?.name ?? 'Error',
        })
      }
    }

    // Deduplicate, then drop already-visited URLs.
    const requestedUrls = [...new Set(newSearchUrls)]
    const freshUrls = await this.getNewUrls(newSearchUrls)
    const selected = new Set(freshUrls)
    for (const url of requestedUrls) {
      if (selected.has(url)) {
        await this.emitResearchEvent('selected_for_fetch', { query, url })
      } else {
        await this.emitResearchEvent('candidate_deduplicated', { query, url, reason_code: 'ALREADY_VISITED' })
      }
    }
    // Shuffle so a per-host cap does not always keep the same host.
    for (let index = freshUrls.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[freshUrls[index], freshUrls[swap]] = [freshUrls[swap], freshUrls[index]]
    }

    return { urls: freshUrls, prefetched: prefetchedContent }
  }

  /**
   * Run a sub-query across retrievers and scrape the resulting URLs.
   *
   * @param {string} subQuery - the sub-query.
   * @param {string[]} [queryDomains] - domain restrictions.
   * @param {{initialResults?: Array<Record<string, unknown>>}} [options] - pre-fetched results.
   * @returns {Promise<Array<Record<string, unknown>>>} scraped content.
   */
  async scrapeDataByUrls(subQuery, queryDomains = [], options = {}) {
    const domains = queryDomains ?? []

    const { urls, prefetched } = await this.searchRelevantSourceUrls(subQuery, domains, options)

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'researching',
        '🤔 Researching for relevant information across multiple sources...\n',
        this.deps.websocket ?? null,
      )
    }

    // Scrape URLs that need fetching (skip those already provided by retrievers).
    const scrapedContent = await this.deps.browserManager.browseUrls(urls)

    // Merge pre-fetched content from retrievers that already provide full text.
    scrapedContent.push(...prefetched)

    this.deps.vectorStore?.load?.(scrapedContent)

    return scrapedContent
  }

  /**
   * Process one sub-query: scrape its sources, then compress to context.
   *
   * @param {string} subQuery - the sub-query.
   * @param {Array<Record<string, unknown>>} [scrapedData] - supplied documents.
   * @param {string[]} [queryDomains] - domain restrictions.
   * @returns {Promise<string>} context, or `''` when nothing was found.
   */
  async processSubQuery(subQuery, scrapedData = [], queryDomains = []) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'running_subquery_research',
        `\n🔍 Running research for '${subQuery}'...`,
        this.deps.websocket ?? null,
      )
    }

    try {
      // Identify MCP retrievers.
      const mcpRetrievers = (this.deps.retrievers ?? []).filter((retriever) => (retriever?.name ?? String(retriever)).toLowerCase().includes('mcpretriever'))
      const nonMcpRetrievers = (this.deps.retrievers ?? []).filter((retriever) => !(retriever?.name ?? String(retriever)).toLowerCase().includes('mcpretriever'))

      // Avoid a dual Tavily path (direct retriever + tavily-mcp) under the
      // default RETRIEVER=tavily.
      let activeMcpRetrievers = mcpRetrievers
      if (this.tavilyMcpRedundantWithDirect(mcpRetrievers, nonMcpRetrievers)) {
        logger.warning('Skipping LLM MCP Tavily path because TavilySearch is already configured as a direct retriever; '
          + 'set RETRIEVER without tavily or use non-Tavily MCP servers to keep MCP.')
        if (this.deps.verbose) {
          await streamOutput(
            'logs',
            'mcp_tavily_deduped',
            '⚠️ Skipping Tavily MCP (redundant with direct Tavily retriever) to avoid double API cost',
            this.deps.websocket ?? null,
          )
        }
        activeMcpRetrievers = []
      }

      let mcpContext = []
      let webContext = ''
      const mcpStrategy = this.getMcpStrategy()

      // Configurable MCP processing.
      if (activeMcpRetrievers.length > 0) {
        if (mcpStrategy === 'disabled') {
          logger.info(`MCP disabled for sub-query: ${subQuery}`)
        } else if (mcpStrategy === 'fast' && this.mcpResultsCache !== null) {
          mcpContext = [...this.mcpResultsCache]
          if (this.deps.verbose) {
            await streamOutput(
              'logs',
              'mcp_cache_reuse',
              `♻️ Reusing cached MCP results (${mcpContext.length} sources) for: ${subQuery}`,
              this.deps.websocket ?? null,
            )
          }
          logger.info(`Reused ${mcpContext.length} cached MCP results for sub-query: ${subQuery}`)
        } else if (mcpStrategy === 'deep') {
          logger.info(`Running deep MCP research for: ${subQuery}`)
          if (this.deps.verbose) {
            await streamOutput(
              'logs',
              'mcp_comprehensive_run',
              `🔍 Running deep MCP research for: ${subQuery}`,
              this.deps.websocket ?? null,
            )
          }
          mcpContext = await this.executeMcpResearchForQueries([subQuery], activeMcpRetrievers)
        } else {
          logger.warning('MCP cache not available, falling back to per-sub-query execution')
          if (this.deps.verbose) {
            await streamOutput(
              'logs',
              'mcp_fallback',
              '🔌 MCP cache unavailable, running MCP research for this sub-query',
              this.deps.websocket ?? null,
            )
          }
          mcpContext = await this.executeMcpResearchForQueries([subQuery], activeMcpRetrievers)
        }
      }

      // Get web search context using non-MCP retrievers (if no scraped data given).
      let scraped = scrapedData
      if (scraped.length === 0) {
        scraped = await this.scrapeDataByUrls(subQuery, queryDomains)
        logger.info(`Scraped data size: ${scraped.length}`)
      }

      // Get similar content based on scraped data.
      if (scraped.length > 0) {
        webContext = await this.deps.contextManager.getSimilarContentByQuery(subQuery, scraped)
        logger.info(`Web content found for sub-query: ${webContext ? String(webContext).length : 0} chars`)
      }

      // Combine MCP context with web context intelligently.
      const combinedContext = this.combineMcpAndWebContext(mcpContext, webContext, subQuery)

      if (combinedContext) {
        logger.info(`Combined context for '${subQuery}': ${String(combinedContext).length} chars`)
        if (this.deps.verbose) {
          const mcpCount = mcpContext.length
          const webAvailable = Boolean(webContext)
          const cacheUsed = this.mcpResultsCache !== null && activeMcpRetrievers.length > 0 && mcpStrategy !== 'deep'
          const cacheStatus = cacheUsed ? ' (cached)' : ''
          await streamOutput(
            'logs',
            'context_combined',
            `📚 Combined research context: ${mcpCount} MCP sources${cacheStatus}, ${webAvailable ? 'web content' : 'no web content'}`,
            this.deps.websocket ?? null,
          )
        }
      } else {
        logger.warning(`No combined context found for sub-query: ${subQuery}`)
        if (this.deps.verbose) {
          await streamOutput(
            'logs',
            'subquery_context_not_found',
            `🤷 No content found for '${subQuery}'...`,
            this.deps.websocket ?? null,
          )
        }
      }

      return combinedContext
    } catch (error) {
      logger.error(`Error processing sub-query ${subQuery}: ${error?.message ?? error}`)
      if (this.deps.verbose) {
        await streamOutput(
          'logs',
          'subquery_error',
          `❌ Error processing '${subQuery}': ${error?.message ?? error}`,
          this.deps.websocket ?? null,
        )
      }
      return ''
    }
  }

  /**
   * Whether MCP would only re-query Tavily while direct Tavily is active.
   *
   * The Tavily Web Search MCP preset hits the same API as `TavilySearch` and adds
   * extra LLM tool-selection cost for no new data when both run together (#1875).
   *
   * @param {Function[]} mcpRetrievers - MCP retriever classes.
   * @param {Function[]} nonMcpRetrievers - direct retriever classes.
   * @returns {boolean} `true` when the MCP path is redundant.
   */
  tavilyMcpRedundantWithDirect(mcpRetrievers, nonMcpRetrievers) {
    if (mcpRetrievers.length === 0 || nonMcpRetrievers.length === 0) return false
    const hasDirectTavily = nonMcpRetrievers.some((retriever) => (retriever?.name ?? '').toLowerCase() === 'tavilysearch')
    if (!hasDirectTavily) return false
    const configs = this.deps.mcpConfigs ?? []
    if (configs.length === 0) return false
    // If every configured MCP server is a Tavily MCP package, treat as redundant.
    const isTavilyMcp = (config) => {
      const name = String(config.name ?? '').toLowerCase()
      const args = (config.args ?? []).map((arg) => String(arg)).join(' ').toLowerCase()
      const command = String(config.command ?? '').toLowerCase()
      const blob = `${name} ${args} ${command}`
      return blob.includes('tavily')
    }
    return configs.every((config) => config !== null && typeof config === 'object' && !Array.isArray(config) && isTavilyMcp(config))
  }

  /**
   * Extract content from search results through the browser manager.
   *
   * @param {Array<Record<string, unknown>>} results - search results.
   * @returns {Promise<Array<Record<string, unknown>>>} scraped content.
   */
  async extractContent(results) {
    logger.info(`Extracting content from ${results.length} search results`)
    const urls = []
    for (const result of results) {
      if (result !== null && typeof result === 'object' && 'href' in result) urls.push(result.href)
    }
    if (urls.length === 0) return []

    // Never visit URLs already visited.
    const newUrls = urls.filter((url) => !this.deps.visitedUrls.has(url))
    if (newUrls.length === 0) return []

    const scrapedContent = await this.deps.browserManager.browseUrls(newUrls)
    for (const url of newUrls) this.deps.visitedUrls.add(url)
    return scrapedContent
  }

  /**
   * Summarize extracted content against a query.
   * @param {string} query - the query.
   * @param {Array<Record<string, unknown>>} content - extracted content.
   * @returns {Promise<string>} summarized content, or `''`.
   */
  async summarizeContent(query, content) {
    logger.info(`Summarizing content for query: ${query}`)
    if (!content || content.length === 0) return ''
    return this.deps.contextManager.getSimilarContentByQuery(query, content)
  }

  /**
   * Emit search progress.
   * @param {number} current - completed count.
   * @param {number} total - total count.
   * @returns {Promise<void>} fulfillment after the emit.
   */
  async updateSearchProgress(current, total) {
    if (this.deps.verbose && this.deps.websocket) {
      const progress = Math.floor((current / total) * 100)
      await streamOutput(
        'logs',
        'research_progress',
        `📊 Research Progress: ${progress}%`,
        this.deps.websocket,
        true,
        { current, total, progress },
      )
    }
  }
}
