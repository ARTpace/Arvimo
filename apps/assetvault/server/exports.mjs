// HTTP surface for the multi-target "send to" feature.
//
// Three endpoints, all local-only (the workbench UI always sends X-SFX-Local: 1):
//  - GET  /api/exports/targets     → list of targets with their configured path + a `configured` flag
//  - POST /api/exports/configure    → {targetId, path}  save (or clear, when path is empty) a target path
//  - POST /api/exports/send         → {targetId, jobId} deliver a saved job to that target
//
// Delivery itself lives in export-targets.mjs so the registry, config and copy logic stay in one
// place and can be reused (or unit-tested) without the HTTP layer.
import {targetsWithStatus,loadConfig,saveConfig,deliverToTarget} from './export-targets.mjs';
import {installDcc} from './dcc-import.mjs';
import {chineseError} from '../src/library/error-message.js';

function json(res,status,obj){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(obj,(key,value)=>key==='error'&&typeof value==='string'?chineseError(value,{fallback:true}):value));
}

async function readBody(req){
  const chunks=[];
  for await (const c of req)chunks.push(c);
  const s=Buffer.concat(chunks).toString('utf8');
  try{return s?JSON.parse(s):{};}catch{return {};}
}

export function createExports({downloads,dataDir}){
  /** Returns true if it wrote a response (and the caller should stop routing). */
  return {
    async handle(req,res,u){
      if(!u.pathname.startsWith('/api/exports'))return false;
      if(req.headers['x-sfx-local']!=='1'){json(res,403,{error:'缺少本地请求标识'});return true;}
      if(req.method==='GET'&&u.pathname==='/api/exports/targets'){
        json(res,200,await targetsWithStatus(dataDir,{refresh:u.searchParams.get('refresh')==='1'}));return true;
      }
      if(req.method==='POST'){
        // 访客没有主机磁盘写权限，绝不能让它把文件复制到主机的 Unity / 引擎工程，或改主机配置。
        if(req.lanVisitor)return (json(res,403,{error:'访客不能配置或发送导出目标'}),true);
        const input=await readBody(req);
        if(u.pathname==='/api/exports/install'){
          if(input.progress===true){
            res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});
            const emit=value=>res.write(JSON.stringify(value)+'\n');
            try{emit({result:await installDcc(dataDir,input.targetId,{onProgress:emit})});}
            catch(error){emit({error:chineseError(error.message,{fallback:true})});}
            res.end();return true;
          }
          try{json(res,200,await installDcc(dataDir,input.targetId));}
          catch(error){json(res,400,{error:error.message});}
          return true;
        }
        if(u.pathname==='/api/exports/configure'){
          if(!input.targetId)return (json(res,400,{error:'缺少 targetId'}),true);
          const map=await loadConfig(dataDir);
          if(input.path&&String(input.path).trim())map[input.targetId]={path:String(input.path).trim()};
          else delete map[input.targetId];
          await saveConfig(dataDir,map);
          json(res,200,await targetsWithStatus(dataDir));return true;
        }
        if(u.pathname==='/api/exports/send'){
          if(!input.targetId||!input.jobId)return (json(res,400,{error:'缺少 targetId 或 jobId'}),true);
          try{
            const result=await deliverToTarget({targetId:input.targetId,jobId:input.jobId,downloads,dataDir});
            json(res,200,result);return true;
          }catch(e){json(res,400,{error:e.message});return true;}
        }
      }
      json(res,404,{error:'导出接口不存在'});return true;
    }
  };
}
