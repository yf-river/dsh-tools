import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const dshRoot = resolve(process.env.DSH_REPO ?? join(root, '../chainweaver-studio'))

/** 启动具名 profile，并将服务管理器的终止信号交给 DSH 处理。 */
export async function runDsh(args, { home, built = false } = {}) {
  const cli = join(dshRoot, built ? 'apps/cli/lib/bin.js' : 'apps/cli/src/bin.ts')
  const loader = join(dshRoot, 'node_modules/tsx/dist/esm/index.mjs')
  if (!existsSync(cli) || (!built && !existsSync(loader))) {
    throw new Error('DSH 启动文件缺失，请检查 DSH_REPO 并完成依赖安装和构建')
  }
  const child = spawn(process.execPath, [...(built ? [] : ['--import', loader]), cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...(home ? { DSH_HOME: resolve(home) } : {}),
      TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.base.json'),
    },
    stdio: 'inherit',
  })
  const stop = signal => child.kill(signal)
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    const result = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => accept({ code, signal }))
    })
    process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
