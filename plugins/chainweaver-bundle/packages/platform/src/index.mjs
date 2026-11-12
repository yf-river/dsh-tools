import { Platform } from './server.mjs'
export const name='chainweaver-platform'
/** 账号入口本身不加载 Agent 或用户工具。 */
export async function apply(ctx,config){const platform=new Platform(config);ctx.effect(()=>async()=>platform.stop());const origin=await platform.start();console.log(`ChainWeaver: ${origin}/login`)}
