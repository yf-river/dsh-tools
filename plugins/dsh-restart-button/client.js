/**
 * Restart button, browser half.
 *
 * Adds one page under Settings → Plugins with a single action: restart the
 * harness so startup-only changes take effect.
 *
 * The button does not restart anything by itself. It asks the Host to exit, and
 * the supervisor relaunches the process. That is the only arrangement that can
 * survive its own action: a page cannot reload a server that is already gone.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-restart-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace for this page. */
    const NS = 'restart-button'
    /** Host route that performs the exit. */
    const ROUTE = '/plugin/restart/request'
    /** How long to keep polling the origin after asking for a restart. */
    const RELOAD_WINDOW_MS = 30000
    /** Gap between origin probes while waiting for the server to come back. */
    const PROBE_INTERVAL_MS = 800

    const zh = {
      'tab.title': '重启',
      'page.title': '重启服务',
      'page.description': '安装或更新插件后，部分改动需要重启进程才会生效。重启期间页面会短暂断开，随后自动重新加载。',
      'action.restart': '立即重启',
      'action.confirm': '确认重启',
      'action.cancel': '取消',
      'dialog.title': '确认重启？',
      'dialog.body': '正在进行的对话会短暂断开，会话记录不会丢失。重启通常需要 5–10 秒。',
      'state.idle': '服务运行中',
      'state.restarting': '正在重启…',
      'state.waiting': '等待服务恢复…',
      'state.done': '已恢复',
      'error.noSupervisor': '当前进程没有守护进程管理，重启会直接停止服务。已取消。',
      'error.failed': '重启请求失败',
      'error.unauthorized': '当前页面未通过认证，无法重启。请从启动时打印的链接重新打开。',
      'warning.unsupervised': '未检测到守护进程（systemd / pm2）。此时重启会停掉服务且无法自动恢复，因此按钮已禁用。',
      'meta.tip': '提示：修改 client.js 之类的前端文件不需要重启，刷新页面即可。',
    }
    const en = {
      'tab.title': 'Restart',
      'page.title': 'Restart the service',
      'page.description': 'Some changes to installed or updated plugins only take effect after the process restarts. The page disconnects briefly and then reloads itself.',
      'action.restart': 'Restart now',
      'action.confirm': 'Restart',
      'action.cancel': 'Cancel',
      'dialog.title': 'Restart the service?',
      'dialog.body': 'Running conversations disconnect briefly; no session data is lost. A restart usually takes 5–10 seconds.',
      'state.idle': 'Service is running',
      'state.restarting': 'Restarting…',
      'state.waiting': 'Waiting for the service…',
      'state.done': 'Back online',
      'error.noSupervisor': 'No supervisor owns this process, so restarting would stop the service. Cancelled.',
      'error.failed': 'The restart request failed',
      'error.unauthorized': 'This page is not authenticated, so it cannot restart the service. Reopen the URL printed at launch.',
      'warning.unsupervised': 'No supervisor (systemd / pm2) was detected. Restarting would stop the service with no way back, so this button is disabled.',
      'meta.tip': 'Note: editing front-end files such as client.js needs no restart — reloading the page is enough.',
    }

    /** Stylesheet, theme tokens only. */
    const CSS = `
.rst-page{display:flex;flex-direction:column;gap:16px;max-width:640px}
.rst-head{display:flex;flex-direction:column;gap:6px}
.rst-title{font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary);font-weight:600}
.rst-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.rst-card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.rst-state{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0}
.rst-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rst-dot[data-busy='true']{background:var(--dsw-alias-state-warn-primary);animation:rst-pulse 1.2s ease-in-out infinite}
@keyframes rst-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.rst-actions{display:flex;align-items:center;gap:8px;flex:none}
.rst-button{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;font-size:13px;cursor:pointer;transition:opacity 120ms var(--ds-ease-in-out,ease)}
.rst-button:hover{opacity:.88}
.rst-button:disabled{opacity:.4;cursor:not-allowed}
.rst-button[data-variant='ghost']{background:transparent;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2)}
.rst-warn{display:flex;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)}
.rst-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.rst-tip{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rst-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, #000 40%, transparent);z-index:60}
.rst-dialog{width:min(420px,calc(100vw - 48px));padding:18px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px color-mix(in srgb, #000 30%, transparent)}
.rst-dialog-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);font-weight:600;margin-bottom:6px}
.rst-dialog-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin-bottom:16px}
.rst-dialog-actions{display:flex;justify-content:flex-end;gap:8px}
@media (prefers-reduced-motion:reduce){.rst-dot[data-busy='true']{animation:none}.rst-button{transition:none}}
`

    /**
     * Wait until the origin answers again, then reload.
     *
     * Polling is what makes the page survive the restart: the server is down for
     * a few seconds, so a plain `location.reload()` on click would land on a
     * network error page rather than the reloaded app.
     * @param onTick - called with the elapsed attempt count for status text.
     * @returns nothing; the page navigates when the origin responds.
     */
    function waitForOrigin(onTick) {
      const startedAt = Date.now()
      let attempts = 0
      const tick = () => {
        attempts += 1
        onTick(attempts)
        if (Date.now() - startedAt > RELOAD_WINDOW_MS) {
          onTick(-1)
          return
        }
        fetch(`${ROUTE}/ping`, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
          .then((response) => {
            if (response.ok) window.location.reload()
            else window.setTimeout(tick, PROBE_INTERVAL_MS)
          })
          .catch(() => {
            window.setTimeout(tick, PROBE_INTERVAL_MS)
          })
      }
      window.setTimeout(tick, PROBE_INTERVAL_MS)
    }

    /**
     * The settings page.
     * @param props - the bound translator.
     * @returns the page.
     */
    function RestartPage({ t }) {
      const [phase, setPhase] = useState('idle')
      const [confirming, setConfirming] = useState(false)
      const [error, setError] = useState(null)
      const [attempts, setAttempts] = useState(0)
      const [supervised, setSupervised] = useState(true)
      const mounted = useRef(true)

      useEffect(() => () => {
        mounted.current = false
      }, [])

      // Ask the Host once whether anything supervises this process; without one
      // the action is unsafe, so the button starts disabled and explains why.
      useEffect(() => {
        fetch(`${ROUTE}/status`, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
          .then((response) => response.json())
          .then((body) => {
            if (mounted.current && typeof body?.supervisor === 'string') setSupervised(true)
            else if (mounted.current) setSupervised(body?.supervisor === 'systemd' || body?.supervisor === 'pm2')
          })
          .catch(() => {
            /* A failed probe is not proof of no supervisor; keep the button
               available and let the POST reject if it truly is unsafe. */
          })
      }, [])

      const request = () => {
        setConfirming(false)
        setError(null)
        setPhase('restarting')
        fetch(ROUTE, { method: 'POST', credentials: 'same-origin' })
          .then(async (response) => {
            if (response.status === 409) {
              setPhase('idle')
              setError(t('error.noSupervisor'))
              return
            }
            if (response.status === 401 || response.status === 403) {
              setPhase('idle')
              setError(t('error.unauthorized'))
              return
            }
            if (!response.ok) {
              setPhase('idle')
              setError(t('error.failed'))
              return
            }
            setPhase('waiting')
            waitForOrigin((count) => {
              if (count === -1) {
                if (mounted.current) {
                  setPhase('idle')
                  setError(t('error.failed'))
                }
                return
              }
              if (mounted.current) setAttempts(count)
            })
          })
          .catch(() => {
            /* The connection often drops as the server exits, which is expected:
               treat it as "restart in progress" and start waiting. */
            setPhase('waiting')
            waitForOrigin((count) => {
              if (count === -1) {
                if (mounted.current) {
                  setPhase('idle')
                  setError(t('error.failed'))
                }
                return
              }
              if (mounted.current) setAttempts(count)
            })
          })
      }

      const busy = phase !== 'idle'
      const statusText = phase === 'restarting'
        ? t('state.restarting')
        : phase === 'waiting'
          ? `${t('state.waiting')}${attempts > 0 ? ` (${attempts})` : ''}`
          : t('state.idle')

      return h(
        'div',
        { className: 'rst-page' },
        h(
          'div',
          { className: 'rst-head' },
          h('div', { className: 'rst-title' }, t('page.title')),
          h('div', { className: 'rst-desc' }, t('page.description')),
        ),
        !supervised
          ? h('div', { className: 'rst-warn' }, h('span', null, t('warning.unsupervised')))
          : null,
        h(
          'div',
          { className: 'rst-card' },
          h(
            'div',
            { className: 'rst-state' },
            h('i', { className: 'rst-dot', 'data-busy': busy ? 'true' : undefined }),
            h('span', null, statusText),
          ),
          h(
            'div',
            { className: 'rst-actions' },
            h(primitives.Button, {
              onClick: () => {
                setConfirming(true)
              },
              disabled: busy || !supervised,
            }, t('action.restart')),
          ),
        ),
        error === null ? null : h('div', { className: 'rst-error' }, error),
        h('div', { className: 'rst-tip' }, t('meta.tip')),
        confirming
          ? h(
              'div',
              {
                className: 'rst-overlay',
                role: 'dialog',
                'aria-modal': 'true',
                onClick: (event) => {
                  if (event.target === event.currentTarget) setConfirming(false)
                },
              },
              h(
                'div',
                { className: 'rst-dialog' },
                h('div', { className: 'rst-dialog-title' }, t('dialog.title')),
                h('div', { className: 'rst-dialog-body' }, t('dialog.body')),
                h(
                  'div',
                  { className: 'rst-dialog-actions' },
                  h('button', {
                    type: 'button',
                    className: 'rst-button',
                    'data-variant': 'ghost',
                    onClick: () => {
                      setConfirming(false)
                    },
                  }, t('action.cancel')),
                  h('button', {
                    type: 'button',
                    className: 'rst-button',
                    onClick: request,
                  }, t('action.confirm')),
                ),
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'restart-button: dictionaries')
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const id = '@local/dsh-restart-button/page.css'
          if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-restart-button'
          tag.dataset.pluginCss = id
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'restart-button: stylesheet')
        /* `label` must be resolved text or a thunk, never a dictionary key: the
           shell renders it verbatim, so a raw key produces an unnamed tab. The
           thunk is re-read on each projection, which is how the label follows
           the active locale without re-registering. */
        ctx.slots.inject('settings.plugins.tab', () => {
          const t = ctx.locale.bind(NS)
          return ctx.slots.register({
            name: 'settings.plugins.tab',
            id: 'restart',
            order: 90,
            locale: NS,
            label: () => t('tab.title'),
            /* Explicit share: the component receives exactly these props rather
               than relying on what the shell happens to inject. */
            inject: () => ({ t }),
          }, RestartPage)
        })
      },
    }
  },
})
