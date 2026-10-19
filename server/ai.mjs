import fs from 'node:fs/promises';
import path from 'node:path';
import {createSearchTranslator} from './ai-search.mjs';

const defaults={enabled:false,baseUrl:'http://127.0.0.1:31415/v1',model:'auto',apiKey:''};
function normalize(input,current){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('AI 设置格式无效');
 const next={...current,...input};
 let url;try{url=new URL(String(next.baseUrl).trim());}catch{throw Error('请输入有效的 AI 接口地址');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('接口地址仅支持 HTTP / HTTPS，不能包含凭证、查询或片段');
 if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('远程 AI 接口请使用 HTTPS');
 const baseUrl=url.href.replace(/\/+$/,'');
 const model=String(next.model||'').trim();
 if(baseUrl.length>2048||!model||model.length>200)throw Error('请填写有效的接口地址和模型名称');
 const apiKey=input.clearKey?'':typeof input.apiKey==='string'&&input.apiKey.trim()?input.apiKey.trim():current.apiKey;
 if(apiKey.length>4096||/[\r\n]/.test(apiKey))throw Error('密钥格式无效');
 return {enabled:next.enabled===true,baseUrl,model,apiKey};
}

export function createAIService({file,fetchImpl=fetch,timeoutMs=30000}){
 let pending=Promise.resolve();
 async function read(){
  try{return normalize(JSON.parse(await fs.readFile(file,'utf8')),defaults);}
  catch(error){if(error.code==='ENOENT')return {...defaults};throw Error('AI 配置读取失败，请检查本地配置文件');}
 }
 const publicConfig=config=>({enabled:config.enabled,baseUrl:config.baseUrl,model:config.model,hasKey:!!config.apiKey});
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
 async function request(config,endpoint,payload,signal){
  const headers={'Content-Type':'application/json'};
  if(config.apiKey)headers.Authorization=`Bearer ${config.apiKey}`;
  let response;
  try{response=await fetchImpl(`${config.baseUrl}/${endpoint}`,{method:payload?'POST':'GET',headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),...(payload?{body:JSON.stringify(payload)}:{})});}
  catch{throw Error('AI 请求失败或超时，请检查地址与服务状态');}
  if(!response.ok){await response.body?.cancel();throw Error(`AI 接口返回 HTTP ${response.status}，请检查密钥、模型和服务状态`);}
  const chunks=[];let bytes=0;
  try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw Error();chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Error('AI 返回内容无效或过大');}
 }
 async function complete(messages,{signal,maxTokens=512}={}){
  const config=await read();
  if(!config.enabled)throw Error('请先在 AI 接入中启用并保存设置');
  const data=await request(config,'chat/completions',{model:config.model,messages,stream:false,max_tokens:maxTokens},signal);
  const text=data.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw Error('AI 没有返回有效文本，请检查模型是否支持文本对话');
  return {text,model:typeof data.model==='string'?data.model:config.model};
 }
 const translator=createSearchTranslator({settings:async()=>publicConfig(await read()),complete});
 return {
  translate:query=>translator.translate(query),
  settings:async()=>publicConfig(await read()),configure,complete,
  models:async(input,signal)=>{
   const config=normalize(input,await read());
   const data=await request(config,'models',null,signal);
   if(!Array.isArray(data.data))throw Error('接口没有返回有效的模型列表');
   return {models:data.data.map(item=>item?.id).filter(id=>typeof id==='string'&&id.length<=200).slice(0,500)};
  },
  test:async(signal)=>{const result=await complete([{role:'user',content:'Reply with OK only.'}],{signal,maxTokens:32});return {ok:true,model:result.model};},
 };
}
