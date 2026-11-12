import { mkdir, stat, readdir, chmod, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { command } from './docker.mjs'
import { Problem } from './store.mjs'

/** 独立 ext4 数据卷对用户写入实施容量上限，不依赖事后清理维持宿主机空间。 */
export class Volumes {
  constructor(root,{userGiB=4,cacheGiB=20,reserveGiB=16}={}) {this.root=resolve(root);this.userGiB=userGiB;this.cacheGiB=cacheGiB;this.reserveGiB=reserveGiB;this.pending=new Map();this.tail=Promise.resolve()}
  async ensure(name,target,gib=this.userGiB) {
    if(!/^(user-[a-f0-9-]{36}|cache)$/.test(name))throw new Error('无效的数据卷名称')
    if(this.pending.has(name))return this.pending.get(name)
    const work=this.tail.then(()=>this.prepare(name,target,gib));this.tail=work.catch(()=>{});const p=work.finally(()=>this.pending.delete(name));this.pending.set(name,p);return p
  }
  async prepare(name,target,gib) {
    const images=join(this.root,'disks');await mkdir(images,{recursive:true,mode:0o700})
    const image=join(images,`${name}.ext4`)
    const mounted=JSON.parse(await command('findmnt',['--json','--target',target]).catch(()=>'{"filesystems":[]}')).filesystems?.[0]
    if(mounted?.target===target) {
      const loops=await command('losetup',['-j',image]);if(!loops.includes(mounted.source+':'))throw new Error('数据卷挂载身份不匹配')
      return target
    }
    await mkdir(target,{recursive:true,mode:0o700})
    if((await readdir(target)).length)throw new Error('数据卷目标存在非卷内容，拒绝覆盖')
    const exists=await stat(image).catch(e=>{if(e.code==='ENOENT')return undefined;throw e})
    if(!exists||exists.blocks===0) {
      const df=await command('df',['--output=avail','--block-size=1',this.root]);const free=Number(df.split('\n').at(-1).trim())
      let reserved=0
      for(const file of await readdir(images)){if(join(images,file)===image)continue;const s=await stat(join(images,file));reserved+=Math.max(0,s.size-s.blocks*512)}
      if(free-reserved-this.reserveGiB*1024**3<gib*1024**3)throw new Problem(429,'磁盘可预留容量不足，不能创建新的个人空间')
      const temporary=image+'.provisioning';try{await command('truncate',['-s',`${gib}G`,temporary]);await chmod(temporary,0o600);await command('mkfs.ext4',['-q','-F',temporary],{timeout:120000});await rename(temporary,image)}finally{await rm(temporary,{force:true})}
    }
    await command('mount',['-t','ext4','-o','loop,nodev,nosuid',image,target]);return target
  }
}
