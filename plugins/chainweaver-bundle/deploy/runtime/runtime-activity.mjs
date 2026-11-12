import {readFileSync} from 'node:fs'
try{const state=JSON.parse(readFileSync('/tmp/chainweaver-activity.json','utf8'));console.log(JSON.stringify({background:Date.now()-state.at>15000||state.background}))}catch{console.log('{"background":true}')}
