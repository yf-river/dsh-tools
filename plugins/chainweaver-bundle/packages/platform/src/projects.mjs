import { mkdir, writeFile, readFile, chmod, chown, realpath, stat, rm, readdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { command } from './docker.mjs'
import { Problem, id } from './store.mjs'

export function gitUrl(value) {
  if(typeof value!=='string'||value.length>2048||/[\s\x00-\x1f]/.test(value))throw new Problem(400,'Git 地址无效')
  if(/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(value))return value
  const u=URL.parse(value)
  if(!u||!['https:','ssh:'].includes(u.protocol)||u.password||(u.protocol==='https:'&&u.username))throw new Problem(400,'Git 地址仅支持 HTTPS 或 SSH，不接受内嵌密码和本地路径')
  return u.href
}
const slug=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)||value==='..')throw new Problem(400,'仓库目录名无效');return value}
export class Projects {
  constructor(store,runtimes,volumes) {this.store=store;this.runtimes=runtimes;this.volumes=volumes;this.cacheLocks=new Map();this.aborts=new Map()}
  async userFs(userId,operation,args){return this.runtimes.userCommand(userId,'node',['--input-type=module','-e',`import * as fs from 'node:fs/promises';const [op,args]=JSON.parse(process.argv[1]);const result=await fs[op](...args);if(typeof result==='string')process.stdout.write(result)`,JSON.stringify([operation,args])])}

  async syncCredentials(userId){
    const paths=this.runtimes.paths(userId),secrets=this.store.credentials(userId),control=join(paths.home,'.chainweaver','git');
    await this.userFs(userId,'mkdir',[control,{recursive:true,mode:448}]);
    await this.userFs(userId,'writeFile',[join(control,'credentials.json'),JSON.stringify(secrets),{mode:384}]);
    const config=join(paths.home,'.gitconfig');let contents=await this.userFs(userId,'readFile',[config,'utf8']).catch(e=>{if(e.message.includes('ENOENT'))return '';throw e});
    if(!contents.includes('/opt/chainweaver/credential-helper.mjs'))await this.userFs(userId,'appendFile',[config,'\n[credential]\n\thelper = !node /opt/chainweaver/credential-helper.mjs\n',{mode:384}]);
    return {paths,secrets,control}
  }
  async initialize(userId) {
    const p=this.runtimes.paths(userId);await this.volumes.ensure(`user-${userId}`,p.home)
    await chown(p.home,this.store.account(userId).uid,this.store.account(userId).uid);await chmod(p.home,0o700);for(const path of [p.projects,p.dsh])await this.userFs(userId,'mkdir',[path,{recursive:true,mode:448}]);await this.syncCredentials(userId)
    return p
  }
  abort(userId){if(!this.aborts.has(userId))this.aborts.set(userId,new AbortController());this.aborts.get(userId).abort(new Error('用户执行已停止'))}
  resume(userId){this.aborts.delete(userId)}
  async git(userId,args,cwd,{shared=false,signal}={}) {
    if(!this.aborts.has(userId))this.aborts.set(userId,new AbortController());signal=AbortSignal.any([this.aborts.get(userId).signal,...signal?[signal]:[]]);signal.throwIfAborted()
    const user=this.store.account(userId);if(!user||user.disabled)throw new Problem(403,'账号不可用')
    const {paths,secrets,control}=await this.syncCredentials(userId)
    const env={HOME:paths.home,GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'protocol.file.allow',GIT_CONFIG_VALUE_0:'never',GIT_CONFIG_KEY_1:'gc.auto',GIT_CONFIG_VALUE_1:'0',GIT_CONFIG_KEY_2:'credential.helper',GIT_CONFIG_VALUE_2:'',GIT_CONFIG_KEY_3:'credential.helper',GIT_CONFIG_VALUE_3:'!/usr/local/bin/node /opt/chainweaver/credential-helper.mjs'}
    if(secrets.sshKey){
      const key=join(control,'key'),hosts=join(control,'known_hosts');await this.userFs(userId,'writeFile',[key,secrets.sshKey,{mode:384}]);await this.userFs(userId,'writeFile',[hosts,secrets.knownHosts??'',{mode:384}])
      env.GIT_SSH_COMMAND=`ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${hosts} -o StrictHostKeyChecking=yes`
    }
    return this.runtimes.userCommand(userId,'git',args,{cwd,env,signal,memory:'2g',cacheWrite:shared||undefined,timeout:180000})
  }
  async cache(userId,url) {
    const entry=this.store.all('repositories').find(r=>r.value.url===url&&r.value.users.includes(userId))
    if(!entry)return undefined
    const repo=entry.value;const target=join(this.runtimes.root,'cache',entry.id)
    await this.git(userId,['ls-remote',url],this.runtimes.paths(userId).home)
    await this.volumes.ensure('cache',join(this.runtimes.root,'cache'),this.volumes.cacheGiB)
    if(!this.cacheLocks.has(entry.id))this.cacheLocks.set(entry.id,(async()=>{
      if(!await stat(join(target,'HEAD')).catch(()=>undefined)) {
        await mkdir(target,{recursive:true,mode:0o750});await chown(target,this.store.account(userId).uid,repo.gid)
        await this.git(userId,['clone','--mirror','--',url,target],this.runtimes.paths(userId).home,{shared:target})
        await this.git(userId,['-C',target,'config','gc.auto','0'],target,{shared:target})
        // 缓存目录只允许平台维护；借用者仅有组读取权限。
        await command('chown',['-R',`0:${repo.gid}`,target]);await command('chmod',['-R','g+rX,o-rwx',target])
      }
      return target
    })().finally(()=>this.cacheLocks.delete(entry.id)))
    return this.cacheLocks.get(entry.id)
  }
  list(userId) {return this.store.all('projects',userId).map(r=>r.value)}
  get(userId,projectId) {const p=this.store.get('projects',projectId,userId);if(!p)throw new Problem(404,'项目不存在');return p}
  async create(userId,input,{defer=false}={}) {
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw new Problem(400,'请填写项目名称')
    if(input.repositories!==undefined&&!Array.isArray(input.repositories))throw new Problem(400,'仓库列表无效')
    if(input.toolchain!==undefined&&(typeof input.toolchain!=='object'||input.toolchain===null||Object.entries(input.toolchain).some(([key,value])=>!['node','java','go','python'].includes(key)||typeof value!=='string'||value.length>80||!/^[-a-zA-Z0-9_.*+/]+$/.test(value))))throw new Problem(400,'项目工具版本无效')
    const p=await this.initialize(userId)
    const repos=(input.repositories??[]).map((repo,index)=>({name:slug(repo.name??`repo-${index+1}`),url:gitUrl(repo.url)}))
    if(repos.length>20||new Set(repos.map(r=>r.name)).size!==repos.length)throw new Problem(400,'仓库数量或目录名无效')
    const project={id:id(),name:input.name.trim(),repositories:repos,status:'preparing',createdAt:new Date().toISOString(),toolchain:input.toolchain??{},directory:''}
    project.directory=join(p.projects,project.id);this.store.put('projects',project.id,project,userId)
    if(defer)return project
    return this.clone(userId,project)
  }
  async clone(userId,project){const repos=project.repositories;const p=this.runtimes.paths(userId);
    try {
      await this.userFs(userId,'mkdir',[project.directory,{mode:448,recursive:true}])
      for(const repo of repos) {
        const cache=await this.cache(userId,repo.url)
        if(cache) {
          // 先记录长期借用，缓存不能因任务完成而被回收。
          this.store.db.prepare('INSERT INTO cache_leases VALUES(?,?,?,?,?)').run(id(),userId,project.id,cache.split('/').at(-1),JSON.stringify({createdAt:Date.now()}))
        }
        repo.directory=join(project.directory,repo.name)
        if(await stat(join(repo.directory,'.git')).catch(()=>false)){const origin=await this.git(userId,['-C',repo.directory,'remote','get-url','origin'],repo.directory);if(origin!==repo.url)throw new Problem(409,'已有仓库来源不匹配，已保留目录')}else await this.git(userId,['clone',...(cache?['--reference',cache]:[]),'--',repo.url,repo.directory],project.directory)
        repo.base??=await this.git(userId,['-C',repo.directory,'rev-parse','HEAD'],repo.directory);this.store.put('projects',project.id,project,userId)
      }
      project.status='ready'
    }catch(e){project.status='failed';project.error=e.message}
    this.store.put('projects',project.id,project,userId);await this.publish(userId);return project
  }
  async publish(userId) {
    const path=join(this.runtimes.paths(userId).home,'projects.json')
    await this.userFs(userId,'writeFile',[path,JSON.stringify(this.list(userId).filter(p=>p.status==='ready').map(p=>({id:p.id,name:p.name,path:p.directory}))),{mode:384}])
  }
  async prepare(userId,job) {
    const project=this.get(userId,job.projectId)
    if(project.status!=='ready')throw new Problem(409,'项目尚未准备完成')
    const userHome=this.runtimes.paths(userId).home,target=resolve(job.directory)
    if(!target.startsWith(userHome+'/'))throw new Problem(403,'执行目录不属于当前账号')
    const canonical=await realpath(project.directory);if(!canonical.startsWith(userHome+'/'))throw new Problem(403,'项目目录已被替换')
    const commits=job.commits??{}
    for(const repo of project.repositories)if(!commits[repo.name])commits[repo.name]=await this.git(userId,['-C',repo.directory,'rev-parse','HEAD'],repo.directory)
    job.commits=commits;this.store.put('executions',job.id,job,userId)
    await this.userFs(userId,'mkdir',[target,{recursive:true,mode:448}])
    for(const repo of project.repositories) {
      const dest=join(target,repo.name),branch=`chainweaver/${job.branchId??job.id}`
      if(await stat(dest).catch(()=>undefined)) {
        const base=await this.git(userId,['-C',dest,'rev-parse','HEAD'],dest)
        const common=await this.git(userId,['-C',dest,'rev-parse','--path-format=absolute','--git-common-dir'],dest)
        const original=await this.git(userId,['-C',repo.directory,'rev-parse','--path-format=absolute','--git-common-dir'],repo.directory)
        const actualBranch=await this.git(userId,['-C',dest,'branch','--show-current'],dest);await this.git(userId,['-C',dest,'merge-base','--is-ancestor',commits[repo.name],base],dest);if(common!==original||actualBranch!==branch)throw new Problem(409,'已有执行目录与记录不匹配，已保留供检查')
      }else await this.git(userId,['-C',repo.directory,'worktree','add','-b',branch,dest,commits[repo.name]],repo.directory)
    }
    await this.runtimes.docker(['exec',this.runtimes.paths(userId).name,'/usr/local/bin/node','/opt/chainweaver/project-toolchain.mjs',JSON.stringify({directory:target,repositories:project.repositories.map(r=>join(target,r.name)),versions:project.toolchain})],{timeout:600000})
    job.prepared=true;job.status='running';this.store.put('executions',job.id,job,userId);return job
  }
  confirm(userId,executionId) {const j=this.store.get('executions',executionId,userId);if(!j)throw new Problem(404,'执行不存在');if(!['completed','failed','interrupted','cancelled'].includes(j.status))throw new Problem(409,'执行结束后才能确认交付');j.acceptedAt=Date.now();this.store.put('executions',j.id,j,userId);return j}
  async reclaim(userId,job,now=Date.now()){
    if(this.maintenance?.has(userId)||this.runtimes.pending.has(userId)||this.store.all('executions',userId).some(row=>['queued','running','preparing'].includes(row.value.status)))return false
    this.maintenance?.add(userId)
    try{if((await this.runtimes.inspect(userId))?.State.Running)return false;return await this.reclaimStopped(userId,job,now)}finally{this.maintenance?.delete(userId);this.resumeScheduling?.()}
  }
  async reclaimStopped(userId,job,now=Date.now()) {
    if(!job.acceptedAt||now-job.acceptedAt<7*86400000||!['completed','failed','interrupted','cancelled'].includes(job.status)||!job.prepared)return false
    const p=this.get(userId,job.projectId)
    const contents=await readdir(job.directory);let generatedConfig=false;if(contents.includes('mise.toml')){const expected='# 项目工具版本，供执行目录中的命令选择。\n[tools]\n'+Object.entries(p.toolchain??{}).filter(([,v])=>v).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n');generatedConfig=!!Object.keys(p.toolchain??{}).length&&(await this.userFs(userId,'readFile',[join(job.directory,'mise.toml'),'utf8'])).trim()===expected.trim()}if(contents.some(name=>!p.repositories.some(repo=>repo.name===name)&&!(generatedConfig&&name==='mise.toml')))return false
    for(const repo of p.repositories) {
      const dir=join(job.directory,repo.name)
      if(!await stat(dir).catch(()=>undefined))continue
      if(await this.git(userId,['-C',dir,'status','--porcelain','--untracked-files=all','--ignored'],dir))return false
      const sha=await this.git(userId,['-C',dir,'rev-parse','HEAD'],dir)
      await this.git(userId,['-C',repo.directory,'update-ref',`refs/chainweaver/deliveries/${job.id}`,sha],repo.directory)
    }
    // 主运行空间停止且调度入口锁定，执行目录没有存活的使用者。
    for(const repo of p.repositories)await this.git(userId,['-C',repo.directory,'worktree','remove',join(job.directory,repo.name)],repo.directory)
    if(generatedConfig)await this.userFs(userId,'unlink',[join(job.directory,'mise.toml')]);await this.userFs(userId,'rmdir',[job.directory])
    this.store.put('executions',job.id,{...job,reclaimedAt:Date.now()},userId);return true
  }
}
