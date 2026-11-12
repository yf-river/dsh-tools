import {mkdirSync,writeFileSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {root,runDsh} from './runtime.mjs'
const home=resolve(process.env.CHAINWEAVER_CONTROL_HOME??join(root,'.local/platform-control'))
const dir=join(home,'profiles/chainweaver-platform');mkdirSync(dir,{recursive:true,mode:0o700})
if(!existsSync(join(dir,'package.json')))writeFileSync(join(dir,'package.json'),JSON.stringify({name:'chainweaver-platform-profile',private:true,type:'module',dependencies:{'@chainweaver/platform':`link:${join(root,'packages/platform')}`},dsh:{profile:{bundles:['@chainweaver/platform']}}},null,2)+'\n')
if(!existsSync(join(dir,'cordis.patch.yml')))writeFileSync(join(dir,'cordis.patch.yml'),'[]\n')
if(process.argv[2]==='setup')await runDsh(['plugin','--profile','chainweaver-platform','install','--ignore-scripts'],{home})
else await runDsh(['--profile','chainweaver-platform'],{home,built:process.env.CHAINWEAVER_SOURCE!=='1'})
