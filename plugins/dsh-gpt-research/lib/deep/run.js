/**
 * Runs the two-layer research graph to completion.
 *
 * This is the source's compiled `deep_researcher` graph: the same four top-level
 * phases, the same nested supervisor and researcher loops, and the same merge of
 * each node's update into state. LangGraph's scheduler is replaced by explicit
 * `while` loops over nodes that return their successor's name.
 *
 * The one structural addition is {@link runResearcher}: in the source a
 * `ConductResearch` call invokes a compiled subgraph; here the supervisor node
 * receives a function that runs one researcher to completion and returns its
 * output state. That keeps the supervisor node readable and lets a caller run the
 * branches as sub-agents without touching the algorithm.
 *
 * @module @yf-river/dsh-gpt-research/deep/run
 */

import { applyUpdate, createAgentState, createResearcherState, createSupervisorState } from './state.js'
import { createGraphNodes, NODE } from './graph.js'

/**
 * Run the whole graph for one research brief.
 *
 * @param {object} deps - resolved dependencies.
 * @param {string[]} deps.messages - the conversation, as `{role, content}` entries.
 * @param {(messages: object[], options: object) => Promise<object>} deps.complete - one model call.
 * @param {(queries: string[], options: object) => Promise<object[]>} deps.search - batch search.
 * @param {object} deps.config - a `createDeepConfig` result.
 * @param {(event: object) => void} [deps.onProgress] - progress sink.
 * @param {AbortSignal} [deps.signal] - cancellation.
 * @returns {Promise<{finalReport: string, notes: string[], messages: object[], clarified: boolean, question: string}>}
 *   the finished run; `clarified` is true when the graph stopped to ask a question.
 */
export async function runDeepResearch(deps) {
  const nodes = createGraphNodes(deps)
  const state = createAgentState({ messages: deps.messages ?? [] })
  const throwIfAborted = () => deps.signal?.throwIfAborted()

  let node = NODE.CLARIFY
  for (let guard = 0; guard < 1000; guard += 1) {
    throwIfAborted()
    if (node === NODE.END) break

    if (node === NODE.CLARIFY) {
      const { goto, update } = await nodes.clarifyWithUser(state)
      applyUpdate(state, update)
      node = goto
      // A clarifying question ends the run: the graph has nothing to research yet.
      if (goto === NODE.END) {
        return {
          finalReport: '',
          notes: [],
          messages: state.messages,
          clarified: true,
          question: String(state.messages.at(-1)?.content ?? ''),
        }
      }
      continue
    }

    if (node === NODE.BRIEF) {
      const { goto, update } = await nodes.writeResearchBrief(state)
      applyUpdate(state, update)
      node = goto
      continue
    }

    if (node === NODE.SUPERVISOR) {
      // The supervisor loop owns its own sub-loop: supervisor → supervisor_tools →
      // supervisor, exactly as the compiled subgraph does.
      const outcome = await runSupervisor(deps, nodes, state)
      applyUpdate(state, outcome)
      node = NODE.REPORT
      continue
    }

    if (node === NODE.REPORT) {
      const { update } = await nodes.finalReportGeneration(state)
      applyUpdate(state, update)
      node = NODE.END
      continue
    }

    throw new Error(`deep research: unknown node "${node}"`)
  }

  return {
    finalReport: String(state.final_report ?? ''),
    notes: Array.isArray(state.notes) ? state.notes : [],
    messages: state.messages,
    clarified: false,
    question: '',
  }
}

/**
 * Run the supervisor subgraph until it ends, then return the fields that flow on.
 *
 * The source's subgraph has `input=SupervisorState` and returns `notes` plus
 * `research_brief` through its `END` command; the same two fields are returned.
 *
 * @param {object} deps - graph dependencies.
 * @param {object} nodes - the node functions.
 * @param {object} parentState - the agent state, read for the brief and messages.
 * @returns {Promise<object>} the update to apply to the agent state.
 */
async function runSupervisor(deps, nodes, parentState) {
  const state = createSupervisorState({
    supervisor_messages: { type: 'override', value: [...(parentState.supervisor_messages ?? [])] },
    research_brief: parentState.research_brief ?? '',
  })

  /** One researcher branch, from its own state to its output state. */
  const runResearcher = async (topic) => {
    const branch = createResearcherState({
      researcher_messages: [{ role: 'user', content: topic }],
      research_topic: topic,
    })
    let node = 'researcher'
    for (let guard = 0; guard < 1000; guard += 1) {
      deps.signal?.throwIfAborted()
      if (node === 'compress_research') {
        const { update } = await nodes.compressResearch(branch)
        applyUpdate(branch, update)
        return {
          compressed_research: String(branch.compressed_research ?? ''),
          raw_notes: Array.isArray(branch.raw_notes) ? branch.raw_notes : [],
        }
      }
      if (node === 'researcher') {
        const { goto, update } = await nodes.researcher(branch)
        applyUpdate(branch, update)
        node = goto
        continue
      }
      if (node === 'researcher_tools') {
        const { goto, update } = await nodes.researcherTools(branch)
        applyUpdate(branch, update)
        node = goto
        continue
      }
      throw new Error(`deep research: unknown researcher node "${node}"`)
    }
    throw new Error('deep research: researcher loop exceeded its guard')
  }

  let node = 'supervisor'
  for (let guard = 0; guard < 1000; guard += 1) {
    deps.signal?.throwIfAborted()
    // The subgraph's END is the registry's `__end__`; the agent graph also uses
    // that name for its own end, so the comparison is against the sentinel value.
    if (node === NODE.END) break
    if (node === 'supervisor') {
      const { goto, update } = await nodes.supervisor(state)
      applyUpdate(state, update)
      node = goto
      continue
    }
    if (node === 'supervisor_tools') {
      const { goto, update } = await nodes.supervisorTools(state, runResearcher)
      applyUpdate(state, update)
      node = goto
      continue
    }
    throw new Error(`deep research: unknown supervisor node "${node}"`)
  }

  return {
    notes: { type: 'override', value: [...(state.notes ?? [])] },
    raw_notes: { type: 'override', value: [...(state.raw_notes ?? [])] },
    research_brief: state.research_brief ?? '',
    supervisor_messages: { type: 'override', value: [...(state.supervisor_messages ?? [])] },
  }
}
