import {readFileSync} from 'node:fs'
let input='';for await(const b of process.stdin)input+=b
const fields=Object.fromEntries(input.trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)]}))
try{const c=JSON.parse(readFileSync(`${process.env.HOME}/.chainweaver/git/credentials.json`,'utf8'));if(process.argv[2]==='get'&&fields.host===c.host&&c.token)console.log(`username=${c.username||'oauth2'}\npassword=${c.token}\n`)}catch{}
