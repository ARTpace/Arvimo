import {randomUUID} from 'node:crypto';
import {normOf} from './library-vocab.mjs';
export const RULE_CHANNEL='taxonomy-split-rules-v1';
const fail=message=>Object.assign(Error(message),{status:409});

export function createTaxonomyRules({storage,onChanged=()=>{}}){
 async function list(){return storage.withDb(conn=>({rules:conn.all(`SELECT r.*,s.value source,t.value target FROM taxonomy_rules r
  JOIN tag_terms s ON s.term_id=r.source_id JOIN tag_terms t ON t.term_id=r.target_id ORDER BY r.created_at,r.rule_id`),version:Number(conn.getMeta('taxonomy_rules_rev')||1)}));}
 async function write(input){
  const result=await storage.withDbWrite(conn=>{
   if(conn.all("SELECT 1 FROM file_operations WHERE state IN ('prepared','recovery-required') LIMIT 1").length)throw fail('文件整理待恢复，请先恢复');
   let id=input.id;
   if(input.action==='remove'){
    const row=conn.all('SELECT * FROM taxonomy_rules WHERE rule_id=?',[String(id||'')])[0];
    if(!row||Number(input.rev)!==row.rev)throw fail('规则已变化，请刷新');
    conn.run('DELETE FROM taxonomy_rules WHERE rule_id=?',[id]);
   }else if(input.action==='create'){
    if(conn.all('SELECT count(*) n FROM taxonomy_rules')[0].n>=1000)throw fail('规则达到 1000 条上限');
    const term=value=>{
     const norm=normOf(value);if(!norm||norm.length>200)throw fail('请输入完整标签名');
     const rows=conn.all("SELECT * FROM tag_terms WHERE norm=? AND status='active' AND retired=0",[norm]);
     if(rows.length!==1)throw fail('标签不存在、未激活或已停用，请使用当前标准名称');return rows[0];
    };
    const source=term(input.source),target=term(input.target),match=normOf(input.match);
    if(target.parent_id!==source.term_id)throw fail('目标必须是源标签的直接子分类，请先创建子分类');
    if(!match||match.length>200||/[\x00-\x1f]/.test(match))throw fail('匹配条件应为 1–200 字符的已有标签');
    if(conn.all('SELECT 1 FROM taxonomy_rules WHERE source_id=? AND target_id=? AND match_norm=?',[source.term_id,target.term_id,match]).length)throw fail('此规则已经存在');
    id=randomUUID();conn.run('INSERT INTO taxonomy_rules VALUES (?,?,?,?,1,?)',[id,source.term_id,target.term_id,match,Date.now()]);
   }else throw fail('未知规则操作');
   const rev=Number(conn.getMeta('taxonomy_rules_rev')||1)+1;conn.run("INSERT INTO db_meta VALUES ('taxonomy_rules_rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[String(rev)]);
   conn.run('DELETE FROM asset_label_progress WHERE channel=?',[RULE_CHANNEL]);
   conn.run("UPDATE label_backfill SET state='paused',cursor=0,error='拆分规则已变化，请继续补标',updated_at=? WHERE channel=?",[Date.now(),RULE_CHANNEL]);
   conn.run('INSERT INTO audit_log (at,actor,action,detail) VALUES (?,?,?,?)',[Date.now(),'host','taxonomy.rule.'+input.action,JSON.stringify({id,version:rev})]);
   return {ok:true,id,version:rev};
  });onChanged();return result;
 }
 return {list,write};
}
