import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.mjs'
import { Scheduler } from '../src/scheduler.mjs'
import { Platform } from '../src/server.mjs'

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'cw-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
test('密码仅首次初始化，登录、凭据隔离和撤销',async t=>{
 const root=await fixture(t);let s=new Store(root);const admin=s.login('admin','123456');assert.equal(admin.account.role,'admin');
 const a=s.createAccount('alice','alice123'),b=s.createAccount('bob','bob12345');assert.throws(()=>s.createAccount('alice','alice123'),{status:409});
 const session=s.login('alice','alice123');s.setCredentials(a.id,{token:'private-alice'});assert.equal(s.credentials(b.id).token,undefined);
 assert.equal((await readFile(join(root,'platform.sqlite'))).includes(Buffer.from('private-alice')),false);
 s.password(a.id,'changed123');assert.equal(s.authenticate(session.token),undefined);s.password(admin.account.id,'newadmin');s.close();
 s=new Store(root);t.after(()=>s.close());assert.throws(()=>s.login('admin','123456'),{status:401});assert.equal(s.login('admin','newadmin').account.id,admin.account.id);
 assert.throws(()=>s.disable(admin.account.id,true),{status:409});const bsession=s.login('bob','bob12345');s.disable(b.id,true);assert.equal(s.authenticate(bsession.token),undefined);
})
test('40 账号共享两个执行名额，每账号一个，重启需确认',async t=>{
 const root=await fixture(t),s=new Store(root,{bootstrap:false});t.after(()=>s.close());const q=new Scheduler(s);
 const users=Array.from({length:40},(_,i)=>s.createAccount('u'+i,'secret123'));
 for(const u of users){assert.ok(s.login(u.username,'secret123').token);q.request(u.id,'first');q.request(u.id,'second')}
 let seen=new Set();while(q.active.size){assert.ok(q.active.size<=2);const per=new Set();for(const j of [...q.active.values()]){assert.equal(per.has(j.userId),false);per.add(j.userId);seen.add(j.userId);assert.throws(()=>q.get(users.find(u=>u.id!==j.userId).id,j.id),{status:404});q.finish(j.userId,j.id)}}assert.equal(seen.size,40);
 const j=q.request(users[0].id,'restart');s.close();const restarted=new Store(root,{bootstrap:false});assert.equal(restarted.get('executions',j.id,users[0].id).status,'interrupted');restarted.close();s.close=()=>{};
})
test('真实 HTTP 登录、CSRF、角色与对象边界',async t=>{
 const root=await fixture(t),p=new Platform({stateDir:root,port:0});const origin=await p.start();t.after(()=>p.stop());
 const req=async(path,{cookie,method='GET',data,originHeader=origin}={})=>{const r=await fetch(origin+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{origin:originHeader}:{}),'content-type':'application/json'},body:data?JSON.stringify(data):undefined,redirect:'manual'});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],value:await r.json().catch(()=>null)}};
 assert.equal((await req('/platform/projects')).status,401);assert.equal((await req('/auth/login',{method:'POST',data:{username:'admin',password:'123456'},originHeader:'http://evil.invalid'})).status,403);
 const admin=await req('/auth/login',{method:'POST',data:{username:'admin',password:'123456'}});assert.equal(admin.status,200);assert.ok(admin.cookie);
 const a=(await req('/platform/admin/accounts',{cookie:admin.cookie,method:'POST',data:{username:'alice',password:'alice123'}})).value.account;
 const b=(await req('/platform/admin/accounts',{cookie:admin.cookie,method:'POST',data:{username:'bob',password:'bob12345'}})).value.account;
 const alice=await req('/auth/login',{method:'POST',data:{username:'alice',password:'alice123'}});
 assert.equal((await req('/platform/admin/accounts',{cookie:alice.cookie})).status,403);
 p.store.put('projects','bob-project',{id:'bob-project',name:'private'},b.id);assert.deepEqual((await req('/platform/projects',{cookie:alice.cookie})).value.projects,[]);
 const j=p.scheduler.request(b.id,'private');assert.equal((await req(`/platform/executions/${j.id}/confirm`,{cookie:alice.cookie,method:'POST',data:{}})).status,404);
 p.runtimes.stop=async()=>{};assert.equal((await req(`/platform/admin/accounts/${a.id}/disable`,{cookie:admin.cookie,method:'POST',data:{}})).status,200);assert.equal((await req('/auth/me',{cookie:alice.cookie})).status,401);
 assert.equal((await req('/api/sessions',{cookie:admin.cookie})).status,404);
 for(let i=0;i<5;i++)assert.equal((await req('/auth/login',{method:'POST',data:{username:'alice',password:'bad'}})).status,401);
 assert.equal((await req('/auth/login',{method:'POST',data:{username:'alice',password:'bad'}})).status,429);
 assert.equal((await req('/platform/admin/repositories',{cookie:admin.cookie,method:'POST',data:{url:'https://token:secret@example.com/private',users:[a.id]}})).status,400);
})

test('积压任务不能饿死其他账号，中断确认不提前占名额',async t=>{
 const root=await fixture(t),s=new Store(root,{bootstrap:false});t.after(()=>s.close());const q=new Scheduler(s,{concurrency:1});
 const a=s.createAccount('alice','secret123'),b=s.createAccount('bob','secret123'),c=s.createAccount('carol','secret123');
 const first=q.request(a.id,'one');for(let i=0;i<20;i++)q.request(a.id,'backlog'+i);const bj=q.request(b.id,'one'),cj=q.request(c.id,'one');
 q.finish(a.id,first.id);assert.ok(q.active.has(bj.id));q.finish(b.id,bj.id);assert.ok(q.active.has(cj.id));
 q.stopped=true;q.stopUser(a.id,'服务停止');q.stopUser(c.id,'服务停止');q.stopped=false;
 assert.throws(()=>q.request(c.id,'one'),{status:409});q.recover(c.id,cj.id);assert.equal(q.active.size,0);assert.equal(q.request(c.id,'one').status,'running');
})

test('40 个账号并发通过真实 HTTP 登录并保持项目隔离',async t=>{
 const root=await fixture(t),p=new Platform({stateDir:root,port:0});const origin=await p.start();t.after(()=>p.stop());
 const accounts=Array.from({length:40},(_,i)=>p.store.createAccount('http-user-'+i,'secret123'));
 const results=await Promise.all(accounts.map(async a=>{const r=await fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:a.username,password:'secret123'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]}));
 const visible=await Promise.all(results.map(cookie=>fetch(origin+'/platform/projects',{headers:{cookie}}).then(r=>r.json())));assert.ok(visible.every(r=>r.projects.length===0));
})

test('停止命令会终止其创建的进程组',async t=>{
 const root=await fixture(t);const {command}=await import('../src/docker.mjs');const path=join(root,'processes.json');const controller=new AbortController();
 const running=command(process.execPath,['--input-type=module','-e',`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`,path],{signal:controller.signal});
 let pids;for(let i=0;i<100&&!pids;i++){try{pids=JSON.parse(await readFile(path,'utf8'))}catch{await new Promise(r=>setTimeout(r,10))}}
 assert.ok(pids);t.after(()=>{try{process.kill(-pids[0],'SIGKILL')}catch{}});controller.abort(new Error('test cancellation'));await assert.rejects(running,/test cancellation/);
 for(const pid of pids){let alive=true;for(let i=0;i<50&&alive;i++){try{const stat=await readFile('/proc/'+pid+'/stat','utf8');alive=!stat.split(') ')[1].startsWith('Z')}catch{alive=false}if(alive)await new Promise(r=>setTimeout(r,10))}assert.equal(alive,false)}
})

test('已有账号库缺失密钥时拒绝重新生成密钥',async t=>{
 const root=await fixture(t),s=new Store(root);s.close();const {unlink,access}=await import('node:fs/promises');await unlink(join(root,'master.key'));assert.throws(()=>new Store(root),/密钥缺失/);await assert.rejects(access(join(root,'master.key')),{code:'ENOENT'});
})

test('同一数据目录禁止并行控制器，释放后允许重启',async t=>{const root=await fixture(t),{lockPlatform}=await import('../src/lock.mjs');const release=lockPlatform(root);assert.throws(()=>lockPlatform(root),/另一个控制进程/);release();const again=lockPlatform(root);again()})
