/**
 * Source curator skill.
 *
 * One-to-one port of `gpt_researcher/skills/curator.py`: the LLM call with its
 * exact temperature (0.2) and token cap (8000), the tolerant JSON recovery, the
 * list-shape guard that falls back to the uncurated sources, and the failure
 * path that returns the input unchanged.
 *
 * The source used LangChain's `parse_json_markdown(response, parser=json_repair.loads)`;
 * the port reproduces both steps explicitly — strip a Markdown fence, then
 * repair-parse — because the guard after it depends on `json_repair` never
 * raising and on non-list results being rejected.
 *
 * @module @yf-river/dsh-gpt-research/skills/curator
 */

import { streamOutput } from '../actions/utils.js'
import { createChatCompletion } from '../utils/llm.js'
import { jsonRepairLoads } from '../utils/json-repair.js'

const logger = {
  error: (...args) => console.error(...args),
  debug: (...args) => {},
}

/**
 * Strip a Markdown code fence, mirroring `parse_json_markdown`'s first step.
 * @param {string} text - model reply.
 * @returns {string} the payload without a fence.
 */
function stripMarkdownFence(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return (fenced === null ? text : fenced[1]).trim()
}

/**
 * Parse a JSON value out of a model reply, tolerating a fence and light damage.
 *
 * @param {string} text - model reply.
 * @returns {unknown} the recovered value; `jsonRepairLoads` throws on unusable input.
 */
function parseJsonMarkdown(text) {
  return jsonRepairLoads(stripMarkdownFence(text))
}

/**
 * Ranks and curates sources by relevance, credibility and reliability.
 */
export class SourceCurator {
  /**
   * @param {object} deps - the parent researcher's collaborating pieces.
   * @param {object} deps.cfg - resolved config.
   * @param {object} [deps.promptFamily] - prompt renderer.
   * @param {string} [deps.role] - the agent role prompt.
   * @param {string} [deps.query] - the research query.
   * @param {((cost: number) => void) | null} [deps.costCallback] - cost sink.
   * @param {boolean} [deps.verbose] - whether to stream progress.
   * @param {object | null} [deps.websocket] - progress sink.
   * @param {object} [deps.provider] - the model-call seam.
   * @param {Record<string, string|undefined>} [deps.env] - environment map.
   */
  constructor(deps) {
    /** @type {object} */
    this.deps = deps
  }

  /**
   * Rank sources and return the most useful ones.
   *
   * @param {Array<Record<string, unknown>>} sourceData - sources to rank.
   * @param {number} [maxResults] - maximum sources to return.
   * @returns {Promise<Array<Record<string, unknown>>>} curated sources, or the input on failure.
   */
  async curateSources(sourceData, maxResults = 10) {
    logger.debug(`Curating ${sourceData.length} sources`)
    if (this.deps.verbose) {
      await streamOutput(
        'logs',
        'research_plan',
        '⚖️ Evaluating and curating sources by credibility and relevance...',
        this.deps.websocket ?? null,
      )
    }

    try {
      const family = this.deps.promptFamily
      const response = await createChatCompletion({
        model: this.deps.cfg.smart_llm_model,
        messages: [
          { role: 'system', content: `${this.deps.role ?? ''}` },
          {
            role: 'user',
            content: family.curate_sources(this.deps.query, sourceData, maxResults),
          },
        ],
        temperature: 0.2,
        maxTokens: 8000,
        llmProvider: this.deps.cfg.smart_llm_provider,
        llmKwargs: this.deps.cfg.llm_kwargs,
        costCallback: this.deps.costCallback ?? null,
        provider: this.deps.provider,
        env: this.deps.env,
      })

      // LLMs frequently wrap the JSON in ```json fences or add prose despite the
      // prompt, which plain JSON parsing cannot handle. Recover the payload the
      // same way the rest of the codebase does.
      const curatedSources = parseJsonMarkdown(response)
      // json_repair never raises: on unusable output it returns "" or a dict
      // rather than a list. Guard so such a result still falls back to the
      // uncurated sources instead of emptying the context.
      if (!Array.isArray(curatedSources)) {
        throw new Error(`expected a JSON list of sources, got ${curatedSources === null ? 'null' : typeof curatedSources}`)
      }
      logger.debug(`Curated ${curatedSources.length} of ${sourceData.length} sources`)

      if (this.deps.verbose) {
        await streamOutput(
          'logs',
          'research_plan',
          `🏅 Verified and ranked top ${curatedSources.length} most reliable sources`,
          this.deps.websocket ?? null,
        )
      }

      return curatedSources
    } catch (error) {
      logger.error(`Error in curate_sources: ${error?.message ?? error}`)
      if (this.deps.verbose) {
        await streamOutput(
          'logs',
          'research_plan',
          `🚫 Source verification failed: ${error?.message ?? error}`,
          this.deps.websocket ?? null,
        )
      }
      return sourceData
    }
  }
}
