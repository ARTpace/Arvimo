import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
const name=`AssetVault_${version}_x64`;
const engine=path.join(root,`src-tauri/target/release/bundle/nsis/${name}-setup.exe`);
const signature=(await fs.readFile(path.join(root,'dist',`${name}-setup.exe.sig`),'utf8')).trim();
if(!signature)throw Error('Missing updater signature');
// 安装包统一落在桌面工程的 dist/ 根目录（2026-10-20 用户要求）：
// 最终安装器（首次安装和在线更新共用）、其签名与更新清单
// latest.json 都放这里，不再有 dist/release/<版本>/ 第二处副本。
const output=path.join(root,'dist');
const setup=path.join(output,`${name}-setup.exe`);
try{
  const stat=await fs.stat(setup);
  if(!stat.isFile()||stat.size===0)throw Error('empty');
}catch{throw Error('最终安装器缺失或为空：先跑 build-custom-installer 再准备发布资产');}
await fs.mkdir(output,{recursive:true});
const notes=process.env.ASSETVAULT_RELEASE_NOTES||'支持应用内检查、签名下载与重启更新；新增安装动效；修复 Blender 导入 ZIP 文件夹条目冲突。';
await fs.writeFile(path.join(output,'latest.json'),JSON.stringify({version,notes,pub_date:new Date().toISOString(),platforms:{'windows-x86_64':{url:`https://github.com/ARTpace/AssetVault/releases/download/v${version}/${name}-setup.exe`,signature}}},null,2)+'\n');
// 引擎已嵌入最终安装器，bundle 目录里的副本删掉：安装包只保留 dist/ 一处，
// 不会再出现「target 里一份、dist 里一份」的两处存放。
await fs.rm(engine,{force:true});
await fs.rm(`${engine}.sig`,{force:true});
console.log(`Release assets prepared: ${output}`);
