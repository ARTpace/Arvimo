/**
 * 首次运行的依赖准备。
 *
 * 安装包里只带工作台自己，三样东西要落到用户本机才谈得上「完整可用」：
 *   1. 后台浏览器（chrome-headless-shell）—— Sketchfab 转换与 ArtStation 读页要用它渲染；
 *   2. Blender —— 导出 FBX、把模型送进已打开的场景都要它；
 *   3. Blender 桥接脚本 —— 写进 Blender 启动目录，工作台才能跟 Blender 说话。
 *
 * 这里只做两件事：把这三样的真实状态汇总成一份清单（不猜、不缓存），
 * 以及记住「用户是否已经确认过这份清单」——确认过就不再每次启动都弹。
 * 下载和安装各自沿用已有的一条路（browser-runtime / blender-import），不在这里另起一套。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveDataDir} from './data-dir.mjs';
import {browserStatus} from './browser-runtime.mjs';
import {blenderStatus} from './blender.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
/** Blender 没有官方直链可按版本稳定下载，所以只给官网入口 + 手动指定路径。 */
const BLENDER_DOWNLOAD_URL='https://www.blender.org/download/';
const DEFAULT={done:false,blenderOverride:'',finishedAt:null,dismissedAt:null};
const REMIND_INTERVAL_MS=7*24*60*60*1000;
/** A usable fallback is not a reason to interrupt startup. */
export function shouldRemindSetup(items,dismissedAt,now=Date.now()){
 if(!items.some(item=>item.state==='missing'||item.state==='blocked'))return false;
 const dismissed=Date.parse(dismissedAt);
 return !Number.isFinite(dismissed)||dismissed>now||now-dismissed>=REMIND_INTERVAL_MS;
}
const stateFile=()=>path.join(resolveDataDir(root).dir,'setup-state.json');

export function setupState(){
 try{
  const raw=JSON.parse(fs.readFileSync(stateFile(),'utf8'))||{};
  return {
   done:!!raw.done,
   blenderOverride:typeof raw.blenderOverride==='string'?raw.blenderOverride:'',
   finishedAt:typeof raw.finishedAt==='string'?raw.finishedAt:null,
   dismissedAt:typeof raw.dismissedAt==='string'?raw.dismissedAt:null,
  };
 }catch{return {...DEFAULT};}
}

export function updateSetup(patch){
 const next={...setupState(),...patch};
 try{fs.mkdirSync(path.dirname(stateFile()),{recursive:true});fs.writeFileSync(stateFile(),JSON.stringify(next));}catch{}
 return next;
}

/**
 * 启动时把用户手动指定的 Blender 接回去。
 * blender.mjs 只认环境变量 SFX_BLENDER，而且是在解析的那一刻才读，
 * 所以只要在服务起来之前把值塞回去，FBX 导出和「发送到 Blender」整条链路都自动生效。
 */
export function applyBlenderOverride(){
 const override=setupState().blenderOverride;
 if(override&&!process.env.SFX_BLENDER)process.env.SFX_BLENDER=override;
}

/** 手动指定 blender：先确认它真是个文件再说，免得把一条坏路径存下去还显示「已配置」。 */
export function setBlenderPath(input){
 const value=String(input||'').trim();
 if(!value){delete process.env.SFX_BLENDER;return {...updateSetup({blenderOverride:''}),applied:false};}
 let ok=false;try{ok=fs.statSync(value).isFile();}catch{}
 if(!ok)throw Error('这个路径不是可执行文件：'+value);
 process.env.SFX_BLENDER=value;
 return {...updateSetup({blenderOverride:value}),applied:true};
}

/**
 * 三样依赖的真实状态。state 的四种取值界面各有对应文案：
 *   ready   已就绪
 *   degraded 没装但有系统浏览器可顶替（能用，只是不稳）
 *   missing 缺，且可以就地补上
 *   blocked 缺，但得先装 Blender 才能补
 */
export async function dependencyReport({downloads=null}={}){
 const browser=browserStatus();
 const blender=blenderStatus();
 let bridge=null,bridgeError=null;
 if(downloads?.blenderBridge){
  try{bridge=await downloads.blenderBridge();}catch(e){bridgeError=String(e?.message||e);}
 }
 const targets=(bridge&&bridge.targets)||[];
 const bridgeReady=!!bridge&&!bridgeError&&bridge.sourceReady&&targets.length>0&&targets.every(t=>t.state==='current');
 const browserBytes=browser.bytes?`（约 ${Math.round(browser.bytes/1048576)} MB）`:'';
 const items=[
  {
   id:'browser',title:'后台浏览器',
   why:'Sketchfab 模型转换、ArtStation 页面读取都要它在后台真实渲染网页。',
   state:browser.installed?'ready':(browser.system?.found?'degraded':'missing'),
   detail:browser.installed
     ? `已就绪 · ${browser.version}${browserBytes}`
     : (browser.system?.found
        ? `还没下载。已检测到系统 ${browser.system.name} 可以临时顶替，但它可能被安全软件拦下。`
        : '还没下载。装好之前 Sketchfab 转换会直接失败。'),
   action:browser.installed?'reinstall':'install',
   actionLabel:browser.installed?'重新下载':'一键下载',
   poll:'/api/browser/install',
  },
  {
   id:'blender',title:'Blender',
   why:'导出 FBX，以及把模型一键送进已经打开的 Blender 场景。',
   state:blender.available?'ready':'missing',
   detail:blender.available
     ? `已检测到：${blender.path}`
     : '本机没找到 Blender。装好后回来点「重新检测」，或直接把 blender.exe 的完整路径粘进下面。',
   action:blender.available?'none':'manual',
   actionLabel:'去官网下载',
   downloadUrl:BLENDER_DOWNLOAD_URL,
  },
  {
   id:'bridge',title:'Blender 桥接脚本',
   why:'把下载好的模型直接送进当前打开的 Blender 场景，不用手动导入。',
   state:!blender.available?'blocked':(bridgeReady?'ready':'missing'),
   detail:!blender.available
     ? '得先有 Blender，桥接脚本才能写进它的启动目录。'
     : bridgeError?`读取桥接状态失败：${bridgeError}`
     : bridgeReady?`已写入 ${targets.length} 个版本目录，端口 ${bridge.port}${bridge.blenderRunning?' · Blender 正在运行':' · Blender 未运行'}`
     : '还没装进 Blender 的启动目录，或已装的版本过期了。',
   action:!blender.available?'none':'install',
   actionLabel:bridgeReady?'重新安装':'安装 / 更新',
   poll:'/api/downloads/blender-bridge/install',
  },
 ];
 const pending=items.filter(item=>item.state!=='ready').length;
 // Only blocking omissions warrant an automatic reminder, at most once per week after dismissal.
 const dismissedAt=setupState().dismissedAt;
 const remind=shouldRemindSetup(items,dismissedAt);
 return {done:setupState().done,ready:pending===0,pending,remind,items,blenderOverride:setupState().blenderOverride};
}
