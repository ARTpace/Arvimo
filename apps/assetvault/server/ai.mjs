import fs from 'node:fs/promises';
import path from 'node:path';
import {createSearchTranslator} from './ai-search.mjs';

const defaults={enabled:true,baseUrl:'http://127.0.0.1:31415/v1',model:'auto',embedModel:'',visionModel:'',apiKey:'',models:[],roles:{text:'',translate:'',vision:'',embed:''}};
/* 功能 → 模型 的四条固定泳道。translate / vision 留空时沿用对话模型，
   embed 留空则表示「语义检索没配」，不会退回对话模型（维度对不上）。 */
const ROLE_KEYS=Object.freeze(['text','translate','vision','embed']);
/* 视觉自检用的 1×1 PNG：只为验证「这个模型收不收图片输入」，不关心内容。 */
const PROBE_PIXEL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const cleanText=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
/** 接口地址校验：只允许 http(s)，远程必须 https，且不能塞凭证 / 查询串 / 片段。 */
function normalizeEndpoint(value,fallback){
 const raw=String(value||'').trim()||String(fallback||'').trim();
 if(!raw)return '';
 let url;try{url=new URL(raw);}catch{throw Error('请输入有效的 AI 接口地址');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('接口地址仅支持 HTTP / HTTPS，不能包含凭证、查询或片段');
 if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('远程 AI 接口请使用 HTTPS');
 if(raw.length>2048)throw Error('接口地址过长');
 return url.href.replace(/\/+$/,'');
}
/** 模型库：每条形如 {id,name,baseUrl,apiKey}，baseUrl 留空表示沿用默认接口。 */
function normalizeModels(input,current){
 if(input===undefined)return (current.models||[]).map(item=>({...item}));
 if(!Array.isArray(input))throw Error('模型列表格式无效');
 if(input.length>60)throw Error('模型数量过多，请精简到 60 个以内');
 const previous=new Map((current.models||[]).map(item=>[item.id,item]));
 const seen=new Set(),out=[];
 for(const raw of input){
  if(!raw||typeof raw!=='object')continue;
  const name=cleanText(raw.name,200);
  if(!name)throw Error('模型名称不能为空');
  const id=cleanText(raw.id,64)||name;
  if(seen.has(id))continue;
  seen.add(id);
  const baseUrl=normalizeEndpoint(raw.baseUrl,'');
  // 密钥以「没传就保留」为准：前端只在用户真的输入新 key 时才带上这个字段。
  let apiKey='';
  if(typeof raw.apiKey==='string'&&raw.apiKey.trim())apiKey=raw.apiKey.trim();
  else if(raw.clearKey!==true)apiKey=previous.get(id)?.apiKey||'';
  if(apiKey.length>4096||/[\r\n]/.test(apiKey))throw Error('密钥格式无效');
  out.push({id,name,baseUrl,apiKey});
 }
 return out;
}
function normalizeRoles(input,current,fallbackText){
 const next=input&&typeof input==='object'&&!Array.isArray(input)?input:null;
 const roles={};
 for(const key of ROLE_KEYS){
  const value=next?cleanText(next[key],200):cleanText((current.roles||{})[key],200);
  if(/[\r\n]/.test(value))throw Error('模型名称无效');
  roles[key]=value;
 }
 // 老客户端只发 model 字段：把它当作「对话模型」的赋值，避免两套语义打架。
 if(!next&&fallbackText)roles.text=fallbackText;
 return roles;
}
function normalize(input,current){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('AI 设置格式无效');
 const next={...current,...input};
 const baseUrl=normalizeEndpoint(next.baseUrl,defaults.baseUrl);
 const model=cleanText(next.model,200)||'auto';
 if(!model)throw Error('请填写有效的接口地址和模型名称');
 const apiKey=input.clearKey?'':typeof input.apiKey==='string'&&input.apiKey.trim()?input.apiKey.trim():current.apiKey;
 if(apiKey.length>4096||/[\r\n]/.test(apiKey))throw Error('密钥格式无效');
 // 向量模型是可选的：没填就意味着「语义搜索未启用」，而不是配置错误。
 // 它刻意与对话模型分开 —— 做图搜的那类服务里，两者几乎从不相同。
 const embedModel=cleanText(next.embedModel,200);
 if(/[\r\n]/.test(embedModel))throw Error('向量模型名称无效');
 const visionModel=cleanText(next.visionModel,200);
 if(/[\r\n]/.test(visionModel))throw Error('视觉模型名称无效');
 const models=normalizeModels(input.models,current);
 const roles=normalizeRoles(input.roles,current,cleanText(input.model,200));
 /* AI 常开（2026-11-18 反馈「AI 默认就是开启的 不用加开关」）：
    开关已经从前端拿掉，老配置里残留的 enabled:false 也不再让功能整条链路哑掉。 */
 return {enabled:true,baseUrl,model,apiKey,embedModel,visionModel,models,roles};
}
/** 角色 → 实际请求目标（模型名 + 该模型自己的接口与密钥，缺省回落默认接口）。 */
function resolveModel(config,role){
 const roles=config.roles||{};
 const fallback=role==='embed'?config.embedModel||'':role==='vision'?config.visionModel||config.model:config.model;
 const name=cleanText(roles[role],200)||fallback;
 if(!name)return null;
 const entry=(config.models||[]).find(item=>item.id===name||item.name===name);
 return {model:entry?entry.name:name,baseUrl:(entry&&entry.baseUrl)||config.baseUrl,apiKey:(entry&&entry.apiKey)||config.apiKey};
}
/** 老配置升级：只有 model / visionModel / embedModel 三格时，把它们折进模型库与角色表。 */
function migrate(config){
 const roles=config.roles||{};
 if((config.models||[]).length||ROLE_KEYS.some(key=>roles[key]))return config;
 const names=[config.model,config.visionModel,config.embedModel].filter(Boolean).filter(name=>name!=='auto');
 const models=[];
 for(const name of names)if(!models.some(item=>item.name===name))models.push({id:name,name,baseUrl:'',apiKey:''});
 const next={...roles,text:config.model||'auto'};
 if(config.visionModel)next.vision=config.visionModel;
 if(config.embedModel)next.embed=config.embedModel;
 return {...config,models,roles:next};
}

export function createAIService({file,fetchImpl=fetch,timeoutMs=30000}){
 let pending=Promise.resolve();
 async function read(){
  try{return migrate(normalize(JSON.parse(await fs.readFile(file,'utf8')),defaults));}
  catch(error){if(error.code==='ENOENT')return {...defaults,models:[],roles:{...defaults.roles}};throw Error('AI 配置读取失败，请检查本地配置文件');}
 }
 const publicConfig=config=>{
  const nameOf=role=>resolveModel(config,role)?.model||'';
  return {enabled:config.enabled,baseUrl:config.baseUrl,hasKey:!!config.apiKey,
   model:nameOf('text'),visionModel:nameOf('vision'),embedModel:nameOf('embed'),
   roles:{...(config.roles||{})},
   models:(config.models||[]).map(item=>({id:item.id,name:item.name,baseUrl:item.baseUrl||'',hasKey:!!item.apiKey}))};
 };
 async function configure(input){
  const operation=pending.then(async()=>{
   const config=normalize(input,await read());
   const temp=file+'.tmp';
   try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(temp,JSON.stringify(config,null,2),{mode:0o600});await fs.rename(temp,file);}
   catch{throw Error('AI 设置保存失败，请检查本地目录权限');}
   translator.clear();return publicConfig(config);
  });
  pending=operation.catch(()=>{});return operation;
 }
 async function request(target,pathname,payload,signal,waitMs=timeoutMs,maxBytes=1024*1024){
  const headers={'Content-Type':'application/json'};
  if(target.apiKey)headers.Authorization=`Bearer ${target.apiKey}`;
  let response;
  try{response=await fetchImpl(`${target.baseUrl}/${pathname}`,{method:payload?'POST':'GET',headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(waitMs)]):AbortSignal.timeout(waitMs),...(payload?{body:JSON.stringify(payload)}:{})});}
  catch{throw Error('AI 请求失败或超时，请检查地址与服务状态');}
  if(!response.ok){
   // 只解释已知错误标记，不向前端透传上游原文或密钥。
   let diagnostic='';
   try{const reader=response.body?.getReader();let bytes=0;while(reader){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>16384){await reader.cancel();break;}diagnostic+=new TextDecoder().decode(value);}}catch{}
   if(/lacks vision|does not support (?:image|vision)|image input.*not supported/i.test(diagnostic))throw Error('当前模型不支持图片输入，请在 AI 接入中设置视觉模型（此本地网关可使用 auto）');
   if(response.status===429)throw Error('AI 接口限流或可用线路耗尽，请稍后重试或更换视觉模型');
   throw Error(`AI 接口返回 HTTP ${response.status}，请检查密钥、模型和服务状态`);
  }
  const chunks=[];let bytes=0;
  try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw Error();chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Error('AI 返回内容无效或过大');}
 }
 async function complete(messages,{signal,maxTokens=512,timeoutMs:waitMs,role='text'}={}){
  const config=await read();
  if(!config.enabled)throw Error('请先在 AI 接入中启用并保存设置');
  const wantsImage=messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
  const target=resolveModel(config,wantsImage?'vision':role)||resolveModel(config,'text');
  if(!target)throw Error('请先在 AI 接入里添加一个模型');
  const data=await request(target,'chat/completions',{model:target.model,messages,stream:false,max_tokens:maxTokens},signal,waitMs);
  const text=data.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw Error('AI 没有返回有效文本，请检查模型是否支持文本对话');
  return {text,model:typeof data.model==='string'?data.model:target.model};
 }
 // 翻译、扩写走「搜索翻译」这条泳道；没单独指派时 resolveModel 会落回对话模型。
 const translator=createSearchTranslator({settings:async()=>publicConfig(await read()),complete:(messages,options)=>complete(messages,{...options,role:'translate'})});
 /**
  * 向量化（OpenAI 兼容 /embeddings）。
  *
  * 响应体积必须单独放宽：32 条 × 1024 维的 JSON 就有 600KB 上下，用对话那套 1MB 上限
  * 迟早会「批量一调就报内容无效」。这里给 8MB，并只接受 float 数组。
  * index 字段按位置排序：兼容实现里普遍带它，但不带时必须仍能对上顺序。
  */
 async function embed(texts,{signal}={}){
  const config=await read();
  if(!config.enabled)throw Error('请先在 AI 接入中启用并保存设置');
  const target=resolveModel(config,'embed');
  if(!target)throw Error('请先在 AI 接入里为「语义检索」指定向量模型，例如 text-embedding-3-small');
  const inputs=(Array.isArray(texts)?texts:[]).map(text=>String(text||'').slice(0,4000)).filter(Boolean);
  if(!inputs.length)return [];
  let data;
  try{
   data=await request(target,'embeddings',{model:target.model,input:inputs,encoding_format:'float'},signal,90000,8*1024*1024);
  }catch(error){
   /* 404 基本只有一个原因：这个模型不是向量模型（对话接口没有 /embeddings）。
      直说，别让前端把它翻成「内容可能已删除」。 */
   if(/HTTP 404/.test(error.message))throw Error(`这个接口没有 /embeddings 端点：「${target.model}」多半不是向量模型，请在接口里加上 text-embedding-3-small / bge-m3 / embedding-v3 这类模型再选它`);
   throw error;
  }
  const list=Array.isArray(data.data)?data.data:[];
  if(list.length!==inputs.length)throw Error(`向量接口返回条数不符（期望 ${inputs.length}，实际 ${list.length}）`);
  const ordered=[...list].sort((a,b)=>(Number(a?.index)||0)-(Number(b?.index)||0));
  return ordered.map(item=>{
   const vec=item?.embedding;
   if(!Array.isArray(vec)||!vec.length||!vec.every(value=>Number.isFinite(value)))throw Error('向量接口返回了无效的向量');
   return Float32Array.from(vec);
  });
 }
 return {
  translate:query=>translator.translate(query),
  translateSearch:query=>translator.translateSearch(query),
  expand:query=>translator.expand(query),
  parseLocal:query=>translator.parseLocal(query),
  visionSearch:input=>translator.visionSearch(input),
  brainstorm:theme=>translator.brainstorm(theme),
  tagAssets:arg=>translator.tagAssets(arg),
  settings:async()=>publicConfig(await read()),key:async()=>({apiKey:(await read()).apiKey}),configure,complete,embed,
  models:async(input,signal)=>{
   const config=normalize(input,await read());
   const data=await request(config,'models',null,signal);
   if(!Array.isArray(data.data))throw Error('接口没有返回有效的模型列表');
   return {models:data.data.map(item=>item?.id).filter(id=>typeof id==='string'&&id.length<=200).slice(0,500)};
  },
  /**
   * 添加模型时的两个探针：只拿「用户刚填的地址 + 密钥」去问一句，不写任何配置。
   * 这样「测试连接」不会把用户正在编辑的东西顺手存进去。
   */
  probeModels:async(input,signal)=>{
   const endpoint=await probeEndpoint(input);
   const data=await request(endpoint,'models',null,signal);
   if(!Array.isArray(data.data))throw Error('接口没有返回有效的模型列表');
   return {models:data.data.map(item=>item?.id).filter(id=>typeof id==='string'&&id.length<=200).slice(0,500)};
  },
  probeChat:async(input,signal)=>{
   const endpoint=await probeEndpoint(input);
   const model=cleanText(input?.model,200)||'auto';
   const data=await request(endpoint,'chat/completions',{model,messages:[{role:'user',content:'Reply with OK only.'}],stream:false,max_tokens:16},signal,30000);
   const text=data.choices?.[0]?.message?.content;
   if(typeof text!=='string')throw Error('模型没有返回内容，请检查模型名称是否可用');
   return {ok:true,model:typeof data.model==='string'?data.model:model};
  },
  /**
   * 按功能自检：每个角色真发一次最小请求，验证的是「这个角色能干活」而不只是端口通。
   * 视觉带一张 1×1 图试图片输入；被拒时降级成纯文本再验一次，并在 note 里说明。
   */
  test:async(role,signal)=>{
   const lane=ROLE_KEYS.includes(role)?role:'text';
   if(lane==='embed'){
    const vectors=await embed(['AssetVault semantic probe'],{signal});
    const vector=vectors[0];
    if(!vector||!vector.length)throw Error('向量模型没有返回有效向量');
    return {ok:true,role:lane,dimension:vector.length,model:resolveModel(await read(),'embed')?.model||''};
   }
   if(lane==='vision'){
    try{
     const result=await complete([{role:'user',content:[{type:'text',text:'Reply with OK only.'},{type:'image_url',image_url:{url:PROBE_PIXEL}}]}],{signal,maxTokens:32,role:'vision'});
     return {ok:true,role:lane,model:result.model};
    }catch(error){
     const fallback=await complete([{role:'user',content:'Reply with OK only.'}],{signal,maxTokens:32,role:'vision'});
     return {ok:true,role:lane,model:fallback.model,note:`文本可用，测试图被拒绝：${error.message}`};
    }
   }
   const prompt=lane==='translate'?'把 cat 翻译成中文，只回答译文。':'Reply with OK only.';
   const result=await complete([{role:'user',content:prompt}],{signal,maxTokens:32,role:lane});
   return {ok:true,role:lane,model:result.model};
  },
 };
 /** 探针用的临时目标：地址必须合法；密钥优先用这次输入的，其次借用该模型已存的（编辑时不重复粘贴）。 */
 async function probeEndpoint(input){
  const baseUrl=normalizeEndpoint(input?.baseUrl,defaults.baseUrl);
  let apiKey=typeof input?.apiKey==='string'?input.apiKey.trim():'';
  if(!apiKey&&input?.modelId){const config=await read();apiKey=(config.models||[]).find(item=>item.id===input.modelId)?.apiKey||'';}
  if(apiKey.length>4096||/[\r\n]/.test(apiKey))throw Error('密钥格式无效');
  return {baseUrl,apiKey};
 }
}
