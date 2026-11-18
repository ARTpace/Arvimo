/**
 * 首次运行的依赖准备：只确认资产保存位置和后台浏览器两件事。
 * 保存位置由前端单独处理，这里只查后台浏览器的真实状态（不猜、不缓存），
 * 并记住用户是否已经确认过——确认过就不再每次启动都弹。
 * Blender 与桥接仍保留在设置页的独立入口里，不占首次准备的篇幅。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveDataDir} from './data-dir.mjs';
import {browserStatus} from './browser-runtime.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
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
 * 后台浏览器的真实状态。state 的三种取值界面各有对应文案：
 *   ready    已就绪
 *   degraded 没装但有系统浏览器可顶替（能用，只是不稳）
 *   missing  缺，且可以就地补上
 */
export async function dependencyReport({downloads=null}={}){
 const browser=browserStatus();
 const browserBytes=browser.bytes?`（约 ${Math.round(browser.bytes/1048576)} MB）`:'';
 const items=[
  {
   id:'browser',title:'后台浏览器',
   why:'用于后台渲染网页，Sketchfab 转换与 ArtStation 读页需要它。',
   state:browser.installed?'ready':(browser.system?.found?'degraded':'missing'),
   detail:browser.installed
     ? `已就绪 · ${browser.version}${browserBytes}`
     : (browser.system?.found
        ? `检测到系统 ${browser.system.name}，可临时替代；专用浏览器更稳。`
        : '未安装，装好前 Sketchfab 转换会失败。'),
   action:browser.installed?'reinstall':'install',
   actionLabel:browser.installed?'重新下载':'一键下载',
   poll:'/api/browser/install',
  },
 ];
 const pending=items.filter(item=>item.state!=='ready').length;
 // Only blocking omissions warrant an automatic reminder, at most once per week after dismissal.
 const dismissedAt=setupState().dismissedAt;
 const remind=shouldRemindSetup(items,dismissedAt);
 return {done:setupState().done,ready:pending===0,pending,remind,items,blenderOverride:setupState().blenderOverride};
}
