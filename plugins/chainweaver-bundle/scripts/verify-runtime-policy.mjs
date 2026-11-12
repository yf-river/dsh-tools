import {Platform}from'../packages/platform/src/server.mjs'
const p=new Platform({host:'9.134.129.162',port:33094,stateDir:'.local/policy-verification'});await p.start();const user=p.store.accounts()[0]
try{
 await p.projects.initialize(user.id);await p.runtimes.ensure(user.id,{resume:true})
 const script=`
 import assert from 'node:assert/strict';import{apply}from'/opt/dsh/node_modules/chainweaver-runtime/src/index.mjs';
 const listeners=new Map(),disposers=[],calls=[],agents=new Map();let jobs=[];const original=globalThis.fetch;
 globalThis.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/_runtime/'))calls.push({path:String(args[0]).split('/').at(-1),state:await response.clone().json()});return response};
 const make=(id,origin='user',parentSession)=>{const a={id,status:'running',session:{header:{origin,parentSession}}};agents.set(id,a);return a};
 const ctx={agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},jobs:{list:()=>jobs},get:()=>undefined,logger:{warn:()=>{}},on:(name,fn)=>listeners.set(name,fn),effect:fn=>disposers.push(fn())};
 const wait=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await new Promise(r=>setTimeout(r,100))}throw new Error('policy state timeout')};
 try{await apply(ctx);const signal=new AbortController().signal;const suffix=crypto.randomUUID();const parent=make('worker-policy-'+suffix),child=make('child-'+suffix,'subagent',parent.id),router=make('orchestrator-policy-'+suffix);
  await listeners.get('agent/pre-step')({agent:parent,signal},async()=>{});await listeners.get('agent/pre-step')({agent:child,signal},async()=>{});assert.equal(calls.filter(c=>c.path==='acquire').length,1);
  parent.status='idle';listeners.get('agent/status')({agent:parent,status:'idle'});await new Promise(r=>setTimeout(r,100));assert.equal(calls.filter(c=>c.path==='release').length,0);child.status='idle';await wait(()=>calls.filter(c=>c.path==='release').length===1);
  await listeners.get('agent/pre-step')({agent:router,signal},async()=>{});assert.equal(calls.filter(c=>c.path==='acquire').length,1);
  await listeners.get('tools/execute')({agent:router,name:'superagent_task_get',signal},async()=>({ok:true}));assert.equal(calls.filter(c=>c.path==='acquire').length,1);
  await listeners.get('tools/execute')({agent:router,name:'bash',signal},async()=>{assert.equal(calls.at(-1).state.status,'running');return{ok:true}});assert.equal(calls.filter(c=>c.path==='release').length,2);
  jobs=[{status:'running'}];await listeners.get('tools/execute')({agent:router,name:'bash',signal},async()=>({ok:true}));assert.equal(calls.filter(c=>c.path==='release').length,2);jobs=[];await wait(()=>calls.filter(c=>c.path==='release').length===3);
  console.log('PASS synthetic Agent events against real coordinator: inherited child lease, Router compute lease, background retention and control admission');
 }finally{for(const dispose of disposers)await dispose();globalThis.fetch=original}
 `
 console.log(await p.runtimes.docker(['exec',p.runtimes.paths(user.id).name,'/usr/local/bin/node','--input-type=module','-e',script],{timeout:60000}))
}finally{await p.stop()}
