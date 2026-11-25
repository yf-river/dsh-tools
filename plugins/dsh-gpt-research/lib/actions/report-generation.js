/**
 * Report generation.
 *
 * One-to-one port of `gpt_researcher/actions/report_generation.py`: the
 * introduction, the conclusion, the per-URL summary, the draft section titles,
 * and the report itself — including the three-branch prompt selection
 * (subtopic / custom / standard), the image-instruction block, and the
 * system+user retry that drops the system message.
 *
 * The source streamed through a WebSocket; DSH reports progress through the
 * workflow engine, so `websocket` is an optional sink whose absence only means
 * "no streaming", exactly as in the source (where `stream=True` with
 * `websocket=None` yields no frames).
 *
 * @module @yf-river/dsh-gpt-research/actions/report-generation
 */

import { getPromptByReportType, PromptFamily } from '../prompts.js'
import { createChatCompletion } from '../utils/llm.js'
import { getFormattedLogger } from '../utils/logger.js'

const logger = getFormattedLogger()

/**
 * Generate an introduction for the report.
 *
 * @param {string} query - the research query.
 * @param {string} context - context for the report.
 * @param {string} agentRolePrompt - role prompt.
 * @param {object} config - resolved config.
 * @param {object} [options] - call options.
 * @returns {Promise<string>} the introduction, or `''` on failure.
 */
export async function writeReportIntroduction(query, context, agentRolePrompt, config, options = {}) {
  const family = options.promptFamily ?? PromptFamily
  try {
    return await createChatCompletion({
      model: config.smart_llm_model,
      messages: [
        { role: 'system', content: `${agentRolePrompt}` },
        {
          role: 'user',
          content: family.generate_report_introduction(
            query,
            context,
            config.language,
            config.report_format,
            options.now,
          ),
        },
      ],
      temperature: 0.25,
      llmProvider: config.smart_llm_provider,
      stream: true,
      websocket: options.websocket ?? null,
      maxTokens: config.smart_token_limit,
      llmKwargs: config.llm_kwargs,
      costCallback: options.costCallback ?? null,
      provider: options.provider,
      env: options.env,
    })
  } catch (error) {
    logger.error(`Error in generating report introduction: ${error?.message ?? error}`)
    return ''
  }
}

/**
 * Write a conclusion for the report.
 *
 * @param {string} query - the research query.
 * @param {string} context - the report body.
 * @param {string} agentRolePrompt - role prompt.
 * @param {object} config - resolved config.
 * @param {object} [options] - call options.
 * @returns {Promise<string>} the conclusion, or `''` on failure.
 */
export async function writeConclusion(query, context, agentRolePrompt, config, options = {}) {
  const family = options.promptFamily ?? PromptFamily
  try {
    return await createChatCompletion({
      model: config.smart_llm_model,
      messages: [
        { role: 'system', content: `${agentRolePrompt}` },
        {
          role: 'user',
          content: family.generate_report_conclusion(
            query,
            context,
            config.language,
            config.report_format,
          ),
        },
      ],
      temperature: 0.25,
      llmProvider: config.smart_llm_provider,
      stream: true,
      websocket: options.websocket ?? null,
      maxTokens: config.smart_token_limit,
      llmKwargs: config.llm_kwargs,
      costCallback: options.costCallback ?? null,
      provider: options.provider,
      env: options.env,
    })
  } catch (error) {
    logger.error(`Error in writing conclusion: ${error?.message ?? error}`)
    return ''
  }
}

/**
 * Generate draft section titles for a subtopic report.
 *
 * @param {string} query - the research query.
 * @param {string} currentSubtopic - the subtopic.
 * @param {string} context - gathered context.
 * @param {string} role - the role prompt.
 * @param {object} config - resolved config.
 * @param {object} [options] - call options.
 * @returns {Promise<string[]>} section titles, or `[]` on failure.
 */
export async function generateDraftSectionTitles(query, currentSubtopic, context, role, config, options = {}) {
  const family = options.promptFamily ?? PromptFamily
  try {
    const sectionTitles = await createChatCompletion({
      model: config.smart_llm_model,
      messages: [
        { role: 'system', content: `${role}` },
        {
          role: 'user',
          content: family.generate_draft_titles_prompt(currentSubtopic, query, context),
        },
      ],
      temperature: 0.25,
      llmProvider: config.smart_llm_provider,
      stream: true,
      // The source passes websocket=None here even when a sink exists.
      websocket: null,
      maxTokens: config.smart_token_limit,
      llmKwargs: config.llm_kwargs,
      costCallback: options.costCallback ?? null,
      provider: options.provider,
      env: options.env,
    })
    return sectionTitles.split('\n')
  } catch (error) {
    logger.error(`Error in generating draft section titles: ${error?.message ?? error}`)
    return []
  }
}

/**
 * Render the image-embedding instruction block.
 *
 * Only image dicts carrying a usable URL are listed: callers (and partial LLM
 * metadata) may pass null rows, non-dicts, or dicts missing `url`.
 *
 * @param {Array<Record<string, unknown>>} availableImages - pre-generated images.
 * @returns {string} the instruction block, or `''` when there is nothing usable.
 */
function renderImagesBlock(availableImages) {
  const lines = []
  for (const image of availableImages) {
    if (image === null || typeof image !== 'object') continue
    const url = image.url ?? ''
    if (!url) continue
    const alt = image.title || image.alt_text || 'Illustration'
    const hint = image.section_hint || 'General'
    lines.push(`- Image ${lines.length + 1}: ![${alt}](${url}) - ${hint}`)
  }
  if (lines.length === 0) return ''
  return `

AVAILABLE IMAGES:
You have the following pre-generated images available. Embed them in relevant sections of your report using the exact markdown syntax provided:

${lines.join('\n')}

Place each image on its own line after the relevant section header or paragraph. Use all available images where they add value to the content.`
}

/**
 * Generate the final report.
 *
 * @param {string} query - the research query.
 * @param {string | string[]} context - gathered context.
 * @param {string} agentRolePrompt - role prompt.
 * @param {string} reportType - report type value.
 * @param {string | null} tone - writing tone.
 * @param {string} reportSource - report source value.
 * @param {object} cfg - resolved config.
 * @param {object} [options] - call options.
 * @returns {Promise<string>} the report.
 * @throws {Error} when both the system+user and user-only attempts fail.
 */
export async function generateReport(
  query,
  context,
  agentRolePrompt,
  reportType,
  tone,
  reportSource,
  cfg,
  options = {},
) {
  const availableImages = options.availableImages ?? []
  const customPrompt = options.customPrompt ?? ''
  const existingHeaders = options.existingHeaders ?? []
  const relevantWrittenContents = options.relevantWrittenContents ?? []
  const mainTopic = options.mainTopic ?? ''
  const family = options.promptFamily ?? PromptFamily
  const generatePrompt = getPromptByReportType(reportType, family)

  let content
  if (reportType === 'subtopic_report') {
    content = generatePrompt(
      query,
      existingHeaders,
      relevantWrittenContents,
      mainTopic,
      context,
      {
        reportFormat: cfg.report_format,
        tone,
        totalWords: cfg.total_words,
        language: cfg.language,
        now: options.now,
      },
    )
  } else if (customPrompt) {
    content = `${customPrompt}\n\nContext: ${context}`
  } else {
    content = generatePrompt(
      query,
      context,
      reportSource,
      cfg.report_format,
      tone,
      cfg.total_words,
      cfg.language,
      options.now,
    )
  }

  if (availableImages.length > 0) {
    content += renderImagesBlock(availableImages)
  }

  try {
    return await createChatCompletion({
      model: cfg.smart_llm_model,
      messages: [
        { role: 'system', content: `${agentRolePrompt}` },
        { role: 'user', content },
      ],
      temperature: 0.35,
      llmProvider: cfg.smart_llm_provider,
      stream: true,
      websocket: options.websocket ?? null,
      maxTokens: cfg.smart_token_limit,
      llmKwargs: cfg.llm_kwargs,
      costCallback: options.costCallback ?? null,
      provider: options.provider,
      env: options.env,
    })
  } catch {
    try {
      return await createChatCompletion({
        model: cfg.smart_llm_model,
        messages: [{ role: 'user', content: `${agentRolePrompt}\n\n${content}` }],
        temperature: 0.35,
        llmProvider: cfg.smart_llm_provider,
        stream: true,
        websocket: options.websocket ?? null,
        maxTokens: cfg.smart_token_limit,
        llmKwargs: cfg.llm_kwargs,
        costCallback: options.costCallback ?? null,
        provider: options.provider,
        env: options.env,
      })
    } catch (error) {
      logger.error(`Error in generate_report: ${error?.message ?? error}`)
      throw error
    }
  }
}
