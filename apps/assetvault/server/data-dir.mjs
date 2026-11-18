import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {REGISTRY_FILE, activeStore, readStoreRegistry} from './store-registry.mjs';
export const DATA_DIR_NAME='.assetvault';
export const LEGACY_DATA_DIR_NAME='.sketchvault';
// 多库共享账号（ADR-13）：账号与机器令牌住在库外面 —— 放进 dataDir 就会被切库带走，
// 结果是「换个库 = 没账号、要重新注册」。显式指定 SFX_DATA_DIR 时（测试、便携实例）
// 账号跟着它走，保证一个数据目录就是一套完全独立的实例。
export const ACCOUNTS_DIR_NAME='accounts';

// 多资源库（ADR-12）：activeId 在 libraries.json 里，切库 = 改它 + 重启进程。
// 这里按 mtime 缓存一次解析结果：resolveUserPaths 被十几个模块反复调用，
// 每次都 stat + 读一份 JSON 没必要；文件变了（切库）就重新读。
let activeCache={base:'',stamp:'',store:null};
function cachedActiveStore(base){
 let stamp='';
 try{const stat=fs.statSync(path.join(base,REGISTRY_FILE));stamp=`${stat.mtimeMs}:${stat.size}`;}catch{stamp='';}
 // 命中缓存也要确认目录还在：注册表没变、但盘拔了/目录被删时 mtime 不会动，
 // 直接返回旧库就会让服务继续指向一个不存在的目录。
 if(activeCache.base===base&&activeCache.stamp===stamp){
  const hit=activeCache.store;
  if(hit&&(hit.builtin||fs.existsSync(hit.dataDir)))return hit;
 }
 // 文件还没写过（首次启动）时也要走默认库：activeStore 内部会给出内置默认库，
 // 否则 dataDir 会掉回 base/data，和注册表里说的位置分家。
 const store=activeStore(base)||null;
 activeCache={base,stamp,store};
 return store;
}

// 显式 SFX_DATA_DIR（启动器、桌面版、测试）时目录以它为准，但归档根仍要跟着
// 「这个目录属于哪个已登记的库」走 —— 否则在设置里改过的资产目录会被丢掉，
// 新下载又掉回 base/默认资源库，和界面上显示的路径对不上。
const normDir=value=>{const resolved=path.resolve(String(value||''));return process.platform==='win32'?resolved.toLowerCase():resolved;};
let dirCache={key:'',store:null};
function storeForDir(base,dir){
 let stamp='';
 try{const stat=fs.statSync(path.join(base,REGISTRY_FILE));stamp=`${stat.mtimeMs}:${stat.size}`;}catch{}
 const key=`${base}|${stamp}|${normDir(dir)}`;
 if(dirCache.key===key)return dirCache.store;
 let store=null;
 try{store=readStoreRegistry(base).stores.find(item=>normDir(item.dataDir)===normDir(dir))||null;}catch{}
 dirCache={key,store};
 return store;
}

// Shared user storage for Node startup, launchers and the desktop app.
export function resolveUserPaths(env=process.env,home=os.homedir()){
 const parent=env.APPDATA||path.join(home,'AppData','Roaming');
 const next=path.join(parent,'AssetVault'),legacy=path.join(parent,'com.assetvault.desktop');
 // Match the desktop resolver: don't merge two independent existing profiles.
 const base=fs.existsSync(legacy)&&(!fs.existsSync(next)||fs.realpathSync(legacy)!==fs.realpathSync(next))?legacy:next;
 const absolute=(value,fallback)=>{if(value&&!path.isAbsolute(value))throw Error('User data paths must be absolute');return value||fallback;};
 // 显式 SFX_DATA_DIR（桌面版、启动器、测试）只决定「库数据放哪」，
 // 资产根与下载记录根一律听注册表里选中的库 —— 否则 Tauri 传进来的路径写法一旦
 // 和注册表对不上（legacy junction、大小写），active 会变 null，archiveRoot 掉回
 // base/默认资源库，设置里改过的资产目录就被无视，前端每次开下载页都弹「重新设置路径」。
 // 选中的库目录被删 / 移动硬盘拔了 → 当场回退默认库，不让服务指向一个不存在的目录。
 const registryStore=cachedActiveStore(base);
 const picked=registryStore||(env.SFX_DATA_DIR?storeForDir(base,env.SFX_DATA_DIR):null);
 // 默认库不能因为「数据目录还没建」就被判成不存在：首次启动时它落在
 // <默认资源库>/.assetvault/data，服务起来才创建。非默认库仍按存在性判断（移动硬盘拔了要回退）。
 const active=picked&&(env.SFX_DATA_DIR||fs.existsSync(picked.dataDir)||picked.builtin)?picked:null;
 // 库数据已经住进资产根（<库>/.assetvault/data）后，旧位置留一张 data-moved.json 字条。
 // 桌面版/启动器可能还在传旧路径（没更新或还没重编），照字条走 —— 否则会拿空目录当默认库，
 // 在里头重建一个新库，界面上看起来就像"资产全没了"。
 const moved=resolveMoveMarker(absolute(env.SFX_DATA_DIR,active?.dataDir||path.join(base,'data')));
 const dataDir=moved.dir;
 // 归档根：按分类树（图片/3D资产/…）落盘的资产根，目录名跟着库名走。
 // 选中库优先用注册表里的 archiveRoot；没选中库时默认库 = base/默认资源库。
 const archiveRoot=absolute(env.SFX_ARCHIVE_DIR,active?.archiveRoot||path.join(base,'默认资源库'));
 // 被搬迁字条改道过来的，账号仍留在库外共享目录：账号是这台机器的身份，
 // 不该跟着库文件被拷到别人的硬盘上。
 const accountsDir=moved.marked?path.join(base,ACCOUNTS_DIR_NAME):explicitAccounts(env,dataDir,base);
 // 老版本把账号写在默认库的 dataDir 里，这里搬一次；之后所有库共用这一份。
 migrateAccountFiles(dataDir,accountsDir);
 return {
  base,
  activeStoreId:active?.id||null,
  accountsDir,
  dataDir,
  archiveRoot,
  downloadDir:absolute(env.SFX_DOWNLOAD_DIR,active?.downloadDir||path.join(base,'downloads')),
 };
}

/**
 * 旧数据目录里的搬迁字条：{"movedTo":"J:\\资产\\.assetvault\\data","at":...}。
 * 只有存在这张字条、且目标目录真实存在时才改道 —— 测试用的临时目录不会有它，
 * 不会把"空目录 = 新库"误判成搬迁。
 */
function resolveMoveMarker(dir){
 try{
  const marker=path.join(dir,'data-moved.json');
  if(!fs.existsSync(marker))return {dir,marked:false};
  const moved=String(JSON.parse(fs.readFileSync(marker,'utf8'))?.movedTo||'');
  if(moved&&path.isAbsolute(moved)&&fs.existsSync(moved))return {dir:path.resolve(moved),marked:true};
 }catch{}
 return {dir,marked:false};
}

function explicitAccounts(env,dataDir,base){
 const override=env.SFX_ACCOUNTS_DIR;
 if(override){
  if(!path.isAbsolute(override))throw Error('User data paths must be absolute');
  return override;
 }
 // 显式给了数据目录 → 账号留在它内部（测试 / 便携实例只认自己这一套）。
 return env.SFX_DATA_DIR?path.join(dataDir,ACCOUNTS_DIR_NAME):path.join(base,ACCOUNTS_DIR_NAME);
}

// 迁移只做一次（目标已存在就跳过），源文件改名留档而不是删掉 —— 万一要回滚，
// 老版本还能靠 *-users.json.migrated-* 找到原账号。
const migratedAccounts=new Set();
function migrateAccountFiles(dataDir,accountsDir){
 if(dataDir===accountsDir||migratedAccounts.has(accountsDir))return;
 migratedAccounts.add(accountsDir);
 for(const name of ['auth-users.json','auth-token']){
  const from=path.join(dataDir,name),to=path.join(accountsDir,name);
  try{
   if(fs.existsSync(to)||!fs.existsSync(from))continue;
   fs.mkdirSync(accountsDir,{recursive:true});
   fs.copyFileSync(from,to);
   fs.renameSync(from,`${from}.migrated-${Date.now()}`);
  }catch{/* 迁移失败不该挡住服务启动：账号文件读不到时 auth 会当成未注册 */ }
 }
}
export function resolveDataDir(_root){
 return {dir:resolveUserPaths().dataDir,migrated:false};
}
