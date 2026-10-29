// Polyfork 参数的 C 层中文化：让模型翻一遍，落盘复用。
//
// 为什么不做成构建期全量跑批：资产有几百个，全跑一遍又慢又贵，而用户一次只开一个预览。
// 所以改成「谁被打开，谁才翻」，翻完永久存盘；下次开同一个资产是纯读文件，零 token。
// 前端本来就是异步拿这份字典、就地替换文字，所以慢几秒也不挡首屏（B 层规则词表已经先渲染了）。
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION=1;
const MAX_LABEL=12;      // 参数名最多 12 个汉字
const MAX_VALUE=10;      // 配色方案 / 选项名最多 10 个
const MAX_DESCRIBE=30;   // 一句话说明最多 30 个（这一项现在不由模型产出，留着是为了按旧格式兼容）

/** 只允许打头的字母数字和中间的 . _ -，防止 id 被当成路径穿越。 */
function safeId(assetId){
 return String(assetId??'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'').replace(/^\.+/,'').slice(0,120);
}

/** 模型返回的 JSON 常常裹一层 ```json 围栏，或者前面寒暄一句。 */
export function parseLooseJson(text){
 const raw=String(text??'').trim();
 if(!raw)return null;
 const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
 const body=fenced?fenced[1]:raw;
 const start=body.indexOf('{'),end=body.lastIndexOf('}');
 if(start<0||end<=start)return null;
 try{return JSON.parse(body.slice(start,end+1));}catch{return null;}
}

const clip=(text,limit)=>String(text??'').replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);

/**
 * 白名单校验：只保留 schema 里真实存在的键，值和长度都夹住。
 * 模型编出来的多余键、把 hex 当 label 塞回来、写一段英文解释，全在这里丢掉 —— 前端拿到什么都能直接塞进 DOM。
 */
export function normalizeZh(raw,schema){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const params=Array.isArray(schema?.params)?schema.params:[];
 const keys=new Set(params.map(param=>String(param.key)));
 const values=new Set();
 for(const param of params){
  for(const option of param.options||[])values.add(String(option));
 }
 for(const name of Object.keys(schema?.presets||{}))values.add(name);
 const pick=(source,allowed,limit)=>{
  const out={};
  if(!source||typeof source!=='object'||Array.isArray(source))return out;
  for(const [key,value] of Object.entries(source)){
   if(!allowed.has(key)||typeof value!=='string')continue;
   const text=clip(value,limit);
   if(text)out[key]=text;
  }
  return out;
 };
 const labels=pick(raw.labels,keys,MAX_LABEL);
 const translated=pick(raw.values,values,MAX_VALUE);
 const describes=pick(raw.describes,keys,MAX_DESCRIBE);
 if(!Object.keys(labels).length&&!Object.keys(translated).length&&!Object.keys(describes).length)return null;
 return {labels,values:translated,describes};
}

/**
 * 把 schema 压成给模型的输入。**只给 label 和取值，不给 describe** ——
 * 那些 describe 是整段英文说明（每个一两百词），喂进去会让本地网关 60 秒后 502，
 * 而面板上真正要中文化的只有名字和配色选项。describe 留着原文当悬浮提示，信息不丢。
 */
export function buildPrompt(schema,{name=''}={}){
 const params=Array.isArray(schema?.params)?schema.params:[];
 const labels={};
 const values=new Set();
 for(const param of params){
  const key=String(param.key);
  if(param.label)labels[key]=clip(param.label,60);
  for(const option of param.options||[])values.add(String(option));
 }
 for(const presetName of Object.keys(schema?.presets||{}))values.add(presetName);
 const input={labels,values:[...values]};
 const subject=clip(name,40);
 return [
  {role:'system',content:'你是 3D 美术工具的本地化译者，输出严格 JSON，不说多余的话。'},
  {role:'user',content:[
   subject?`资产名：${subject}。先按这个资产的实际对象理解参数，别按字面猜。`:'',
   '把这个程序化 3D 低模的参数名和选项值翻成简体中文。',
   'labels：参数名，≤12 个汉字，用建模/美术同行会说的词。',
   '示例：cap pitch → 顶盖坡度；sail span → 风帆跨度（风车上的帆，不是船帆）；wall batter → 墙面收分。',
   'values：配色方案名或选项值，≤10 个汉字（cream-stone → 奶油色石材）；纯数字、纯编号原样保留。',
   '只输出 JSON：{"labels":{...},"values":{...}}，键必须与输入完全一致，不要输出别的字段。',
   JSON.stringify(input),
  ].filter(Boolean).join('\n')},
 ];
}

export function createPolyforkZh({dir,complete,log=()=>{}}={}){
 const pending=new Map();   // 同一资产并发打开时只翻一次
 const failing=new Map();   // 翻失败记 5 分钟，别每次开预览都再撞一遍墙

 const file=id=>path.join(dir,`${safeId(id)}.json`);

 async function read(id){
  try{
   const data=JSON.parse(await fs.readFile(file(id),'utf8'));
   if(data?.v!==VERSION||!data.zh)return null;
   return data.zh;
  }catch{return null;}
 }

 async function write(id,zh,schema){
  await fs.mkdir(dir,{recursive:true});
  const temp=`${file(id)}.tmp`;
  await fs.writeFile(temp,JSON.stringify({v:VERSION,at:Date.now(),model:schema?.name||'',zh}),'utf8');
  await fs.rename(temp,file(id));
 }

 async function translate(id,schema,signal,name){
  if(typeof complete!=='function')return null;
  // 90 秒：本地网关的推理模型写十个中文短句要几十秒，默认的 30 秒会被砍在半路。
  const result=await complete(buildPrompt(schema,{name}),{signal,maxTokens:1600,timeoutMs:90000});
  const zh=normalizeZh(parseLooseJson(result.text),schema);
  if(!zh)throw Error('模型返回的参数译名无法解析');
  return zh;
 }

 return {
  /**
   * 拿某个资产的中文字典。命中磁盘就返回；没有就翻一次并落盘。
   * 翻不动（未配置 AI / 超时 / 返回不合规）一律返回 null，让前端留在 B 层结果上 —— 中文化是锦上添花，不能挡住参数面板。
   */
  async get(assetId,schema,{signal,name=''}={}){
   const id=safeId(assetId);
   if(!id||!schema?.params?.length)return {zh:null,source:'none'};
   const cached=await read(id);
   if(cached)return {zh:cached,source:'cache'};
   const failedAt=failing.get(id);
   if(failedAt&&Date.now()-failedAt<5*60*1000)return {zh:null,source:'none'};
   let task=pending.get(id);
   if(!task){
    task=translate(id,schema,signal,name)
     .then(async zh=>{failing.delete(id);await write(id,zh,schema).catch(()=>{});return zh;})
     .catch(error=>{failing.set(id,Date.now());log(`polyfork-zh ${id}: ${error.message}`);return null;})
     .finally(()=>pending.delete(id));
    pending.set(id,task);
   }
   const zh=await task;
   return {zh,source:zh?'ai':'none'};
  },
  file:safeId,
 };
}
