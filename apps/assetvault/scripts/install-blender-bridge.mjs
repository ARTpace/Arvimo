/**
 * 把 Blender 桥接脚本安装到本机所有 Blender 版本的 startup 目录。
 *
 * 换新电脑、或想抢在打开 Blender 之前装好时运行：
 *   双击 Install-Blender-Bridge.cmd（推荐），或 node scripts/install-blender-bridge.mjs
 *
 * 平时不需要手动跑 —— AssetVault 在点击「Blender」导入时会自动同步这个脚本。
 * 但那种情况下 Blender 往往已经开着，装完还得重启才生效，所以单独提供这个入口。
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureBlenderBridgeInstalled,startupRoots,versionDirs} from '../server/blender-import.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(here,'..');
const source=path.join(root,'server','blender-bridge.py');
const installedName='assetvault_bridge_startup.py';

const readText=file=>{try{return fs.readFileSync(file,'utf8');}catch{return null;}};
const existsDir=dir=>{try{return fs.statSync(dir).isDirectory();}catch{return false;}};

function blenderRunning(){
 try{
  if(process.platform!=='win32')return false;
  const out=execFileSync('tasklist.exe',['/FI','IMAGENAME eq blender.exe','/NH'],{encoding:'utf8',timeout:3000,windowsHide:true});
  return /blender\.exe/i.test(out);
 }catch{return false;}
}

const line=text=>console.log(text);
line('AssetVault · Blender 桥接安装器');
line('='.repeat(58));
line('源文件：'+source);
line('');

const sourceText=readText(source);
if(sourceText===null){
 line('找不到桥接脚本：'+source);
 line('请确认本脚本位于 AssetVault 项目内的 scripts 目录。');
 process.exit(1);
}

// 先扫一遍，才知道每个目标是「新装」「更新」还是「已是最新」。
const roots=startupRoots();
const plan=[];
const missingRoots=[];
for(const base of roots){
 if(!existsDir(base)&&!/[\\/]startup$/i.test(base)){
  missingRoots.push(base);
  continue;
 }
 for(const startup of versionDirs(base)){
  const target=path.join(startup,installedName);
  const current=readText(target);
  plan.push({
   target,
   state:current===null?'missing':(current===sourceText?'current':'stale'),
  });
 }
}

if(!plan.length){
 line('没有找到任何 Blender 用户配置目录，无法安装。');
 line('');
 for(const base of (missingRoots.length?missingRoots:roots))line('  未发现：'+base);
 line('');
 line('原因通常是：这台电脑还没装过 Blender，或者装了但从未启动过。');
 line('请先启动一次 Blender（让它生成配置目录），然后重新运行本脚本。');
 line('');
 line('手动兜底：把 server\\blender-bridge.py 复制到');
 line('  %APPDATA%\\Blender Foundation\\Blender\\<版本>\\scripts\\startup\\');
 line('并改名为 '+installedName+'，然后重启 Blender。');
 process.exit(2);
}

const result=ensureBlenderBridgeInstalled();

line('安装结果：');
let fresh=0,updated=0,kept=0;
for(const item of plan){
 const label=item.state==='missing'?'新装  ':item.state==='stale'?'更新  ':'已是最新';
 if(item.state==='missing')fresh++;
 else if(item.state==='stale')updated++;
 else kept++;
 line(`  [${label}] ${item.target}`);
}
line('');
line(`合计：新装 ${fresh}，更新 ${updated}，已是最新 ${kept}`);
line('='.repeat(58));

if(result.errors?.length){
 line('以下位置写入失败：');
 for(const err of result.errors)line('  '+err);
 line('（若提示拒绝访问，请用管理员身份重新运行，或检查该目录是否为只读/同步盘冲突）');
}

const problems=(result.errors?.length||0)+(plan.length-(result.locations?.length||0));
if(problems&&!result.installed){
 line('');
 line('安装未成功。');
 process.exit(1);
}

line('');
if(fresh||updated){
 if(blenderRunning()){
  line('★ Blender 正在运行，现在请把它关掉再重新打开，桥接才会生效。');
 }else{
  line('★ 已安装完成。下次启动 Blender 时桥接会自动生效。');
 }
}else{
 line('所有位置的脚本都已是最新版，无需改动。');
 if(blenderRunning()){
  line('提示：如果之前是在旧脚本下启动的 Blender，仍需重启一次才能生效。');
 }else{
  line('提示：桥接会在 Blender 启动时自动生效。');
 }
}
line('');
line('验证：启动 Blender 后，AssetVault 里点「Blender」应能在 1~2 秒内导入。');
line('排错：桥接运行日志会出现在 Blender 的控制台，搜 "AssetVault Blender Bridge"。');
