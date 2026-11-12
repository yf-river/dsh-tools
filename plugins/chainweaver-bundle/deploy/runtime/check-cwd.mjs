import {readdirSync,readlinkSync} from 'node:fs'
const path=process.argv[2]
let busy=false
for(const pid of readdirSync('/proc'))if(/^\d+$/.test(pid)&&Number(pid)!==process.pid){try{const cwd=readlinkSync(`/proc/${pid}/cwd`);if(cwd===path||cwd.startsWith(path+'/'))busy=true}catch{}}
console.log(busy?'busy':'free')
