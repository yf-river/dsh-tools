import { mkdirSync,existsSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
const home=process.env.DSH_HOME,dir=join(home,'profiles/chainweaver')
mkdirSync(dir,{recursive:true,mode:0o700})
if(!existsSync(join(dir,'package.json')))writeFileSync(join(dir,'package.json'),JSON.stringify({name:'chainweaver-user',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','chainweaver-bundle']}}}))
if(!existsSync(join(dir,'cordis.patch.yml')))writeFileSync(join(dir,'cordis.patch.yml'),'[]\n')
const host=Object.values(networkInterfaces()).flat().find(a=>a?.family==='IPv4'&&!a.internal)?.address
if(!host)throw new Error('容器没有可用监听地址')
const authority=process.env.CHAINWEAVER_AUTHORITY
if(!authority)throw new Error('缺少平台访问地址')
process.env.PATH=`${process.env.HOME}/.local/share/mise/shims:${process.env.PATH}`
process.env.MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS='node,python,go,java'
const child=spawn(process.execPath,['/opt/dsh/lib/bin.js','--profile','chainweaver','--host',host,'--port','3080','--no-open','--public-url',`http://${authority}/app/`,'--trusted-host',authority],{stdio:'inherit',cwd:process.env.HOME})
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1})
