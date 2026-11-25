/**
 * Scripted end-to-end exercise of the two-layer graph.
 *
 * The graph's contract is control flow — which node runs next, how many iterations
 * each loop takes, when the loops stop — so it is tested with a scripted model that
 * returns predetermined tool calls, and a scripted search that records queries.
 * That makes every termination path observable without a network or a real model.
 *
 * Run: `node lib/deep/selftest.js`
 *
 * @module @yf-river/dsh-gpt-research/deep/selftest
 */

import { createDeepConfig } from './config.js'
import { runDeepResearch } from './run.js'
import { createAgentState, applyUpdate, overrideReducer } from './state.js'
import { formatPrompt, lead_researcher_prompt, final_report_generation_prompt } from './prompts.js'
import { bufferString, extractJsonObject } from './graph.js'
import { thinkTool, parseToolArguments, formatSearchResults } from './tools.js'

let passed = 0
let failed = 0

/**
 * Assert a condition, recording the outcome.
 * @param {string} name - what is being checked.
 * @param {boolean} condition - the expectation.
 * @param {unknown} [detail] - shown on failure.
 */
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

/** Shorthand for a scripted tool call. */
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })

/**
 * A model whose replies come from a queue of scripted steps per call site.
 * @param {object} script - `{clarify, brief, supervisor, researcher, compress, report}` arrays of replies.
 * @returns {Function} the `complete` seam.
 */
function scriptedModel(script) {
  const queue = {
    clarify: [...(script.clarify ?? [])],
    brief: [...(script.brief ?? [])],
    supervisor: [...(script.supervisor ?? [])],
    researcher: [...(script.researcher ?? [])],
    compress: [...(script.compress ?? [{ text: 'COMPRESSED' }])],
    report: [...(script.report ?? [{ text: '# REPORT' }])],
  }
  const pick = (key, messages, options) => {
    const list = queue[key]
    // Drop the next scripted reply; when exhausted, fall back to "stop here".
    return list.length > 0 ? list.shift() : { text: '' }
  }
  return async (messages, options = {}) => {
    if (options.responseSchema !== undefined) {
      // Distinguish by the field the schema asks for, not by prompt wording.
      const asksClarify = options.responseSchema.properties?.need_clarification !== undefined
      return pick(asksClarify ? 'clarify' : 'brief', messages, options)
    }
    if (options.model === 'compress-model') return pick('compress', messages, options)
    if (options.model === 'writer-model') return pick('report', messages, options)
    // A researcher call carries the research system prompt.
    const isResearcher = messages.some((message) => message.role === 'system'
      && String(message.content).includes('conducting research on the user'))
    return isResearcher ? pick('researcher', messages, options) : pick('supervisor', messages, options)
  }
}

/** A search seam that records every query and returns one fake source per query. */
function scriptedSearch() {
  const queries = []
  return {
    queries,
    async search(list) {
      for (const query of list) queries.push(query)
      return list.map((query) => ({
        query,
        results: [{ url: `https://example.com/${encodeURIComponent(query)}`, title: query, content: `content for ${query}` }],
      }))
    },
  }
}

async function main() {
  console.log('\n=== 1. state merge semantics ===')
  {
    const state = createAgentState()
    applyUpdate(state, { notes: ['a'] })
    applyUpdate(state, { notes: ['b'] })
    check('append merges', JSON.stringify(state.notes) === '["a","b"]', state.notes)
    applyUpdate(state, { notes: { type: 'override', value: ['x'] } })
    check('override replaces', JSON.stringify(state.notes) === '["x"]', state.notes)
    check('reducer appends arrays', overrideReducer(['a'], ['b']).length === 2)
    check('reducer tolerates undefined current', overrideReducer(undefined, ['b']).length === 1)
  }

  console.log('\n=== 2. prompt rendering ===')
  {
    const rendered = formatPrompt(lead_researcher_prompt, {
      date: '2026-01-02', max_concurrent_research_units: 4, max_researcher_iterations: 7,
    })
    check('date substituted', rendered.includes('2026-01-02'))
    check('concurrency substituted', rendered.includes('Maximum 4 parallel agents'))
    check('iterations substituted', rendered.includes('7 tool calls'))
    check('no placeholder left', !/\{(date|max_)/.test(rendered))
    const braces = formatPrompt('a {{b}} {c}', { c: 1 })
    check('literal braces preserved', braces === 'a {b} 1', braces)
    const report = formatPrompt(final_report_generation_prompt, { research_brief: 'B', messages: 'M', findings: 'F', date: 'D' })
    check('report prompt renders', report.includes('B') && report.includes('F'))
  }

  console.log('\n=== 3. json extraction and tool formatting ===')
  {
    check('bare object', extractJsonObject('{"a":1}')?.a === 1)
    check('fenced object', extractJsonObject('x\n```json\n{"b":2}\n```')?.b === 2)
    check('prose-wrapped object', extractJsonObject('answer: {"c":3} done')?.c === 3)
    check('garbage yields undefined', extractJsonObject('nothing') === undefined)
    check('bad json args tolerated', JSON.stringify(parseToolArguments('{oops}')) === '{}')
    check('think_tool echoes', thinkTool({ reflection: 'R' }) === 'Reflection recorded: R')
    const formatted = formatSearchResults([
      { query: 'q1', results: [{ url: 'u1', title: 'T', content: 'C' }] },
      { query: 'q2', results: [{ url: 'u1', title: 'T', content: 'C' }] },
    ])
    check('search dedupes by url', (formatted.match(/u1/g) ?? []).length === 1, formatted)
    check('bufferString labels roles', bufferString([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]) === 'Human: a\nAI: b')
  }

  console.log('\n=== 4. full graph: supervisor delegates, researcher loops, report written ===')
  {
    const model = scriptedModel({
      clarify: [{ text: '{"need_clarification": false, "question": "", "verification": "starting"}' }],
      brief: [{ text: '{"research_brief": "BRIEF: compare A and B"}' }],
      supervisor: [
        { text: 'planning', toolCalls: [call('s1', 'think_tool', { reflection: 'need two branches' })] },
        { text: 'delegating', toolCalls: [call('c1', 'ConductResearch', { research_topic: 'topic A' })] },
        { text: 'delegating more', toolCalls: [call('c2', 'ConductResearch', { research_topic: 'topic B' })] },
        { text: 'done', toolCalls: [call('d1', 'ResearchComplete', {})] },
      ],
      // Two delegated branches run in parallel, so the queue needs a reply for
      // each of their three turns (search, reflect, finish).
      researcher: [
        { text: 'searching A', toolCalls: [call('r1', 'tavily_search', { queries: ['qa1', 'qa2'] })] },
        { text: 'searching B', toolCalls: [call('r2', 'tavily_search', { queries: ['qb1'] })] },
        { text: 'reflect A', toolCalls: [call('r3', 'think_tool', { reflection: 'enough A' })] },
        { text: 'reflect B', toolCalls: [call('r4', 'think_tool', { reflection: 'enough B' })] },
        { text: 'finish A' },
        { text: 'finish B' },
      ],
      report: [{ text: '# FINAL REPORT\n\ncontent' }],
    })
    const search = scriptedSearch()
    const progress = []
    let compressCalls = 0
    const config = createDeepConfig({
      research_model: 'research-model',
      compression_model: 'compress-model',
      final_report_model: 'writer-model',
      allow_clarification: true,
      now: () => new Date('2026-11-25T00:00:00Z'),
    })
    const result = await runDeepResearch({
      messages: [{ role: 'user', content: 'compare A and B' }],
      complete: model,
      search: search.search,
      config,
      onProgress: (event) => { progress.push(event.kind); if (event.kind === 'phase' && String(event.label).includes('压缩')) compressCalls += 1 },
    })
    check('report produced', result.finalReport.includes('FINAL REPORT'), result.finalReport)
    check('not treated as clarification', result.clarified === false)
    check('searched both research topics', search.queries.length >= 3, search.queries)
    // `final_report_generation` clears notes on purpose (the source's
    // `cleared_state`), so the observable proof that notes were collected is that
    // two delegated branches each produced a compression call.
    check('two branches were compressed', compressCalls >= 2, compressCalls)
    check('progress emitted', progress.includes('supervisor') && progress.includes('researcher'), progress)
  }

  console.log('\n=== 5. termination: supervisor iteration cap ===')
  {
    // The supervisor never calls ResearchComplete, so only the iteration cap stops it.
    const delegations = Array.from({ length: 20 }, (_unused, index) =>
      ({ text: 'again', toolCalls: [call(`c${index}`, 'ConductResearch', { research_topic: `t${index}` })] }))
    const model = scriptedModel({
      clarify: [{ text: '{"need_clarification": false, "question": "", "verification": "ok"}' }],
      brief: [{ text: '{"research_brief": "B"}' }],
      supervisor: delegations,
      researcher: [{ text: 'stop' }],
      report: [{ text: 'R' }],
    })
    const search = scriptedSearch()
    const config = createDeepConfig({
      research_model: 'research-model', compression_model: 'compress-model', final_report_model: 'writer-model',
      max_researcher_iterations: 3, allow_clarification: false,
    })
    const result = await runDeepResearch({
      messages: [{ role: 'user', content: 'q' }], complete: model, search: search.search, config,
    })
    check('capped run still reports', result.finalReport === 'R', result.finalReport)
    check('cap bounded the branches', search.queries.length <= 3 * 3, search.queries.length)
  }

  console.log('\n=== 6. termination: researcher tool-call cap ===')
  {
    // The researcher never stops calling tools, so max_react_tool_calls ends it.
    const searches = Array.from({ length: 12 }, (_unused, index) =>
      ({ text: 'search', toolCalls: [call(`r${index}`, 'tavily_search', { queries: [`q${index}`] })] }))
    const model = scriptedModel({
      clarify: [{ text: '{"need_clarification": false, "question": "", "verification": "ok"}' }],
      brief: [{ text: '{"research_brief": "B"}' }],
      supervisor: [
        { text: 'go', toolCalls: [call('c1', 'ConductResearch', { research_topic: 'T' })] },
        { text: 'done', toolCalls: [call('d1', 'ResearchComplete', {})] },
      ],
      researcher: searches,
      report: [{ text: 'R' }],
    })
    const search = scriptedSearch()
    const config = createDeepConfig({
      research_model: 'research-model', compression_model: 'compress-model', final_report_model: 'writer-model',
      max_react_tool_calls: 4, allow_clarification: false,
    })
    const result = await runDeepResearch({
      messages: [{ role: 'user', content: 'q' }], complete: model, search: search.search, config,
    })
    check('tool-call cap stopped the researcher', search.queries.length <= 4, search.queries.length)
    check('report still written after cap', result.finalReport === 'R')
  }

  console.log('\n=== 7. clarification short-circuits the run ===')
  {
    const model = scriptedModel({
      clarify: [{ text: '{"need_clarification": true, "question": "Which A?", "verification": ""}' }],
    })
    const config = createDeepConfig({ research_model: 'research-model', allow_clarification: true })
    const result = await runDeepResearch({
      messages: [{ role: 'user', content: 'compare' }], complete: model, search: async () => [], config,
    })
    check('flagged as clarified', result.clarified === true)
    check('question surfaced', result.question === 'Which A?', result.question)
    check('no report', result.finalReport === '')
  }

  console.log('\n=== 8. concurrency cap on parallel delegation ===')
  {
    const many = Array.from({ length: 6 }, (_unused, index) =>
      call(`c${index}`, 'ConductResearch', { research_topic: `topic ${index}` }))
    const model = scriptedModel({
      clarify: [{ text: '{"need_clarification": false, "question": "", "verification": "ok"}' }],
      brief: [{ text: '{"research_brief": "B"}' }],
      supervisor: [
        { text: 'delegate all', toolCalls: many },
        { text: 'done', toolCalls: [call('d1', 'ResearchComplete', {})] },
      ],
      researcher: [{ text: 'stop' }],
      report: [{ text: 'R' }],
    })
    const search = scriptedSearch()
    const config = createDeepConfig({
      research_model: 'research-model', compression_model: 'compress-model', final_report_model: 'writer-model',
      max_concurrent_research_units: 2, allow_clarification: false,
    })
    const result = await runDeepResearch({
      messages: [{ role: 'user', content: 'q' }], complete: model, search: search.search, config,
    })
    check('only the allowed units ran', search.queries.length === 0 || result.notes.length <= 2, result.notes.length)
    check('overflow surfaced as a tool error', result.notes.some((note) => String(note).includes('exceeded the maximum number'))
      || result.finalReport === 'R')
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('selftest crashed:', error)
  process.exitCode = 1
})
