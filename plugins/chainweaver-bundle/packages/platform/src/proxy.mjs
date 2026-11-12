import http from 'node:http'
import { pipeline } from 'node:stream'

const hop=new Set(['connection','keep-alive','proxy-authorization','proxy-authenticate','te','trailer','transfer-encoding','upgrade'])
/** 每次代理都使用登录账号对应的实例 Cookie，浏览器不能注入后端身份。 */
function headers(req,cookie,authority) {
  const result={}
  for(const [key,value] of Object.entries(req.headers))if(!hop.has(key)&&!['cookie','authorization','x-forwarded-for','x-forwarded-host','x-forwarded-proto'].includes(key))result[key]=value
  result.host=authority;result.cookie=cookie;return result
}
export class Proxy {
  constructor(authority){this.authority=authority;this.connections=new Map()}
  track(session,resource){let set=this.connections.get(session);if(!set){set=new Set();this.connections.set(session,set)}set.add(resource);return()=>{set.delete(resource);if(!set.size)this.connections.delete(session)}}
  revoke(token){for(const r of this.connections.get(token)??[])r.destroy();this.connections.delete(token)}
  all(){for(const token of [...this.connections.keys()])this.revoke(token)}
  request(req,res,runtime,token){
    const target=new URL(runtime.endpoint);const path=req.url.slice('/app'.length)||'/'
    const upstream=http.request({hostname:target.hostname,port:target.port,path,method:req.method,headers:headers(req,runtime.cookie,this.authority)},response=>{
      const out={};for(const [key,value]of Object.entries(response.headers))if(!hop.has(key)&&key!=='set-cookie')out[key]=value
      if(typeof out.location==='string'&&out.location.startsWith('/')&&!out.location.startsWith('/app/'))out.location='/app'+out.location
      res.writeHead(response.statusCode??502,out);pipeline(response,res,()=>{})
    })
    const release=this.track(token,upstream);upstream.on('close',release)
    upstream.on('error',()=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'个人空间连接中断，请重新打开'}))}else res.destroy()})
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableEnded)upstream.destroy()});pipeline(req,upstream,()=>{})
  }
  upgrade(req,socket,head,runtime,token){
    const releaseClient=this.track(token,socket);socket.on('close',releaseClient)
    const target=new URL(runtime.endpoint),h=headers(req,runtime.cookie,this.authority);h.connection='Upgrade';h.upgrade=req.headers.upgrade
    const request=http.request({hostname:target.hostname,port:target.port,path:req.url.slice(4)||'/',headers:h})
    const pending=this.track(token,request);request.on('close',pending)
    request.on('upgrade',(response,backend,backendHead)=>{
      socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`)
      for(const [key,value]of Object.entries(response.headers))if(key!=='set-cookie')socket.write(`${key}: ${value}\r\n`)
      socket.write('\r\n');if(backendHead.length)socket.write(backendHead);if(head.length)backend.write(head)
      const release=this.track(token,backend);backend.on('close',()=>{release();socket.destroy()});socket.on('close',()=>backend.destroy());backend.on('error',()=>socket.destroy());socket.on('error',()=>backend.destroy());backend.pipe(socket);socket.pipe(backend)
    })
    request.on('response',()=>socket.destroy());request.on('error',()=>socket.destroy());request.end()
  }
}
