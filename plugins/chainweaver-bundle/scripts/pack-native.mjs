import { cpSync,mkdirSync,existsSync,realpathSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function packNative(app,dshRoot){
 for(const name of ['node-addon-native-custom-loader','node-addon-require-builtin-linux-x64-gnu']){
  const source=join(dshRoot,'node_modules/.pnpm/node_modules',name),target=join(app,'node_modules',name)
  if(!existsSync(source))throw new Error('缺少当前平台原生依赖：'+name)
  mkdirSync(target,{recursive:true});cpSync(realpathSync(source),target,{recursive:true,force:true,filter:path=>path===source||!['node_modules','.git'].includes(path.split('/').at(-1))})
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))packNative(resolve(process.argv[2]),resolve(process.argv[3]))
