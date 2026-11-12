import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const input=JSON.parse(process.argv[2])
const run=args=>new Promise((accept,reject)=>{const p=spawn('mise',args,{cwd:input.directory,stdio:'inherit'});p.once('error',reject);p.once('exit',code=>code===0?accept():reject(new Error('项目工具版本准备失败')))} )
const defaults=join(process.env.HOME,'.config/mise');await mkdir(defaults,{recursive:true})
try{await access(join(defaults,'config.toml'))}catch{await writeFile(join(defaults,'config.toml'),'[tools]\nnode="system"\npython="system"\ngo="system"\njava="system"\n')}
for(const directory of [input.directory,...input.repositories]){
 const versions=directory===input.directory?{...input.versions}:{}
 for(const [tool,files]of Object.entries({node:['.nvmrc','.node-version'],python:['.python-version'],go:['.go-version'],java:['.java-version']}))for(const file of files){try{const value=(await readFile(join(directory,file),'utf8')).trim();if(value&&!versions[tool])versions[tool]=value;break}catch(e){if(e.code!=='ENOENT')throw e}}
 if(!versions.go)try{versions.go=(await readFile(join(directory,'go.mod'),'utf8')).match(/^go\s+([\d.]+)$/m)?.[1]}catch(e){if(e.code!=='ENOENT')throw e}
 const tools=Object.entries(versions).filter(([,v])=>v)
 for(const [tool,version]of tools){if(!['node','python','go','java'].includes(tool)||typeof version!=='string'||version.length>80||!/^[-a-zA-Z0-9_.*+/]+$/.test(version))throw new Error('项目工具版本无效');await run(['install',`core:${tool}@${version}`])}
 if(tools.length&&directory===input.directory){const config=join(directory,'mise.toml');try{await access(config)}catch{await writeFile(config,'# 项目工具版本，供执行目录中的命令选择。\n[tools]\n'+tools.map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n')};await run(['trust',join(directory,'mise.toml')])}
}
await run(['reshim'])
