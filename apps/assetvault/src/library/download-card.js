import {STEPS,STATE_LABELS,progressView,ACTIVE,WAITING,TERMINAL} from './download-progress.js';
import {chineseError} from './error-message.js';

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
 if(t.kind==='media')return t.assetType==='audio'?'音频 · 原始文件':'视频 / 图集 · 原始媒体';
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
 const liveSection=(t,view)=>`<section class="job-progress is-live" aria-label="下载进度">${bar(view)}${view.percent!==null?`<span class="task-progress-percent">${view.percent}%</span>`:''}</section>`;
 /** Hints explain why a number is a partial view; they cannot be guessed from the bar alone. */
 const hints=(t,view,n)=>{
  const out=[];
  if(view.receiving)out.push(`<p class="progress-hint">当前批次 ${sizeText(n.activeReceived)} / ${sizeText(n.activeTotal)} · ${n.active} 个请求；${n.activeTotal===null?'站点未提供可用总长度，显示不定进度':'此百分比不是整个任务进度'}</p>`);
  if(t.state==='running'&&!view.receiving)out.push('<p class="progress-hint">转换与打包由后台进程推进，没有整体百分比。</p>');
  out.push('<p class="progress-hint">资源按需获取，接收与转换阶段可能交替。</p>');
  return out;
 };
 const pathLine=t=>visitor?'<p class="job-path">任务由主机处理，完成后自动取回到此电脑的保存位置。</p>':t.filePath&&t.fileExists
  ?`<p class="job-path" title="${esc(t.filePath)}">${icon('folder')}${esc(t.filePath)}${t.state==='saved'?'':'（下载中，可先打开）'}</p>`
  :`<p class="job-path" title="${esc(t.downloadDir)}">${icon('folder')}保存到：${esc(t.downloadDir)}</p>`;
 // An image bundle is verified against its own manifest, so the shield line names images, not meshes.
 const verifiedLine=t=>{
  const images=t.verification?.images||[];
  const textures=t.verification?.textures||[];
  const what=t.kind==='media'?'已校验媒体清单、文件内容与来源':textures.length?`已校验 ${textures.length} 张材质贴图与内容指纹`:images.length?`已校验 ${images.length} 张作品图片与内容指纹`:t.verification?.folder?'导出时已校验 GLB 网格与内容指纹':'初次保存时已校验 ZIP CRC + GLB 结构';
  return `<p class="verified">${icon('shield')}${what} · ${t.verification?.entries||0} 个文件 · SHA-256 <span title="${esc(t.verification?.sha256)}">${esc((t.verification?.sha256||'').slice(0,16))}…</span></p>`;
 };
 const detailBody=(t,view,n)=>`<p class="task-format-detail">${esc(formatBadge(t))}</p>${pathLine(t)}${t.fbx?`<p class="task-warning">${esc(t.fbx.message)}${t.fbx.filePath?` · ${esc(t.fbx.filePath)}`:''}</p>`:''}${t.warning?`<p class="task-warning">${esc(t.warning)}</p>`:''}<div class="task-detail-log-head"><strong>最近日志</strong><button data-dm-action="log" data-id="${t.id}">${icon('download')}导出日志</button></div><pre>${esc((t.logs||[]).slice(-30).join('\n')||'暂无日志')}</pre>`;
 const actions=(t,{busy,done,canCancel})=>[
  // 图片包是边下边写的：第一张图落地后文件夹就已经存在，不必等任务结束才给入口。
  !visitor&&t.fileExists?`<button data-dm-action="reveal" data-id="${t.id}">${icon('folder')}文件夹</button>`:'',
  !visitor&&done&&t.fileExists&&t.verification?.folder&&t.verification?.glbs?.length?`<button data-dm-action="convert-fbx" data-id="${t.id}"${t.fbx?.state==='running'?' disabled':''}>${icon('cube')}${t.fbx?.state==='running'?'转换 FBX 中…':t.fbx?.state==='saved'?'重新转换 FBX':'转换 FBX'}</button>`:'',
  canCancel?`<button data-dm-action="cancel" data-id="${t.id}">${icon('close')}取消</button>`:'',
  ['queued','retry_wait'].includes(t.state)?`<button data-dm-action="hold" data-id="${t.id}">${icon('pause')}暂停</button>`:'',
  t.state==='held'?`<button data-dm-action="resume" data-id="${t.id}">${icon('play')}继续</button>`:'',
  TERMINAL.has(t.state)&&!done?`<button data-dm-action="retry" data-id="${t.id}">${icon('rotate')}重试</button>`:'',
  // 记录存在主机上，访客删了主机那边也没了 —— 同「清理记录」一起收掉，只留取消/暂停这类本机动作。
  !visitor&&!busy&&!WAITING.has(t.state)?`<button data-dm-action="remove" data-id="${t.id}" title="只删除记录，不删除文件">${icon('trash')}移除</button>`:''
 ].join('');
 return t=>{
  t={...t,warning:chineseError(t.warning)};
  const busy=ACTIVE.has(t.state),done=t.state==='saved';
  const canCancel=WAITING.has(t.state)||busy&&!['saving','cancelling'].includes(t.state);
  const elapsed=Math.max(0,((t.finishedAt||Date.now())-(t.startedAt||t.createdAt))/1000);
  const view=progressView(t),n=t.network;
  const status=done&&!t.fileExists?'文件已移动或删除':busy?view.label:STATE_LABELS[t.state]||t.state;
  const error=['failed','interrupted'].includes(t.state)||done&&!t.fileExists;
  // "尝试 1 次" is the norm; attempts only earn space on the face once a retry actually happened.
  const facts=[sizeText(t.bytes||t.totalBytes),...(t.attempts>1?[`尝试 ${t.attempts} 次`]:[]),`${Math.floor(elapsed)}s`].join(' · ');
  // A completed task is already stated by the status line; "已保存到本机…" repeats it word for word.
  const message=t.fbx?.state==='failed'?`<p class="task-message">${esc(t.fbx.message)}（GLB 已保留）</p>`:error?`<p class="task-message" title="${esc(chineseError(t.message,{fallback:true}))}">${esc(chineseError(t.message,{fallback:true}))}</p>`:'';
  return `<article class="task ${busy?'task-running':''}" data-job="${t.id}"><div class="task-main">${t.thumbnail?`<img class="task-image" src="/api/image?url=${encodeURIComponent(t.thumbnail)}" alt="" loading="lazy">`:`<div class="task-image task-cube">${icon('cube')}</div>`}<div class="task-summary"><h3>${esc(t.name)}<span class="job-format">${esc(formatBadge(t))}</span></h3><div class="task-status ${error?'error':''}">${busy?'<span class="spinner"></span>':''}${esc(status)} <span class="job-facts">${facts}</span></div>${message}${busy?liveSection(t,view):''}</div><div class="task-actions">${actions(t,{busy,done,canCancel})}<button data-task-disclosure="details" data-id="${t.id}" aria-haspopup="dialog">${icon('list')}详情</button></div></div><template data-task-detail>${detailBody(t,view,n)}</template></article>`;
 };
}
