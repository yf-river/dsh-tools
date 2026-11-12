import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { root, dshRoot, runDsh } from './runtime.mjs'

const superagentRoot = join(root, 'packages/superagent')
const home = resolve(process.env.DSH_HOME ?? join(root, '.local/dsh'))
const profileDir = join(home, 'profiles/chainweaver')
const manifestPath = join(profileDir, 'package.json')
const cli = join(dshRoot, 'apps/cli/src/bin.ts')
const loader = join(dshRoot, 'node_modules/tsx/dist/esm/index.mjs')
const [command, ...args] = process.argv.slice(2)


if (!existsSync(cli) || !existsSync(loader)) {
  throw new Error('DSH 源码或 tsx 不存在，请通过 DSH_REPO 指向已完成依赖安装与构建的仓库')
}

if (command === 'setup') {
  if (args.length > 0) throw new Error('setup 不接受额外参数')
  if (!existsSync(join(superagentRoot, 'lib/index.js'))) {
    throw new Error('内嵌 Superagent 尚未构建，请先运行 pnpm build')
  }
  const template = JSON.parse(readFileSync(join(root, 'profiles/chainweaver.json'), 'utf8'))
  if (existsSync(manifestPath)) {
    const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (JSON.stringify(current.dsh?.profile?.bundles) !== JSON.stringify(template.dsh.profile.bundles)) {
      throw new Error(`已有 profile 组合与模板不同，请检查 ${manifestPath}；setup 不覆盖已有组合`)
    }
  } else {
    mkdirSync(profileDir, { recursive: true })
    template.dependencies = {
      'chainweaver-bundle': `link:${root}`,
    }
    writeFileSync(manifestPath, JSON.stringify(template, null, 2) + '\n', { flag: 'wx' })
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, '[]\n', { flag: 'wx' })
  await runDsh(['plugin', '--profile', 'chainweaver', 'install', '--ignore-scripts'], { home })
} else if (command === 'start' || command === 'dump') {
  if (!existsSync(manifestPath)) throw new Error('请先运行 node scripts/dev.mjs setup')
  await runDsh(['--profile', 'chainweaver', ...(command === 'dump' ? ['--dump-config'] : ['--no-open']), ...args], { home })
} else {
  throw new Error('用法：node scripts/dev.mjs <setup|start|dump> [DSH 参数]')
}
