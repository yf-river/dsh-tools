import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_REPO ?? join(root, '../chainweaver-studio'))
const home = resolve(process.env.DSH_HOME ?? join(root, '.local/dsh'))
const yaml = createRequire(join(dshRoot, 'package.json'))('js-yaml')
// 配置检查只读取表达式文本，不执行 !!js。
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }),
])
const result = spawnSync(process.execPath, [join(root, 'scripts/dev.mjs'), 'dump'], {
  cwd: root,
  env: process.env,
  encoding: 'utf8',
})
if (result.error) throw result.error
assert.equal(result.status, 0, result.stderr)
assert.equal(result.stderr.trim(), '', 'profile 含加载警告，请检查 bundle 是否缺失或版本不兼容')
const entries = yaml.load(result.stdout, { schema })
assert.ok(Array.isArray(entries))
const row = id => {
  const entry = entries.find(entry => entry.id === id)
  assert.ok(entry, `缺少 ${id}`)
  return entry
}
const manifest = JSON.parse(readFileSync(join(home, 'profiles/chainweaver/package.json'), 'utf8'))
const template = JSON.parse(readFileSync(join(root, 'profiles/chainweaver.json'), 'utf8'))
assert.deepEqual(manifest.dsh.profile.bundles, template.dsh.profile.bundles)
assert.equal(row('dsh-superagent').name, 'dsh-superagent')
assert.notEqual(row('dsh-superagent').disabled, true)
for (const id of ['preset-ptc', 'preset-minimal', 'preset-cordis', 'ui-brand-official']) {
  assert.equal(row(id).disabled, true, `${id} 未禁用`)
}
assert.equal(row('ui-sidebar').config.showBrand, false)
assert.equal(row('ui-conversation').config.showHeroBrand, false)
assert.equal(row('agent-preset-registry').config.default, 'standard')
assert.deepEqual(entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset' && entry.disabled !== true)
  .map(entry => entry.config.id).sort(), ['standard', 'dsh-superagent-router', 'dsh-superagent-worker'].sort())
console.log('PASS: 三层 profile、Web、内嵌 Superagent、模式裁剪与界面配置')
