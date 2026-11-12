import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { root,dshRoot } from './runtime.mjs'
import { command } from '../packages/platform/src/docker.mjs'
await mkdir(join(root,'.local'),{recursive:true})
const imageDir=await mkdtemp(join(root,'.local/runtime-image-'))
console.log('构建目录：',imageDir)
await command(process.execPath,[join(dshRoot,'node_modules/pnpm/bin/pnpm.cjs'),'--dir',dshRoot,'--filter','@deepseek-ai/dsh','deploy','--legacy','--prod',join(imageDir,'app'),'--config.allow-unused-patches=true'],{timeout:600000})
await command(process.execPath,[join(root,'scripts/pack-runtime.mjs')],{env:{...process.env,CHAINWEAVER_IMAGE_DIR:imageDir},timeout:600000})
await command(process.execPath,[join(imageDir,'app/lib/bin.js'),'--help'],{timeout:60000})
console.log(await command('docker',['build','-t','chainweaver/runtime:0.1.0',imageDir],{timeout:900000}))
