import assert from 'node:assert/strict'
import {join,resolve}from'node:path'
import {writeFile}from'node:fs/promises'
import {Platform}from'../packages/platform/src/server.mjs'
const p=new Platform({host:'9.134.129.162',port:33092,stateDir:'.local/toolchain-verification'});await p.start();const user=p.store.accounts()[0]
try{
 await p.projects.initialize(user.id);await p.runtimes.ensure(user.id,{resume:true})
 const project=await p.projects.create(user.id,{name:'Node version acceptance',repositories:[],toolchain:{node:'22.15.0'}});assert.equal(project.status,'ready')
 const directory=join(p.runtimes.paths(user.id).home,'toolchain-'+crypto.randomUUID());const job=p.scheduler.request(user.id,crypto.randomUUID(),'prepare',{projectId:project.id,directory})
 while(!p.scheduler.get(user.id,job.id).prepared){const state=p.scheduler.heartbeat(user.id,job.id);if(!['running','queued'].includes(state.status))throw new Error(state.reason);await new Promise(r=>setTimeout(r,500))}
 const version=await p.runtimes.docker(['exec','--workdir',directory,p.runtimes.paths(user.id).name,'/bin/bash','-c','PATH="$HOME/.local/share/mise/shims:$PATH" node --version']);assert.equal(version,'v22.15.0');console.log('PASS project-selected Node version:',version)
 p.scheduler.finish(user.id,job.id);const accepted=p.projects.confirm(user.id,job.id);accepted.acceptedAt=Date.now()-8*86400000;await p.runtimes.stop(user.id,{paused:false});assert.equal(await p.projects.reclaim(user.id,accepted),true);console.log('PASS generated toolchain config does not prevent safe reclaim')
 await writeFile(resolve('.local/toolchain-verification/verification.json'),JSON.stringify({at:new Date().toISOString(),node:version,reclaimed:true},null,2))
}finally{await p.stop()}
