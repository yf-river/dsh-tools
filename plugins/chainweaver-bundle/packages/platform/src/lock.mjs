import {mkdirSync,writeFileSync,readFileSync,unlinkSync}from'node:fs'
import{join}from'node:path'
import{randomUUID}from'node:crypto'

/** 同一数据目录只允许一个控制进程，避免独立调度器同时写入。 */
export function lockPlatform(root){
 mkdirSync(root,{recursive:true,mode:0o700});const path=join(root,'controller.lock'),nonce=randomUUID()
 const started=pid=>readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19]
 const owner={pid:process.pid,started:started(process.pid),nonce}
 for(let attempt=0;attempt<2;attempt++){
  try{writeFileSync(path,JSON.stringify(owner),{flag:'wx',mode:0o600});return()=>{try{if(JSON.parse(readFileSync(path,'utf8')).nonce===nonce)unlinkSync(path)}catch(error){if(error.code!=='ENOENT')throw error}}}
  catch(error){if(error.code!=='EEXIST')throw error;const previous=JSON.parse(readFileSync(path,'utf8'));let live=false;try{live=started(previous.pid)===previous.started}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}if(live)throw new Error('平台数据目录已由另一个控制进程使用');unlinkSync(path)}
 }
 throw new Error('无法锁定平台数据目录')
}
