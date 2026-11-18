import {loadLibrary,saveLibrary,collectModels} from './library-state.js';
import {diffMainState,mutationPayloadSize,MAX_MUTATION_BYTES,MAIN_STATE_KEY} from './state-mutations.js';
import {translateStateChange,PROBE_STATE_KEY} from './tag-ops.js';
import {applyLocalFileMoves} from './local-file-moves.js';
const keys=['sfx-library-v2','sfx-discovery-v1','sfx-library-ui','sfx-local-index-v1'];
const parse=value=>{try{const data=JSON.parse(value);return data&&typeof data==='object'&&!Array.isArray(data)?data:null;}catch{return null;}};

/**
 * 前端持久化层（阶段 4：自动差量写入）。
 *
 * app.js 只调用标准的 getItem/setItem，所以「一次评分只发几十字节」这件事完全在本文件完成，
 * 业务代码零改动。每次 setItem 把新 blob 与上一次已提交状态做键级 diff：
 *   - 只有评分/标签/收藏/历史等白名单字段变化 → POST /api/library/mutations（几十字节）；
 *   - models/trashed 变化（导入、删除、恢复）、未知字段变化、或差量过大 → 退回整块 POST；
 *   - 服务端是老进程（404）或任何一步失败 → 关掉差量通道并用整块请求重放，绝不丢数据。
 * 附带变更的其它 key（搜索现场、UI 偏好）按体积分流：小的塞进差量请求，大的单独整块提交，
 * 两条请求都在同一个串行队列里依次发出，不会互相覆盖。
 */
export async function createPersistentStorage(local,request=fetch,options={}){
 // ADR-09：新服务端返回瘦身读视图（models 交给 /catalog/page 按页取）；
 // 老服务端忽略该参数、照旧返回全量目录且不带 catalogPaged，前端自动走原路径。
 // 显式开启：页面传 {catalogPaged:true}，纯逻辑测试不传就走原路径（老服务端也自动降级）。
 const response=await request(options.catalogPaged===true?'/api/library-state?catalog=paged':'/api/library-state',{headers:{'X-SFX-Local':'1'}});
 if(!response.ok)throw Error('无法读取持久资产库，请检查本地服务');
 const {values={},recovered=[],scanIndex=false,catalogPaged=false,catalogTotal=0}=await response.json();
 const cache={};
 for(const key of keys)cache[key]=values[key]??local?.getItem(key)??null;
 let pending=Promise.resolve(),scheduled=false,mutationsEnabled=options.mutations!==false,collectionsEnabled=options.collections!==false,assetOpsEnabled=options.assetOps!==false;
 let lastParsed=parse(cache[MAIN_STATE_KEY]);
 const dirty=new Map();
 const fileMoves=new Map();
 const report=message=>{
  options.onWarn?.(message);
  if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function'&&typeof CustomEvent==='function')
   window.dispatchEvent(new CustomEvent('assetvault:storage-error',{detail:message}));
 };
 /**
  * ADR-09：启动目录按页取。第一页阻塞启动（保证 loadLibrary 有数据可画），其余页后台补，
  * 每补一页**同步**更新 cache 与 lastParsed —— 前端的 saveLibrary 仍写出完整目录，
  * 只有基准同步，translateStateChange 才不会把「尚未补齐」判成删除、误发 asset:remove。
  */
 const CATALOG_PAGE_SIZE=200;
 const catalogModels=[],catalogSeen=new Set(),delivered=new Set();
 let catalogHandler=null,catalogReady=Promise.resolve();
 function deliver(items){
  const fresh=(items||[]).filter(item=>item&&typeof item.uid==='string'&&!delivered.has(item.uid));
  if(!fresh.length)return;
  for(const item of fresh)delivered.add(item.uid);
  try{catalogHandler?.(fresh);}catch(error){report(`目录补页回调失败：${error.message}`);}
 }
 function acceptCatalogPage(items=[]){
  let added=0;
  for(const item of items){
   if(!item||typeof item.uid!=='string'||catalogSeen.has(item.uid))continue;
   const moved=fileMoves.get(item.uid);if(moved)applyLocalFileMoves([item],{root:moved.root,changes:[moved.change]});
   catalogSeen.add(item.uid);catalogModels.push(item);added++;
  }
  if(!added)return;
  const blob=parse(cache[MAIN_STATE_KEY])||{};
  blob.models=catalogModels.slice();
  cache[MAIN_STATE_KEY]=JSON.stringify(blob);
  lastParsed=parse(cache[MAIN_STATE_KEY]);
  deliver(items);
 }
 function setCatalogPageHandler(fn){
  catalogHandler=typeof fn==='function'?fn:null;
  // 全量重发已到的页：app.js 的 state 是在本函数返回后才建的，启动期到的页必须补给它。
  // handler 内部按 uid 去重，重复投递无害。
  if(catalogHandler&&catalogModels.length)try{catalogHandler(catalogModels.slice());}catch(error){report(`目录补页回调失败：${error.message}`);}
 }
 async function fetchCatalogPage(offset){
  const r=await request(`/api/library/catalog/page?offset=${offset}&limit=${CATALOG_PAGE_SIZE}`,{headers:{'X-SFX-Local':'1'}});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  const data=await r.json();
  if(!Array.isArray(data.items))throw Error('目录分页格式无效');
  return data;
 }
 /** 分页通道不可用（老服务端 / DB 故障）时整块重放：宁可多传一次，绝不白屏。 */
 async function replayFullCatalog(reason){
  const r=await request('/api/library-state',{headers:{'X-SFX-Local':'1'}});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  const full=await r.json();
  const raw=full.values?.[MAIN_STATE_KEY];
  if(typeof raw!=='string')throw Error('整块目录为空');
  catalogModels.length=0;catalogSeen.clear();delivered.clear();
  cache[MAIN_STATE_KEY]=raw;lastParsed=parse(raw);
  acceptCatalogPage(parse(raw)?.models||[]);
  report(`按页目录不可用，已整块重放：${reason}`);
 }
 if(catalogPaged){
  let first=null;
  try{first=await fetchCatalogPage(0);acceptCatalogPage(first.items);}
  catch(error){
   try{await replayFullCatalog(error.message);}catch(replayError){report(`按页目录与整块重放均失败：${replayError.message}`);}
   first={nextOffset:0,total:0};
  }
  const start=Number(first?.nextOffset)||0,total=Number(first?.total)||Number(catalogTotal)||0;
  catalogReady=start>0&&start<total?(async()=>{
   let offset=start,pages=0;
   try{
    while(offset<total&&pages<50){
     const data=await fetchCatalogPage(offset);
     acceptCatalogPage(data.items);
     if(!data.items.length||Number(data.nextOffset)<=offset)break;
     offset=Number(data.nextOffset);pages++;
     await new Promise(resolve=>setTimeout(resolve,0));
    }
   }catch(error){
    try{await replayFullCatalog(error.message);}catch(replayError){report(`目录补齐失败：${replayError.message}`);}
   }
  })():Promise.resolve();
 }
 let writeBlocked=null;
 const post=async(path,body)=>{
  if(writeBlocked)throw writeBlocked;
  const result=await request(path,{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json','X-AV-File-Protocol':'1'},body:JSON.stringify(body),keepalive:false});
  if(result.status===426||result.status===503){
   let detail;try{detail=await result.clone().json();}catch{}
   if(result.status===426||detail?.code==='write_protocol_unavailable'){
    writeBlocked=Object.assign(Error(detail?.error||'资产库写入协议已更新，请刷新或升级页面后再保存；本次未写入'),{noFallback:true});
    throw writeBlocked;
   }
  }
  return result;
 };
 /**
  * 定点写入按体积切批。单条 model 上限 512KB，一次带 200 条理论上能到 100MB，
  * 而服务端对请求体是有上限的 —— 撞上限会整批失败并退化成整块重放，等于白传几十 MB。
  * 启动补发下载资产（319KB/批起步）就是被这个坑卡在启动画面上的，别再让它发生。
  */
 function chunkOps(ops,budget=2*1024*1024,maxCount=64){
  const batches=[];let current=[],bytes=0;
  for(const op of ops){
   const size=JSON.stringify(op).length;
   if(current.length&&(bytes+size>budget||current.length>=maxCount)){batches.push(current);current=[];bytes=0;}
   current.push(op);bytes+=size;
  }
  if(current.length)batches.push(current);
  return batches;
 }
 async function saveError(result,label){
  let detail;try{detail=await result.json();}catch{}
  return Error(`${label}：${detail?.error||`HTTP ${result.status||'未知错误'}`}`);
 }
 async function postState(values){const result=await post('/api/library-state',values);if(!result.ok)throw await saveError(result,'资产库保存失败');}
 /** 细粒度通道：404/405 说明服务端是老进程，关掉通道后整块重放。 */
 async function postJson(path,body){
  const result=await post(path,body);
  if(result.status===404||result.status===405)collectionsEnabled=false;
  if(!result.ok)throw await saveError(result,`${path} 保存失败`);
  return result;
 }
 /**
  * 按域发包。顺序很重要：先定点写用户域，再写会话/探测/目录，最后才显式删除。
  * 全部排在同一个串行队列里，不会互相覆盖；任何一步失败由调用方整块重放。
  */
 async function postDomains(change,small,bulk,main){
  const domains=[];
  // 5.2：纯新增先发 asset:add，让资产在 DB 里存在，后面的 tag.add / asset.set
  // 才不会撞「资产不存在」。顺序不能反。
  let catalog=change.catalog;
  // 5.4：adds / trash / restore 合成一批 op 一次发，顺序天然是「先入库再移动」。
  // 翻译层把这些变化从 catalog 里摘掉了，通道一旦不可用必须改回完整主状态，
  // 否则后续一条请求都不发（5.2 踩过的坑，别再踩第三次）。
  const assetOps=[
   ...(change.adds||[]).map(model=>({op:'asset:add',uid:model.uid,model})),
   ...(change.trash||[]),...(change.restore||[]),
  ];
  if(assetOps.length){
   if(!assetOpsEnabled){if(main!==undefined)catalog=main;}
   else{
    let ok=false;
    try{
     // 分批发：一批撞上服务端体量上限就整批失败，分批后每批都能独立成立。
     // 只有全部批次都被接受才算成功；中途抛错（ok 保持 false）同样退回整块重放。
     let accepted=true;
     for(const batch of chunkOps(assetOps)){
      const result=await post('/api/library/assets/mutate',{ops:batch});
      if([404,405,409,503].includes(result.status))assetOpsEnabled=false;
      if(!result.ok){accepted=false;break;}
     }
     ok=accepted;
    }catch{assetOpsEnabled=false;}
    if(ok)domains.push('adds');
    else if(main!==undefined){catalog=main;domains.push('adds-fallback');}
   }
  }
  if(change.ops.length){await postJson('/api/library/tags/mutate',{ops:change.ops});domains.push('user');}
  if(Object.keys(change.session).length){await postJson('/api/library/session',change.session);domains.push('session');}
  if(change.probe!==null){await postState({[PROBE_STATE_KEY]:JSON.stringify(change.probe)});domains.push('probe');}
  if(change.removes.length){await postJson('/api/library/assets/remove',{uids:change.removes});domains.push('remove');}
  const stateValues={...(catalog?{[MAIN_STATE_KEY]:catalog}:{}),...small};
  if(Object.keys(stateValues).length)await postState(stateValues);
  if(Object.keys(bulk).length)await postState(bulk);
  return domains;
 }

 function scheduleSave(){
  if(scheduled)return;
  scheduled=true;
  pending=pending.then(async()=>{
   const values=Object.fromEntries(dirty);dirty.clear();
   const main=Object.hasOwn(values,MAIN_STATE_KEY)?values[MAIN_STATE_KEY]:undefined;
   const parsedMain=main!==undefined?parse(main):null;
   const diff=parsedMain&&mutationsEnabled?diffMainState(lastParsed,parsedMain):null;
   const small={},bulk={};
   for(const [key,value] of Object.entries(values)){
    if(key===MAIN_STATE_KEY)continue;
    (String(value).length>32*1024?bulk:small)[key]=value;
   }
   const smallBytes=mutationPayloadSize(small);
   const canDiff=diff&&!diff.unchanged&&mutationPayloadSize(diff.ops)+smallBytes<=MAX_MUTATION_BYTES;
   // 主 blob 没变但有其它的小 key：整块请求只带那些 key，服务端 merge 会原样保留主 blob 字符串。
   const onlyKeys=diff?.unchanged&&main!==undefined?Object.fromEntries(Object.entries(values).filter(([key])=>key!==MAIN_STATE_KEY)):null;
   // ADR-02：主 blob 的变化先翻译成「按域」的写入指令。看懂了就不回传整块 blob，
   // 看不懂（版本号 / 未知字段 / 脏数据 / 变更过多）才退回原来的整块或差量通道。
   // 解析不出来绝不能当成「没有变化」—— 那会把这次主状态写入整条吞掉。
   const change=parsedMain&&collectionsEnabled?translateStateChange(lastParsed,parsedMain):null;
   const useDomains=change&&!change.fallback;
   let incremental=false,applied=0,domains=null;
   try{
    if(useDomains){
     domains=await postDomains(change,small,bulk,main);
     incremental=true;applied=change.ops.length;
    }else if(canDiff){
     const result=await post('/api/library/mutations',{ops:diff.ops,values:small});
     if(result.status===404||result.status===405)mutationsEnabled=false;
     if(!result.ok)throw await saveError(result,'资产库增量保存失败');
     incremental=true;applied=diff.ops.length;
     // 大 key 单独整块提交：紧跟在同一次差量之后，都排在串行队列里，不会覆盖刚改的主 blob。
     if(Object.keys(bulk).length)await postState(bulk);
    }else if(onlyKeys&&!Object.keys(bulk).length){
     await postState(onlyKeys);
    }else{
     await postState(values);
    }
    if(main!==undefined)lastParsed=parsedMain;
    options.onCommit?.({incremental,applied,keys:Object.keys(values),domains});
   }catch(error){
    if(error.noFallback){report(error.message);return;}
    if(useDomains||canDiff){
     // 任一细粒度通道失败一律整块重放；同时永久关掉通道，避免每次输入都白撞一次老接口。
     collectionsEnabled=false;
     if(canDiff)mutationsEnabled=false;
     try{
      await postState(values);
      if(main!==undefined)lastParsed=parsedMain;
      options.onCommit?.({incremental:false,fallback:true,keys:Object.keys(values)});
     }catch(fallbackError){report(fallbackError.message);}
    }else report(error.message);
   }
  }).catch(error=>report(error.message)).finally(()=>{
   scheduled=false;if(dirty.size)scheduleSave();
  });
 }
 const storage={getItem:key=>cache[key]??local?.getItem(key)??null,setItem(key,value){
  cache[key]=String(value);try{local?.setItem(key,value);}catch{}
  if(keys.includes(key)&&(key!=='sfx-local-index-v1'||scanIndex)){dirty.set(key,String(value));scheduleSave();}
 },
 // ADR-09：app.js 在 state 建好后挂补页回调；全选等操作要等目录补齐完成。
 catalogModels,catalogReady,setCatalogPageHandler,
 applyFileMoves(result){
  for(const change of result.changes||[])fileMoves.set(change.uid,{root:result.root,change:{...change,from:fileMoves.get(change.uid)?.change.from??change.from}});
  const patch=data=>{if(!data)return;applyLocalFileMoves(data.models,result);applyLocalFileMoves(data.trashed,result);};
  const data=parse(cache[MAIN_STATE_KEY]);patch(data);patch(lastParsed);
  applyLocalFileMoves(catalogModels,result);
  if(data){cache[MAIN_STATE_KEY]=JSON.stringify(data);try{local?.setItem(MAIN_STATE_KEY,cache[MAIN_STATE_KEY]);}catch{}}
  if(dirty.has(MAIN_STATE_KEY)){const queued=parse(dirty.get(MAIN_STATE_KEY));patch(queued);if(queued)dirty.set(MAIN_STATE_KEY,JSON.stringify(queued));}
 }};
 // Restore actual downloads only on first migration; later removals must stay removed.
 if(!values['sfx-library-v2']){
  const state=loadLibrary(storage);state.models=collectModels(state.models,recovered).models;
  saveLibrary(storage,state);await pending;
 }
 // ADR-09：瘦身读视图恒带主状态，旧迁移分支不再触发；下载任务恢复出来的资产必须
 // 显式走 asset:add 才进得了 DB —— 整块 catalog 通道已经不承载入库，否则会被剥离丢弃。
 if(catalogPaged&&recovered.length){
  // 已经读到过（第一页里就有）的资产不必再补：asset:add 是幂等的，但每次启动都白传
  // 几百 KB 没有意义。只补「目录里确实没有的」，正常情况下一批都发不出去。
  const ops=recovered.slice(0,200)
   .filter(m=>m&&typeof m.uid==='string'&&!catalogSeen.has(m.uid))
   .map(m=>({op:'asset:add',uid:m.uid,model:m}));
  if(ops.length){
   // 同样要分批：一批几百 KB 起，整批发过去会撞上限，而这一步是 await 的，
   // 失败或吊死都会把启动画面钉在 92%（2026-11-11 的真实故障）。
   // 再加一道 15 秒超时兜底：补发只是「顺手把下载资产登记进库」，绝不配拖住启动。
   try{
    const flush=(async()=>{
     let allOk=true;
     for(const batch of chunkOps(ops)){
      const result=await post('/api/library/assets/mutate',{ops:batch});
      if(!result.ok){allOk=false;break;}
     }
     if(!allOk)report('恢复的下载资产未能入库');
    })();
    await Promise.race([flush,new Promise((resolve,reject)=>setTimeout(()=>reject(Error('补发超时，已跳过')),15000))]);
   }
   catch(error){report(`恢复的下载资产入库失败：${error.message}`);}
   acceptCatalogPage(recovered);
  }
 }
 return storage;
}
