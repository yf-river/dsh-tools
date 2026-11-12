import http from 'node:http'
import { readFile, mkdir, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockPlatform } from './lock.mjs'
import { Store, Problem, id } from './store.mjs'
import { RuntimeManager } from './docker.mjs'
import { Scheduler } from './scheduler.mjs'
import { Projects, gitUrl } from './projects.mjs'
import { Volumes } from './volumes.mjs'
import { Proxy } from './proxy.mjs'

const publicRoot=fileURLToPath(new URL('../public/',import.meta.url))
const cookieToken=req=>(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('cw_session='))?.slice(11)
function json(res,status,body,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body))}
async function body(req){let size=0,text='';for await(const data of req){size+=data.length;if(size>1024*1024)throw new Problem(413,'请求内容过大');text+=data}try{return JSON.parse(text||'{}')}catch{throw new Problem(400,'请求内容不是有效 JSON')}}
export class Platform {
  constructor(config={}) {
    this.config={host:'127.0.0.1',port:33090,...config};this.root=resolve(config.stateDir??'.local/platform')
    this.releaseLock=lockPlatform(this.root);try{this.store=new Store(this.root,{uidRegistry:config.uidRegistry??'/var/lib/chainweaver/identities.sqlite'})}catch(error){this.releaseLock();throw error};this.runtimes=new RuntimeManager(this.store,this.root,{...config.runtime,...config.runtimeImage?{image:config.runtimeImage}:{}})
    this.volumes=new Volumes(this.root,config.storage);this.runtimes.volumes=this.volumes
    this.projects=new Projects(this.store,this.runtimes,this.volumes);this.scheduler=new Scheduler(this.store,config.scheduler);this.projects.maintenance=this.runtimes.maintenance=this.scheduler.maintenance;this.projects.resumeScheduling=()=>this.scheduler.drain()
    this.scheduler.handlers.set('project',async job=>{const project=await this.projects.clone(job.userId,this.projects.get(job.userId,job.projectId));this.scheduler.finish(job.userId,job.id,project.status==='ready'?'completed':'failed',project.error)})
    this.scheduler.handlers.set('prepare',async job=>{await this.runtimes.resize(job.userId,true);await this.projects.prepare(job.userId,job)})
    this.upgradeSockets=new Set();this.tokens=new Map();this.attempts=new Map();this.tasks=new Set();this.maintenance=[]
    this.server=http.createServer((req,res)=>{this.handle(req,res).catch(error=>{if(!res.headersSent)json(res,error.status??500,{error:error.status?error.message:'操作失败，请稍后重试'});else res.destroy();if(!error.status)console.error('[platform]',error.message)})})
    this.server.on('upgrade',(req,socket,head)=>{this.upgradeSockets.add(socket);socket.on('close',()=>this.upgradeSockets.delete(socket));this.upgrade(req,socket,head).catch(()=>socket.destroy())})
  }
  async start() {
    for(const row of this.store.all('runtimes'))await this.runtimes.stop(row.user_id);
    await chmod(this.root,0o711);await mkdir(join(this.root,'control'),{recursive:true,mode:0o700})
    for(const dir of ['users','cache','git-control']){await mkdir(join(this.root,dir),{recursive:true,mode:0o711});await chmod(join(this.root,dir),0o711)}
    await new Promise((accept,reject)=>{this.server.once('error',reject);this.server.listen(this.config.port,this.config.host,accept)})
    this.authority=this.config.authority??`${this.config.host.includes(':')?'['+this.config.host+']':this.config.host}:${this.server.address().port}`
    this.origin=`http://${this.authority}`;this.proxy=new Proxy(this.authority)
    this.runtimes.config.authority=this.authority;this.runtimes.config.coordinator=this.config.coordinator??this.origin
    this.maintenance.push(setInterval(()=>{for(const [token,user]of this.tokens)if(!this.store.authenticate(token)){this.proxy.revoke(token);this.tokens.delete(token)}},5000))
    this.maintenance.push(setInterval(()=>this.track(this.runtimes.maintain()),60000))
    this.maintenance.push(setInterval(()=>this.track(this.reclaim()),3600000))
    this.maintenance.push(setInterval(()=>this.track(this.expireExecutions()),15000))
    for(const timer of this.maintenance)timer.unref()
    return this.origin
  }
  track(promise){this.tasks.add(promise);promise.catch(e=>console.error('[maintenance]',e.message)).finally(()=>this.tasks.delete(promise))}
  identity(req){const token=cookieToken(req);const user=this.store.authenticate(token);if(!user)throw new Problem(401,'请先登录');this.tokens.set(token,user.id);return{token,user}}
  revoke(userId){for(const [token,user]of this.tokens)if(user===userId){this.proxy.revoke(token);this.tokens.delete(token)}}
  async handle(req,res) {
    const url=new URL(req.url,'http://platform.invalid'),path=url.pathname
    if(req.headers.host!==this.authority)throw new Problem(403,'访问地址不受信任')
    if(req.method==='GET'&&path==='/favicon.ico'){res.writeHead(204);res.end();return}
    if(req.method==='GET'&&['/login','/account','/admin','/'].includes(path)) {
      if(path!=='/login') {
        const user=this.store.authenticate(cookieToken(req));if(!user){res.writeHead(303,{location:'/login'});res.end();return}
        if(path==='/admin'&&user.role!=='admin')throw new Problem(403,'需要管理员权限')
      }
      const html=await readFile(join(publicRoot,'index.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(html);return
    }
    if(req.method==='GET'&&['/platform/app.js','/platform/style.css'].includes(path)) {
      const file=path.endsWith('.js')?'app.js':'style.css';res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','cache-control':'no-cache'});res.end(await readFile(join(publicRoot,file)));return
    }
    if(req.method==='GET'&&path.startsWith('/app/')&&req.headers.accept?.includes('text/html')&&!this.store.authenticate(cookieToken(req))){res.writeHead(303,{location:'/login'});res.end();return}
    if(path.startsWith('/_runtime/'))return this.runtime(req,res,path)
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==this.origin)throw new Problem(403,'请求来源不受信任')
    if(path==='/auth/login'&&req.method==='POST') {
      const input=await body(req);if(typeof input.username!=='string'||typeof input.password!=='string')throw new Problem(400,'请填写账号和密码');const key=`${req.socket.remoteAddress}:${input.username}`,now=Date.now();let attempt=this.attempts.get(key)
      if(!attempt||now-attempt.since>300000)attempt={since:now,count:0}
      if(attempt.count>=5)throw new Problem(429,'登录尝试过多，请五分钟后重试')
      this.attempts.set(key,attempt)
      try {
        const result=this.store.login(input.username,input.password);this.attempts.delete(key);this.store.audit(result.account.id,'login',result.account.id)
        json(res,200,{account:result.account},{'set-cookie':`cw_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`})
      }catch(e){attempt.count++;throw e}return
    }
    const {user,token}=this.identity(req)
    if(path==='/auth/me'&&req.method==='GET'){json(res,200,{account:user});return}
    if(path==='/auth/logout'&&req.method==='POST'){this.store.logout(token);this.proxy.revoke(token);json(res,200,{ok:true},{'set-cookie':'cw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return}
    if(path==='/auth/password'&&req.method==='POST'){const b=await body(req);if(typeof b.oldPassword!=='string')throw new Problem(400,'请填写原密码');this.store.password(user.id,b.password,b.oldPassword);this.revoke(user.id);json(res,200,{ok:true});return}
    if(path.startsWith('/platform/admin/')) {
      if(user.role!=='admin')throw new Problem(403,'需要管理员权限')
      return this.admin(req,res,path,user)
    }
    if(path==='/platform/credentials') {
      if(req.method==='GET'){const c=this.store.credentials(user.id);json(res,200,{configured:!!(c.token||c.sshKey),host:c.host??'',username:c.username??''});return}
      if(req.method==='POST'){const b=await body(req);if(typeof b.host!=='string'||!/^[a-zA-Z0-9.-]+$/.test(b.host))throw new Problem(400,'请填写 Git 服务主机名');this.store.setCredentials(user.id,{host:b.host,username:String(b.username??''),token:String(b.token??''),sshKey:String(b.sshKey??''),knownHosts:String(b.knownHosts??'')});await this.projects.initialize(user.id);await this.projects.syncCredentials(user.id);json(res,200,{ok:true});return}
    }
    if(path==='/platform/projects') {
      if(req.method==='GET'){json(res,200,{projects:this.projects.list(user.id)});return}
      if(req.method==='POST'){const project=await this.projects.create(user.id,await body(req),{defer:true});this.scheduler.request(user.id,`project-${project.id}`,'project',{projectId:project.id});json(res,201,{project});return}
    }
    if(path==='/platform/executions'&&req.method==='GET'){json(res,200,{executions:this.store.all('executions',user.id).map(r=>r.value)});return}
    const action=path.match(/^\/platform\/executions\/([a-f0-9-]{36})\/(confirm|resume)$/)
    if(action&&req.method==='POST'){const job=action[2]==='confirm'?this.projects.confirm(user.id,action[1]):this.scheduler.recover(user.id,action[1]);json(res,200,{execution:job});return}
    if(path==='/platform/runtime') {
      if(req.method==='GET'){json(res,200,{runtime:this.store.get('runtimes',user.id)?{paused:this.store.get('runtimes',user.id).paused}:null});return}
      if(req.method==='POST'){const input=await body(req);await this.projects.initialize(user.id);const runtime=await this.runtimes.ensure(user.id,{resume:input.resume===true});json(res,200,{ready:true});return}
    }
    if(path==='/app'){res.writeHead(303,{location:'/app/'});res.end();return}
    if(path.startsWith('/app/')) {
      const runtime=await this.runtimes.ensure(user.id)
      if(!this.store.authenticate(token))throw new Problem(401,'登录已失效')
      this.proxy.request(req,res,runtime,token);return
    }
    throw new Problem(404,'页面或接口不存在')
  }
  async admin(req,res,path,user) {
    if(path==='/platform/admin/accounts') {
      if(req.method==='GET'){json(res,200,{accounts:this.store.accounts()});return}
      if(req.method==='POST'){const b=await body(req),account=this.store.createAccount(b.username,b.password,b.role);this.store.audit(user.id,'account.create',account.id);json(res,201,{account});return}
    }
    const match=path.match(/^\/platform\/admin\/accounts\/([a-f0-9-]{36})\/(disable|enable|password)$/)
    if(match&&req.method==='POST') {
      const [,accountId,action]=match
      if(action==='password'){this.store.password(accountId,(await body(req)).password);this.revoke(accountId)}
      else if(action==='disable'){this.store.disable(accountId,true);this.revoke(accountId);this.projects.abort(accountId);this.scheduler.stopUser(accountId);await this.runtimes.stop(accountId)}
      else {this.store.disable(accountId,false);this.projects.resume(accountId)}
      this.store.audit(user.id,`account.${action}`,accountId);json(res,200,{ok:true});return
    }
    if(path==='/platform/admin/resources'&&req.method==='GET'){json(res,200,{limits:this.runtimes.config,concurrency:this.scheduler.concurrency,perUser:this.scheduler.perUser,runtimes:await this.runtimes.stats()});return}
    if(path==='/platform/admin/repositories') {
      if(req.method==='GET'){json(res,200,{repositories:this.store.all('repositories').map(r=>({id:r.id,...r.value}))});return}
      if(req.method==='POST') {
        const b=await body(req),repoId=id();if(typeof b.url!=='string'||!b.url.startsWith('https://')||!Array.isArray(b.users)||b.users.some(u=>!this.store.account(u)))throw new Problem(400,'请填写 HTTPS 仓库地址和有效账号')
        const repo={url:gitUrl(b.url),users:b.users,gid:this.store.allocateIdentity(),createdAt:Date.now()};this.store.put('repositories',repoId,repo);this.store.audit(user.id,'repository.authorize',repoId);json(res,201,{repository:{id:repoId,...repo}});return
      }
    }
    throw new Problem(404,'管理接口不存在')
  }
  async runtime(req,res,path) {
    const userId=this.runtimes.keyAccount(req.headers.authorization?.replace(/^Bearer /,''));if(!userId)throw new Problem(401,'运行实例身份无效')
    const b=await body(req)
    if(path==='/_runtime/acquire') {
      if(typeof b.key!=='string'||b.key.length>200)throw new Problem(400,'执行标识无效')
      const job=this.scheduler.request(userId,b.key);if(job.status==='running')await this.runtimes.resize(userId,true);json(res,200,job);return
    }
    if(path==='/_runtime/poll'){const j=this.scheduler.heartbeat(userId,b.id);if(j.status==='running')await this.runtimes.resize(userId,true);json(res,200,j);return}
    if(path==='/_runtime/release'){const j=this.scheduler.finish(userId,b.id,b.status??'completed');if(!this.store.all('executions',userId).some(j=>j.value.status==='running'))await this.runtimes.resize(userId,false).catch(()=>{});json(res,200,j);return}
    if(path==='/_runtime/prepare') {
      const p=this.projects.list(userId).find(p=>p.directory===b.projectDirectory||p.repositories.some(r=>r.directory===b.projectDirectory));if(!p)throw new Problem(404,'任务目录不是该账号登记的项目')
      if(!/^[a-zA-Z0-9-]{1,100}$/.test(b.ticketId))throw new Problem(400,'工单标识无效')
      const prior=this.store.all('executions',userId).map(r=>r.value).find(j=>j.kind==='prepare'&&j.key===`worker-${b.ticketId}`&&j.directory===b.directory);const job=this.scheduler.request(userId,`worker-${b.ticketId}`,'prepare',{projectId:p.id,directory:b.directory,...prior?{commits:prior.commits,branchId:prior.branchId??prior.id}:{}});json(res,200,job);return
    }
    throw new Problem(404,'运行管理接口不存在')
  }
  async upgrade(req,socket,head) {
    if(req.headers.host!==this.authority||req.headers.origin!==this.origin||!req.url.startsWith('/app/'))throw new Problem(403,'连接来源无效')
    const {user,token}=this.identity(req);const runtime=await this.runtimes.ensure(user.id);if(!this.store.authenticate(token))throw new Problem(401,'登录失效');this.proxy.upgrade(req,socket,head,runtime,token)
  }
  async expireExecutions(){for(const job of [...this.scheduler.active.values()])if(job.kind!=='project'&&Date.now()-job.heartbeat>45000){await this.runtimes.stop(job.userId);this.projects.abort(job.userId);this.scheduler.stopUser(job.userId,'执行心跳中断，请确认恢复')}}
  async reclaim(){for(const row of this.store.all('executions'))if(row.value.acceptedAt&&!row.value.reclaimedAt)await this.projects.reclaim(row.user_id,row.value).catch(e=>this.store.audit(null,'reclaim.refused',row.id,e.message))}
  async stop(){this.scheduler.stopped=true;this.runtimes.closing=true;for(const account of this.store.accounts()){this.projects.abort(account.id);this.scheduler.stopUser(account.id,'服务已停止，请确认恢复')}for(const t of this.maintenance)clearInterval(t);this.proxy?.all();for(const socket of this.upgradeSockets)socket.destroy();this.server.closeIdleConnections();await new Promise(resolve=>this.server.close(resolve));await Promise.allSettled([...this.tasks,...this.scheduler.work.values(),...this.runtimes.pending.values()]);await Promise.allSettled(this.store.all('runtimes').map(row=>this.runtimes.stop(row.user_id)));this.store.close();this.releaseLock()}
}
