import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkedOrganizePath, createFileOrganizePreflight} from './file-organize-preflight.mjs';
import {localLocator, locationModel} from './file-locations.mjs';
import {requireFileWriteProtocol} from './file-write-protocol.mjs';

const exec = promisify(execFile);
const fail = message => Object.assign(Error(message), {status:409});
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const contains = (base, value) => key(base) === key(value) || key(value).startsWith(key(base) + '/');
const parentRel = rel => path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
const absolute = (root, rel) => path.join(root, ...rel.split('/'));
const validRel = (root, rel) => localLocator({localRoot:root,localRel:rel})?.rel;
const protectedName = name => /^(?:\.git|\.arvimo-|ProjectSettings$|.*\.uproject$|.*\.meta$)/i.test(name);

async function exists(file) { try {await fs.lstat(file); return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;} }
async function exactExists(file) {
  try { return (await fs.readdir(path.dirname(file))).includes(path.basename(file)); }
  catch(error) { if(error.code==='ENOENT')return false;throw error; }
}

// File.Move / Directory.Move 使用系统的“不替换”语义；Node fs.rename 会覆盖已有文件。
// 路径通过环境 JSON 传递，绝不拼进可执行脚本；Windows 上不弹终端窗口。
async function moveNoReplace(from, to, directory) {
  if(process.platform!=='win32')throw fail('真实整理目前仅支持 Windows 本机磁盘');
  const script = '$ErrorActionPreference="Stop"; $p=ConvertFrom-Json $env:ARVIMO_FILE_MOVE; if($p.directory){[IO.Directory]::Move($p.from,$p.to)}else{[IO.File]::Move($p.from,$p.to)}';
  try {
    await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,timeout:60000,env:{...process.env,ARVIMO_FILE_MOVE:JSON.stringify({from,to,directory})},maxBuffer:8192});
  } catch(error) {throw Object.assign(fail('系统未能移动文件，请检查占用、权限、目标重名或路径长度'),{cause:error});}
}

async function projectGuard(root, rel) {
  let current = absolute(root, rel), volumeRoot = path.parse(current).root;
  for (;;) {
    const names=await fs.readdir(current);
    if(names.some(name=>/^(?:ProjectSettings|.*\.uproject)$/i.test(name)))throw fail('包含 Unity / UE 工程，请使用对应软件整理');
    if(current===volumeRoot)break;
    current=path.dirname(current);
  }
}

/** 不对大型文件重新编码或哈希；记录卷/文件 ID、大小和修改时间，移动前后均复核。 */
async function manifest(file) {
  const out=[];
  async function visit(current, rel, depth) {
    if(depth>64||out.length>=20000)throw fail('目录超过本期安全整理范围（2 万项 / 64 层）');
    const stat=await fs.lstat(current,{bigint:true});
    if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw fail('目录内存在链接或非常规文件，不能整理');
    if(stat.ino===0n)throw fail('当前磁盘不提供可靠文件身份，不能安全整理');
    out.push({rel,directory:stat.isDirectory(),dev:String(stat.dev),ino:String(stat.ino),
      birthtime:String(stat.birthtimeNs),size:stat.isFile()?String(stat.size):'',mtime:stat.isFile()?String(stat.mtimeNs):''});
    if(stat.isDirectory()) {
      const names=(await fs.readdir(current)).sort();
      for(const name of names) {
        if(protectedName(name))throw fail('目录含工程元数据或受保护文件，不能通用整理');
        await visit(path.join(current,name),rel?rel+'/'+name:name,depth+1);
      }
    }
  }
  await visit(file,'',0);return out;
}
const sameManifest = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const changeResult = (plan,id) => ({ok:true,operationId:id,root:plan.root,from:plan.from,to:plan.to,
  affected:plan.affected.length,changes:plan.affected.map(({uid,from,to})=>({uid,from,to}))});

export function createFileOrganizer({storage,importRoots,beforeEnable=async()=>{},onChanged=()=>{},
  // 仅用于持久恢复测试的故障注入，不通过 HTTP 暴露。
  afterFilesystemMove=async()=>{}}) {
  const preflight=createFileOrganizePreflight({storage,importRoots});
  let queue=Promise.resolve();
  const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
  async function rootEntry(folder,write=false) {
    const report=await preflight.inspect(folder);
    if(report.issues.length)throw fail('存在定位冲突，请先运行整理预检并解决问题');
    if(write&&!report.root.writable)throw fail('请先启用此目录的“允许整理源文件”');
    if(write&&process.platform!=='win32')throw fail('真实整理目前仅支持 Windows');
    return report;
  }
  async function unresolved() {
    return await storage.withDb(conn=>conn.all("SELECT operation_id,state,error FROM file_operations WHERE state IN ('prepared','recovery-required')"))||[];
  }
  async function requireRecovered() {if((await unresolved()).length)throw fail('有未恢复的文件操作，请先重试恢复，暂停新的整理操作');}
  async function setState(id,state,error=null) {
    await storage.withDbWrite(conn=>conn.run('UPDATE file_operations SET state=?,error=?,updated_at=? WHERE operation_id=?',[state,error,Date.now(),id]));
  }
  function applyPlan(conn,plan,id) {
    const stamp=Date.now();
    const treeByRel=new Map(plan.manifest.map(entry=>[entry.rel,entry]));
    for(const item of plan.affected) {
      const location=conn.all('SELECT * FROM file_locations WHERE location_id=?',[item.locationId])[0];
      if(!location||location.asset_uid!==item.uid||location.root_id!==plan.rootId||location.rel!==item.from)throw fail('资产定位已变化，保留恢复任务');
      const row=conn.all('SELECT rowid,payload,name,author,platform,note,tags_text,category_text FROM assets WHERE uid=?',[item.uid])[0];
      if(!row)throw fail('资产已删除，保留恢复任务');
      const model=locationModel(JSON.parse(row.payload),{...location,path:plan.root,rel:item.to,availability:'online'});
      const entry=treeByRel.get(item.from===plan.from?'':item.from.slice(plan.from.length+1));
      const fingerprint=entry?JSON.stringify({v:1,...entry,rel:undefined}):location.fingerprint;
      conn.run('UPDATE file_locations SET rel=?,fingerprint=?,availability=\'online\' WHERE location_id=?',[item.to,fingerprint,item.locationId]);
      // 位置变更不重写标签、不重建词表、不对整库 blob 反复序列化。
      conn.run('UPDATE assets SET payload=?,name=?,url=?,thumbnail=?,rev=rev+1,updated_at=? WHERE uid=?',
        [JSON.stringify(model),model.name||row.name,model.url||null,model.thumbnail||null,stamp,item.uid]);
      conn.run("DELETE FROM asset_label_progress WHERE uid=? AND channel='taxonomy-file-text-v1'",[item.uid]);
      if(model.name!==row.name) {
        conn.run('DELETE FROM assets_fts WHERE rowid=?',[row.rowid]);
        conn.run('INSERT INTO assets_fts (rowid,uid,body) VALUES (?,?,?)',[row.rowid,item.uid,
          [model.name,row.author,row.platform,row.note,row.tags_text,row.category_text].filter(Boolean).join(' \u0001 ')]);
      }
    }
    conn.run("UPDATE file_operations SET state='completed',error=NULL,updated_at=? WHERE operation_id=?",[stamp,id]);
    if(plan.undoOf)conn.run("UPDATE file_operations SET state='undone',updated_at=? WHERE operation_id=?",[stamp,plan.undoOf]);
    conn.run('INSERT INTO audit_log (at,actor,action,detail) VALUES (?,?,?,?)',[stamp,'host','files.move',JSON.stringify({operationId:id,from:plan.from,to:plan.to,count:plan.affected.length})]);
  }
  async function recoverNow() {
    const rows=await storage.withDb(conn=>conn.all("SELECT * FROM file_operations WHERE state IN ('prepared','recovery-required') ORDER BY created_at"))||[];
    const results=[];
    for(const row of rows) {
      try {
        const plan=JSON.parse(row.plan);
        if(plan.version!==1||!validRel(plan.root,plan.from)||!validRel(plan.root,plan.to)||plan.stage&&!validRel(plan.root,plan.stage))throw fail('操作日志版本或路径无效');
        await checkedOrganizePath(plan.root,'',true);
        const paths=[plan.from,plan.to,...(plan.stage?[plan.stage]:[])];
        const present=[];
        for(const rel of paths)if(await exactExists(absolute(plan.root,rel)))present.push(rel);
        if(present.length!==1)throw fail('源或目标被占用/缺失，需要人工核实，未覆盖任何文件');
        const found=present[0];
        await checkedOrganizePath(plan.root,found);
        if(!sameManifest(plan.manifest,await manifest(absolute(plan.root,found))))throw fail('文件身份或内容版本已变化，需要人工核实');
        if(found===plan.from) {await setState(row.operation_id,'cancelled');results.push({id:row.operation_id,state:'cancelled'});continue;}
        await checkedOrganizePath(plan.root,parentRel(plan.to),true);
        if(found===plan.stage)await moveNoReplace(absolute(plan.root,found),absolute(plan.root,plan.to),plan.directory);
        await storage.withDbWrite(conn=>applyPlan(conn,plan,row.operation_id));
        results.push({...changeResult(plan,row.operation_id),id:row.operation_id,state:'completed'});
        onChanged();
      } catch(error) {
        await setState(row.operation_id,'recovery-required',error.message);
        results.push({id:row.operation_id,state:'recovery-required',error:error.message});
      }
    }
    return {results,pending:await unresolved()};
  }
  const ready=serial(recoverNow);
  async function planMove(input) {
    const report=await rootEntry(input.folder,true),root=report.root.path;
    const from=validRel(root,input.from),to=validRel(root,input.to);
    if(!from||!to||from===to)throw fail('源或目标名称无效');
    if([...from.split('/'),...to.split('/')].some(protectedName))throw fail('不能整理受保护文件或内部恢复目录');
    for(const registered of importRoots.list()) {
      const nested=path.relative(root,registered).split(path.sep).join('/');
      if(!nested||nested.startsWith('../')||nested==='..'||path.isAbsolute(nested))continue;
      if(contains(from,nested)||contains(nested,from)||contains(nested,to))throw fail('不能跨越或搬动另一个已登记根，请在对应根内整理');
    }
    if(contains(from,to)&&key(from)!==key(to))throw fail('不能移动到自身子目录');
    const caseOnly=key(from)===key(to);
    if(caseOnly&&parentRel(from)!==parentRel(to))throw fail('大小写改名只支持同一父目录');
    const source=await checkedOrganizePath(root,from);
    await checkedOrganizePath(root,parentRel(to),true);
    await projectGuard(root,parentRel(from));await projectGuard(root,parentRel(to));
    if(!caseOnly&&await exists(absolute(root,to)))throw fail('目标已存在，不能覆盖');
    const stat=await fs.lstat(source);
    if(stat.isFile()&&/\.(?:meta|blend|fbx|obj|mtl|gltf|glb|bin|usd[ac]?|unity|prefab|mat)$/i.test(from))throw fail('依赖型文件请连同完整素材目录一起整理');
    const tree=await manifest(source);
    const targetStat=await fs.stat(absolute(root,parentRel(to)),{bigint:true});
    if(tree[0].dev!==String(targetStat.dev))throw fail('首期不支持跨卷移动');
    const owned=new Map(report.locations.map(item=>[key(item.rel),item]));
    for(const entry of tree) {
      if(entry.directory)continue;
      const rel=entry.rel?from+'/'+entry.rel:from;
      if(!owned.has(key(rel)))throw fail(`包含尚未入库的文件，请先导入再整理：${rel}`);
      const location=owned.get(key(rel));
      let prior;try{prior=JSON.parse(location.fingerprint);}catch{}
      if(prior?.v===1) {
        if(prior.dev!==entry.dev||prior.ino!==entry.ino||prior.birthtime!==entry.birthtime)throw fail(`源文件身份已变化，请重新定位核实：${rel}`);
      } else if(/^[a-f0-9]{64}$/i.test(location.fingerprint)) {
        // 首次采用旧 SHA 定位时才读取内容；以后以文件系统身份识别，避免反复哈希大文件。
        const hash=createHash('sha256');for await(const chunk of createReadStream(absolute(root,rel)))hash.update(chunk);
        if(hash.digest('hex')!==location.fingerprint.toLowerCase())throw fail(`源内容与入库记录不同，请先核实文件身份：${rel}`);
      } else throw fail(`此旧资产尚无可验证的文件身份，请先重新校验导入：${rel}`);
    }
    const affected=report.locations.filter(item=>contains(from,item.rel)).map(item=>({uid:item.asset_uid,locationId:item.location_id,from:item.rel,to:to+item.rel.slice(from.length)}));
    const ids=new Set(affected.map(item=>item.locationId));
    if(report.locations.some(item=>contains(to,item.rel)&&!ids.has(item.location_id)))throw fail('目标存在其他资产定位记录，不能覆盖');
    return {version:1,rootId:report.root.root_id,root,from,to,directory:stat.isDirectory(),manifest:tree,affected,
      ...(caseOnly?{stage:(parentRel(from)?parentRel(from)+'/':'')+'.arvimo-'+randomUUID()}:{}),
      warnings:tree.some(item=>/\.blend$/i.test(item.rel))?['Blender 包内相对路径会保留，包外绝对引用可能失效']:[]};
  }
  async function moveNow(input,{undoOf,expectedManifest}={}) {
    await requireRecovered();
    const plan=await planMove(input);
    if(expectedManifest&&!sameManifest(plan.manifest,expectedManifest))throw fail('文件自移动后发生变化，不能安全撤销');
    if(plan.warnings.length&&!input.acceptReferenceRisk)throw fail(plan.warnings.join('；')+'；确认后请带引用风险授权重试');
    if(undoOf)plan.undoOf=undoOf;
    const id=randomUUID(),stamp=Date.now();
    // 先独立提交日志，再进入覆盖整个文件移动和 DB 定点更新的写队列检查点。
    await storage.withDbWrite(conn=>conn.run('INSERT INTO file_operations VALUES (?,?,?,?,?,?)',[id,'prepared',JSON.stringify(plan),null,stamp,stamp]));
    try {
      await storage.withDbWrite(async conn=>{
        if(!sameManifest(plan.manifest,await manifest(absolute(plan.root,plan.from))))throw fail('源在预检后发生变化');
        await checkedOrganizePath(plan.root,parentRel(plan.to),true);
        if(plan.stage) {
          await moveNoReplace(absolute(plan.root,plan.from),absolute(plan.root,plan.stage),plan.directory);
          await moveNoReplace(absolute(plan.root,plan.stage),absolute(plan.root,plan.to),plan.directory);
        } else await moveNoReplace(absolute(plan.root,plan.from),absolute(plan.root,plan.to),plan.directory);
        await afterFilesystemMove(plan);
        if(!sameManifest(plan.manifest,await manifest(absolute(plan.root,plan.to))))throw fail('移动期间文件被外部修改');
        applyPlan(conn,plan,id);
      });
      onChanged();return changeResult(plan,id);
    } catch(error) {
      // 不凭路径猜测执行反向覆盖；日志保持可恢复，下次显式恢复或启动时按文件身份收敛。
      await setState(id,'recovery-required',error.message);
      throw Object.assign(fail(`操作未完成，已保留恢复记录：${error.message}`),{operationId:id});
    }
  }
  return {
    ready,
    pending:()=>unresolved(),
    recover:()=>serial(recoverNow),
    move:input=>serial(()=>moveNow(input)),
    preview:input=>serial(async()=>{await requireRecovered();const plan=await planMove(input);return {from:plan.from,to:plan.to,affected:plan.affected.length,files:plan.manifest.filter(item=>!item.directory).length,warnings:plan.warnings};}),
    async list({folder,rel='',offset=0,limit=300}) {
      await ready;const report=await rootEntry(folder);const root=report.root.path;
      const directory=await checkedOrganizePath(root,rel,true);
      const names=await fs.readdir(directory,{withFileTypes:true});
      const byPath=new Map(report.locations.map(item=>[key(item.rel),item]));
      const entries=names.filter(item=>!item.name.startsWith('.arvimo-')).map(item=>{
        const entryRel=rel?rel+'/'+item.name:item.name;
        return {name:item.name,rel:entryRel,directory:item.isDirectory(),linked:item.isSymbolicLink(),managed:byPath.has(key(entryRel))};
      }).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,'zh-CN'));
      const start=Math.max(0,Math.floor(Number(offset)||0)),size=Math.max(1,Math.min(500,Math.floor(Number(limit)||300)));
      return {root,rootId:report.root.root_id,rel,writable:!!report.root.writable,total:entries.length,entries:entries.slice(start,start+size),pending:await unresolved(),supported:process.platform==='win32'};
    },
    setWritable:input=>serial(async()=>{
      await requireRecovered();const report=await rootEntry(input.folder);
      await checkedOrganizePath(report.root.path,'',true);
      if(typeof input.writable!=='boolean')throw fail('权限参数无效');
      if(input.writable) {await projectGuard(report.root.path,'');await beforeEnable();}
      const id=report.root.root_id||randomUUID();
      await storage.withDbWrite(conn=>{
        conn.run('INSERT OR IGNORE INTO file_roots (root_id,path) VALUES (?,?)',[id,report.root.path]);
        conn.run('UPDATE file_roots SET writable=? WHERE root_id=?',[input.writable?1:0,id]);
        if(input.writable)requireFileWriteProtocol(conn);
      });return {ok:true,writable:input.writable};
    }),
    history:async()=>{await ready;return await storage.withDb(conn=>conn.all('SELECT operation_id,state,plan,error,created_at FROM file_operations ORDER BY created_at DESC LIMIT 30').map(row=>{
      const plan=JSON.parse(row.plan);return {id:row.operation_id,state:row.state,root:plan.root,from:plan.from,to:plan.to,error:row.error,createdAt:row.created_at};
    }))||[];},
    undo:id=>serial(async()=>{
      const row=await storage.withDb(conn=>conn.all('SELECT * FROM file_operations WHERE operation_id=?',[id])[0]);
      if(!row||row.state!=='completed')throw fail('只能撤销已经完成且尚未撤销的操作');
      const plan=JSON.parse(row.plan);
      return moveNow({folder:plan.root,from:plan.to,to:plan.from,acceptReferenceRisk:true},{undoOf:id,expectedManifest:plan.manifest});
    }),
  };
}
