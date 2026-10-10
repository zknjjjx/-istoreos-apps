const src=require('fs').readFileSync(process.argv[2],'utf8');
function Node(tag,attrs,kids){this.tag=tag;this.attrs=attrs||{};this.children=[];this.style={};this.innerHTMLv='';if(kids!==undefined)this.add(kids);}
Node.prototype.add=function(k){if(Array.isArray(k))k.forEach(x=>this.add(x));else if(k!==''&&k!=null)this.children.push(k);}
Node.prototype.appendChild=function(c){this.children.push(c);return c;}
Object.defineProperty(Node.prototype,'innerHTML',{set(v){this.children=[]},get(){return ''}});
Node.prototype.addEventListener=function(){};Node.prototype.focus=function(){};Node.prototype.remove=function(){};
Node.prototype.text=function(){return this.children.map(c=>c instanceof Node?c.text():String(c)).join('');}
global.E=function(tag,a,k){if(Array.isArray(a)||typeof a==='string'||a instanceof Node){k=a;a={};}return new Node(tag,a,k);};
global.L={bind:(f,ctx,...a)=>f.bind(ctx,...a)};
global.window={setInterval:()=>1,clearInterval:()=>{},scrollTo:()=>{}};global.document={querySelector:()=>null};
let status={success:true,version:'cloudflared version 2026.10.0',arch:'arm64',installing:false,install_log:'',has_token:true,account_id:'acc1',proxy:'x',protocol:'http2',ip_version:'auto',autostart:'1',uptime:'5000',boot_enabled:true,tunnels:[{sec:'t_a',id:'aaa',name:'home',enabled:true,running:true,pid:123,started:100},{sec:'m',id:'manual_1',name:'tok',enabled:false,running:false}]};
const fsm={exec:(b,args)=>{let out;
 if(args[0]=='status')out=status;
 else if(args[0]=='api'){const p=args[2];if(p.includes('/configurations'))out={success:true,result:{config:{ingress:[{hostname:'nas.ex.com',service:'http://1.2.3.4:5000'},{service:'http_status:404'}]}}};
 else if(p.includes('cfd_tunnel'))out={success:true,result:[{id:'aaa',name:'home',status:'healthy',created_at:'2026-10-10T10:00:00Z',connections:[1,2,3,4]}]};
 else out={success:true,result:[{id:'z1',name:'ex.com'}]};}
 else if(args[0]=='logs')out={success:true,log:'hello'};
 else out={success:true};
 return Promise.resolve({stdout:JSON.stringify(out)});}};
const ui={addNotification:()=>{},showModal:(t,c)=>{global.lastModal=c},hideModal:()=>{},createHandlerFn:(c,f)=>f};
const view={extend:o=>o};
const V=new Function('view','fs','ui',src)(view,fsm,ui);
(async()=>{const st=await V.load();const m=V.render(st);await new Promise(r=>setTimeout(r,50));
for(const t of ['home','account','system','tunnels','logs']){V.tab=t;V.draw();console.log('==',t,V.content.text().slice(0,400));}
V.newTunnel();V.addByToken();V.editRoutes(V.tunnels[0]);console.log('modals ok');
status.has_token=false;status.account_id='';await V.refresh();V.tab='tunnels';V.draw();console.log('== notoken',V.content.text().slice(0,300));V.tab='home';V.draw();
})().catch(e=>{console.error('ERR',e);process.exit(1)});
