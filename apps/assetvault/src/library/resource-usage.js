import {icon} from './icon-set.js';
import {esc} from './html-esc.js';
import {createAssetAudit} from './asset-audit.js';

const bytes=value=>!Number.isFinite(value)?'不可用':value>=1024**3?`${(value/1024**3).toFixed(2)} GB`:`${(value/1024**2).toFixed(1)} MB`;
const percent=value=>`${Number(value||0).toFixed(1)}%`;

export function resourceUsageHtml(data){
 const memory=data.memory;
 const used=memory.used??Math.max(0,memory.total-memory.available);
 const bar=(value,tone)=>`<span class="ru-bar-${tone}" style="width:${Math.max(0,Math.min(100,value/memory.total*100)).toFixed(2)}%"></span>`;
 return `<div class="ru-totals"><div><span>${icon('file')}工具私有驻留内存</span><strong>${bytes(memory.privateWorkingSet)}</strong><small>${data.processes} 个进程 · 不含共享页和独立显存</small></div><div><span>${icon('pulse')}工具 CPU</span><strong>${data.cpu.pending?'采样中':percent(data.cpu.percent)}</strong><small>100% = 占用 1 个逻辑核心</small></div></div>
 <p class="ru-note ru-memory-details">工作集汇总 ${bytes(memory.workingSet??memory.app)}（共享页可能重复） · 私有提交 ${bytes(memory.privateCommit)}（不等于驻留物理内存）</p>
 <div class="ru-memory-bar" role="img" aria-label="系统物理内存：已用 ${bytes(used)}，可用 ${bytes(memory.available)}">${bar(used,'other')}${bar(memory.available,'free')}</div>
 <div class="ru-legend"><span><i class="ru-dot-other"></i>系统已用 ${bytes(used)}（含 Arvimo 与共享页）</span><span><i class="ru-dot-free"></i>可用 ${bytes(memory.available)}</span></div>
 ${data.scope==='backend'?'<p class="ru-note">当前统计后台服务及其子进程，未关联到桌面主程序；独立浏览器窗口不计入。</p>':''}
 ${data.partial?'<p class="ru-note">当前系统无法枚举子进程，仅显示后台服务。</p>':''}
 <div class="ru-table-scroll"><table class="ru-table"><thead><tr><th>模块</th><th>进程</th><th>私有驻留</th><th>工作集</th><th>私有提交</th><th>CPU</th></tr></thead><tbody>${data.groups.map(group=>`<tr><th>${esc(group.label)}</th><td>${group.processes}</td><td>${bytes(group.privateWorkingSet)}</td><td>${bytes(group.memory)}</td><td>${bytes(group.privateCommit)}</td><td>${group.cpuPending?'采样中':percent(group.cpu)}</td></tr>`).join('')}</tbody></table></div>
 <p class="ru-note">${data.cores} 个逻辑核心 · CPU 可超过 100% · 私有驻留仅统计各进程独占的物理页，不代表应用全部物理占用；私有提交包含未驻留部分。无法读取的计数显示“不可用”。</p>`;
}

export function createResourceUsagePanel({entry,notify=()=>{},fetchImpl=fetch,interval=3000,audit=null}={}){
 if(!entry)return;
 // 2026-11-18：原「资源占用」独立面板把「资产检查」也收进来，改名「工具检测」。
 // 上半块是进程采样（下面那套逻辑搬进来照旧），下半块挂 createAssetAudit 的一致性检查。
 const dialog=document.createElement('dialog');dialog.className='ru-dialog tool-check-dialog';dialog.setAttribute('aria-label','工具检测');
 dialog.innerHTML=`<div class="dialog-header"><span>${icon('scan')}工具检测</span><button type="button" class="icon-button" data-ru-close aria-label="关闭工具检测">${icon('close')}</button></div><div class="ru-toolbar"><span class="ru-status" role="status">仅在打开时采样</span><button type="button" class="secondary" data-ru-copy disabled>${icon('copy')}复制诊断</button></div><div class="ru-content" aria-live="off"><section class="tc-block tc-usage" data-tc-usage></section>${audit?'<section class="tc-block tc-audit" data-tc-audit></section>':''}</div>`;
 document.body.append(dialog);
 const content=dialog.querySelector('[data-tc-usage]'),status=dialog.querySelector('.ru-status'),copy=dialog.querySelector('[data-ru-copy]');
 let timer=null,controller=null,revision=0,latest=null,auditBlock=null;
 // 检查那块只在第一次打开时挂载，之后每次打开 reload：启动就跑一遍全库比对太浪费。
 const openAudit=()=>{
  const host=dialog.querySelector('[data-tc-audit]');
  if(!host)return;
  if(!auditBlock)auditBlock=createAssetAudit({host,fetchImpl,...audit});
  else auditBlock.reload();
 };
 const active=()=>dialog.open&&!document.hidden;
 function stop(){revision++;clearTimeout(timer);timer=null;controller?.abort();controller=null;}
 async function refresh(){
  if(!active())return;
  const token=revision;
  controller=new AbortController();
  try{
   const response=await fetchImpl('/api/resource-usage',{headers:{'X-SFX-Local':'1'},cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
   const data=await response.json();if(!response.ok)throw Error(data.error||'采样失败');
   if(token!==revision||!active())return;
   latest=data;copy.disabled=false;content.innerHTML=resourceUsageHtml(data);
   status.textContent=`${data.cpu.pending?'正在计算 CPU…':'实时采样'} · ${new Date(data.at).toLocaleTimeString('zh-CN',{hour12:false})}`;
  }catch(error){if(token===revision&&active())status.textContent=error.name==='TimeoutError'?'采样超时，下轮自动重试':error.message;}
  finally{if(token===revision&&active())timer=setTimeout(refresh,interval);}
 }
 const open=()=>{
  if(dialog.open)return;
  stop();latest=null;copy.disabled=true;content.textContent='正在读取进程信息…';status.textContent='仅在打开时采样';
  dialog.showModal();refresh();openAudit();
 };
 entry.onclick=open;
 dialog.querySelector('[data-ru-close]').onclick=()=>dialog.close();
 dialog.addEventListener('close',stop);
 document.addEventListener('visibilitychange',()=>{stop();if(active())refresh();});
 copy.onclick=async()=>{
  if(!latest)return;
  try{await navigator.clipboard.writeText(JSON.stringify({application:'Arvimo',...latest},null,2));notify('已复制资源占用诊断');}
  catch{notify('复制失败，请检查剪贴板权限');}
 };
 return {dialog,open};
}
