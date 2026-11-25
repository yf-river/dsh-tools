/**
 * Prompt family.
 *
 * One-to-one port of `gpt_researcher/prompts.py`. Every prompt template is
 * copied with its exact wording, whitespace, bullet order and date formatting,
 * because these strings are the whole reason the source's reports read the way
 * they do: rewording a bullet changes the output.
 *
 * Python's rendering conventions are preserved where they leak into the output:
 * - `{value}` in an f-string is `String(value)`; there is no escaping.
 * - `{date.today()}` renders as `YYYY-MM-DD`; `{datetime.now(timezone.utc).strftime('%B %d, %Y')}`
 *   renders as `Month DD, YYYY` in UTC.
 * - `{report_format.upper()}` is uppercased at the call site in the same places.
 *
 * The Granite prompt families are ported too: they change only
 * `pretty_print_docs` / `join_local_web_documents`, but a deployment that sets
 * `PROMPT_FAMILY=granite3` must get Granite's document framing.
 *
 * @module @yf-river/dsh-gpt-research/prompts
 */

import { PromptFamily as PromptFamilyEnum, ReportSource, ReportType, Tone } from './utils/enum.js'

/** Monday-first month names, as Python's `%B`. */
const MONTHS = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
])

/**
 * Format a date the way `datetime.now(timezone.utc).strftime('%B %d, %Y')` does.
 * @param {Date} [now] - the instant, defaulting to the current time.
 * @returns {string} e.g. `November 23, 2026`.
 */
export function formatUtcLongDate(now = new Date()) {
  return `${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, '0')}, ${now.getUTCFullYear()}`
}

/**
 * Format a date the way `date.today()` stringifies.
 * @param {Date} [now] - the instant, defaulting to the current time.
 * @returns {string} e.g. `2026-11-23`.
 */
export function formatToday(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

/**
 * Render a value the way Python's f-string `{value}` does (i.e. `str(value)`).
 *
 * This matters wherever the source interpolates a list or dict into a prompt:
 * `str([{'a': 1}])` is `[{'a': 1}]` in Python but `[object Object]` from
 * `String()`. The prompt text therefore depends on Python's repr rules, so they
 * are reproduced here: single-quoted strings, `None`/`True`/`False` capitalised,
 * and nested containers rendered recursively.
 *
 * @param {unknown} value - the value to render.
 * @returns {string} Python-style `str()` output.
 */
export function pyStr(value) {
  if (value === null || value === undefined) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (value instanceof Set) return `{${[...value].map(pyRepr).join(', ')}}`
  if (value instanceof Map) {
    return `{${[...value].map(([key, inner]) => `${pyRepr(key)}: ${pyRepr(inner)}`).join(', ')}}`
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, inner]) => `${pyRepr(key)}: ${pyRepr(inner)}`).join(', ')}}`
  }
  return String(value)
}

/**
 * Render a value the way Python's `repr()` does, including quoting strings.
 *
 * Python picks double quotes only when the string contains a single quote and no
 * double quote; that rule is preserved so a prompt containing quotes matches.
 *
 * @param {unknown} value - the value to render.
 * @returns {string} Python-style `repr()` output.
 */
export function pyRepr(value) {
  if (typeof value === 'string') {
    const needsDouble = value.includes('\'') && !value.includes('"')
    const quote = needsDouble ? '"' : '\''
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(new RegExp(quote, 'g'), `\\${quote}`)
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
    return `${quote}${escaped}${quote}`
  }
  return pyStr(value)
}

/**
 * Render documents into the model-facing context string.
 *
 * Port of `PromptFamily.pretty_print_docs`. The exact shape matters: sub-queries
 * and the writer both receive this text, and the leading newline plus the
 * `Source / Title / Content` triple is what the report prompt's citation
 * instructions refer to.
 *
 * @param {Array<{pageContent: string, metadata: Record<string, unknown>}>} docs - documents to render.
 * @param {number | null} [topN] - keep at most this many documents.
 * @returns {string} the rendered context.
 */
export function prettyPrintDocs(docs, topN = null) {
  return docs
    .filter((_doc, index) => topN === null || index < topN)
    .map((doc) => `Source: ${doc.metadata.source}\n`
      + `Title: ${doc.metadata.title}\n`
      + `Content: ${doc.pageContent}\n`)
    .join('\n')
}

/**
 * Join local-document context with web context.
 * @param {string} docsContext - context from local documents.
 * @param {string} webContext - context from web sources.
 * @returns {string} the combined context.
 */
export function joinLocalWebDocuments(docsContext, webContext) {
  return `Context from local documents: ${docsContext}\n\nContext from web sources: ${webContext}`
}

/** General-purpose prompt formatting, port of `class PromptFamily`. */
export class PromptFamily {
  /**
   * @param {object} [config] - resolved config, for derived families that inspect the model name.
   */
  constructor(config) {
    /** @type {object} */
    this.cfg = config ?? {}
  }

  /**
   * Get the right Granite prompt family for the configured model.
   * @returns {Function} the family class.
   */
  getGraniteClass() {
    const model = String(this.cfg.smart_llm ?? '')
    if (model.includes('3.3')) return Granite33PromptFamily
    if (model.includes('3')) return Granite3PromptFamily
    return PromptFamily
  }

  /**
   * Render documents. Static like the source's `@staticmethod`, so both the
   * class and an instance can call it.
   * @param {Array<{pageContent: string, metadata: Record<string, unknown>>} | null} docs - documents.
   * @param {number | null} [topN] - keep at most this many documents.
   * @returns {string} rendered context.
   */
  static pretty_print_docs(docs, topN = null) {
    return prettyPrintDocs(docs ?? [], topN)
  }

  /**
   * Join local and web context. Static like the source's `@staticmethod`.
   * @param {string} docsContext - local context.
   * @param {string} webContext - web context.
   * @returns {string} joined context.
   */
  static join_local_web_documents(docsContext, webContext) {
    return joinLocalWebDocuments(docsContext, webContext)
  }

  /** @returns {string} rendered documents (instance form of the static). */
  pretty_print_docs(docs, topN = null) {
    return prettyPrintDocs(docs ?? [], topN)
  }

  /** @returns {string} joined context (instance form of the static). */
  join_local_web_documents(docsContext, webContext) {
    return joinLocalWebDocuments(docsContext, webContext)
  }

  // ---------------------------------------------------------------- MCP prompts

  /**
   * Prompt for LLM-based MCP tool selection.
   * @param {string} query - the research query.
   * @param {Array<Record<string, unknown>>} toolsInfo - available tools with metadata.
   * @param {number} [maxTools] - number of tools to select.
   * @returns {string} the prompt.
   */
  static generate_mcp_tool_selection_prompt(query, toolsInfo, maxTools = 3) {
    return `You are a research assistant helping to select the most relevant tools for a research query.

RESEARCH QUERY: "${query}"

AVAILABLE TOOLS:
${JSON.stringify(toolsInfo, null, 2)}

TASK: Analyze the tools and select EXACTLY ${maxTools} tools that are most relevant for researching the given query.

SELECTION CRITERIA:
- Choose tools that can provide information, data, or insights related to the query
- Prioritize tools that can search, retrieve, or access relevant content
- Consider tools that complement each other (e.g., different data sources)
- Exclude tools that are clearly unrelated to the research topic

Return a JSON object with this exact format:
{
  "selected_tools": [
    {
      "index": 0,
      "name": "tool_name",
      "relevance_score": 9,
      "reason": "Detailed explanation of why this tool is relevant"
    }
  ],
  "selection_reasoning": "Overall explanation of the selection strategy"
}

Select exactly ${maxTools} tools, ranked by relevance to the research query.
`
  }

  /**
   * Prompt for MCP research execution.
   * @param {string} query - the research query.
   * @param {Array<object|string>} selectedTools - selected tools or their names.
   * @returns {string} the prompt.
   */
  static generate_mcp_research_prompt(query, selectedTools) {
    const toolNames = selectedTools.map((tool) => (tool !== null && typeof tool === 'object' && 'name' in tool ? tool.name : String(tool)))
    return `You are a research assistant with access to specialized tools. Your task is to research the following query and provide comprehensive, accurate information.

RESEARCH QUERY: "${query}"

INSTRUCTIONS:
1. Use the available tools to gather relevant information about the query
2. Call multiple tools if needed to get comprehensive coverage
3. If a tool call fails or returns empty results, try alternative approaches
4. Synthesize information from multiple sources when possible
5. Focus on factual, relevant information that directly addresses the query

AVAILABLE TOOLS: ${toolNames.join(', ')}

Please conduct thorough research and provide your findings. Use the tools strategically to gather the most relevant and comprehensive information.`
  }

  // ------------------------------------------------------------ image prompts

  /**
   * Prompt for choosing which report sections need images.
   * @param {string} query - the research query.
   * @param {Array<{header: string, content: string}>} sections - report sections.
   * @param {number} [maxImages] - maximum suggestions.
   * @returns {string} the prompt.
   */
  static generate_image_analysis_prompt(query, sections, maxImages = 3) {
    const sectionsText = sections
      .map((section, index) => `### Section ${index + 1}: ${section.header}\n${String(section.content).slice(0, 500)}...`)
      .join('\n\n')
    return `Analyze the following research report sections and identify which ${maxImages} sections would benefit MOST from a visual illustration or diagram.

RESEARCH TOPIC: ${query}

REPORT SECTIONS:
${sectionsText}

For each recommended section, provide:
1. The section number (1-indexed)
2. A specific, detailed image prompt that would create an informative illustration
3. A brief explanation of why this section benefits from visualization

IMPORTANT GUIDELINES:
- Choose sections where visual representation would genuinely aid understanding
- Focus on concepts, processes, comparisons, data flows, or statistics that are inherently visual
- Avoid sections that are purely textual analysis, introductions, or conclusions
- The image prompt should be specific enough to generate a relevant, professional illustration
- Images should be informative and educational, not decorative
- Consider diagrams, flowcharts, comparison charts, or conceptual illustrations

Respond in JSON format:
{
    "suggestions": [
        {
            "section_number": 1,
            "section_header": "Section Title",
            "image_prompt": "Detailed prompt for generating an informative illustration...",
            "image_type": "diagram|flowchart|comparison|concept|data_visualization",
            "reason": "Why this section benefits from visualization"
        }
    ]
}

Return ONLY the JSON, no additional text.`
  }

  /**
   * Prompt that enriches a base image prompt with report context.
   * @param {string} basePrompt - the base image prompt.
   * @param {string} sectionContent - section content.
   * @param {string} researchTopic - the main topic.
   * @returns {string} the prompt.
   */
  static generate_image_prompt_enhancement(basePrompt, sectionContent, researchTopic) {
    return `Create a professional, informative illustration for a research report.

RESEARCH TOPIC: ${researchTopic}

IMAGE DESCRIPTION: ${basePrompt}

CONTEXT FROM REPORT:
${String(sectionContent).slice(0, 800)}

STYLE REQUIREMENTS:
- Professional and clean design suitable for academic/business reports
- Clear, easy-to-understand visual elements
- Modern, minimalist aesthetic
- Use a professional color palette (blues, teals, grays)
- Avoid excessive text in the image
- High contrast for readability
- If showing data or comparisons, use clear labels and legends
- Suitable for both digital viewing and printing`
  }

  // -------------------------------------------------------------- core prompts

  /**
   * Prompt asking for N search queries for a task.
   * @param {string} question - the question.
   * @param {string} parentQuery - the main question, for detailed/subtopic reports.
   * @param {string} reportType - report type value.
   * @param {number} [maxIterations] - how many queries to request.
   * @param {Array<Record<string, unknown>>} [context] - real-time web context.
   * @param {Date} [now] - clock, for the date line.
   * @returns {string} the prompt.
   */
  static generate_search_queries_prompt(question, parentQuery, reportType, maxIterations = 3, context = [], now = new Date()) {
    const task = (reportType === ReportType.DetailedReport || reportType === ReportType.SubtopicReport)
      ? `${parentQuery} - ${question}`
      : question

    const contextPrompt = context.length > 0
      ? `
You are a seasoned research assistant tasked with generating search queries to find relevant information for the following task: "${task}".
Context: ${pyStr(context)}

Use this context to inform and refine your search queries. The context provides real-time web information that can help you generate more specific and relevant queries. Consider any current events, recent developments, or specific details mentioned in the context that could enhance the search queries.
`
      : ''

    const dynamicExample = Array.from({ length: maxIterations }, (_value, index) => `"query ${index + 1}"`).join(', ')

    return `Write ${maxIterations} search queries to research the following task: "${task}"

Each query must be a plain natural language phrase. Do not use search operator syntax
such as site:, filetype:, inurl:, intitle:, OR, AND, or NOT — these operators are
not universally supported and will return empty results on many search backends.

Assume the current date is ${formatUtcLongDate(now)} if required.

${contextPrompt}
You must respond with a list of strings in the following format: [${dynamicExample}].
The response should contain ONLY the list.
`
  }

  /**
   * Prompt for the standard research report.
   * @param {string} question - the question.
   * @param {string} context - gathered context.
   * @param {string} reportSource - report source value.
   * @param {string} [reportFormat] - citation format.
   * @param {number} [totalWords] - minimum length.
   * @param {string | null} [tone] - writing tone value.
   * @param {string} [language] - output language.
   * @param {Date} [now] - clock.
   * @returns {string} the prompt.
   */
  static generate_report_prompt(question, context, reportSource, reportFormat = 'apa', totalWords = 1000, tone = null, language = 'english', now = new Date()) {
    const referencePrompt = reportSource === ReportSource.Web
      ? `
You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.
Every url should be hyperlinked: [url website](url)
Additionally, you MUST include hyperlinks to the relevant URLs wherever they are referenced in the report:

eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)
`
      : `
You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
`

    const tonePrompt = tone ? `Write the report in a ${tone} tone.` : ''

    return `
Information: "${context}"
---
Using the above information, answer the following query or task: "${question}" in a detailed report --
The report should focus on the answer to the query, should be well structured, informative,
in-depth, and comprehensive, with facts and numbers if available and at least ${totalWords} words.
You should strive to write the report as long as you can using all relevant and necessary information provided.

Please follow all of the following guidelines in your report:
- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.
- You MUST write the report with markdown syntax and ${reportFormat} format.
- Structure your report with clear markdown headers: use # for the main title, ## for major sections, and ### for subsections.
- Use markdown tables when presenting structured data or comparisons to enhance readability.
- You MUST prioritize the relevance, reliability, and significance of the sources you use. Choose trusted sources over less reliable ones.
- You must also prioritize new articles over older articles if the source can be trusted.
- You MUST NOT include a table of contents, but DO include proper markdown headers (# ## ###) to structure your report clearly.
- Use in-text citation references in ${reportFormat} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- Every substantive claim, figure or quote MUST carry an in-text citation to the source it came from. Do NOT cite sources that do not appear in the provided information.
- Don't forget to add a reference list at the end of the report in ${reportFormat} format.
- ${referencePrompt}
- ${tonePrompt}
You MUST write the report in the following language: ${language}.
Assume that the current date is ${formatToday(now)}.
`
  }

  /**
   * Prompt for curating scraped sources.
   * @param {string} query - the research query.
   * @param {unknown} sources - the source list.
   * @param {number} [maxResults] - maximum sources to keep.
   * @returns {string} the prompt.
   */
  static curate_sources(query, sources, maxResults = 10) {
    return `Your goal is to evaluate and curate the provided scraped content for the research task: "${query}"
    while prioritizing the inclusion of relevant and high-quality information, especially sources containing statistics, numbers, or concrete data.

The final curated list will be used as context for creating a research report, so prioritize:
- Retaining as much original information as possible, with extra emphasis on sources featuring quantitative data or unique insights
- Including a wide range of perspectives and insights
- Filtering out only clearly irrelevant or unusable content

EVALUATION GUIDELINES:
1. Assess each source based on:
   - Relevance: Include sources directly or partially connected to the research query. Err on the side of inclusion.
   - Credibility: Favor authoritative sources but retain others unless clearly untrustworthy.
   - Currency: Prefer recent information unless older data is essential or valuable.
   - Objectivity: Retain sources with bias if they provide a unique or complementary perspective.
   - Quantitative Value: Give higher priority to sources with statistics, numbers, or other concrete data.
2. Source Selection:
   - Include as many relevant sources as possible, up to ${maxResults}, focusing on broad coverage and diversity.
   - Prioritize sources with statistics, numerical data, or verifiable facts.
   - Overlapping content is acceptable if it adds depth, especially when data is involved.
   - Exclude sources only if they are entirely irrelevant, severely outdated, or unusable due to poor content quality.
3. Content Retention:
   - DO NOT rewrite, summarize, or condense any source content.
   - Retain all usable information, cleaning up only clear garbage or formatting issues.
   - Keep marginally relevant or incomplete sources if they contain valuable data or insights.

SOURCES LIST TO EVALUATE:
${sources}

You MUST return your response in the EXACT sources JSON list format as the original sources.
The response MUST not contain any markdown format or additional text (like \`\`\`json), just the JSON list!
`
  }

  /**
   * Prompt for the resource (bibliography) report.
   * @param {string} question - the question.
   * @param {string} context - gathered context.
   * @param {string} reportSource - report source value.
   * @param {string} [reportFormat] - citation format.
   * @param {string | null} [tone] - writing tone.
   * @param {number} [totalWords] - minimum length.
   * @param {string} [language] - output language.
   * @returns {string} the prompt.
   */
  static generate_resource_report_prompt(question, context, reportSource, reportFormat = 'apa', tone = null, totalWords = 1000, language = 'english') {
    const referencePrompt = reportSource === ReportSource.Web
      ? `
            You MUST include all relevant source urls.
            Every url should be hyperlinked: [url website](url)
            `
      : `
            You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
        `

    return `"""${context}"""\n\nBased on the above information, generate a bibliography recommendation report for the following`
      + ` question or topic: "${question}". The report should provide a detailed analysis of each recommended resource,`
      + ' explaining how each source can contribute to finding answers to the research question.\n'
      + 'Focus on the relevance, reliability, and significance of each source.\n'
      + 'Ensure that the report is well-structured, informative, in-depth, and follows Markdown syntax.\n'
      + 'Use markdown tables and other formatting features when appropriate to organize and present information clearly.\n'
      + 'Include relevant facts, figures, and numbers whenever available.\n'
      + `The report should have a minimum length of ${totalWords} words.\n`
      + `You MUST write the report in the following language: ${language}.\n`
      + 'You MUST include all relevant source urls.'
      + 'Every url should be hyperlinked: [url website](url)'
      + `${referencePrompt}`
  }

  /**
   * Prompt for a caller-supplied report instruction.
   * @param {string} queryPrompt - the caller's instruction.
   * @param {string} context - gathered context.
   * @returns {string} the prompt.
   */
  static generate_custom_report_prompt(queryPrompt, context) {
    return `"${context}"\n\n${queryPrompt}`
  }

  /**
   * Prompt for an outline report.
   * @param {string} question - the question.
   * @param {string} context - gathered context.
   * @param {number} [totalWords] - target length.
   * @returns {string} the prompt.
   */
  static generate_outline_report_prompt(question, context, totalWords = 1000) {
    return `"""${context}""" Using the above information, generate an outline for a research report in Markdown syntax`
      + ` for the following question or topic: "${question}". The outline should provide a well-structured framework`
      + ' for the research report, including the main sections, subsections, and key points to be covered.'
      + ` The research report should be detailed, informative, in-depth, and a minimum of ${totalWords} words.`
      + ' Use appropriate Markdown syntax to format the outline and ensure readability.'
      + ' Consider using markdown tables and other formatting features where they would enhance the presentation of information.'
  }

  /**
   * Prompt for the deep-research (hierarchical) report.
   * @param {string} question - the question.
   * @param {string} context - hierarchical research context.
   * @param {string} reportSource - report source value.
   * @param {string} [reportFormat] - citation format.
   * @param {string | null} [tone] - writing tone.
   * @param {number} [totalWords] - minimum length.
   * @param {string} [language] - output language.
   * @param {Date} [now] - clock.
   * @returns {string} the prompt.
   */
  static generate_deep_research_prompt(question, context, reportSource, reportFormat = 'apa', tone = null, totalWords = 2000, language = 'english', now = new Date()) {
    const referencePrompt = reportSource === ReportSource.Web
      ? `
You MUST write all used source urls at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each.
Every url should be hyperlinked: [url website](url)
Additionally, you MUST include hyperlinks to the relevant URLs wherever they are referenced in the report:

eg: Author, A. A. (Year, Month Date). Title of web page. Website Name. [url website](url)
`
      : `
You MUST write all used source document names at the end of the report as references, and make sure to not add duplicated sources, but only one reference for each."
`

    const tonePrompt = tone ? `Write the report in a ${tone} tone.` : ''

    return `
Using the following hierarchically researched information and citations:

"${context}"

Write a comprehensive research report answering the query: "${question}"

The report should:
1. Synthesize information from multiple levels of research depth
2. Integrate findings from various research branches
3. Present a coherent narrative that builds from foundational to advanced insights
4. Maintain proper citation of sources throughout
5. Be well-structured with clear sections and subsections
6. Have a minimum length of ${totalWords} words
7. Follow ${reportFormat} format with markdown syntax
8. Use markdown tables, lists and other formatting features when presenting comparative data, statistics, or structured information

Additional requirements:
- Prioritize insights that emerged from deeper levels of research
- Highlight connections between different research branches
- Include relevant statistics, data, and concrete examples
- You MUST determine your own concrete and valid opinion based on the given information. Do NOT defer to general and meaningless conclusions.
- You MUST prioritize the relevance, reliability, and significance of the sources you use. Choose trusted sources over less reliable ones.
- You must also prioritize new articles over older articles if the source can be trusted.
- Use in-text citation references in ${reportFormat} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- ${tonePrompt}
- Write in ${language}

${referencePrompt}

Please write a thorough, well-researched report that synthesizes all the gathered information into a cohesive whole.
Assume the current date is ${formatUtcLongDate(now)}.
`
  }

  /** @returns {string} instructions for the agent-selection call. */
  static auto_agent_instructions() {
    return `
This task involves researching a given topic, regardless of its complexity or the availability of a definitive answer. The research is conducted by a specific server, defined by its type and role, with each server requiring distinct instructions.
Agent
The server is determined by the field of the topic and the specific name of the server that could be utilized to research the topic provided. Agents are categorized by their area of expertise, and each server type is associated with a corresponding emoji.

examples:
task: "should I invest in apple stocks?"
response:
{
    "server": "💰 Finance Agent",
    "agent_role_prompt": "You are a seasoned finance analyst AI assistant. Your primary goal is to compose comprehensive, astute, impartial, and methodically arranged financial reports based on provided data and trends."
}
task: "could reselling sneakers become profitable?"
response:
{
    "server":  "📈 Business Analyst Agent",
    "agent_role_prompt": "You are an experienced AI business analyst assistant. Your main objective is to produce comprehensive, insightful, impartial, and systematically structured business reports based on provided business data, market trends, and strategic analysis."
}
task: "what are the most interesting sites in Tel Aviv?"
response:
{
    "server":  "🌍 Travel Agent",
    "agent_role_prompt": "You are a world-travelled AI tour guide assistant. Your main purpose is to draft engaging, insightful, unbiased, and well-structured travel reports on given locations, including history, attractions, and cultural insights."
}
`
  }

  /**
   * Prompt that summarizes data against a query.
   * @param {string} query - the query.
   * @param {string} data - the text to summarize.
   * @returns {string} the prompt.
   */
  static generate_summary_prompt(query, data) {
    return `${data}\n Using the above text, summarize it based on the following task or query: "${query}".\n If the `
      + 'query cannot be answered using the text, YOU MUST summarize the text in short.\n Include all factual '
      + 'information such as numbers, stats, quotes, etc if available. '
  }

  /**
   * Prompt for a single continuous summary over search results.
   * @param {string} query - the query.
   * @param {string} context - the search results.
   * @returns {string} the prompt.
   */
  static generate_quick_summary_prompt(query, context) {
    return `
Synthesize a comprehensive answer to the following query based ONLY on the provided search results.
Query: "${query}"

Search Results:
${context}

Instructions:
1. Provide a single, continuous narrative summary.
2. Cite your sources using numbers [1], [2], etc., corresponding to the search results.
3. If the results are insufficient to answer the query, state that clearly.
4. Focus on accuracy and relevance.
`
  }

  /** @returns {string} the subtopics prompt template. */
  static generate_subtopics_prompt() {
    return `
Provided the main topic:

{task}

and research data:

{data}

- Construct a list of subtopics which indicate the headers of a report document to be generated on the task.
- These are a possible list of subtopics : {subtopics}.
- There should NOT be any duplicate subtopics.
- Limit the number of subtopics to a maximum of {max_subtopics}
- Finally order the subtopics by their tasks, in a relevant and meaningful order which is presentable in a detailed report

"IMPORTANT!":
- Every subtopic MUST be relevant to the main topic and provided research data ONLY!

{format_instructions}
`
  }

  /**
   * Prompt for one subtopic report section.
   * @param {string} currentSubtopic - the subtopic.
   * @param {string[]} existingHeaders - headers already written.
   * @param {string[]} relevantWrittenContents - contents already written.
   * @param {string} mainTopic - the main topic.
   * @param {string} context - gathered context.
   * @param {object} [options] - formatting options.
   * @returns {string} the prompt.
   */
  static generate_subtopic_report_prompt(
    currentSubtopic,
    existingHeaders,
    relevantWrittenContents,
    mainTopic,
    context,
    options = {},
  ) {
    const reportFormat = options.reportFormat ?? 'apa'
    const maxSubsections = options.maxSubsections ?? 5
    const totalWords = options.totalWords ?? 800
    const tone = options.tone ?? Tone.Objective
    const language = options.language ?? 'english'
    const now = options.now ?? new Date()

    return `
Context:
"${context}"

Main Topic and Subtopic:
Using the latest information available, construct a detailed report on the subtopic: ${currentSubtopic} under the main topic: ${mainTopic}.
You must limit the number of subsections to a maximum of ${maxSubsections}.

Content Focus:
- The report should focus on answering the question, be well-structured, informative, in-depth, and include facts and numbers if available.
- Use markdown syntax and follow the ${reportFormat.toUpperCase()} format.
- When presenting data, comparisons, or structured information, use markdown tables to enhance readability.

IMPORTANT:Content and Sections Uniqueness:
- This part of the instructions is crucial to ensure the content is unique and does not overlap with existing reports.
- Carefully review the existing headers and existing written contents provided below before writing any new subsections.
- Prevent any content that is already covered in the existing written contents.
- Do not use any of the existing headers as the new subsection headers.
- Do not repeat any information already covered in the existing written contents or closely related variations to avoid duplicates.
- If you have nested subsections, ensure they are unique and not covered in the existing written contents.
- Ensure that your content is entirely new and does not overlap with any information already covered in the previous subtopic reports.

"Existing Subtopic Reports":
- Existing subtopic reports and their section headers:

    ${pyStr(existingHeaders)}

- Existing written contents from previous subtopic reports:

    ${pyStr(relevantWrittenContents)}

"Structure and Formatting":
- As this sub-report will be part of a larger report, include only the main body divided into suitable subtopics without any introduction or conclusion section.

- You MUST include markdown hyperlinks to relevant source URLs wherever referenced in the report, for example:

    ### Section Header

    This is a sample text ([in-text citation](url)).

- Use H2 for the main subtopic header (##) and H3 for subsections (###).
- Use smaller Markdown headers (e.g., H2 or H3) for content structure, avoiding the largest header (H1) as it will be used for the larger report's heading.
- Organize your content into distinct sections that complement but do not overlap with existing reports.
- When adding similar or identical subsections to your report, you should clearly indicate the differences between and the new content and the existing written content from previous subtopic reports. For example:

    ### New header (similar to existing header)

    While the previous section discussed [topic A], this section will explore [topic B]."

"Date":
Assume the current date is ${formatUtcLongDate(now)} if required.

"IMPORTANT!":
- You MUST write the report in the following language: ${language}.
- The focus MUST be on the main topic! You MUST Leave out any information un-related to it!
- Must NOT have any introduction, conclusion, summary or reference section.
- You MUST use in-text citation references in ${reportFormat.toUpperCase()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
- You MUST mention the difference between the existing content and the new content in the report if you are adding the similar or same subsections wherever necessary.
- The report should have a minimum length of ${totalWords} words.
- Use an ${tone} tone throughout the report.

Do NOT add a conclusion section.
`
  }

  /**
   * Prompt for draft section titles of a subtopic report.
   * @param {string} currentSubtopic - the subtopic.
   * @param {string} mainTopic - the main topic.
   * @param {string} context - gathered context.
   * @param {number} [maxSubsections] - maximum subsections.
   * @returns {string} the prompt.
   */
  static generate_draft_titles_prompt(currentSubtopic, mainTopic, context, maxSubsections = 5) {
    return `
"Context":
"${context}"

"Main Topic and Subtopic":
Using the latest information available, construct a draft section title headers for a detailed report on the subtopic: ${currentSubtopic} under the main topic: ${mainTopic}.

"Task":
1. Create a list of draft section title headers for the subtopic report.
2. Each header should be concise and relevant to the subtopic.
3. The header shouldn't be too high level, but detailed enough to cover the main aspects of the subtopic.
4. Use markdown syntax for the headers, using H3 (###) as H1 and H2 will be used for the larger report's heading.
5. Ensure the headers cover main aspects of the subtopic.

"Structure and Formatting":
Provide the draft headers in a list format using markdown syntax, for example:

### Header 1
### Header 2
### Header 3

"IMPORTANT!":
- The focus MUST be on the main topic! You MUST Leave out any information un-related to it!
- Must NOT have any introduction, conclusion, summary or reference section.
- Focus solely on creating headers, not content.
`
  }

  /**
   * Prompt for the report introduction.
   * @param {string} question - the research question.
   * @param {string} [researchSummary] - gathered context.
   * @param {string} [language] - output language.
   * @param {string} [reportFormat] - citation format.
   * @param {Date} [now] - clock.
   * @returns {string} the prompt.
   */
  static generate_report_introduction(question, researchSummary = '', language = 'english', reportFormat = 'apa', now = new Date()) {
    return `${researchSummary}\n
Using the above latest information, Prepare a detailed report introduction on the topic -- ${question}.
- The introduction should be succinct, well-structured, informative with markdown syntax.
- As this introduction will be part of a larger report, do NOT include any other sections, which are generally present in a report.
- The introduction should be preceded by an H1 heading with a suitable topic for the entire report.
- You must use in-text citation references in ${reportFormat.toUpperCase()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).
Assume that the current date is ${formatUtcLongDate(now)} if required.
- The output must be in ${language} language.
`
  }

  /**
   * Prompt for the report conclusion.
   * @param {string} query - the research task.
   * @param {string} reportContent - the report body.
   * @param {string} [language] - output language.
   * @param {string} [reportFormat] - citation format.
   * @returns {string} the prompt.
   */
  static generate_report_conclusion(query, reportContent, language = 'english', reportFormat = 'apa') {
    return `
    Based on the research report below and research task, please write a concise conclusion that summarizes the main findings and their implications:

    Research task: ${query}

    Research Report: ${reportContent}

    Your conclusion should:
    1. Recap the main points of the research
    2. Highlight the most important findings
    3. Discuss any implications or next steps
    4. Be approximately 2-3 paragraphs long

    If there is no "## Conclusion" section title written at the end of the report, please add it to the top of your conclusion.
    You must use in-text citation references in ${reportFormat.toUpperCase()} format and make it with markdown hyperlink placed at the end of the sentence or paragraph that references them like this: ([in-text citation](url)).

    IMPORTANT: The entire conclusion MUST be written in ${language} language.

    Write the conclusion:
    `
  }
}

/** Prompts for IBM's Granite models. */
export class GranitePromptFamily extends PromptFamily {
  /** @returns {Function} the concrete Granite family. */
  graniteClass() {
    return this.getGraniteClass()
  }

  /** @returns {string} rendered documents in Granite framing. */
  pretty_print_docs(...args) {
    return this.graniteClass().pretty_print_docs(...args)
  }

  /** @returns {string} joined context in Granite framing. */
  join_local_web_documents(...args) {
    return this.graniteClass().join_local_web_documents(...args)
  }
}

/** Prompts for Granite 3.X models before 3.3. */
export class Granite3PromptFamily extends PromptFamily {
  static DOCUMENTS_PREFIX = '<|start_of_role|>documents<|end_of_role|>\n'
  static DOCUMENTS_SUFFIX = '\n<|end_of_text|>'

  /**
   * @param {Array<{pageContent: string, metadata: Record<string, unknown>>} | null} docs - documents.
   * @param {number | null} [topN] - maximum documents.
   * @returns {string} Granite-framed documents.
   */
  static pretty_print_docs(docs, topN = null) {
    if (!docs || docs.length === 0) return ''
    const allDocuments = docs
      .filter((_doc, index) => topN === null || index < topN)
      .map((doc, index) => `Document ${doc.metadata.source ?? index}\n`
        + `Title: ${doc.metadata.title}\n`
        + doc.pageContent)
      .join('\n\n')
    return [Granite3PromptFamily.DOCUMENTS_PREFIX, allDocuments, Granite3PromptFamily.DOCUMENTS_SUFFIX].join('')
  }

  /**
   * @param {string} docsContext - local context.
   * @param {string} webContext - web context.
   * @returns {string} Granite-framed joined context.
   */
  static join_local_web_documents(docsContext, webContext) {
    let local = docsContext
    let web = webContext
    if (typeof local === 'string' && local.startsWith(Granite3PromptFamily.DOCUMENTS_PREFIX)) {
      local = local.slice(Granite3PromptFamily.DOCUMENTS_PREFIX.length)
    }
    if (typeof web === 'string' && web.endsWith(Granite3PromptFamily.DOCUMENTS_SUFFIX)) {
      web = web.slice(0, -Granite3PromptFamily.DOCUMENTS_SUFFIX.length)
    }
    const allDocuments = [local, web].join('\n\n')
    return [Granite3PromptFamily.DOCUMENTS_PREFIX, allDocuments, Granite3PromptFamily.DOCUMENTS_SUFFIX].join('')
  }
}

/** Prompts for IBM's Granite 3.3 models. */
export class Granite33PromptFamily extends PromptFamily {
  static DOCUMENT_TEMPLATE = '<|start_of_role|>document {{"document_id": "{document_id}"}}<|end_of_role|>\n{document_content}<|end_of_text|>\n'

  /**
   * @param {{pageContent: string, metadata: Record<string, unknown>}} doc - document.
   * @returns {string} document content with an optional title prefix.
   */
  static getContent(doc) {
    let docContent = doc.pageContent
    if (doc.metadata.title) docContent = `Title: ${doc.metadata.title}\n${docContent}`
    return docContent.trim()
  }

  /**
   * @param {Array<{pageContent: string, metadata: Record<string, unknown>>} | null} docs - documents.
   * @param {number | null} [topN] - maximum documents.
   * @returns {string} Granite 3.3-framed documents.
   */
  static pretty_print_docs(docs, topN = null) {
    if (!docs) return ''
    return docs
      .filter((_doc, index) => topN === null || index < topN)
      .map((doc, index) => Granite33PromptFamily.DOCUMENT_TEMPLATE
        .replace('{document_id}', String(doc.metadata.source ?? index))
        .replace('{document_content}', Granite33PromptFamily.getContent(doc)))
      .join('\n')
  }

  /**
   * @param {string} docsContext - local context.
   * @param {string} webContext - web context.
   * @returns {string} joined context.
   */
  static join_local_web_documents(docsContext, webContext) {
    return [docsContext, webContext].join('\n\n')
  }
}

/**
 * Expose every static prompt builder on the instance too.
 *
 * Python's `@staticmethod` is callable from both the class and an instance, and
 * the source mixes the two (`PromptFamily.generate_report_prompt(...)` and
 * `self.prompt_family.curate_sources(...)`). JavaScript static methods are not
 * reachable through an instance, so each one is mirrored onto the prototype.
 * Instance methods declared in the class body keep priority.
 */
for (const name of Object.getOwnPropertyNames(PromptFamily)) {
  if (name === 'length' || name === 'name' || name === 'prototype') continue
  if (Object.prototype.hasOwnProperty.call(PromptFamily.prototype, name)) continue
  const descriptor = Object.getOwnPropertyDescriptor(PromptFamily, name)
  if (descriptor === undefined || typeof descriptor.value !== 'function') continue
  PromptFamily.prototype[name] = descriptor.value
}

/** Report type value → prompt method name. */
export const reportTypeMapping = Object.freeze({
  [ReportType.ResearchReport]: 'generate_report_prompt',
  [ReportType.ResourceReport]: 'generate_resource_report_prompt',
  [ReportType.OutlineReport]: 'generate_outline_report_prompt',
  [ReportType.CustomReport]: 'generate_custom_report_prompt',
  [ReportType.SubtopicReport]: 'generate_subtopic_report_prompt',
  [ReportType.DeepResearch]: 'generate_deep_research_prompt',
})

/**
 * Resolve the prompt builder for a report type.
 *
 * @param {string} reportType - report type value.
 * @param {Function | object} promptFamily - the family class or instance.
 * @returns {Function} the bound prompt builder.
 */
export function getPromptByReportType(reportType, promptFamily) {
  const name = reportTypeMapping[reportType]
  const family = typeof promptFamily === 'function' ? promptFamily : promptFamily.constructor
  let builder = name === undefined ? undefined : family[name]
  if (typeof builder !== 'function') {
    const defaultType = ReportType.ResearchReport
    console.warn('Invalid report type: ' + reportType + '.\n'
      + 'Please use one of the following: ' + Object.keys(reportTypeMapping).join(', ') + '\n'
      + `Using default report type: ${defaultType} prompt.`)
    builder = family[reportTypeMapping[defaultType]]
  }
  return builder
}

/** Prompt family name → family class. */
export const promptFamilyMapping = Object.freeze({
  [PromptFamilyEnum.Default]: PromptFamily,
  [PromptFamilyEnum.Granite]: GranitePromptFamily,
  [PromptFamilyEnum.Granite3]: Granite3PromptFamily,
  [PromptFamilyEnum.Granite31]: Granite3PromptFamily,
  [PromptFamilyEnum.Granite32]: Granite3PromptFamily,
  [PromptFamilyEnum.Granite33]: Granite33PromptFamily,
})

/**
 * Resolve a prompt family by name.
 * @param {string} promptFamilyName - family name.
 * @param {object} config - resolved config.
 * @returns {object} the family instance.
 */
export function getPromptFamily(promptFamilyName, config) {
  const name = typeof promptFamilyName === 'string' ? promptFamilyName : promptFamilyName
  const family = promptFamilyMapping[name]
  if (family === undefined) {
    console.warn('Invalid prompt family: ' + promptFamilyName + '.\n'
      + 'Please use one of the following: ' + Object.keys(promptFamilyMapping).join(', ') + '\n'
      + `Using default prompt family: ${PromptFamilyEnum.Default} prompt.`)
    return new PromptFamily(config)
  }
  return new family(config)
}
