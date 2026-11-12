import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { Platform } from '../packages/platform/src/server.mjs'
const root=resolve('.local/isolation-verification-v2');await mkdir(root,{recursive:true})
const p=new Platform({host:'9.134.129.162',port:33091,stateDir:root});const origin=await p.start();const findings=[]
const check=(label,value)=>{assert.ok(value,label);findings.push(label);console.log('PASS',label)}
const api=async(path,{cookie,method='GET',data}={})=>{const r=await fetch(origin+path,{method,headers:{origin,...cookie?{cookie}:{},'content-type':'application/json'},body:data?JSON.stringify(data):undefined,redirect:'manual',signal:AbortSignal.timeout(150000)});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],text:await r.text()}}
const accounts=[]
try {
 const admin=await api('/auth/login',{method:'POST',data:{username:'admin',password:'123456'}});check('管理员通过账号入口登录',admin.status===200)
 for(const username of ['isolation-a','isolation-b']){const account=p.store.accounts().find(a=>a.username===username)??p.store.createAccount(username,'isolated123');accounts.push(account)}
 const cookies=[]
 for(const a of accounts){const r=await api('/auth/login',{method:'POST',data:{username:a.username,password:'isolated123'}});cookies.push(r.cookie);const start=await api('/platform/runtime',{cookie:r.cookie,method:'POST',data:{resume:true}});check(`${a.username} 真实容器启动`,start.status===200);if(start.status!==200)console.log(start.text)}
 const [a,b]=accounts,pa=p.runtimes.paths(a.id),pb=p.runtimes.paths(b.id)
 const containers=await Promise.all(accounts.map(a=>p.runtimes.inspect(a.id)))
 check('独立非 root UID',containers[0].Config.User!==containers[1].Config.User&&!containers.some(c=>c.Config.User.startsWith('0:')))
 check('独立 Docker 网络',containers[0].HostConfig.NetworkMode!==containers[1].HostConfig.NetworkMode)
 check('运行容器无 Docker socket',containers.every(c=>!c.Mounts.some(m=>m.Destination.includes('docker.sock'))))
 check('容器端口只绑定回环',containers.every(c=>c.NetworkSettings.Ports['3080/tcp'].every(binding=>binding.HostIp==='127.0.0.1')))
 await p.runtimes.docker(['exec',pa.name,'node','-e',`require('fs').writeFileSync(process.env.HOME+'/private.txt','a-only')`])
 const crossFile=await p.runtimes.docker(['exec',pb.name,'node','-e',`try{require('fs').readFileSync(${JSON.stringify(pa.home+'/private.txt')});process.exit(3)}catch(e){if(!['ENOENT','EACCES'].includes(e.code))throw e;console.log('isolated')}`]);check('B 无法读取 A 的文件',crossFile==='isolated')
 const ipA=Object.values(containers[0].NetworkSettings.Networks)[0].IPAddress
 const net=await p.runtimes.docker(['exec',pb.name,'node','-e',`fetch('http://${ipA}:3080/',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(3),()=>console.log('isolated'))`]);check('B 容器无法连接 A 运行端口',net==='isolated')
 const pages=await Promise.all(cookies.map(cookie=>api('/app/',{cookie})));check('两个登录均可打开真实 DSH 页面',pages.every(r=>r.status===200&&r.text.includes('<html')))
 const noLogin=await api('/app/');check('未登录不能代理 DSH',noLogin.status===401)
 const raw=await api('/api/sessions',{cookie:cookies[0]});check('旧 DSH 根路由不暴露',raw.status===404)
 const repoUrl='https://github.com/octocat/Hello-World.git';const repositoryId=p.store.all('repositories').find(r=>r.value.url===repoUrl)?.id??crypto.randomUUID();p.store.put('repositories',repositoryId,{url:repoUrl,users:[a.id,b.id],gid:200000,createdAt:Date.now()})
 const projectA=await p.projects.create(a.id,{name:'isolation-project-a',repositories:[{name:'hello',url:repoUrl}]});check('真实 Git 项目 A 克隆',projectA.status==='ready');
 const projectB=await p.projects.create(b.id,{name:'isolation-project-b',repositories:[{name:'hello',url:repoUrl}]});check('真实 Git 项目 B 共享授权缓存',projectB.status==='ready');
 check('缓存具有两个长期租约',p.store.db.prepare('SELECT count(DISTINCT user_id) n FROM cache_leases WHERE repository_id=?').get(repositoryId).n===2)
 await p.runtimes.ensure(a.id);await p.runtimes.ensure(b.id)
 const workdir=join(pa.home,'task-verification-'+crypto.randomUUID());const job=p.scheduler.request(a.id,'worker-verification','prepare',{projectId:projectA.id,directory:workdir});
 while(!p.store.get('executions',job.id,a.id).prepared){const current=p.scheduler.heartbeat(a.id,job.id);if(current.status==='failed')throw new Error(current.reason);await new Promise(r=>setTimeout(r,100))}
 check('执行时创建真实 Git worktree',!!await readFile(join(workdir,'hello','.git'),'utf8'))
 await p.runtimes.docker(['exec',pa.name,'node','-e',`require('fs').writeFileSync(${JSON.stringify(workdir+'/hello/untracked.txt')},'keep me')`]);
 p.scheduler.finish(a.id,job.id);const accepted=p.projects.confirm(a.id,job.id);accepted.acceptedAt=Date.now()-8*86400000;await p.runtimes.stop(a.id,{paused:false});
 check('七天后拒绝回收有未跟踪文件的目录',await p.projects.reclaim(a.id,accepted)===false)
 await p.projects.userFs(a.id,'unlink',[join(workdir,'hello/untracked.txt')]);
 check('七天后回收干净且无人占用的 worktree',await p.projects.reclaim(a.id,accepted)===true)
 const protectedRef=await p.projects.git(a.id,['-C',projectA.repositories[0].directory,'rev-parse',`refs/chainweaver/deliveries/${job.id}`],projectA.directory);check('回收保留 Git 成果引用',!!protectedRef)
 await p.runtimes.ensure(a.id,{resume:true});
 const disabled=await api(`/platform/admin/accounts/${a.id}/disable`,{cookie:admin.cookie,method:'POST',data:{}});check('停用账号成功',disabled.status===200)
 check('停用立即撤销登录',(await api('/auth/me',{cookie:cookies[0]})).status===401)
 check('停用停止对应容器',!(await p.runtimes.inspect(a.id)).State.Running)
 check('另一个账号仍可访问',(await api('/app/',{cookie:cookies[1]})).status===200)
 const enabled=await api(`/platform/admin/accounts/${a.id}/enable`,{cookie:admin.cookie,method:'POST',data:{}});check('重新启用保留数据',enabled.status===200)
 const relog=await api('/auth/login',{method:'POST',data:{username:a.username,password:'isolated123'}});check('重新启用需确认恢复',(await api('/app/',{cookie:relog.cookie})).status===409)
 await writeFile(join(root,'verification.json'),JSON.stringify({at:new Date().toISOString(),findings},null,2))
}finally{for(const a of accounts)await p.runtimes.stop(a.id).catch(()=>{});await p.stop()}
