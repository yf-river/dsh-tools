import http from 'node:http'
import assert from 'node:assert/strict'
import {randomBytes,createHash}from'node:crypto'
import{readFile,writeFile}from'node:fs/promises'
import{join,resolve}from'node:path'
import{Platform}from'../packages/platform/src/server.mjs'
const p=new Platform({host:'9.134.129.162',port:33095,stateDir:'.local/stream-verification'});const origin=await p.start(),admin=p.store.accounts()[0]
const user=p.store.accounts().find(a=>a.username==='stream-user')??p.store.createAccount('stream-user','stream123');if(user.disabled)p.store.disable(user.id,false)
try{
 await p.projects.initialize(user.id);await p.runtimes.ensure(user.id,{resume:true})
 const manifest=join(p.runtimes.paths(user.id).dsh,'profiles/chainweaver/package.json'),before=createHash('sha256').update(await readFile(manifest)).digest('hex')
 let denied=false;try{await p.runtimes.docker(['exec',p.runtimes.paths(user.id).name,'/usr/local/bin/node','/opt/dsh/lib/bin.js','plugin','--profile','chainweaver','remove','chainweaver-bundle'])}catch(error){denied=/built-in product capabilities cannot be removed/.test(error.message)}assert.ok(denied);assert.equal(createHash('sha256').update(await readFile(manifest)).digest('hex'),before);console.log('PASS real CLI refuses removing built-in bundle without manifest mutation')
 const cookie='cw_session='+p.store.login(user.username,'stream123').token,adminCookie='cw_session='+p.store.login('admin','123456').token
 const socket=await new Promise((accept,reject)=>{const r=http.request(origin+'/app/api/remote.mux',{headers:{cookie,origin,connection:'Upgrade',upgrade:'websocket','sec-websocket-key':randomBytes(16).toString('base64'),'sec-websocket-version':'13'}});r.on('upgrade',(_,s)=>accept(s));r.on('response',response=>reject(new Error('WS status '+response.statusCode)));r.on('error',reject);r.end()});socket.on('data',()=>{});socket.on('error',()=>{})
 let closedAt;const closed=new Promise(resolve=>socket.once('close',()=>{closedAt=Date.now();resolve()})),started=Date.now()
 const response=await fetch(origin+`/platform/admin/accounts/${user.id}/disable`,{method:'POST',headers:{origin,cookie:adminCookie,'content-type':'application/json'},body:'{}'});assert.equal(response.status,200);await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('WebSocket not revoked')),1500))]);assert.ok(closedAt-started<1500);console.log('PASS real WebSocket is revoked immediately on account disable')
 await writeFile(resolve('.local/stream-verification/verification.json'),JSON.stringify({at:new Date().toISOString(),protectedCli:true,websocketRevocationMs:closedAt-started},null,2))
}finally{await p.stop()}
