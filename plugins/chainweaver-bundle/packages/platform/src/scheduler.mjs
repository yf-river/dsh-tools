import { Problem, id } from './store.mjs'

/** 顶层执行租约；子 Agent 复用其父执行租约。 */
export class Scheduler {
  constructor(store, { concurrency = 2, perUser = 1 } = {}) {
    this.store = store; this.concurrency = concurrency; this.perUser = perUser
    this.maintenance=new Set();this.stopped=false;this.work=new Map();this.queue = []; this.active = new Map(); this.served=new Map();this.sequence=0; this.handlers = new Map()
  }
  request(userId, key, kind = 'agent', detail = {}) {
    if (this.store.account(userId)?.disabled) throw new Problem(403, '账号已停用')
    if(this.stopped)throw new Problem(503,'服务正在停止')
    const prior=this.store.all('executions',userId).map(r=>r.value).find(j=>j.key===key&&j.status==='interrupted'&&!j.resumeAllowed);if(prior)throw new Problem(409,'此执行已中断，请在执行记录中允许恢复')
    const existing = this.store.all('executions', userId).find(r => r.value.key === key && ['queued','running','preparing'].includes(r.value.status))
    if (existing) return existing.value
    const job = { id: id(), key, kind, userId, status: 'queued', createdAt: new Date().toISOString(), heartbeat: Date.now(), ...detail }
    this.store.put('executions', job.id, job, userId); this.queue.push(job); this.drain(); return this.store.get('executions', job.id, userId)
  }
  drain() {
    if(this.stopped)return
    while (this.active.size < this.concurrency) {
      const eligible = this.queue.filter(j => !this.maintenance.has(j.userId) && !this.store.account(j.userId)?.disabled && [...this.active.values()].filter(a => a.userId === j.userId).length < this.perUser)
      const job = eligible.sort((a,b)=>(this.served.get(a.userId)??0)-(this.served.get(b.userId)??0))[0]
      if (!job) return
      this.queue = this.queue.filter(j => j.id !== job.id); this.served.set(job.userId,++this.sequence)
      job.status = 'running'; job.startedAt = new Date().toISOString(); job.heartbeat = Date.now()
      this.active.set(job.id,job); this.store.put('executions',job.id,job,job.userId)
      const handler = this.handlers.get(job.kind)
      if(handler){const work=Promise.resolve().then(()=>handler(job)).catch(error=>this.finish(job.userId,job.id,'failed',error.message)).finally(()=>this.work.delete(job.id));this.work.set(job.id,work)}
    }
  }
  get(userId, jobId) { const job=this.store.get('executions',jobId,userId); if(!job) throw new Problem(404,'执行不存在');return job }
  heartbeat(userId, jobId) { const j=this.get(userId,jobId); if(this.active.has(jobId)){j.heartbeat=Date.now();this.active.set(jobId,j);this.store.put('executions',jobId,j,userId)}return j }
  finish(userId, jobId, status = 'completed', reason) {
    const job=this.get(userId,jobId)
    if (!['completed','failed','interrupted','cancelled'].includes(status)) throw new Problem(400,'执行状态无效')
    if (!['queued','running','preparing'].includes(job.status)) return job
    job.status=status;job.reason=reason;job.endedAt=new Date().toISOString()
    this.active.delete(jobId);this.queue=this.queue.filter(j=>j.id!==jobId);this.store.put('executions',jobId,job,userId);this.drain();return job
  }
  stopUser(userId,reason='账号已停用，重新启用后需确认恢复') {
    for(const row of this.store.all('executions',userId)) if(['queued','running','preparing'].includes(row.value.status)) this.finish(userId,row.id,'interrupted',reason)
  }
  recover(userId, jobId) {
    const job=this.get(userId,jobId)
    if(!['interrupted','failed'].includes(job.status)) throw new Problem(409,'此执行不需要恢复')
    const next={...job,resumeAllowed:true,status:job.kind==='project'?'queued':'interrupted',reason:job.kind==='project'?undefined:'已允许恢复；请在个人空间继续对应会话或任务',heartbeat:Date.now()};this.store.put('executions',jobId,next,userId);if(job.kind==='project'){this.queue.push(next);this.drain()}return next
  }
}
