import {FACETS} from './library-vocab.seed.mjs';
import {normOf} from './library-vocab.mjs';

const reject=message=>Object.assign(Error(message),{status:409});
const text=value=>typeof value==='string'?value.normalize('NFKC').trim().replace(/\s+/g,' '):'';
function label(value){const result=text(value);if(!result||result.length>200||/[\x00-\x1f]/.test(result))throw reject('标签名称应为 1–200 字符且不含控制字符');return result;}
function idOf(value){const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw reject('标签 ID 无效');return id;}

export function createTagManagement({storage,onChanged=()=>{},beforeMerge=async()=>{}}){
 async function list({q='',offset=0,limit=100}={}){
  const start=Math.max(0,Math.floor(Number(offset)||0)),size=Math.max(1,Math.min(200,Math.floor(Number(limit)||100))),needle=text(q).slice(0,200);
  return storage.withDb(conn=>{
   const where="t.status<>'merged' AND (?='' OR instr(t.norm,?)>0)";
   const total=conn.all(`SELECT count(*) n FROM tag_terms t WHERE ${where}`,[normOf(needle),normOf(needle)])[0].n;
   const terms=conn.all(`SELECT t.term_id id,t.value,t.parent_id parentId,t.seed_key seedKey,t.retired,t.edit_rev rev,t.status,
     p.value parent,COALESCE(c.asset_count,0) count FROM tag_terms t LEFT JOIN tag_terms p ON p.term_id=t.parent_id
     LEFT JOIN tag_counts c ON c.term_id=t.term_id WHERE ${where} ORDER BY t.seed_key IS NOT NULL,t.norm LIMIT ? OFFSET ?`,[normOf(needle),normOf(needle),size,start]);
   for(const term of terms){term.facets=conn.all('SELECT facet FROM tag_facets WHERE term_id=? ORDER BY facet',[term.id]).map(item=>item.facet);
    term.aliases=conn.all('SELECT alias_norm FROM tag_aliases WHERE term_id=? ORDER BY alias_norm',[term.id]).map(item=>item.alias_norm);}
   return {terms,total,offset:start,limit:size,facets:FACETS};
  });
 }
 function term(conn,id,rev,editable=true){
  const row=conn.all('SELECT * FROM tag_terms WHERE term_id=?',[idOf(id)])[0];
  if(!row||row.status==='merged')throw reject('标签不存在或已合并，请刷新列表');
  if(editable&&row.seed_key)throw reject('内置词条由版本升级维护，请创建自定义补充标签');
  if(rev!==undefined&&Number(rev)!==row.edit_rev)throw reject('标签已被其它操作修改，请刷新后重试');
  return row;
 }
 function available(conn,value,ownId=null){
  const norm=normOf(value),hit=conn.all('SELECT term_id FROM tag_terms WHERE norm=? UNION SELECT term_id FROM tag_aliases WHERE alias_norm=?',[norm,norm]);
  for(const row of hit){
   let id=row.term_id;const seen=new Set();
   while(id!==ownId&&!seen.has(id)){
    seen.add(id);const entry=conn.all('SELECT status,merged_into FROM tag_terms WHERE term_id=?',[id])[0];
    if(entry?.status!=='merged'||!entry.merged_into)break;id=entry.merged_into;
   }
   if(id!==ownId)throw reject('名称或别名已被其它标签占用');
  }
 }
 function parent(conn,id,parentId){
  if(parentId===null||parentId===undefined||parentId==='')return null;
  let cursor=idOf(parentId);const selected=term(conn,cursor,undefined,false);if(selected.retired)throw reject('不能挂到已停用标签下面');
  const seen=new Set([id]);
  while(cursor){if(seen.has(cursor))throw reject('父子层级不能成环');seen.add(cursor);cursor=conn.all('SELECT parent_id FROM tag_terms WHERE term_id=?',[cursor])[0]?.parent_id;}
  return selected.term_id;
 }
 function refresh(conn,uids){
  // ponytail: 复用同一个写入器的搜索投影，不把旧原始标签重新添加为新关联。
  conn.refreshTagSearch(uids);
 }
 async function mutate(input){
  if(input.action==='merge'||input.action==='split')await beforeMerge();
  const result=await storage.withDbWrite(conn=>{
   if(conn.all("SELECT 1 FROM file_operations WHERE state IN ('prepared','recovery-required') LIMIT 1").length)throw reject('文件整理待恢复，请先恢复后管理标签');
   const action=input.action,stamp=Date.now();let row,id,affected=[];
   const namedId=value=>{
    if(!text(value))return null;
    const hit=conn.all("SELECT term_id FROM tag_terms WHERE norm=? AND status<>'merged' UNION SELECT term_id FROM tag_aliases WHERE alias_norm=?",[normOf(value),normOf(value)]);
    if(hit.length!==1)throw reject('指定标签不存在或名称不明确，请输入完整名称');return hit[0].term_id;
   };
   const parentIdInput=input.parentValue!==undefined?namedId(input.parentValue):input.parentId;
   if(action==='create'){
    const value=label(input.value);available(conn,value);
    id=Number(conn.run("INSERT INTO tag_terms (value,norm,status,created_at) VALUES (?,?,'active',?)",[value,normOf(value),stamp]).lastInsertRowid);
    const facets=input.facets??[];if(!Array.isArray(facets)||facets.some(facet=>!Object.hasOwn(FACETS,facet)))throw reject('分类维度无效');
    for(const facet of new Set(facets))conn.run('INSERT INTO tag_facets VALUES (?,?)',[id,facet]);
    conn.run('UPDATE tag_terms SET parent_id=? WHERE term_id=?',[parent(conn,id,parentIdInput),id]);
   }else{
    row=term(conn,input.id,input.rev);id=row.term_id;
    if(action==='save'){
     const value=label(input.value);available(conn,value,id);
     const aliases=[...new Set((Array.isArray(input.aliases)?input.aliases:[]).map(item=>normOf(label(item))))].filter(item=>item!==normOf(value));
     if(aliases.length>50)throw reject('每个标签最多 50 个别名');
     // 原始标签仍可能保存旧别名；保留兼容映射，不能在刷新时把它们重新变成 pending 词条。
     aliases.push(...conn.all('SELECT alias_norm FROM tag_aliases WHERE term_id=?',[id]).map(item=>item.alias_norm));
     if(normOf(value)!==row.norm)aliases.push(row.norm);
     for(const alias of aliases)available(conn,alias,id);
     const facets=input.facets??[];if(!Array.isArray(facets)||facets.some(facet=>!Object.hasOwn(FACETS,facet)))throw reject('分类维度无效');
     const parentId=parent(conn,id,parentIdInput);
     affected=conn.all('SELECT DISTINCT uid FROM asset_tags WHERE term_id=? LIMIT 10001',[id]).map(item=>item.uid);
     if(affected.length>10000)throw reject('此标签关联超过 1 万资产，需要后台批量迁移，当前不执行');
     // 原始标签文本保留作兼容别名；新标准名和别名通过定点搜索投影可查询。
     conn.run("UPDATE tag_terms SET value=?,norm=?,parent_id=?,status='active',edit_rev=edit_rev+1 WHERE term_id=?",[value,normOf(value),parentId,id]);
     conn.run('DELETE FROM tag_facets WHERE term_id=?',[id]);for(const facet of new Set(facets))conn.run('INSERT INTO tag_facets VALUES (?,?)',[id,facet]);
     conn.run('DELETE FROM tag_aliases WHERE term_id=?',[id]);for(const alias of new Set(aliases))conn.run('INSERT INTO tag_aliases VALUES (?,?,?)',[alias,id,stamp]);
     refresh(conn,affected);
    }else if(action==='retire'||action==='restore'){
     conn.run('UPDATE tag_terms SET retired=?,edit_rev=edit_rev+1 WHERE term_id=?',[action==='retire'?1:0,id]);
    }else if(action==='split'){
     if(row.retired)throw reject('不能拆分已停用标签');
     const values=Array.isArray(input.values)?input.values.map(label):[];
     if(values.length<2||values.length>20||new Set(values.map(normOf)).size!==values.length)throw reject('请提供 2–20 个不重复的子分类名称');
     for(const value of values)available(conn,value);
     const facets=conn.all('SELECT facet FROM tag_facets WHERE term_id=?',[id]);
     for(const value of values){
      const child=Number(conn.run("INSERT INTO tag_terms (value,norm,parent_id,status,created_at) VALUES (?,?,?,'active',?)",[value,normOf(value),id,stamp]).lastInsertRowid);
      for(const {facet} of facets)conn.run('INSERT INTO tag_facets VALUES (?,?)',[child,facet]);
     }
     // ponytail: 无确定规则时只建子分类，原关联留作待细分，不猜测分配资产。
     conn.run('UPDATE tag_terms SET edit_rev=edit_rev+1 WHERE term_id=?',[id]);
    }else if(action==='merge'){
     const target=term(conn,input.targetValue!==undefined?namedId(input.targetValue):input.targetId,undefined,false);
     if(target.retired||target.term_id===id)throw reject('合并目标无效或已停用');
     // 目标不能是源的子孙，否则后续把子项接到目标会形成环。
     parent(conn,id,target.term_id);
     affected=conn.all('SELECT DISTINCT uid FROM asset_tags WHERE term_id IN (?,?) LIMIT 10001',[id,target.term_id]).map(item=>item.uid);
     if(affected.length>10000)throw reject('关联超过 1 万资产，需要后台批量迁移');
     const aliases=conn.all('SELECT alias_norm FROM tag_aliases WHERE term_id=?',[id]);
     conn.run('UPDATE OR IGNORE asset_tags SET term_id=? WHERE term_id=?',[target.term_id,id]);conn.run('DELETE FROM asset_tags WHERE term_id=?',[id]);
     conn.run('UPDATE OR IGNORE tag_rejections SET term_id=? WHERE term_id=?',[target.term_id,id]);conn.run('DELETE FROM tag_rejections WHERE term_id=?',[id]);
     conn.run('UPDATE tag_terms SET parent_id=?,edit_rev=edit_rev+1 WHERE parent_id=?',[target.term_id,id]);
     conn.run('DELETE FROM tag_aliases WHERE term_id=?',[id]);
     for(const alias of new Set([row.norm,...aliases.map(item=>item.alias_norm)]))conn.run('INSERT INTO tag_aliases VALUES (?,?,?) ON CONFLICT(alias_norm) DO UPDATE SET term_id=excluded.term_id',[alias,target.term_id,stamp]);
     conn.run("UPDATE tag_terms SET status='merged',merged_into=?,edit_rev=edit_rev+1 WHERE term_id=?",[target.term_id,id]);
     conn.run('UPDATE tag_terms SET edit_rev=edit_rev+1 WHERE term_id=?',[target.term_id]);
     conn.run('DELETE FROM tag_counts WHERE term_id=?',[id]);
     // 合并不能让“已排除的目标自动标签”借来源标签重新出现；平台和人工来源保持。
     const targetNorms=new Set([target.norm,...conn.all('SELECT alias_norm FROM tag_aliases WHERE term_id=?',[target.term_id]).map(item=>item.alias_norm)]);
     for(const uid of affected){
      if(!conn.all("SELECT 1 FROM tag_rejections WHERE uid=? AND term_id=? AND source='ai'",[uid,target.term_id]).length)continue;
      conn.run("DELETE FROM asset_tags WHERE uid=? AND term_id=? AND source='ai'",[uid,target.term_id]);
      for(const raw of conn.all("SELECT tag FROM tags WHERE uid=? AND kind='ai'",[uid]))if(targetNorms.has(normOf(raw.tag)))conn.run("DELETE FROM tags WHERE uid=? AND kind='ai' AND tag=?",[uid,raw.tag]);
     }
     refresh(conn,affected);
     conn.run(`INSERT INTO tag_counts VALUES (?,(SELECT count(DISTINCT uid) FROM asset_tags WHERE term_id=?),?)
       ON CONFLICT(term_id) DO UPDATE SET asset_count=excluded.asset_count,updated_at=excluded.updated_at`,[target.term_id,target.term_id,stamp]);
    }else throw reject('未知标签管理操作');
   }
   conn.run('INSERT INTO audit_log (at,actor,action,term_id,detail) VALUES (?,?,?,?,?)',[stamp,'host','taxonomy.'+action,id,JSON.stringify({affected:affected.length})]);
   // 自定义词表变化后已覆盖资产重新检查映射，但不清理它们已有标签。
   conn.run('DELETE FROM asset_label_progress');
   conn.run("UPDATE label_backfill SET state='paused',cursor=0,error='自定义词表已变化，请继续补标',updated_at=?",[stamp]);
   return {ok:true,id,affected:affected.length};
  });
  onChanged();return result;
 }
 async function rejections({offset=0,limit=100}={}){
  const start=Math.max(0,Math.floor(Number(offset)||0)),size=Math.max(1,Math.min(200,Math.floor(Number(limit)||100)));
  return storage.withDb(conn=>({
   total:conn.all('SELECT count(*) n FROM tag_rejections')[0].n,
   items:conn.all(`SELECT r.uid,r.term_id id,r.source,r.created_at createdAt,t.value,a.name
    FROM tag_rejections r JOIN tag_terms t ON t.term_id=r.term_id JOIN assets a ON a.uid=r.uid
    ORDER BY r.created_at DESC,r.uid,r.term_id,r.source LIMIT ? OFFSET ?`,[size,start]),offset:start,limit:size
  }));
 }
 async function restoreRejection({uid,id,source='ai',createdAt}){
  if(typeof uid!=='string'||source!=='ai'||!Number.isSafeInteger(createdAt))throw reject('排除记录参数无效');
  const result=await storage.withDbWrite(conn=>{
   if(conn.all("SELECT 1 FROM file_operations WHERE state IN ('prepared','recovery-required') LIMIT 1").length)throw reject('文件整理待恢复，请先恢复');
   const removed=conn.run('DELETE FROM tag_rejections WHERE uid=? AND term_id=? AND source=? AND created_at=?',[uid,idOf(id),source,createdAt]);
   if(!removed.changes)throw reject('排除记录已变化，请刷新后重试');
   conn.run('DELETE FROM asset_label_progress WHERE uid=?',[uid]);
   conn.run('INSERT INTO audit_log (at,actor,action,uid,term_id,detail) VALUES (?,?,?,?,?,?)',[Date.now(),'host','taxonomy.restore-rejection',uid,id,JSON.stringify({source})]);
   return {ok:true};
  });onChanged();return result;
 }
 return {list,mutate,rejections,restoreRejection};
}
