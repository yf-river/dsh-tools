/**
 * Report generator skill.
 *
 * One-to-one port of `gpt_researcher/skills/writer.py`: the research-parameter
 * bag, the empty-context abstention (never fabricate a report from nothing),
 * the subtopic parameter branch, and the four delegation methods.
 *
 * The source read live attributes off `self.researcher` in `write_report` — the
 * comment there explains why (a caller could change `websocket` after
 * construction). The port reads the same live fields from `this.deps` on every
 * call, so that behaviour is preserved.
 *
 * @module @yf-river/dsh-gpt-research/skills/writer
 */

import { generateDraftSectionTitles, generateReport, writeConclusion, writeReportIntroduction } from '../actions/report-generation.js'
import { streamOutput } from '../actions/utils.js'
import { constructSubtopics } from '../utils/llm.js'

/**
 * Generates reports from research data.
 */
export class ReportGenerator {
  /**
   * @param {object} deps - the parent researcher's collaborating pieces.
   * @param {string} deps.query - the research query.
   * @param {object} deps.cfg - resolved config.
   * @param {object} [deps.promptFamily] - prompt renderer.
   * @param {string} [deps.role] - the agent role prompt.
   * @param {string} [deps.reportType] - report type value.
   * @param {string} [deps.reportSource] - report source value.
   * @param {string | null} [deps.tone] - writing tone.
   * @param {string} [deps.parentQuery] - the parent query, for subtopic reports.
   * @param {unknown} [deps.context] - gathered context.
   * @param {boolean} [deps.verbose] - whether to stream progress.
   * @param {object | null} [deps.websocket] - progress sink.
   * @param {((cost: number) => void) | null} [deps.costCallback] - cost sink.
   * @param {() => string[]} [deps.getResearchImages] - current research images.
   * @param {object} [deps.provider] - the model-call seam.
   * @param {Record<string, string|undefined>} [deps.env] - environment map.
   */
  constructor(deps) {
    /** @type {object} */
    this.deps = deps
    this.researchParams = {
      query: deps.query,
      agent_role_prompt: deps.cfg.agent_role || deps.role,
      report_type: deps.reportType,
      report_source: deps.reportSource,
      tone: deps.tone,
      websocket: deps.websocket,
      cfg: deps.cfg,
      headers: deps.headers,
    }
  }

  /**
   * Write a report from the gathered context.
   *
   * @param {object} [options] - report options.
   * @param {string[]} [options.existingHeaders] - headers already written.
   * @param {string[]} [options.relevantWrittenContents] - contents already written.
   * @param {unknown} [options.extContext] - context override.
   * @param {string} [options.customPrompt] - caller instruction.
   * @param {Array<object>} [options.availableImages] - pre-generated images.
   * @returns {Promise<string>} the report, or an abstention message.
   */
  async writeReport(options = {}) {
    const availableImages = options.availableImages ?? []
    const existingHeaders = options.existingHeaders ?? []
    const relevantWrittenContents = options.relevantWrittenContents ?? []
    const customPrompt = options.customPrompt ?? ''

    // Send the selected images before writing the report.
    const researchImages = this.deps.getResearchImages?.() ?? []
    if (researchImages.length > 0) {
      await streamOutput(
        'images',
        'selected_images',
        JSON.stringify(researchImages),
        this.deps.websocket ?? null,
        true,
        researchImages,
      )
    }

    const context = options.extContext ?? this.deps.context

    // Guard against fabricating a report from nothing: if no research content
    // was gathered (every retriever returned empty / was blocked / rate-limited),
    // don't silently write a confident, sourced-looking report — abstain so it
    // is visible.
    const contextText = Array.isArray(context) ? context.join('\n') : String(context ?? '')
    if (contextText.trim() === '') {
      return `I could not gather any source material for "${this.deps.query}". `
        + 'No sources were retrieved (searches may have returned nothing or been '
        + 'blocked), so I am not able to produce a reliable, sourced report.'
    }

    if (availableImages.length > 0 && this.deps.verbose) {
      await streamOutput(
        'logs',
        'images_available',
        `🖼️ ${availableImages.length} pre-generated images available for embedding`,
        this.deps.websocket ?? null,
      )
    }

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'writing_report',
        `✍️ Writing report for '${this.deps.query}'...`,
        this.deps.websocket ?? null,
      )
    }

    const reportParams = { ...this.researchParams }
    // The captured websocket may be stale; re-read the live field.
    reportParams.websocket = this.deps.websocket
    if (!reportParams.agent_role_prompt) {
      reportParams.agent_role_prompt = this.deps.cfg.agent_role || this.deps.role
    }
    reportParams.context = context
    reportParams.custom_prompt = customPrompt
    reportParams.available_images = availableImages

    if (this.deps.reportType === 'subtopic_report') {
      Object.assign(reportParams, {
        main_topic: this.deps.parentQuery,
        existing_headers: existingHeaders,
        relevant_written_contents: relevantWrittenContents,
        cost_callback: this.deps.costCallback ?? null,
      })
    } else {
      reportParams.cost_callback = this.deps.costCallback ?? null
    }

    const report = await generateReport(
      reportParams.query,
      reportParams.context,
      reportParams.agent_role_prompt,
      reportParams.report_type,
      reportParams.tone,
      reportParams.report_source,
      reportParams.cfg,
      {
        mainTopic: reportParams.main_topic,
        existingHeaders: reportParams.existing_headers,
        relevantWrittenContents: reportParams.relevant_written_contents,
        customPrompt: reportParams.custom_prompt,
        availableImages: reportParams.available_images,
        costCallback: reportParams.cost_callback,
        websocket: reportParams.websocket,
        promptFamily: this.deps.promptFamily,
        provider: this.deps.provider,
        env: this.deps.env,
      },
    )

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'report_written',
        `📝 Report written for '${this.deps.query}'`,
        this.deps.websocket ?? null,
      )
    }

    return report
  }

  /**
   * Write the report conclusion.
   * @param {string} reportContent - the report body.
   * @returns {Promise<string>} the conclusion.
   */
  async writeReportConclusion(reportContent) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'writing_conclusion',
        `✍️ Writing conclusion for '${this.deps.query}'...`,
        this.deps.websocket ?? null,
      )
    }

    const conclusion = await writeConclusion(
      this.deps.query,
      reportContent,
      this.deps.cfg.agent_role || this.deps.role,
      this.deps.cfg,
      {
        websocket: this.deps.websocket ?? null,
        costCallback: this.deps.costCallback ?? null,
        promptFamily: this.deps.promptFamily,
        provider: this.deps.provider,
        env: this.deps.env,
      },
    )

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'conclusion_written',
        `📝 Conclusion written for '${this.deps.query}'`,
        this.deps.websocket ?? null,
      )
    }

    return conclusion
  }

  /**
   * Write the report introduction.
   * @returns {Promise<string>} the introduction.
   */
  async writeIntroduction() {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'writing_introduction',
        `✍️ Writing introduction for '${this.deps.query}'...`,
        this.deps.websocket ?? null,
      )
    }

    const introduction = await writeReportIntroduction(
      this.deps.query,
      this.deps.context,
      this.deps.cfg.agent_role || this.deps.role,
      this.deps.cfg,
      {
        websocket: this.deps.websocket ?? null,
        costCallback: this.deps.costCallback ?? null,
        promptFamily: this.deps.promptFamily,
        provider: this.deps.provider,
        env: this.deps.env,
      },
    )

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'introduction_written',
        `📝 Introduction written for '${this.deps.query}'`,
        this.deps.websocket ?? null,
      )
    }

    return introduction
  }

  /**
   * Retrieve subtopics for the research.
   * @returns {Promise<Array<object>>} subtopics.
   */
  async getSubtopics() {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'generating_subtopics',
        `🌳 Generating subtopics for '${this.deps.query}'...`,
        this.deps.websocket ?? null,
      )
    }

    const subtopics = await constructSubtopics({
      task: this.deps.query,
      data: this.deps.context,
      config: this.deps.cfg,
      subtopics: this.deps.subtopics,
      buildPrompt: (task, data, existing, maxSubtopics, formatInstructions) => this.deps.promptFamily
        .generate_subtopics_prompt()
        .replace('{task}', String(task))
        .replace('{data}', String(data))
        .replace('{subtopics}', String(existing))
        .replace('{max_subtopics}', String(maxSubtopics))
        .replace('{format_instructions}', String(formatInstructions)),
      formatInstructions: this.deps.promptFamily?.formatInstructions?.() ?? '',
      provider: this.deps.provider,
      env: this.deps.env,
    })

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'subtopics_generated',
        `📊 Subtopics generated for '${this.deps.query}'`,
        this.deps.websocket ?? null,
      )
    }

    return subtopics
  }

  /**
   * Generate draft section titles for one subtopic.
   * @param {string} currentSubtopic - the subtopic.
   * @returns {Promise<string[]>} draft section titles.
   */
  async getDraftSectionTitles(currentSubtopic) {
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'generating_draft_sections',
        `📑 Generating draft section titles for '${this.deps.query}'...`,
        this.deps.websocket ?? null,
      )
    }

    const draftSectionTitles = await generateDraftSectionTitles(
      this.deps.query,
      currentSubtopic,
      this.deps.context,
      this.deps.cfg.agent_role || this.deps.role,
      this.deps.cfg,
      {
        websocket: this.deps.websocket ?? null,
        costCallback: this.deps.costCallback ?? null,
        promptFamily: this.deps.promptFamily,
        provider: this.deps.provider,
        env: this.deps.env,
      },
    )

    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'draft_sections_generated',
        `🗂️ Draft section titles generated for '${this.deps.query}'`,
        this.deps.websocket ?? null,
      )
    }

    return draftSectionTitles
  }
}
