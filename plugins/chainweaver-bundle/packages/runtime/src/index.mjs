import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

export const name='chainweaver-runtime'
export const inject=['agents','jobs','tools']
/** 顶层执行占用一个租约；子 Agent 与后台作业沿用所属执行。 */
export async function apply(ctx) {
  if(process.env.CHAINWEAVER_MANAGED!=='1')return
  const {key,coordinator}=JSON.parse(readFileSync('/run/chainweaver/runtime.json','utf8'))
  const leases=new Map(),pending=new Map(),releasing=new Map(),routerWork=new Map()
  let stopped=false,automation=!!ctx.get('schedule')
  const request=async(path,body,signal)=>{
    const response=await fetch(`${coordinator}/_runtime/${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)})
    if(!response.ok)throw new Error((await response.json()).error??`平台拒绝执行：${response.status}`)
    return response.json()
  }
  const rootOf=agent=>{
    const visited=new Set()
    while(agent.session.header.origin==='subagent'&&agent.session.header.parentSession&&!visited.has(agent.id)){
      visited.add(agent.id);const parent=ctx.agents.get(agent.session.header.parentSession);if(!parent)break;agent=parent
    }
    return agent
  }
  const isRouter=agent=>agent.id.startsWith('orchestrator-')
  const jobsRunning=()=>ctx.jobs.list().some(job=>job.status==='running')
  const childrenRunning=root=>ctx.agents.list().some(agent=>agent.id!==root.id&&rootOf(agent).id===root.id&&agent.status!=='idle')
  const activity=()=>{
    try{
      const projects=JSON.parse(readFileSync(`${process.env.HOME}/projects.json`,'utf8'))
      for(const project of projects)ctx.get('workspaceRegistry')?.create(project.path,project.name).catch(error=>ctx.logger.warn('项目工作区登记失败：%s',error.message))
    }catch(error){if(error.code!=='ENOENT')ctx.logger.warn('项目列表读取失败：%s',error.message)}
    const agents=ctx.agents.list();const terminalController=ctx.get('terminalController'),terminals=ctx.get('terminals');const terminalOpen=agents.some(agent=>(terminalController?.list(agent.id).length??0)>0||(terminals?.list(agent).length??0)>0)
    let background=automation||terminalOpen||agents.some(agent=>agent.status!=='idle')||jobsRunning()
    const superagent=ctx.get('orchestrator')
    if(superagent){const settings=superagent.store.settings();background ||=Object.entries(settings.sources??{}).some(([kind,source])=>kind!=='local'&&source.enabled)||superagent.store.tickets.list().some(ticket=>!ticket.ended)}
    writeFileSync('/tmp/chainweaver-activity.json',JSON.stringify({background,at:Date.now()}))
  }
  const refreshAutomation=()=>{
    const schedule=ctx.get('schedule');if(!schedule){automation=false;return}
    schedule.list({active:true,limit:1}).then(result=>{if(stopped)return;automation=result.total>0;activity()}).catch(error=>{if(!stopped){automation=true;activity();ctx.logger.warn('自动化职责查询失败：%s',error.message)}})
  }
  ctx.on('schedule/changed',()=>{automation=true;activity();refreshAutomation()})
  const acquire=async(root,signal)=>{
    await releasing.get(root.id)
    if(leases.has(root.id)){
      const state=await request('poll',{id:leases.get(root.id)},signal)
      if(state.status!=='running'){leases.delete(root.id);throw new Error(state.reason??'执行需要确认恢复')}
    }
    if(!leases.has(root.id)){
      if(!pending.has(root.id))pending.set(root.id,(async()=>{
        let state=await request('acquire',{key:root.id},signal)
        while(state.status!=='running'){
          if(stopped||signal.aborted)throw signal.reason??new Error('执行已停止')
          await delay(700,undefined,{signal});state=await request('poll',{id:state.id},signal)
          if(!['queued','running'].includes(state.status))throw new Error(state.reason??'执行需要确认恢复')
        }
        leases.set(root.id,state.id)
      })().finally(()=>pending.delete(root.id)))
      await pending.get(root.id)
    }
    activity()
  }
  const releaseLease=async root=>{
    if(releasing.has(root.id))return releasing.get(root.id)
    const lease=leases.get(root.id);if(!lease)return
    const work=request('release',{id:lease}).then(()=>{if(leases.get(root.id)===lease)leases.delete(root.id);activity()}).finally(()=>releasing.delete(root.id))
    releasing.set(root.id,work);return work
  }
  const release=async agent=>{
    const root=rootOf(agent)
    if(root.id!==agent.id||jobsRunning()||childrenRunning(root)||(routerWork.get(root.id)??0)>0)return
    if(agent.status!=='idle'&&!isRouter(agent))return
    await releaseLease(root)
  }
  ctx.on('agent/pre-step',async({agent,signal},next)=>{const root=rootOf(agent);if(!isRouter(root))await acquire(root,signal);return next()})
  // Router 的控制消息不占执行名额；Shell 和实际子执行仍受同一队列约束。
  ctx.on('tools/execute',async(execution,next)=>{
    const root=execution.agent&&rootOf(execution.agent)
    if(!root||!isRouter(root)||!['bash','pwsh','subagent'].includes(execution.name))return next()
    routerWork.set(root.id,(routerWork.get(root.id)??0)+1)
    try{await acquire(root,execution.signal);return await next()}
    finally{routerWork.set(root.id,routerWork.get(root.id)-1);await release(root)}
  })
  ctx.on('agent/status',({agent,status})=>{activity();if(status==='idle')release(agent).catch(error=>ctx.logger.warn('执行租约释放失败：%s',error.message))})
  const timer=setInterval(()=>{
    refreshAutomation();activity()
    for(const [id,lease]of leases){const agent=ctx.agents.get(id);if(agent&&(agent.status==='idle'||isRouter(agent)))release(agent).catch(()=>{});request('poll',{id:lease}).catch(error=>ctx.logger.warn('执行心跳失败：%s',error.message))}
  },5000)
  timer.unref();refreshAutomation();activity()
  ctx.effect(()=>async()=>{stopped=true;clearInterval(timer);await Promise.allSettled([...pending.values(),...releasing.values()]);for(const lease of leases.values())await request('release',{id:lease,status:'interrupted'}).catch(()=>{});leases.clear()})
}
