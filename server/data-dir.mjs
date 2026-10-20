import fs from 'node:fs';
import path from 'node:path';
export const DATA_DIR_NAME='.assetvault';
export const LEGACY_DATA_DIR_NAME='.sketchvault';
/**
 * 数据目录名跟着品牌改过一次，所以启动时把旧目录搬过来。
 * 只在「新目录不存在、旧目录存在」时改名；改名失败（被占用 / 无权限）就继续用旧目录，绝不删数据。
 */
export function resolveDataDir(root){
 // 安装版由 Tauri 传 SFX_DATA_DIR（%APPDATA%\AssetVault\data，旧路径兼容迁移）。
 // 安装目录常在 Program Files 下、没有写权限，以前所有数据目录都按 sidecar 根目录推导，
 // 结果 AI 设置 mkdir 直接 EPERM。只要外面给了绝对路径就以它为准。
 const override=process.env.SFX_DATA_DIR;
 if(override&&path.isAbsolute(override))return {dir:override,migrated:false};
 const next=path.join(root,DATA_DIR_NAME),legacy=path.join(root,LEGACY_DATA_DIR_NAME);
 if(fs.existsSync(next)||!fs.existsSync(legacy))return {dir:next,migrated:false};
 try{fs.renameSync(legacy,next);return {dir:next,migrated:true};}
 catch{return {dir:legacy,migrated:false};}
}
