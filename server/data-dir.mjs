import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {REGISTRY_FILE, activeStore} from './store-registry.mjs';
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
 if(activeCache.base===base&&activeCache.stamp===stamp)return activeCache.store;
 const store=stamp?activeStore(base):null;
 activeCache={base,stamp,store};
 return store;
}

// Shared user storage for Node startup, launchers and the desktop app.
export function resolveUserPaths(env=process.env,home=os.homedir()){
 const parent=env.APPDATA||path.join(home,'AppData','Roaming');
 const next=path.join(parent,'AssetVault'),legacy=path.join(parent,'com.assetvault.desktop');
 // Match the desktop resolver: don't merge two independent existing profiles.
 const base=fs.existsSync(legacy)&&(!fs.existsSync(next)||fs.realpathSync(legacy)!==fs.realpathSync(next))?legacy:next;
 const absolute=(value,fallback)=>{if(value&&!path.isAbsolute(value))throw Error('User data paths must be absolute');return value||fallback;};
 // 显式的 SFX_DATA_DIR 优先级最高（桌面版与测试都靠它定向），
 // 没显式指定时才认注册表里选中的库，最后才是默认目录。
 // 选中的库目录被删 / 移动硬盘拔了 → 当场回退默认库，不让服务指向一个不存在的目录。
 const picked=env.SFX_DATA_DIR?null:cachedActiveStore(base);
 const active=picked&&fs.existsSync(picked.dataDir)?picked:null;
 const dataDir=absolute(env.SFX_DATA_DIR,active?.dataDir||path.join(base,'data'));
 const accountsDir=explicitAccounts(env,dataDir,base);
 // 老版本把账号写在默认库的 dataDir 里，这里搬一次；之后所有库共用这一份。
 migrateAccountFiles(dataDir,accountsDir);
 return {
  base,
  activeStoreId:active?.id||null,
  accountsDir,
  dataDir,
  downloadDir:absolute(env.SFX_DOWNLOAD_DIR,active?.downloadDir||path.join(base,'downloads')),
 };
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
