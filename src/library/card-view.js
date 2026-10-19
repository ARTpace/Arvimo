// The model card: how one asset looks in the grid and the waterfall view.
//
// Everything here is presentation, and everything it reads about an asset (does it have a local
// file? is it in the library? is the artwork a Marmoset scene?) is decided outside. That split is
// why this file can be grown or restyled without touching how the grid decides what to render.
// Two collaborators are passed as getters because they are wired up later than this module exists.
import {coverRendition} from './gallery-view.js';
import {classifyBlenderJob} from './blender-send.js';

export function createCardView({icon,esc,fmt,state,queuePulse,imageDownload,blenderSendButton,platformLabel,artstationUI=()=>null,downloadsUI=()=>null}){
/** 封面一律走本地代理，代理负责按需降级到能取到的档位；
 *  画廊额外点名要轻一档的等比图，好让瀑布流按原图比例排且不吃带宽。 */
function imageUrl(model,{gallery=false}={}){
 if(!model.thumbnail)return '';
 const rendition=coverRendition({platform:model.platform,gallery});
 return `/api/image?url=${encodeURIComponent(model.thumbnail)}${rendition?`&rendition=${rendition}`:''}`;
}
/** 材质精度选择（卡片下载键左边、预览面板各一份，同一份标记）：选择经全局 change 委托写回
 *  模型对象，重渲染按它回填，下载时队列从同一个字段读——不复制第二份状态。 */
function isMaterial(m){return m.platform==='ambientcg'||m.platform==='polyhaven'&&m.assetType==='textures'||m.platform==='freestylized'&&m.assetType==='textures';}
/** Poly Haven 的缩略图是官方按资产形状竖/横排的（models 竖幅 148×256~193×255、hdris 横幅 256×192、
 *  textures 近方 255×256），而卡片是 1:1 容器 + object-fit:cover —— 直接 cover 会把模型切掉上半、把全景切掉两端。
 *  ambientCG / FreeStylized 的贴图同理。所以这两个平台的缩略图一律完整显示（contain），不做裁切。
 *  归到独立标记而不是复用 isMaterial：那只是「是不是贴图」，与「要不要裁切」无关。 */
function needsFullThumb(m){return m.platform==='polyhaven'||m.platform==='ambientcg'||m.platform==='freestylized';}
function isHdri(m){return m.platform==='polyhaven'&&m.assetType==='hdris';}
/** 许可标识只留缩写：「CC0 1.0 通用公共领域贡献」→ CC0，完整许可说明留在 title 里。
 *  卡片标题行要放标题、作者、许可三样，全称会把标题挤没（2026-10-16 用户要求简化）。 */
function shortLicense(l){
 const s=String(l||'').trim();
 if(!s)return '查看许可';
 const m=s.match(/^(CC0|CC BY-NC(?:-ND|-SA)?|CC BY-(?:ND|SA)|CC BY)/i);
 return m?m[1].toUpperCase():s;
}
/** 精度下拉里给已下载的档位打勾：只下载过 4K 时，1K/2K/8K 都不该被误标。
 *  downloadedRes 由卡片侧从后端任务现算（state==='saved' 且文件还在，无 options 的老任务算默认 2K）。 */
function materialResolutionSelect(m,downloadedRes=new Set()){
 if(!isMaterial(m)&&!isHdri(m)&&!(m.platform==='freestylized'&&m.assetType==='skybox'))return '';
 return `<select class="material-resolution" data-material-resolution="${m.uid}" aria-label="材质下载精度" title="材质贴图下载精度（✓ = 已下载）">${['1K','2K','4K','8K'].map(r=>`<option value="${r}"${(m.materialResolution||'2K')===r?' selected':''}>${r}${downloadedRes.has(r)?' ✓':''}</option>`).join('')}</select>`;
}
function card(m,{gallery=false}={}){
 const art=m.platform==='artstation',art3d=art&&artstationUI().has3dScene(m),saved=state.favorites.has(m.uid),collected=state.models.some(x=>x.uid===m.uid),selected=state.selected.has(m.uid),backendJobs=downloadsUI()?.jobs||[],task=backendJobs.findLast(t=>t.uid===m.uid)||state.tasks.findLast(t=>t.uid===m.uid);
 // 有精度选择的资产（材质/HDRI/天空盒），「已下载」必须按精度对上：8K 下载过不代表 2K 也
 // 有了。历史任务没记精度的一律视为默认 2K，老记录不会集体变灰。
 const hasResSelect=isMaterial(m)||isHdri(m)||m.platform==='freestylized'&&m.assetType==='skybox';
 const wantedRes=m.materialResolution||'2K';
 const savedJob=backendJobs.findLast(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.id&&(!hasResSelect||(t.options?.resolution||'2K')===wantedRes));
 const pulse=queuePulse.has(m.uid)&&Date.now()-queuePulse.get(m.uid)<6000;
 const busy=pulse||task&&['queued','held','retry_wait','running','transferring','validating','saving','cancelling'].includes(task.state),downloaded=!!savedJob||task&&task.fileExists!==false&&['saved','sent'].includes(task.state)&&(!hasResSelect||(task.options?.resolution||'2K')===wantedRes);
 // 已下载的精度集合：喂给精度下拉打勾用。与 savedJob 同一判据（saved + 文件还在），
 // 只是不收窄到当前所选精度——四档里哪几档下过都要标出来。
 const downloadedRes=hasResSelect?new Set(backendJobs.filter(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.id).map(t=>t.options?.resolution||'2K')):new Set();
 // 媒体区的入口两种视图都有：有 Marmoset 场景的开 3D 预览弹窗，纯图片作品直接开官方作品页
 // ——没有场景的图片套一层弹窗等于白点，用户要的是这张图的出处。
 // Poly Haven 只有 models 有网格可转，HDRI 是全景图、贴图是平铺图，转不了视角就别写「3D 预览」。
 // FreeStylized 的资源包 / Alpha / 智能材质里没有可渲染的东西（点开是官方页面），角标跟着改。
 const fsNoScene=m.platform==='freestylized'&&!['models','textures','skybox'].includes(m.assetType||'models');
 const previewLabel=art&&!art3d?'打开作品页':fsNoScene?'打开官方页面':'交互式 3D 预览';
 const previewIcon=art&&!art3d||fsNoScene?'external':'rotate';
 // 缩略图上的两个角标：左下角是「加入模型库」状态（点一下即加入），右下角是打开下载文件夹
 // （只有已下载的卡片才有）。多选复选框因此挪到右上角收藏键左边，四个角各司其职不重叠。
 const openFolder=savedJob?`<button class="card-icon-action open-folder" data-action="reveal-download" data-id="${esc(savedJob.id)}" title="打开下载所在文件夹" aria-label="打开下载所在文件夹">${icon('folder')}</button>`:'';
 const collectedBadge=`<button class="collect-badge ${collected?'collected':''}" data-action="collect" data-uid="${m.uid}" ${collected?'disabled':''} title="${collected?'已在模型库中':'加入模型库'}" aria-label="${collected?'已加入模型库':'加入模型库'}">${icon(collected?'check':'folder')}<span>${collected?'已加入模型库':'加入模型库'}</span></button>`;
  // 材质资产送进 Blender 是「建材质」、HDRI/天空盒是「设环境」，按钮文案跟着 job 的
  // kind/assetType 走。判定与服务端 sendToBlender 同一份逻辑（classifyBlenderJob），
  // 保证卡片、预览面板、后端三处一致，不会一个说「材质」一个发模型。
  const fsKind=classifyBlenderJob(savedJob);
  const blenderButton=blenderSendButton({job:savedJob,className:'card-download blender-download',label:fsKind==='material'?'材质':fsKind==='hdri'?'环境':'Blender'});
 // 封面图下载功能已移除：卡片不再提供单独的「下载封面图」入口。
 // ambientCG 卡片在下载键左边带一个精度选择：选择写回模型对象（materialResolution），
 // 重渲染后原样回填；下载时队列从模型上读，整批取第一张的选择（服务端会再校验一次）。
 const materialResolution=materialResolutionSelect(m,downloadedRes);
 // meta 一行化：作者与平台标签重复时（如 ambientCG）不再显示，只留「标题 · 作者 · 许可」。
 const byline=m.author&&m.author.trim()!==platformLabel(m.platform)?`<span class="card-byline" title="${esc(m.author)}">${esc(m.author)}</span>`:'';
 // 控件拆成可复用的片段：紧凑视图缩略图只有 96px，角标与按键全叠在上面等于糊成一团，
 // 所以紧凑视图把它们整体搬进右侧信息栏（图片本身不再叠层，标题与预览键仍可打开预览）。
 // 左上角只放资源类型标志（模型/材质/HDRI/天空盒…）。下载与导出状态由左下角「已加入模型库」、
 // 右下角文件夹键和底部下载键各自表达，不再挤占类型位（2026-10-16 用户要求）。
 const typeLabel=`<div class="card-type">${icon(art3d?'rotate':isHdri(m)?'image':isMaterial(m)?'image':'cube')}${art?(art3d?'MARMOSET 3D':'ARTSTATION 图片'):isHdri(m)?'HDRI':isMaterial(m)?'PBR 材质':m.platform==='kenney'?'资源包':m.platform==='freestylized'?(m.assetType==='skybox'?'天空盒':m.assetType==='textures'?'材质':m.assetType==='packs'?'资源包':m.assetType==='alphas'?'Alpha':m.assetType==='smart'?'智能材质':'3D 模型'):'3D ASSET'}</div>`;
 const favoriteButton=`<button class="favorite ${saved?'saved':''}" data-action="favorite" data-uid="${m.uid}" title="${saved?'取消收藏（仍保留在模型库）':'收藏并加入模型库'}" aria-label="${saved?'取消收藏':'收藏模型'}" aria-pressed="${saved}">${icon('heart')}</button>`;
 const selectLabel=`<label class="card-select"><input type="checkbox" data-select="${m.uid}" aria-label="选择 ${esc(m.name)}" ${selected?'checked':''}></label>`;
 // gallery 视图虽然 state.compact 可能仍为 true，但样式类不挂 compact，这里必须同步判断。
 const compact=!!state.compact&&!gallery;
 const controls=compact?`<div class="card-controls">${typeLabel}${selectLabel}${favoriteButton}<button class="card-icon-action compact-preview" data-action="preview" data-uid="${m.uid}" title="${previewLabel}" aria-label="${previewLabel} ${esc(m.name)}">${icon(previewIcon)}</button>${collectedBadge}${openFolder}</div>`:'';
 return `<article class="model-card ${selected?'selected':''} ${needsFullThumb(m)?'thumb-contain':''}" data-uid="${m.uid}"><div class="card-media">${m.thumbnail?`<img class="thumbnail" src="${esc(imageUrl(m,{gallery}))}" alt="${esc(m.name)}" loading="lazy">`:`<div class="image-placeholder">${icon('cube')}<span>暂无缩略图</span></div>`}${compact?'':`<button class="preview-hit" data-action="preview" data-uid="${m.uid}" aria-label="${previewLabel} ${esc(m.name)}"><span>${icon(previewIcon)}${previewLabel}</span></button>${typeLabel}${favoriteButton}${selectLabel}${collectedBadge}${openFolder}`}${controls}</div><div class="card-meta"><button class="card-title" title="${esc(m.name)}" data-action="preview" data-uid="${m.uid}">${esc(m.name)}</button>${byline}<div class="card-license"><span class="license-brief" title="${esc(m.license||'查看许可')} · 可下载不代表可商用">${esc(shortLicense(m.license))}</span></div></div><div class="card-bottom"><div class="card-primary-actions">${materialResolution}<button class="card-download${busy?' busy':''}" data-action="download" data-uid="${m.uid}" ${busy||downloaded?'disabled':''} title="${downloaded?'已下载到本地，无需重复下载':busy?'队列中':'下载到本地'}" aria-label="${downloaded?'已下载到本地':busy?'队列中':'下载到本地'}">${icon(busy?'clock':downloaded?'check':'download')}<span>${busy?'队列':downloaded?'已下载':'下载'}</span></button>${blenderButton}${state.route!=='discover'?`<button class="remove-model" data-action="remove" data-uid="${m.uid}" title="从模型库移除" aria-label="从模型库移除">${icon('close')}</button>`:''}</div></div></div></article>`;
}
 return {imageUrl,card,materialResolutionSelect};
}
