window.__ModuleLoader__.load({id:'chainweaver-runtime',factory:(require)=>{
  const React=require('react')
  function Account({wide}){
    const icon=React.createElement('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,'aria-hidden':true},React.createElement('circle',{cx:12,cy:8,r:3}),React.createElement('path',{d:'M5 21v-2a7 7 0 0 1 14 0v2'}))
    return React.createElement('a',{href:'/account',title:'账号与项目','aria-label':'账号与项目',style:{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',fontSize:13,color:'inherit',textDecoration:'none'}},icon,wide?'账号与项目':null)
  }
  return {inject:['slots'],apply(ctx){ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'chainweaver-account',order:0},Account))}}
}})
