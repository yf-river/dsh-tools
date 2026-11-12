import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, chown, chmod, lstat, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Problem } from './store.mjs'

/** 命令参数由服务端构造；不执行用户拼接的宿主机 shell。 */
export function command(executable,args,{env,cwd,signal,timeout=120000}={}) {
  return new Promise((accept,reject)=>{
    if(signal?.aborted){reject(signal.reason);return}
    const child=spawn(executable,args,{cwd,env:env??process.env,detached:true,stdio:['ignore','pipe','pipe']});let out='',err='',killTimer
    const kill=kind=>{try{process.kill(-child.pid,kind)}catch(e){if(e.code!=='ESRCH')throw e}}
    const terminate=()=>{kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),5000);killTimer.unref()}
    const timer=setTimeout(terminate,timeout);timer.unref();signal?.addEventListener('abort',terminate,{once:true})
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',terminate)}
    child.stdout.on('data',data=>{if(out.length<8*1024*1024)out+=data})
    child.stderr.on('data',data=>{if(err.length<1024*1024)err+=data})
    child.once('error',e=>{cleanup();reject(e)})
    child.once('close',(code,term)=>{cleanup();code===0&&!signal?.aborted?accept(out.trim()):reject(signal?.aborted?signal.reason:new Error(`${executable} 执行失败（${term??code}）：${err.slice(-1500)}`))})
  })
}

export class RuntimeManager {
  constructor(store,root,config={}) {
    this.store=store;this.root=resolve(root);this.config={image:'chainweaver/runtime:0.1.0',cgroupParent:'chainweaver-users.slice',maxResident:8,idleMinutes:20,memory:'768m',activeMemory:'4g',cpus:2,...config}
    this.maintenance=new Set();this.operationSlots=0;this.operationWaiters=[];this.oneshots=new Map();this.startGate=Promise.resolve();this.pending=new Map();this.cookieJars=new Map();this.abort=new Map();this.lastUse=new Map()
  }
  paths(userId) {
    if(!/^[a-f0-9-]{36}$/.test(userId))throw new Problem(400,'账号标识无效')
    const home=join(this.root,'users',userId)
    return {home,dsh:join(home,'dsh'),projects:join(home,'projects'),name:`cw-user-${userId}`,network:`cw-net-${userId}`}
  }
  async docker(args,options) {return command('docker',args,options)}
  async userCommand(userId,executable,args,{cwd,env={},signal,cacheWrite,memory='256m',timeout=120000}={}){
    if(this.operationSlots<4)this.operationSlots++;else await new Promise(resolve=>this.operationWaiters.push(resolve))
    const paths=this.paths(userId),user=this.store.account(userId),name=`cw-job-${randomBytes(12).toString('hex')}`
    let tracked=this.oneshots.get(userId);if(!tracked){tracked=new Set();this.oneshots.set(userId,tracked)}tracked.add(name)
    try{
      if(this.closing||!user||user.disabled)throw new Problem(403,'账号不可用');signal?.throwIfAborted()
      const control=join(this.root,'control',userId);await mkdir(control,{recursive:true,mode:0o755});await chmod(control,0o755);await writeFile(join(control,'passwd'),`root:x:0:0:root:/root:/bin/bash\nchainweaver:x:${user.uid}:${user.uid}::${paths.home}:/bin/bash\n`,{mode:0o444,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error});await chmod(join(control,'passwd'),0o444)
      const mounts=['--mount',`type=bind,src=${paths.home},dst=${paths.home}`,'--mount',`type=bind,src=${join(control,'passwd')},dst=/etc/passwd,readonly`],groups=[]
      const leased=this.store.db.prepare('SELECT DISTINCT repository_id FROM cache_leases WHERE user_id=?').all(userId).map(r=>r.repository_id)
      const allowed=this.store.all('repositories').filter(r=>r.value.users.includes(userId))
      if(cacheWrite&&!allowed.some(r=>join(this.root,'cache',r.id)===cacheWrite))throw new Problem(403,'缓存写入未获授权')
      for(const repo of allowed){const path=join(this.root,'cache',repo.id);if(!leased.includes(repo.id)&&path!==cacheWrite)continue;groups.push('--group-add',String(repo.value.gid));mounts.push('--mount',`type=bind,src=${path},dst=${path}${path===cacheWrite?'':',readonly'}`)}
      const environment={HOME:paths.home,USER:'chainweaver',LOGNAME:'chainweaver',...env}
      if(executable==='git')await this.network(userId)
      await this.docker(['create','--name',name,'--label','chainweaver.managed=true','--label','chainweaver.kind=operation','--label',`chainweaver.user=${userId}`,'--user',`${user.uid}:${user.uid}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--network',executable==='git'?paths.network:'none','--cgroup-parent',this.config.cgroupParent,'--memory',memory,'--memory-swap',memory,'--cpus','2','--pids-limit','128','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=512m','--log-driver','none','--entrypoint',executable==='git'?'/usr/bin/git':'/usr/local/bin/node','--workdir',cwd??paths.home,...Object.entries(environment).flatMap(([k,v])=>['-e',`${k}=${v}`]),...groups,...mounts,this.config.image,...args])
      if(this.closing||this.store.account(userId)?.disabled)throw new Problem(403,'账号不可用');signal?.throwIfAborted()
      return await this.docker(['start','--attach',name],{signal,timeout})
    }finally{
      await this.docker(['rm','--force',name]).catch(()=>{});tracked.delete(name);if(!tracked.size)this.oneshots.delete(userId);const next=this.operationWaiters.shift();if(next)next();else this.operationSlots--
    }
  }
  async network(userId){
    const paths=this.paths(userId),existing=await this.docker(['network','inspect',paths.network]).catch(e=>{if(e.message.includes('not found')||e.message.includes('No such'))return '';throw e})
    if(existing){if(JSON.parse(existing)[0].Labels?.['chainweaver.user']!==userId)throw new Error('网络身份不匹配');return}
    for(let n=0;n<8192;n++){
      const subnet=`10.254.${Math.floor(n/32)}.${(n%32)*8}/29`
      try{await this.docker(['network','create','--subnet',subnet,'--label','chainweaver.managed=true','--label','chainweaver.kind=runtime','--label',`chainweaver.user=${userId}`,paths.network]);return}catch(e){if(!e.message.includes('overlap'))throw e}
    }
    throw new Problem(429,'ChainWeaver 专用网络地址已用完')
  }
  async inspect(userId) {
    const {name}=this.paths(userId)
    const out=await this.docker(['container','inspect',name]).catch(error=>{if(error.message.includes('No such'))return '';throw error})
    return out?JSON.parse(out)[0]:undefined
  }
  async ensure(userId,{resume=false}={}) {
    if(this.maintenance.has(userId))throw new Problem(429,'个人空间正在安全回收执行目录，请稍后重试')
    if(this.closing)throw new Problem(503,'服务正在停止')
    if(this.closing||this.store.account(userId)?.disabled)throw new Problem(403,'账号已停用')
    const saved=this.store.get('runtimes',userId)
    if(saved?.paused&&!resume)throw new Problem(409,'个人空间已停止，请确认恢复')
    this.lastUse.set(userId,Date.now())
    if(this.pending.has(userId))return this.pending.get(userId)
    const work=this.startGate.then(()=>this.start(userId,saved,resume));this.startGate=work.catch(()=>{});const promise=work.finally(()=>this.pending.delete(userId));this.pending.set(userId,promise);return promise
  }
  async start(userId,saved,resume) {
    this.imageIdentity??=await this.docker(['image','inspect',this.config.image,'--format','{{.Id}}']);const paths=this.paths(userId);const control=join(this.root,'control',userId);await mkdir(control,{recursive:true,mode:0o755});await chmod(control,0o755);for(const file of ['runtime.json','passwd'])await chmod(join(control,file),0o444).catch(e=>{if(e.code!=='ENOENT')throw e});
    if(this.volumes)await this.volumes.ensure(`user-${userId}`,paths.home)
    let current=await this.inspect(userId)
    const cacheIds=this.store.db.prepare('SELECT DISTINCT repository_id FROM cache_leases WHERE user_id=? ORDER BY repository_id').all(userId).map(r=>r.repository_id)
    const signature=cacheIds.join(',');const spec=createHash('sha256').update(JSON.stringify({cacheIds,image:this.imageIdentity,config:this.config,isolation:'readonly-capdrop-tmpfs-exec-v2'})).digest('hex')
    if(current && (!saved?.key||current.Config.Labels?.['chainweaver.caches']!==signature||current.Image!==this.imageIdentity||current.Config.Labels?.['chainweaver.spec']!==spec)) {
      if(this.store.all('executions',userId).some(r=>['running','queued','preparing'].includes(r.value.status)))throw new Problem(429,'有执行正在运行，缓存挂载更新等待执行结束')
      await this.docker(['stop','--time','20',paths.name]).catch(()=>{});await this.docker(['rm',paths.name]);this.cookieJars.delete(userId);current=undefined
    }
    if(!current?.State.Running) {
      const running=await this.docker(['ps','--filter','label=chainweaver.managed=true','--filter','label=chainweaver.kind=runtime','--format','{{.ID}}'])
      if(running.split('\n').filter(Boolean).length>=this.config.maxResident&&!await this.evictIdle(userId))throw new Problem(429,'个人空间正在等待可用资源，请稍后重试')
      const mem=await readFile('/proc/meminfo','utf8');const available=Number(mem.match(/MemAvailable:\s+(\d+)/)?.[1]??0)*1024
      if(available<2*1024**3)throw new Problem(429,'服务器内存余量不足，正在等待资源')
      await mkdir(paths.dsh,{recursive:true,mode:0o700});await mkdir(paths.projects,{recursive:true,mode:0o700});for(const path of [paths.dsh,paths.projects])if((await lstat(path)).isSymbolicLink())throw new Error('个人空间目录不能是符号链接')
      const uid=this.store.account(userId).uid
      await chown(paths.home,uid,uid);await chmod(paths.home,0o700);await chown(paths.dsh,uid,uid);await chown(paths.projects,uid,uid)
      if(!current) {
        const key=randomBytes(32).toString('base64url')
        await mkdir(control,{recursive:true,mode:0o755})
        await writeFile(join(control,'runtime.json'),JSON.stringify({key,coordinator:this.config.coordinator,userId}),{mode:0o444});await chmod(join(control,'runtime.json'),0o444)
        await this.network(userId)
        await writeFile(join(control,'passwd'),`root:x:0:0:root:/root:/bin/bash\nchainweaver:x:${uid}:${uid}::${paths.home}:/bin/bash\n`,{mode:0o444,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error});await chmod(join(control,'passwd'),0o444)
        const mounts=['--mount',`type=bind,src=${join(control,'passwd')},dst=/etc/passwd,readonly`,'--mount',`type=bind,src=${paths.home},dst=${paths.home}`,'--mount',`type=bind,src=${control},dst=/run/chainweaver,readonly`]
        for(const lease of this.store.db.prepare('SELECT DISTINCT repository_id FROM cache_leases WHERE user_id=?').all(userId)) {
          const shared=this.store.get('repositories',lease.repository_id);if(shared?.gid)mounts.push('--group-add',String(shared.gid));const path=join(this.root,'cache',lease.repository_id);mounts.push('--mount',`type=bind,src=${path},dst=${path},readonly`)
        }
        await this.docker(['create','--name',paths.name,'--label','chainweaver.managed=true','--label','chainweaver.kind=runtime','--label',`chainweaver.user=${userId}`,'--label',`chainweaver.caches=${signature}`,'--label',`chainweaver.spec=${spec}`,
          '--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=3','--network',paths.network,'--user',`${uid}:${uid}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
          '--cgroup-parent',this.config.cgroupParent,'--pids-limit','256','--memory',this.config.memory,'--memory-swap',this.config.memory,'--cpus',String(this.config.cpus),
          '--tmpfs','/tmp:rw,exec,nosuid,nodev,size=512m','--init','-p','127.0.0.1::3080',
          '-e','USER=chainweaver','-e','LOGNAME=chainweaver','-e',`HOME=${paths.home}`,'-e',`DSH_HOME=${paths.dsh}`,'-e','CHAINWEAVER_MANAGED=1','-e',`CHAINWEAVER_AUTHORITY=${this.config.authority}`,
          '-e',`CHAINWEAVER_PROJECTS=${paths.projects}`,...mounts,this.config.image])
        saved={userId,key:this.store.encrypt(key),paused:false};this.store.put('runtimes',userId,saved)
      }
      if(resume) {saved={...saved,paused:false};this.store.put('runtimes',userId,saved)}
      if(this.closing||this.store.account(userId)?.disabled)throw new Problem(403,'账号已停用');await this.docker(['start',paths.name]);if(this.store.account(userId)?.disabled){await this.stop(userId);throw new Problem(403,'账号已停用')}current=await this.inspect(userId)
    }
    const port=current.NetworkSettings.Ports['3080/tcp']?.[0]?.HostPort
    if(!port)throw new Error('个人空间没有内部监听端口')
    const endpoint=`http://127.0.0.1:${port}`
    if(!this.cookieJars.has(userId)) {
      const deadline=Date.now()+60000;let last
      while(Date.now()<deadline) {
        if(this.closing||this.store.account(userId)?.disabled)throw new Problem(403,'账号已停用')
        if(!(await this.inspect(userId))?.State.Running)throw new Error('个人空间进程已退出，请检查容器日志');const log=await this.docker(['logs','--tail','120',paths.name]);const urls=[...log.matchAll(/dsh web: (http[^\s]+)/g)]
        if(urls.length) {
          const token=new URL(urls.at(-1)[1]).searchParams.get('token')
          try {
            const response=await new Promise((accept,reject)=>{const request=http.get(`${endpoint}/?token=${encodeURIComponent(token)}`,{headers:{host:this.config.authority}},result=>{result.resume();accept({status:result.statusCode,cookie:result.headers['set-cookie']?.[0]?.split(';')[0]})});request.setTimeout(3000,()=>request.destroy(new Error('后端认证超时')));request.on('error',reject)})
            if(response.status===303&&response.cookie){this.cookieJars.set(userId,response.cookie);break}
            last=`认证状态 ${response.status}`
          }catch(e){last=e.message}
        }
        await new Promise(resolve=>setTimeout(resolve,400))
      }
      if(!this.cookieJars.has(userId))throw new Error(`个人空间未能就绪：${last??'未发布启动地址'}`)
    }
    return {endpoint,cookie:this.cookieJars.get(userId),userId}
  }
  async stop(userId,{paused=true}={}) {
    this.abort.get(userId)?.abort();this.cookieJars.delete(userId);const initial=this.store.get('runtimes',userId);if(initial)this.store.put('runtimes',userId,{...initial,paused})
    await Promise.all([...this.oneshots.get(userId)??[]].map(name=>this.docker(['rm','--force',name]).catch(()=>{})))
    const current=await this.inspect(userId)
    if(current?.State.Running)await this.docker(['stop','--time','20',this.paths(userId).name],{timeout:30000})
    const state=this.store.get('runtimes',userId);if(state)this.store.put('runtimes',userId,{...state,paused})
  }
  async resize(userId,active) {
    if(!(await this.inspect(userId))?.State.Running)return
    await this.docker(['update','--memory',active?this.config.activeMemory:this.config.memory,'--memory-swap',active?this.config.activeMemory:this.config.memory,this.paths(userId).name])
  }
  keyAccount(key) {
    if(!key)return undefined
    for(const row of this.store.all('runtimes'))if(this.store.decrypt(row.value.key)===key&&!row.value.paused&&!this.store.account(row.user_id)?.disabled)return row.user_id
  }
  async stats() {
    const raw=await this.docker(['stats','--no-stream','--format','{{json .}}','--all'])
    return raw.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(s=>s.Name.startsWith('cw-user-')).map(s=>({userId:s.Name.slice(8),cpu:s.CPUPerc,memory:s.MemUsage,pids:s.PIDs}))
  }
  async evictIdle(except){
    const candidates=this.store.all('runtimes').filter(r=>r.user_id!==except&&!r.value.paused&&!this.oneshots.has(r.user_id)).sort((a,b)=>(this.lastUse.get(a.user_id)??0)-(this.lastUse.get(b.user_id)??0))
    for(const row of candidates){if(this.store.all('executions',row.user_id).some(j=>['running','queued','preparing'].includes(j.value.status)))continue;if(!(await this.inspect(row.user_id))?.State.Running)continue;const activity=await this.docker(['exec',this.paths(row.user_id).name,'/usr/local/bin/node','/opt/chainweaver/runtime-activity.mjs']).catch(()=>'{"background":true}');if(!JSON.parse(activity).background){await this.stop(row.user_id,{paused:false});return true}}return false
  }
  async maintain() {
    for(const row of this.store.all('runtimes')) {
      if(this.oneshots.has(row.user_id)||row.value.paused||Date.now()-(this.lastUse.get(row.user_id)??Date.now())<this.config.idleMinutes*60000)continue
      if(this.store.all('executions',row.user_id).some(j=>['running','queued','preparing'].includes(j.value.status)))continue
      const p=this.paths(row.user_id)
      const activity=await this.docker(['exec',p.name,'node','/opt/chainweaver/runtime-activity.mjs']).catch(()=>'{"background":true}')
      if(!JSON.parse(activity).background)await this.stop(row.user_id,{paused:false})
    }
  }
}
