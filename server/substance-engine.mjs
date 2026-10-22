// Talks to Adobe's free Substance Remote Engine (substance_remote_engine.exe).
// The message shape is the one the official Blender add-on uses: one JSON document per TCP
// connection to 127.0.0.1, then the engine calls back on a port we registered.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {tmpdir, homedir} from 'node:os';

const ENDPOINT={system:'Lwnd-CHcT-uJlw-YSw3',substance:'m7ef-7gYN-zTGu-4D3w'};
// 与 Blender 插件默认分辨率相同：边长是 2 的这个次方，10 就是 1024。
const OUTPUT_SIZE=[10,10];
// 0 是 DirectX 法线，1 是 OpenGL。网页预览用的 three.js 吃 OpenGL。
const OP={addClient:10,load:20,update:24,render:25};
function downloadedToolDirs(){
 const downloads=path.join(homedir(),'Downloads');
 let names=[];
 try{names=fssync.readdirSync(downloads,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^Substance3DIntegrationTools/i.test(entry.name)).map(entry=>path.join(downloads,entry.name));}catch{}
 return names;
}
export function substanceEngineDir(){
 const fromEnv=process.env.SFX_SRE_DIR&&String(process.env.SFX_SRE_DIR);
 const roaming=process.env.APPDATA&&path.join(process.env.APPDATA,'Adobe','Substance3DIntegrationTools');
 return [fromEnv,roaming,...downloadedToolDirs()].filter(Boolean);
}

function message(endpoint,operation,data,type=1){
 return {type,endpoint,operation,data,timer:Date.now()/1000};
}

export function exchangeJson(port,payload,{host='127.0.0.1',timeout=120000}={}){
 return new Promise((resolve,reject)=>{
  const sock=net.connect({port,host});
  let text='',settled=false;
  const timer=setTimeout(()=>{if(!settled){settled=true;sock.destroy();reject(Error('Substance 引擎没有在时限内回答'));}},timeout);
  const finish=body=>{
   if(settled)return;
   settled=true;
   clearTimeout(timer);
   sock.end();
   if(!body)return resolve(null);
   try{resolve(JSON.parse(body));}catch{reject(Error(`Substance 引擎返回的不是 JSON：${body.slice(0,180)}`));}
  };
  sock.on('error',e=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}});
  sock.on('data',chunk=>{
   text+=chunk.toString('utf8');
   const start=text.indexOf('{');
   if(start<0)return;
   let depth=0,inString=false,escaped=false;
   for(let i=start;i<text.length;i++){
    const char=text[i];
    if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
    if(char==='"')inString=true;
    else if(char==='{')depth++;
    else if(char==='}'&&--depth===0)return finish(text.slice(start,i+1));
   }
  });
  // 引擎收到完整 JSON 后在同一条连接上回答，不会主动关掉连接。写完就 FIN 的话它会直接空回。
  sock.write(JSON.stringify(payload));
 });
}

function listenForCallbacks(){
 return new Promise((resolve,reject)=>{
  const server=http.createServer((req,res)=>{
   const chunks=[];
   req.on('data',chunk=>chunks.push(chunk));
   req.on('end',()=>{
    const text=Buffer.concat(chunks).toString('utf8').trim();
    let body=null;
    try{body=text?JSON.parse(text):null;}catch{body={raw:text.slice(0,400)};}
    server.emit('callback',body);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end('{}');
   });
  });
  server.unref();
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>resolve(server));
 });
}

async function findSbsar(file){
 const resolved=path.resolve(String(file||''));
 const stat=await fs.stat(resolved).catch(()=>null);
 if(!stat)throw Error('找不到已下载的 SBSAR 文件');
 if(stat.isFile()){
  if(!/\.sbsar$/i.test(resolved))throw Error('这不是 .sbsar 文件');
  return resolved;
 }
 const names=await fs.readdir(resolved);
 const hit=names.find(name=>/\.sbsar$/i.test(name));
 if(!hit)throw Error('下载目录里没有 .sbsar 文件');
 return path.join(resolved,hit);
}

function graphsFrom(payload){
 const data=payload?.data??payload;
 const bag=data?.substance||data;
 const graphs=Array.isArray(bag?.graphs)?bag.graphs:[];
 return {uuid:String(bag?.uuid||data?.uuid||''),graphs};
}

function previewInputs(graph){
 const inputs=Array.isArray(graph?.inputs)?graph.inputs:[];
 const seen=new Set();
 return inputs.filter(input=>input&&input.identifier&&input.identifier!=='$outputsize'&&(input.type==='float'||input.type==='int')&&input.visibleIf!==false&&!seen.has(input.identifier)&&seen.add(input.identifier)).map(input=>({
  id:Number(input.id),
  identifier:String(input.identifier),
  label:input.guiGroup?`${input.guiGroup} · ${input.label||input.identifier}`:String(input.label||input.identifier),
  type:String(input.type||''),
  widget:String(input.guiWidget||''),
  value:input.value??input.default??input.defaultValue??null,
  min:input.min??input.minValue??input.guiMin??null,
  max:input.max??input.maxValue??input.guiMax??null,
 }));
}

function outputList(graph){
 const outputs=Array.isArray(graph?.outputs)?graph.outputs:[];
 const images=outputs.filter(output=>!output.type||output.type==='image');
 const list=images.length?images:outputs;
 return list.map(output=>({identifier:output.identifier,enabled:true,format:'PNG',bitdepth:'8'}));
}

async function mapsIn(dir){
 const names=await fs.readdir(dir).catch(()=>[]);
 const files=names.filter(name=>/\.(png|jpe?g)$/i.test(name));
 const slot=pattern=>files.find(name=>pattern.test(name))||null;
 return {
  basecolor:slot(/base.?color|albedo|diffuse|color/i),
  normal:slot(/normal/i),
  roughness:slot(/rough/i),
  metalness:slot(/metal/i),
 };
}

export function createSubstanceBridge({dirs=substanceEngineDir(),spawnImpl=spawn,exchange=exchangeJson,port=0}={}){
 let child=null,enginePort=port,callbackServer=null,session=null,starting=null;
 async function engineFile(){
  for(const dir of dirs){
   const exe=path.join(dir,process.platform==='win32'?'substance_remote_engine.exe':'substance_remote_engine');
   if(await fs.stat(exe).then(s=>s.isFile()).catch(()=>false))return {dir,exe};
  }
  throw Error('没有找到 Substance Remote Engine。把 Integration Tools 解压后的目录设到环境变量 SFX_SRE_DIR。');
 }
 async function ensure(){
  if(child&&enginePort&&callbackServer)return;
  if(starting)return starting;
  starting=(async()=>{
   const {dir,exe}=await engineFile();
   callbackServer=await listenForCallbacks();
   const callbackPort=callbackServer.address().port;
   enginePort=enginePort||41646;
   child=spawnImpl(exe,['-p='+enginePort,'-e=DX','-c=4','-mb=2048'],{cwd:dir,windowsHide:true,stdio:'ignore'});
   child.on('exit',()=>{child=null;});
   const deadline=Date.now()+15000;
   let last;
   while(Date.now()<deadline){
    try{
     last=await exchange(enginePort,message(ENDPOINT.system,OP.addClient,{app:{pid:process.pid,host:'127.0.0.1',port:callbackPort,key:'AV',name:'AssetVault'}}));
     if(last&&last.code!==undefined&&last.code!==0&&last.type==='error')throw Error(last.message||'Substance 引擎拒绝连接');
     return;
    }catch(e){last=e;await new Promise(r=>setTimeout(r,300));}
   }
   throw Error(last?.message||'Substance 引擎没有启动');
  })();
  try{await starting;}finally{starting=null;}
 }
 let renderChain=Promise.resolve();
 async function render(uuid,graph){
  const job=renderChain.then(()=>renderNow(uuid,graph));
  renderChain=job.catch(()=>{});
  return job;
 }
 async function renderNow(uuid,graph){
  const outDir=session.outDir;
  await fs.mkdir(outDir,{recursive:true});
  const stale=await fs.readdir(outDir).catch(()=>[]);
  await Promise.all(stale.filter(name=>/\.(png|jpe?g)$/i.test(name)).map(name=>fs.unlink(path.join(outDir,name)).catch(()=>{})));
  let callbackTimer;
  let callbackDone=false;
  const callback=new Promise(resolve=>{
   callbackTimer=setTimeout(()=>resolve(false),60000);
   callbackServer.once('callback',()=>{callbackDone=true;clearTimeout(callbackTimer);resolve(true);});
  });
  await exchange(enginePort,message(ENDPOINT.substance,OP.render,{
   app:{pid:process.pid,host:'127.0.0.1',port:callbackServer.address().port},
   substance:{uuid,graph_idx:graph.index??0},
   render:{path:outDir,outputs:outputList(graph)},
  },2),{timeout:60000}).catch(()=>{});
  const started=Date.now();
  let lastSize=-1;
  while(Date.now()-started<60000){
   const signaled=callbackDone||await Promise.race([callback,new Promise(resolve=>setTimeout(()=>resolve(false),250))]);
   const maps=await mapsIn(outDir);
   if(maps.basecolor){
    const size=await fs.stat(path.join(outDir,maps.basecolor)).then(s=>s.size).catch(()=>0);
    if(signaled&&size>0){clearTimeout(callbackTimer);return maps;}
    if(size>0&&size===lastSize){clearTimeout(callbackTimer);return maps;}
    lastSize=size;
   }
  }
  clearTimeout(callbackTimer);
  const maps=await mapsIn(outDir);
  if(!maps.basecolor)throw Error('引擎把材质放进了渲染队列，但没有写出底色贴图');
  return maps;
 }
 return {
  async status(){
   try{const {dir}=await engineFile();return {available:true,dir};}
   catch(e){return {available:false,error:e.message};}
  },
  async open(file){
   await ensure();
   const sbsar=await findSbsar(file);
   const loaded=await exchange(enginePort,message(ENDPOINT.substance,OP.load,{
    app:{pid:process.pid},
    substance:{name:path.basename(sbsar),file:sbsar,'$outputsize':OUTPUT_SIZE,normal_format:1},
   }));
   if(loaded?.code&&loaded.code!==0)throw Error(loaded.message||'加载 SBSAR 失败');
   const {uuid,graphs}=graphsFrom(loaded);
   const graph=graphs[0];
   if(!uuid||!graph)throw Error('引擎没有返回这张 SBSAR 的参数');
   const outDir=await fs.mkdtemp(path.join(tmpdir(),'sbsar-preview-'));
   session={uuid,graph,outDir,file:sbsar};
   const images=await render(uuid,graph);
   return {uuid,file:sbsar,inputs:previewInputs(graph),images};
  },
  async setInput(input){
   if(!session)throw Error('还没有打开 SBSAR');
   const value=input?.value;
   const updated=await exchange(enginePort,message(ENDPOINT.substance,OP.update,{
    app:{pid:process.pid},
    substance:{uuid:session.uuid,graph_idx:0},
    input:{id:Number(input.id),identifier:String(input.identifier||''),type:String(input.type||''),value},
   }));
   if(updated?.code&&updated.code!==0)throw Error(updated.message||'更新参数失败');
   const images=await render(session.uuid,session.graph);
   return {images};
  },
  async readImage(name){
   if(!session)throw Error('还没有打开 SBSAR');
   const base=path.basename(String(name||''));
   if(!base||base!==name||!/\.(png|jpe?g)$/i.test(base))throw Error('贴图名称无效');
   const full=path.join(session.outDir,base);
   return {data:await fs.readFile(full),name:base};
  },
  async stop(){
   if(callbackServer)callbackServer.close();
   callbackServer=null;
   if(child)child.kill();
   child=null;
  },
 };
}
