/**
 * `/research` — the human-only entry point.
 *
 * A slash command rather than a model-facing tool, deliberately: deep research
 * costs minutes and a full model budget, so it must be started by a person, not
 * chosen automatically mid-conversation.
 *
 * The run is registered as a `ctx.jobs` job so the user sees it working:
 * `append` narrates each phase, `updateProgress` shows the live counters. Without
 * that, a two-minute run looks identical to a hang — which is exactly the
 * complaint this design answers.
 *
 * @module @yf-river/dsh-gpt-research/command
 */

import { runResearch } from './tools.js'

/** Usage text shown in the command palette and on a parse miss. */
const USAGE = 'Usage: /research <topic>'

/** Job kind used in the job id prefix. */
const JOB_KIND = 'research'

/** Runs in flight per session, so two invocations cannot pile up unnoticed. */
const inFlight = new Set()

/**
 * Register the command.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - resolved plugin configuration.
 * @param {() => object | undefined} web - lazy `ctx.web` resolver.
 * @param {() => object | undefined} llm - lazy `ctx.llm` resolver.
 * @param {(agent: object, text: string) => void} deliver - posts text back into a session.
 */
export function registerCommand(ctx, config, web, llm, deliver) {
  ctx.inject(['commands', 'jobs'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'research',
      description: 'Run a deep-research report on a topic (multi-query search, source reading, cited report)',
      input: { hint: '<topic>', attachments: false },
      handler: (invocation) => {
        const topic = invocation.rawInput.trim()
        if (topic.length === 0) return { kind: 'error', text: USAGE }

        const agent = invocation.agent
        const sessionId = agent.session?.id
        if (sessionId !== undefined && inFlight.has(sessionId)) {
          return { kind: 'error', text: '这个会话已有一个研究在跑，等它结束再发起。' }
        }

        // Fail fast, before a job is registered: the same checks inside
        // `runResearch` would only surface after the job had already started and
        // shown "研究已开始".
        const webNow = web()
        const llmNow = llm()
        if (webNow === undefined) {
          return { kind: 'error', text: '当前 profile 没有可用的 ctx.web（search/fetch），无法研究。请在「插件 → 内置插件设置 → Web search」选好搜索后端。' }
        }
        if (llmNow === undefined) {
          return { kind: 'error', text: '当前 profile 没有可用的模型通道（ctx.llm），无法研究。' }
        }

        if (sessionId !== undefined) inFlight.add(sessionId)
        let jobId
        try {
          jobId = commandCtx.jobs.start({
            kind: JOB_KIND,
            label: `research: ${topic}`,
            ...(sessionId === undefined ? {} : { owner: sessionId }),
            run: (job) => {
              const started = Date.now()
              let searches = 0
              let fetched = 0
              // `invocation.signal` belongs to the UI request that dispatched the
              // command and aborts as soon as the handler returns, so passing it
              // to a two-minute background run would cancel the run immediately.
              // Cancellation is owned here instead, driven by the job's `cancel`.
              const controller = new AbortController()
              const task = (async () => {
                try {
                  job.append(`开始研究「${topic}」\n`)
                  job.updateProgress('规划子问题…')
                  // Progress lives on the job, NOT in the conversation: a user
                  // message wakes the agent, and the model then answers the
                  // progress line instead of waiting for the report (observed:
                  // it spent a turn grepping for the quoted phrase).

                  const result = await runResearch(
                    { topic, breadth: config.breadth, depth: config.depth },
                    config,
                    {
                      web: webNow,
                      llm: llmNow,
                      env: process.env,
                      signal: controller.signal,
                      onProgress: (event) => {
                        // One live progress line plus a compact roll-up. The
                        // pipeline issues 20+ search calls, so appending a line
                        // per call would bury the phases; counters live in the
                        // progress line instead, and only phase changes append.
                        const at = ((Date.now() - started) / 1000).toFixed(0)
                        if (event.kind === 'phase') {
                          job.updateProgress(`[${at}s] ${event.label}（查询 ${searches}，取证 ${fetched}）`)
                          job.append(`[${at}s] ${event.label}\n`)
                        } else if (event.kind === 'queries') {
                          searches += 1
                          job.updateProgress(`[${at}s] 检索中（查询 ${searches}，取证 ${fetched}）`)
                        } else if (event.kind === 'sources') {
                          fetched += 1
                          job.updateProgress(`[${at}s] 取证中（查询 ${searches}，取证 ${fetched}）`)
                          job.append(`[${at}s]   已读 ${event.url}\n`)
                        }
                      },
                    },
                  )

                  const seconds = ((Date.now() - started) / 1000).toFixed(0)
                  if (result.ok) {
                    job.append(`\n完成（${seconds}s，报告 ${result.report.length} 字符）\n`)
                    deliver(agent, `以下是 /research「${topic}」的研究报告：\n\n${result.report}`)
                    return { status: 'completed', result: `研究报告已完成：${result.report.length} 字符` }
                  }
                  deliver(agent, `/research「${topic}」未完成：${result.report}`)
                  return { status: 'failed', detail: 'no report', result: `未完成：${result.report}` }
                } catch (error) {
                  const message = error?.message ?? String(error)
                  job.append(`\n失败：${message}\n`)
                  deliver(agent, `/research「${topic}」失败：${message}`)
                  return { status: 'failed', detail: message.slice(0, 200), result: `失败：${message}` }
                } finally {
                  if (sessionId !== undefined) inFlight.delete(sessionId)
                }
              })()
              void task
              return {
                cancel: (reason) => {
                  controller.abort(reason ?? 'cancelled')
                  job.append(`\n已取消：${reason ?? ''}\n`)
                },
                // `done` must resolve a JobOutcome, not `undefined`: the registry
                // reads `outcome.status` and a bare resolve crashes the whole
                // process with "Cannot read properties of undefined (reading
                // 'status')". The task resolves its own outcome below.
                done: task,
              }
            },
          })
        } catch (error) {
          if (sessionId !== undefined) inFlight.delete(sessionId)
          return { kind: 'error', text: `无法启动研究任务：${error?.message ?? String(error)}` }
        }

        // The command result is the immediate feedback the user sees; the job's
        // progress line then updates live in the session header, and the report
        // arrives as a message when the run finishes.
        return {
          kind: 'success',
          text: `🔍 研究已开始：「${topic}」\n\n`
            + `任务 ${String(jobId)} 正在后台运行（规划子问题 → 多路检索 → 读正文 → 交叉印证 → 成稿）。\n`
            + `进度看会话头部的任务条目，预计 2 分钟；完成后报告自动出现在本会话。`,
        }
      },
    }))
  })
}
