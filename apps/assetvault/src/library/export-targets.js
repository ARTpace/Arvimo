// Client side of the multi-target "send to" feature.
//
// The registry here mirrors server/export-targets.mjs. Adding a destination is a one-line entry in
// each. The classification reuses classifyBlenderJob (the same job→mode logic the old Blender-only
// button used) so a material still says "材质", an HDRI still says "环境", and a model still says
// "模型" — just now spread across every applicable target instead of a single hardcoded Blender key.
//
// 交互是两步：先在「发送到」里挑目标（挑完按键上显示软件名），再点旁边的图标键才真正导出。
// 一步到位的手滑风险太大——选错目标就直接把成品推给了错误的软件，改起来比重选一次麻烦得多。
import {classifyBlenderJob} from './blender-send.js';

/** Mirror of the server TARGETS array. `icon` falls back to a cube if a dedicated icon is missing. */
export const TARGETS=[
  {id:'blender', label:'Blender', kind:'bridge', engine:false, deliver:['material','model','hdri'], icon:'blender'},
  {id:'unity',   label:'Unity',   kind:'dir', engine:true,  deliver:['material','model'], icon:'unity'},
  {id:'unreal',  label:'Unreal Engine', kind:'dir', engine:true,  deliver:['model'], icon:'unreal'},
  {id:'godot',   label:'Godot',   kind:'dir', engine:true,  deliver:['model'], icon:'godot'},
  {id:'maya',    label:'Maya',    kind:'dcc', engine:false, deliver:['model'], icon:'maya'},
  {id:'3dsmax',  label:'3ds Max', kind:'dcc', engine:false, deliver:['model'], icon:'max'},
  {id:'houdini', label:'Houdini', kind:'dcc', engine:false, deliver:['model'], icon:'houdini'},
  {id:'c4d',     label:'Cinema 4D', kind:'dcc', engine:false, deliver:['model'], icon:'c4d'},
];

export const targetById=id=>TARGETS.find(t=>t.id===id)||null;

/** Which targets can take this job. HDRI only Blender; material/model go to bridge + dir targets. */
export function applicableTargets(job,{isVisitor=false}={}){
  const mode=classifyBlenderJob(job);
  if(!mode)return [];
  return TARGETS.filter(t=>{
    // 访客没有主机磁盘写权限，也不可能在本机桥接里接材质/HDRI（猜不出贴图槽），
    // 所以访客只能把整包模型推给自己电脑上的 Blender。
    if(isVisitor)return t.id==='blender'&&mode==='model';
    return t.deliver.includes(mode);
  });
}

/* 用户挑的目标按 job 记住。卡片会因为队列脉冲、筛选切换而整片重渲染，状态放 DOM 里
 * 会被冲掉，放模块里才能在重渲染后接着显示同一个软件名。 */
const pickedTargets=new Map();
/** 这个 job 选过的目标（没选过就是 null）。 */
export function selectedTargetFor(jobId){
  return jobId?pickedTargets.get(jobId)||null:null;
}
/** 记住选择，返回真正生效的目标对象（目标不存在就不记）。 */
export function setSelectedTarget(jobId,targetId){
  if(!jobId||!targetId)return null;
  const target=targetById(targetId);
  if(!target)return null;
  pickedTargets.set(jobId,target);
  return target;
}

/**
 * 实际生效的目标：用户选过就用选的，没选过就用适用清单里的第一个（Blender）。
 * 有默认值的意义是导出键永远可点 —— 否则用户得先学会怎么点那个小三角才能用。
 */
export function effectiveTarget(jobId,targets){
  const list=targets||[];
  if(!list.length)return null;
  return selectedTargetFor(jobId)||list[0];
}

/**
 * Renders the export control: a text button that picks the target, plus an icon-only button
 * that performs the export.
 *
 * The menu itself is NOT rendered here: the card has both overflow:hidden (rounded thumbnail)
 * and a hover transform, and a transformed ancestor turns position:fixed children into
 * "relative to the card" — the popover gets positioned inside the card and clipped away, which
 * looks exactly like a button that does nothing. app.js therefore mounts the menu on <body> on
 * click, and this module only decides which targets are applicable.
 */
export function createSendMenu({icon,esc}){
  return function sendControl({job,className='secondary',isVisitor=false}){
    if(!job)return '';
    const targets=applicableTargets(job,{isVisitor});
    if(!targets.length)return '';
    const chosen=effectiveTarget(job.id,targets);
    const tip=chosen?`导出到 ${chosen.label}（点击可更换）`:'选择导出软件';
    const goTip=chosen?`导出到 ${chosen.label}`:'先选择导出软件';
    return `<div class="export-control" data-job="${esc(job.id)}">`
      +`<button class="${className} export-toggle" data-action="export-toggle" data-id="${esc(job.id)}" type="button" aria-haspopup="true" aria-expanded="false" title="${esc(tip)}" aria-label="${esc(tip)}">${icon('share')}<span>${esc(chosen.label)}</span></button>`
      +`<button class="export-go" data-action="export-go" data-id="${esc(job.id)}" data-target="${esc(chosen.id)}" type="button" title="${esc(goTip)}" aria-label="${esc(goTip)}">${icon('export')}</button>`
      +`</div>`;
  };
}

/** Menu markup for the given targets. Kept next to the registry so both ends agree on the list. */
export function exportMenuHtml(targets,{icon,esc}){
  // 菜单按 job 打开，所以清单里所有目标属于同一个 job，当前生效的那一个打勾。
  const jobId=targets[0]?.jobId||'';
  const cur=effectiveTarget(jobId,targets);
  return `<div class="export-menu-head">选择导出软件</div>`
    +targets.map(t=>{
      const on=cur?.id===t.id;
      return `<button class="export-item${on?' on':''}" role="menuitem" type="button" data-action="export-pick" data-target="${esc(t.id)}" data-id="${esc(t.jobId||'')}" title="导出到 ${esc(t.label)}">${icon(t.engine?'engine':t.id==='blender'?'blender':'cube')}<span>${esc(t.label)}</span></button>`;
    }).join('');
}
