import {VOCAB_REV,FACETS} from './library-vocab.seed.mjs';
import {normOf} from './library-vocab.mjs';
import {RULE_CHANNEL} from './taxonomy-rules.mjs';
import {mappedPlatformCategories} from './platform-categories.mjs';
import {TEXT_LABEL_CHANNEL,createTextLabelMatcher} from './text-label-analysis.mjs';
const CHANNEL='taxonomy-existing-tags-v1',METADATA='taxonomy-explicit-metadata-v1';
const CHANNELS=[{id:CHANNEL,label:'已有标签归一化'},{id:METADATA,label:'元数据与平台分类补标'},{id:TEXT_LABEL_CHANNEL,label:'文件信息匹配（无需视觉）'},{id:RULE_CHANNEL,label:'规则细分分类'}];
const revision=(conn,channel)=>channel===RULE_CHANNEL?VOCAB_REV*100000+Number(conn.getMeta('taxonomy_rules_rev')||1):VOCAB_REV;
const checkedChannel=value=>{const channel=value?.channel||CHANNEL;if(!CHANNELS.some(item=>item.id===channel))throw Object.assign(Error('补标通道无效'),{status:400});return channel;};
function explicitValues(model){
 const result=[];
 for(const [facet,keys] of [['platform',['platform','originPlatform','importPlatform']],['software',['software','softwares']],['license',['license','licenses']]])
  for(const key of keys)for(const value of Array.isArray(model[key])?model[key]:[model[key]])if(typeof value==='string')result.push({facet,value});
 return result;
}
// ponytail: 三个确定性通道共用原有 100 项事务/进度表，不从格式或名字猜授权/软件，不调用付费 AI。
export function createTagBackfill({storage,onChanged=()=>{}}){
 const running=new Set();let textIndexKey='',textMatcher;
 async function status(input){const channel=checkedChannel(input);return storage.withDb(conn=>{
  const channels=CHANNELS.map(item=>({...item,version:revision(conn,item.id),job:conn.all('SELECT * FROM label_backfill WHERE channel=?',[item.id])[0]||null,
   covered:conn.all("SELECT count(*) n FROM asset_label_progress p JOIN assets a ON a.uid=p.uid WHERE p.channel=? AND p.vocab_rev=? AND a.state='active'",[item.id,revision(conn,item.id)])[0].n}));
  const selected=channels.find(item=>item.id===channel);
  return {version:VOCAB_REV,channel,facets:FACETS,job:selected.job,covered:selected.covered,channels,total:conn.all("SELECT count(*) n FROM assets WHERE state='active'")[0].n,rejections:conn.all('SELECT count(*) n FROM tag_rejections')[0].n};
 });}
 async function batch(channel){return storage.withDbWrite(conn=>{
  const job=conn.all('SELECT * FROM label_backfill WHERE channel=?',[channel])[0];if(!job||job.state!=='running')return false;
  if(conn.all("SELECT 1 FROM file_operations WHERE state IN ('prepared','recovery-required') LIMIT 1").length){conn.run("UPDATE label_backfill SET state='paused',error='文件整理待恢复，补标已暂停',updated_at=? WHERE channel=?",[Date.now(),channel]);return false;}
  const rev=revision(conn,channel);if(job.vocab_rev!==rev)throw Error('词表或规则版本已变化，请重新启动补标');
  const terms=conn.all("SELECT term_id,value,norm FROM tag_terms WHERE status='active' AND retired=0"),canonical=new Map(terms.map(term=>[term.norm,term])),byId=new Map(terms.map(term=>[term.term_id,term]));
  const aliases=new Map(conn.all("SELECT x.alias_norm,t.term_id,t.value FROM tag_aliases x JOIN tag_terms t ON t.term_id=x.term_id WHERE t.status='active' AND t.retired=0").map(term=>[term.alias_norm,term]));
  const facets=new Map();for(const row of conn.all('SELECT * FROM tag_facets')){const set=facets.get(row.term_id)||new Set();set.add(row.facet);facets.set(row.term_id,set);}
  if(channel===TEXT_LABEL_CHANNEL){
   const key=JSON.stringify([terms,[...aliases.values()],[...facets].map(([id,set])=>[id,[...set]])]);
   if(key!==textIndexKey){textMatcher=createTextLabelMatcher({terms,aliases:[...aliases.values()],facets});textIndexKey=key;}
  }
  const rules=channel===RULE_CHANNEL?conn.all("SELECT r.* FROM taxonomy_rules r JOIN tag_terms s ON s.term_id=r.source_id JOIN tag_terms t ON t.term_id=r.target_id WHERE s.status='active' AND t.status='active' AND s.retired=0 AND t.retired=0 AND t.parent_id=s.term_id"):[];
  const rows=conn.all(`SELECT a.rowid,a.uid,a.payload FROM assets a LEFT JOIN asset_label_progress p ON p.uid=a.uid AND p.channel=? WHERE a.state='active' AND a.rowid>? AND (p.vocab_rev IS NULL OR p.vocab_rev<>?) ORDER BY a.rowid LIMIT 100`,[channel,job.cursor,rev]);
  if(!rows.length){conn.run("UPDATE label_backfill SET state='completed',error=NULL,updated_at=? WHERE channel=?",[Date.now(),channel]);return false;}
  for(const row of rows){
   const existing=new Set(conn.all('SELECT term_id FROM asset_tags WHERE uid=?',[row.uid]).map(item=>item.term_id));
   const rejected=new Set(conn.all("SELECT term_id FROM tag_rejections WHERE uid=? AND source='ai'",[row.uid]).map(item=>item.term_id));
   const raw=conn.all('SELECT tag FROM tags WHERE uid=?',[row.uid]).map(item=>normOf(item.tag));let candidates=[];
   if(channel===CHANNEL)candidates=raw.map(norm=>aliases.get(norm)||canonical.get(norm)).filter(Boolean);
   else if(channel===METADATA){
    const model=JSON.parse(row.payload);
    candidates=explicitValues(model).flatMap(({facet,value})=>{const term=aliases.get(normOf(value))||canonical.get(normOf(value));return term&&facets.get(term.term_id)?.has(facet)?[term]:[];});
    for(const entry of mappedPlatformCategories(model)){
     const term=canonical.get(normOf(entry.value))||aliases.get(normOf(entry.value))||canonical.get(normOf(entry.name))||aliases.get(normOf(entry.name));
     if(term)candidates.push(term);
    }
   }else if(channel===TEXT_LABEL_CHANNEL)candidates=textMatcher(JSON.parse(row.payload));
   else{
    const matches=new Map();for(const rule of rules)if(existing.has(rule.source_id)&&raw.includes(rule.match_norm)){const group=matches.get(rule.source_id)||new Set();group.add(rule.target_id);matches.set(rule.source_id,group);}
    // 同一粗分类命中不同目标则保留待细分；原人工/平台归属不删除。
    candidates=[...matches.values()].filter(group=>group.size===1).map(group=>byId.get([...group][0]));
   }
   candidates=[...new Map(candidates.filter(term=>term&&!existing.has(term.term_id)&&!rejected.has(term.term_id)).map(term=>[term.term_id,term])).values()];
   if(candidates.length){const result=conn.applyTagOps(candidates.map(term=>({op:'tag.add',uid:row.uid,source:'ai',value:term.value,by:channel})),{actor:'taxonomy-backfill'});if(result.conflicts?.length)throw Error('资产补标冲突：'+row.uid);}
   conn.run('INSERT OR REPLACE INTO asset_label_progress VALUES (?,?,?,?)',[row.uid,channel,rev,Date.now()]);
  }
  conn.run('UPDATE label_backfill SET cursor=?,processed=processed+?,updated_at=? WHERE channel=?',[rows.at(-1).rowid,rows.length,Date.now(),channel]);return true;
 });}
 async function pump(channel){
  if(running.has(channel))return;running.add(channel);
  try{while(await batch(channel)){onChanged();await new Promise(resolve=>setTimeout(resolve,20));}}
  catch(error){await storage.withDbWrite(conn=>conn.run("UPDATE label_backfill SET state='failed',error=?,updated_at=? WHERE channel=?",[error.message,Date.now(),channel]));}
  finally{running.delete(channel);onChanged();}
 }
 return {status,async start(input){const channel=checkedChannel(input);await storage.withDbWrite(conn=>{
  conn.run(`INSERT INTO label_backfill VALUES (?,?,'running',0,0,NULL,?) ON CONFLICT(channel) DO UPDATE SET vocab_rev=excluded.vocab_rev,state='running',cursor=0,processed=0,error=NULL,updated_at=excluded.updated_at`,[channel,revision(conn,channel),Date.now()]);
 });void pump(channel);return status({channel});},
 async pause(input){const channel=checkedChannel(input);await storage.withDbWrite(conn=>conn.run("UPDATE label_backfill SET state='paused',updated_at=? WHERE channel=?",[Date.now(),channel]));return status({channel});},
 async resume(){for(const {id} of CHANNELS){const current=await status({channel:id});if(current?.job?.state==='running')void pump(id);}}};
}
