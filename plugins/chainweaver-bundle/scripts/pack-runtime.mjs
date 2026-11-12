import { mkdirSync,cpSync,existsSync,readFileSync,writeFileSync,lstatSync,readdirSync,realpathSync,unlinkSync,symlinkSync } from 'node:fs'
import { resolve,join,dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { createRequire, isBuiltin } from 'node:module'
import { packNative } from './pack-native.mjs'
import { root,dshRoot } from './runtime.mjs'

const imageRoot=resolve(process.env.CHAINWEAVER_IMAGE_DIR??join(root,'.local/image')),app=join(imageRoot,'app'),modules=join(app,'node_modules')
if(!existsSync(join(app,'lib/bin.js')))throw new Error('请先使用 pnpm deploy 将 DSH 生产依赖部署到 .local/image/app')
function copy(source,target,filter){mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,force:true,filter:(src,dest)=>{if(!(filter??(s=>!['node_modules','.git','.local'].includes(s.split('/').at(-1))))(src))return false;try{const a=lstatSync(src),b=lstatSync(dest);if(a.isFile()&&a.ino===b.ino&&a.dev===b.dev)return false}catch{}return true}})}
function packageRoot(name,anchor){const req=createRequire(anchor);for(const base of req.resolve.paths(name)??[]){const path=join(base,name,'package.json');if(existsSync(path))return realpathSync(dirname(path))}throw new Error('无法定位依赖 '+name)}
const visited=new Set()
function dependency(name,anchor){if(name.startsWith('@deepseek-ai/')){if(!existsSync(join(modules,name)))throw new Error('DSH 发行缺少 '+name);return}const source=packageRoot(name,anchor),manifest=JSON.parse(readFileSync(join(source,'package.json')));if(visited.has(name))return;visited.add(name);copy(source,join(modules,name));for(const dep of Object.keys(manifest.dependencies??{}))dependency(dep,join(source,'package.json'))}
for(const name of ['chainweaver-bundle','dsh-superagent','chainweaver-runtime']){const target=join(modules,name);try{if(lstatSync(target).isSymbolicLink())unlinkSync(target)}catch(e){if(e.code!=='ENOENT')throw e}}
for(const entry of readdirSync(root).filter(n=>!['.local','.git','node_modules'].includes(n)))copy(join(root,entry),join(modules,'chainweaver-bundle',entry),src=>{const rel=src.slice(root.length+1);return !rel.split('/').some(p=>['node_modules','.local','.git'].includes(p))&&!rel.startsWith('packages/platform')&&!rel.startsWith('packages/superagent/src')&&!rel.startsWith('packages/superagent/tests')&&!rel.startsWith('packages/superagent/lib')})
for(const name of ['superagent','runtime'])copy(join(root,'packages',name),join(modules,name==='runtime'?'chainweaver-runtime':'dsh-superagent'))
for(const name of ['zod','proper-lockfile'])dependency(name,join(root,'packages/superagent/package.json'))
// 当前分支的构建产物覆盖部署工具捕获的同名包，避免带入旧的保护规则。
for(const rel of ['apps/cli','packages/boot/app-boot','packages/boot/plugin-manager','packages/util/official-bundles']){
 const source=join(dshRoot,rel),name=JSON.parse(readFileSync(join(source,'package.json'))).name,target=rel==='apps/cli'?app:join(modules,name)
 copy(join(source,'lib'),join(target,'lib'));if(rel==='apps/cli'){const p=JSON.parse(readFileSync(join(target,'package.json')));p.dependencies['chainweaver-bundle']='0.1.0';writeFileSync(join(target,'package.json'),JSON.stringify(p,null,2)+'\n')}
}
for(const file of ['Dockerfile','entry.mjs','runtime-activity.mjs','check-cwd.mjs','credential-helper.mjs','project-toolchain.mjs'])copy(join(root,'deploy/runtime',file),join(imageRoot,file))
const copies=new Map([[root,join(modules,'chainweaver-bundle')],[join(root,'packages/superagent'),join(modules,'dsh-superagent')],[join(root,'packages/runtime'),join(modules,'chainweaver-runtime')],[join(dshRoot,'apps/cli'),app]])
function embed(source){
 if(copies.has(source))return copies.get(source)
 if(lstatSync(source).isDirectory()&&existsSync(join(source,'package.json'))){const original=JSON.parse(readFileSync(join(source,'package.json'))),name=original.name,candidate=join(modules,name??'');if(name&&existsSync(candidate)){const staged=realpathSync(candidate);if(staged.startsWith(app+'/')&&JSON.parse(readFileSync(join(staged,'package.json'))).version===original.version){copies.set(source,staged);return staged}}}
 const target=join(modules,'.chainweaver-external',createHash('sha256').update(source).digest('hex').slice(0,16),source.split('/').at(-1));copies.set(source,target)
 mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,filter:s=>!['node_modules','.git','.local'].includes(s.split('/').at(-1))})
 if(lstatSync(source).isDirectory()&&existsSync(join(source,'package.json'))){
  const manifest=JSON.parse(readFileSync(join(source,'package.json')))
  for(const name of new Set([...Object.keys(manifest.dependencies??{}),...Object.keys(manifest.optionalDependencies??{})])){
   if(isBuiltin(name))continue;let original;try{original=packageRoot(name,join(source,'package.json'))}catch(e){if(name in (manifest.optionalDependencies??{}))continue;throw e}
   const dependency=embed(realpathSync(original)),link=join(target,'node_modules',name);mkdirSync(dirname(link),{recursive:true});try{unlinkSync(link)}catch(e){if(e.code!=='ENOENT')throw e}symlinkSync(relative(dirname(link),dependency),link)
  }
 }
 return target
}
function check(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isSymbolicLink()){
 let source;try{source=realpathSync(p)}catch(e){if(e.code==='ENOENT'){unlinkSync(p);continue}throw e}
 if(!source.startsWith(app+'/')){const target=embed(source);unlinkSync(p);symlinkSync(relative(dirname(p),target),p)}
}else if(entry.isDirectory()&&entry.name!=='.chainweaver-external')check(p)}}
check(app)
const sources=new Map()
function locate(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){if(!entry.isDirectory()||['node_modules','lib','.git','.local','dist'].includes(entry.name))continue;const path=join(dir,entry.name);if(existsSync(join(path,'package.json'))){const manifest=JSON.parse(readFileSync(join(path,'package.json')));sources.set(manifest.name,path)}locate(path)}}
for(const folder of ['packages','apps','vendor','native'])locate(join(dshRoot,folder))
const closed=new Set()
function closeDependencies(source,target){
 if(closed.has(source))return;closed.add(source)
 const manifest=JSON.parse(readFileSync(join(source,'package.json')))
 if(source.startsWith(dshRoot+'/')){copy(source,target,path=>!path.slice(source.length+1).split('/').some(part=>['node_modules','.git','.local','tests','coverage','.agents'].includes(part)));const normalized=structuredClone(manifest);for(const section of ['dependencies','peerDependencies','optionalDependencies'])for(const [name,value]of Object.entries(normalized[section]??{}))if(value.startsWith('workspace:')){const owner=sources.get(name);if(!owner)throw new Error('缺少工作区依赖 '+name);normalized[section][name]=JSON.parse(readFileSync(join(owner,'package.json'))).version}writeFileSync(join(target,'package.json'),JSON.stringify(normalized,null,2)+'\n')}
 for(const name of new Set([...Object.keys(manifest.dependencies??{}),...Object.keys(manifest.peerDependencies??{}),...Object.keys(manifest.optionalDependencies??{})])){
  if(isBuiltin(name))continue
  let original;try{original=sources.get(name)??packageRoot(name,join(source,'package.json'))}catch(e){if(name in (manifest.optionalDependencies??{})||manifest.peerDependenciesMeta?.[name]?.optional)continue;throw e}
  const embedded=embed(original),link=join(target,'node_modules',name)
  if(link!==embedded){mkdirSync(dirname(link),{recursive:true});try{if(realpathSync(link)!==realpathSync(embedded)){if(!lstatSync(link).isSymbolicLink())throw new Error('依赖位置冲突 '+link);unlinkSync(link);symlinkSync(relative(dirname(link),embedded),link)}}catch(e){if(e.code==='ENOENT'){try{unlinkSync(link)}catch{}symlinkSync(relative(dirname(link),embedded),link)}else throw e}}
  closeDependencies(original,embedded)
 }
}
closeDependencies(join(dshRoot,'apps/cli'),app)
closeDependencies(join(root,'packages/superagent'),join(modules,'dsh-superagent'))
check(app)
packNative(app,dshRoot)
const cliManifest=JSON.parse(readFileSync(join(app,'package.json')));cliManifest.dependencies['chainweaver-bundle']='0.1.0';writeFileSync(join(app,'package.json'),JSON.stringify(cliManifest,null,2)+'\n')

console.log('PASS: standalone runtime payload assembled; external dependencies embedded:',copies.size)
