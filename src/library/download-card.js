import {STEPS,STATE_LABELS,progressView,ACTIVE,WAITING,TERMINAL} from './download-progress.js';

/**
 * Task card rendering. One rule drives the whole layout: the card face carries only what a
 * glance needs (name, format badge, state, size/elapsed, a live bar), and everything that
 * belongs to diagnosis — step list, transfer counters, save path, checksum — lives inside
 * the per-task disclosure. Nothing is dropped, it only costs one click.
 */

/** Byte sizes stay human-readable; a missing total renders as an em dash, never as "NaN". */
export const sizeText=n=>!Number.isFinite(n)?'—':n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';

// The badge answers "what will land in my folder?" — content, model format and delivery in one line.
export const formatBadge=t=>{
 const o=t.options||{};
 const delivery=o.output==='folder'?'文件夹':'ZIP';
 if(t.kind==='artstation'){
  // A scene-less artwork never produces a mesh, so promising a GLB here would be a lie: what
  // actually lands on disk is the author's images (persisted as hasMarmoset on the job itself).
  if(t.hasMarmoset===false)return `作品图片 ${delivery}`;
  return `MARMOSET → ${o.format==='fbx'?'GLB + FBX':'GLB'} ${delivery}`;
 }
 if(t.kind==='images'){
  const src=t.platform==='polyhaven'?'Poly Haven 官方渲染图':t.platform==='ambientcg'?'ambientCG 官方缩略图':t.platform==='artstation'?'ArtStation 作品图片':'Sketchfab 封面原图';
  return `${src} ${delivery}`;
 }
 const format=o.format==='fbx'?'GLB + FBX':'GLB';
 const content=o.packMode==='model'?'模型+贴图':o.packMode==='glb'?'仅 GLB':'完整包';
 return `${content} · ${format} ${delivery}`;
};

export function createTaskCard({esc,icon,visitor=false}){
 const bar=view=>view.percent!==null
  ?`<progress max="100" value="${view.percent}" aria-label="${esc(view.label)}"></progress>`
  :view.active?`<progress aria-label="${esc(view.label)}"></progress>`:'<div class="progress-rest"></div>';
 const percent=view=>view.percent!==null?view.percent+'%':view.active?'处理中':'—';
 const heading=view=>`<div class="progress-heading"><strong>${esc(view.label)}</strong><span>${percent(view)}</span></div>`;
 const writeLine=t=>`本机写入 ${sizeText(t.bytesWritten)} / ${sizeText(t.totalBytes)} · ${sizeText(t.transferRate)}/s`;
 // Request counts and per-file failures are diagnostics; while running the byte count is the signal.
 const receivedLine=(t,view,n)=>{
  const parts=[`已接收 ${sizeText(n.received)}`];
  if(view.receiving&&view.rate)parts.push(sizeText(view.rate)+'/s');
  if(TERMINAL.has(t.state))parts.push(`完成 ${n.completed}/${n.requests} 个资源请求`);
  if(n.failed)parts.push(`${n.failed} 个请求失败`);
  return parts.join(' · ');
 };
 /** The card face while the task is live: label, bar, and the one number that changes. */
 const liveSection=(t,view,n)=>{
  const line=t.state==='transferring'?writeLine(t):view.receiving?receivedLine(t,view,n):'';
  return `<section class="job-progress is-live" aria-label="下载进度">${heading(view)}${bar(view)}${line?`<p class="network-facts">${line}</p>`:''}</section>`;
 };
 /** Hints explain why a number is a partial view; they cannot be guessed from the bar alone. */
 const hints=(t,view,n)=>{
  const out=[];
  if(view.receiving)out.push(`<p class="progress-hint">当前批次 ${sizeText(n.activeReceived)} / ${sizeText(n.activeTotal)} · ${n.active} 个请求；${n.activeTotal===null?'站点未提供可用总长度，显示不定进度':'此百分比不是整个任务进度'}</p>`);
  if(t.state==='running'&&!view.receiving)out.push('<p class="progress-hint">转换与打包由后台进程推进，没有整体百分比。</p>');
  out.push('<p class="progress-hint">资源按需获取，接收与转换阶段可能交替。</p>');
  return out;
 };
 const pathLine=t=>visitor?'<p class="job-path">任务由主机处理，完成后自动取回到此电脑的保存位置。</p>':t.state==='saved'
  ?`<p class="job-path" title="${esc(t.filePath)}">${icon('folder')}${esc(t.filePath)}</p>`
  :`<p class="job-path" title="${esc(t.downloadDir)}">${icon('folder')}保存到：${esc(t.downloadDir)}</p>`;
 // An image bundle is verified against its own manifest, so the shield line names images, not meshes.
 const verifiedLine=t=>{
  const images=t.verification?.images||[];
  const textures=t.verification?.textures||[];
  const what=textures.length?`已校验 ${textures.length} 张材质贴图与内容指纹`:images.length?`已校验 ${images.length} 张作品图片与内容指纹`:t.verification?.folder?'导出时已校验 GLB 网格与内容指纹':'初次保存时已校验 ZIP CRC + GLB 结构';
  return `<p class="verified">${icon('shield')}${what} · ${t.verification?.entries||0} 个文件 · SHA-256 <span title="${esc(t.verification?.sha256)}">${esc((t.verification?.sha256||'').slice(0,16))}…</span></p>`;
 };
 const detailBody=(t,view,n)=>{
  const parts=[];
  // A finished task keeps its final bar here, so "100%" is still one click away instead of always on screen.
  if(TERMINAL.has(t.state))parts.push(`<section class="job-progress" aria-label="下载进度">${heading(view)}${bar(view)}</section>`);
  parts.push(`<div class="progress-steps">${STEPS.map((name,i)=>`<span class="${i===view.step?'current':''}">${i+1} ${name}</span>`).join('')}</div>`);
  if(n&&!ACTIVE.has(t.state))parts.push(`<p class="network-facts">${receivedLine(t,view,n)}</p>`);
  if(ACTIVE.has(t.state))parts.push(...hints(t,view,n));
  parts.push(pathLine(t));
  if(t.state==='saved')parts.push(verifiedLine(t));
  return parts.join('');
 };
 const actions=(t,{busy,done,canCancel})=>[
  !visitor&&done&&t.fileExists?`<button data-dm-action="reveal" data-id="${t.id}">${icon('folder')}文件夹</button>`:'',
  done&&t.fileExists?`<button data-dm-action="download-local" data-id="${t.id}" title="保存到当前浏览器所在电脑；文件夹会打包为 ZIP（最大 2GB）">下载到我的电脑</button>`:'',
  canCancel?`<button data-dm-action="cancel" data-id="${t.id}">取消</button>`:'',
  ['queued','retry_wait'].includes(t.state)?`<button data-dm-action="hold" data-id="${t.id}">暂停</button>`:'',
  t.state==='held'?`<button data-dm-action="resume" data-id="${t.id}">继续</button>`:'',
  TERMINAL.has(t.state)&&!done?`<button data-dm-action="retry" data-id="${t.id}">重试</button>`:'',
  // 记录存在主机上，访客删了主机那边也没了 —— 同「清理记录」一起收掉，只留取消/暂停这类本机动作。
  !visitor&&!busy&&!WAITING.has(t.state)?`<button data-dm-action="remove" data-id="${t.id}" title="只删除记录，不删除文件">移除</button>`:''
 ].join('');
 return (t,{selected,openDetails,openLog}={})=>{
  const busy=ACTIVE.has(t.state),done=t.state==='saved';
  const canCancel=WAITING.has(t.state)||busy&&!['saving','cancelling'].includes(t.state);
  const elapsed=Math.max(0,((t.finishedAt||Date.now())-(t.startedAt||t.createdAt))/1000);
  const view=progressView(t),n=t.network;
  const status=done&&!t.fileExists?'文件已移动或删除':STATE_LABELS[t.state]||t.state;
  const error=['failed','interrupted'].includes(t.state)||done&&!t.fileExists;
  // "尝试 1 次" is the norm; attempts only earn space on the face once a retry actually happened.
  const facts=[sizeText(t.bytes||t.totalBytes),...(t.attempts>1?[`尝试 ${t.attempts} 次`]:[]),`${Math.floor(elapsed)}s`].join(' · ');
  // A completed task is already stated by the status line; "已保存到本机…" repeats it word for word.
  const message=done?'':`<p class="task-message">${esc(t.message)}</p>`;
  return `<article class="task ${busy?'task-running':''}" data-job="${t.id}"><div class="task-main"><label class="task-checkbox"><input type="checkbox" data-job-select="${t.id}" aria-label="选择任务 ${esc(t.name)}" ${selected?'checked':''}></label>${t.thumbnail?`<img class="task-image" src="/api/image?url=${encodeURIComponent(t.thumbnail)}" alt="" loading="lazy">`:`<div class="task-image task-cube">${icon('cube')}</div>`}<div class="task-summary"><h3>${esc(t.name)}<span class="job-format">${esc(formatBadge(t))}</span></h3><div class="task-status ${error?'error':''}">${busy?'<span class="spinner"></span>':''}${esc(status)} <span class="job-facts">${facts}</span></div>${message}${t.warning?`<p class="task-warning">${esc(t.warning)}</p>`:''}${busy?liveSection(t,view,n):''}</div><div class="task-actions">${actions(t,{busy,done,canCancel})}<button data-task-disclosure="details" aria-expanded="${!!openDetails}">详情</button><button data-task-disclosure="log" aria-expanded="${!!openLog}">日志</button></div></div><details class="task-details" data-kind="details" data-id="${t.id}" ${openDetails?'open':''}><summary>详情<span>${TERMINAL.has(t.state)?'保存位置 · 校验信息':'保存位置 · 进度明细'}</span></summary><div class="task-details-body">${detailBody(t,view,n)}</div></details><details class="task-log" data-kind="log" data-id="${t.id}" ${openLog?'open':''}><summary>任务日志 · ${t.logs.length} 条 · ${esc(t.author)} <span>${new Date(t.createdAt).toLocaleString()}</span></summary><div class="task-log-head"><button data-dm-action="log" data-id="${t.id}">导出日志</button><span>${esc(t.downloadDir)}</span></div><pre>${esc(t.logs.join('\n')||'任务尚未开始')}</pre></details></article>`;
 };
}
