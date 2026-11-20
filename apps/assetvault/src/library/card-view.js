// The model card: how one asset looks in the grid and the waterfall view.
//
// Everything here is presentation, and everything it reads about an asset (does it have a local
// file? is it in the library? is the artwork a Marmoset scene?) is decided outside. That split is
// why this file can be grown or restyled without touching how the grid decides what to render.
// Two collaborators are passed as getters because they are wired up later than this module exists.
import {classifyAsset} from './asset-classification.js';
import {coverRendition} from './gallery-view.js';
import {authorButton} from './asset-author.js';
import {assetCard,cardMedia} from './card-shell.js';
import {userMetaFor} from './library-state.js';
import {uiElementSlot} from './ui-element-preview.js';
import {registerFavoriteTarget,favoriteButtonHtml} from './favorite-targets.js';
import {formatKind,canPreviewModelInViewer} from './format-registry.js';

/** /api/local/thumb 只对光栅图出 PNG；模型等非图片格式会回退成原始二进制流，
 *  <img> 拿到的不是图片，必然裂图（2026-11-14）。这类资产直接给格式占位，不发无效请求。
 *  例外是 3D 模型：它的封面由前端离屏渲好后写进同一个缓存，所以仍要出 <img>，
 *  由 library-view 在 error 时触发 model-thumb.js 渲染并重试（.model-thumb 是唯一标记）。 */
const NON_IMAGE_KINDS=new Set(['model','video','audio','document','archive','font']);
function localThumbRel(raw){
 const value=String(raw||'');
 if(!/^\/(?!\/)/.test(value))return '';
 try{
  const u=new URL(value,'http://127.0.0.1');
  return u.pathname==='/api/local/thumb'?(u.searchParams.get('rel')||''):'';
 }catch{return '';}
}

/** A downloaded image must preview its own file, never a same-named model's cover. */
export function localImageThumbnail(model={}){
 if(classifyAsset(model).kind!=='images')return '';
 let root=model.localRoot,rel=model.localRel;
 if((!root||!rel)&&String(model.previewUrl||'').startsWith('/api/local/file?')){
  const params=new URL(model.previewUrl,'http://local').searchParams;
  root=params.get('root');rel=params.get('rel');
 }
 if(!root||!rel||formatKind(rel)!=='image')return '';
 return `/api/local/thumb?${new URLSearchParams({root,rel,w:'384'})}`;
}

export function createCardView({albumCard,icon,esc,fmt,state,queuePulse,imageDownload,sendControl,platformLabel,artstationUI=()=>null,downloadsUI=()=>null,isVisitor=false}){
/** 封面一律走本地代理，代理负责按需降级到能取到的档位；
 *  画廊额外点名要轻一档的等比图，好让瀑布流按原图比例排且不吃带宽。 */
/** 同源相对地址（托管副本 / 本地索引文件的缩略图，如 /api/local/thumb?…）已经是本机直出，
 *  再套一层 /api/image 代理会被「只支持图床地址」的白名单挡下来 —— 卡片上就是一张裂图。 */
function isLocalUrl(url){return /^\/(?!\/)/.test(String(url||''));}
function imageUrl(model,{gallery=false}={}){
 const ownImage=localImageThumbnail(model);
 if(ownImage)return ownImage;
 if(!model.thumbnail)return '';
 if(isLocalUrl(model.thumbnail))return model.thumbnail;
 const rendition=coverRendition({platform:model.platform,gallery});
 return `/api/image?url=${encodeURIComponent(model.thumbnail)}&card=1${rendition?`&rendition=${rendition}`:''}`;
}
/** 材质精度选择（卡片下载键左边、预览面板各一份，同一份标记）：选择经全局 change 委托写回
 *  模型对象，重渲染按它回填，下载时队列从同一个字段读——不复制第二份状态。 */
function isMaterial(m){return m.platform==='ambientcg'&&(!m.assetType||m.assetType==='textures')||m.platform==='polyhaven'&&m.assetType==='textures'||m.platform==='freestylized'&&m.assetType==='textures';}
/** Poly Haven 的缩略图是官方按资产形状竖/横排的（models 竖幅 148×256~193×255、hdris 横幅 256×192、
 *  textures 近方 255×256），而卡片是 1:1 容器 + object-fit:cover —— 直接 cover 会把模型切掉上半、把全景切掉两端。
 *  Sketchfab 横幅效果图、ambientCG / FreeStylized 的贴图同理，复用 contain 并关闭悬停放大。
 *  归到独立标记而不是复用 isMaterial：那只是「是不是贴图」，与「要不要裁切」无关。 */
function needsFullThumb(m){return m.platform==='local'||m.platform==='sketchfab'||m.platform==='polyhaven'||m.platform==='ambientcg'||m.platform==='freestylized';}
function isHdri(m){return ['polyhaven','ambientcg'].includes(m.platform)&&m.assetType==='hdris';}
/** FreeStylized 的天空盒：库里可能存原始值 skybox，也可能存归一后的 hdris（跨平台统一值）。
 *  两值都要认，否则精度下拉 / 分辨率标记会在这个类型上整体失效。 */
function isFsSkybox(m){return m.platform==='freestylized'&&(m.assetType==='skybox'||m.assetType==='hdris');}
/** 精度下拉里给已下载的档位打勾：只下载过 4K 时，1K/2K/8K 都不该被误标。
 *  downloadedRes 由卡片侧从后端任务现算（state==='saved' 且文件还在，无 options 的老任务算默认 2K）。 */
function materialFormat(m){return m.sourceType==='substance'?'SBSAR':m.materialFormat==='PNG'||m.materialFormat==='SBSAR'?m.materialFormat:'JPG';}
/** 贴图精度和 SBSAR 是两种交付。已下载标记必须同时对上，否则下过 2K JPG 会把 SBSAR 挡掉。 */
function sameMaterialTier(job,m){
 const fmt=materialFormat(m);
 if((job.options?.textureFormat||'JPG')!==fmt)return false;
 if(fmt==='SBSAR')return true;
 return (job.options?.resolution||'2K')===(m.materialResolution||'2K');
}
function materialFormatSelect(m){
 if(m.platform!=='ambientcg'||!isMaterial(m)||m.sourceType==='substance')return '';
 const current=materialFormat(m);
 const noSbsar=m.substanceParent==='';
 return `<select class="material-resolution material-format" data-material-format="${m.uid}" aria-label="材质下载格式" title="JPG/PNG 是烘焙贴图；SBSAR 是父级 Substance 编译包">${[['JPG','JPG'],['PNG','PNG'],['SBSAR','SBSAR']].map(([value,label])=>`<option value="${value}"${current===value?' selected':''}${value==='SBSAR'&&noSbsar?' disabled':''}>${label}</option>`).join('')}</select>`;
}
function materialResolutionSelect(m,downloadedRes=new Set()){
 if(m.platform==='ambientcg'&&materialFormat(m)==='SBSAR')return '';
 if(!isMaterial(m)&&!isHdri(m)&&!isFsSkybox(m))return '';
 return `<select class="material-resolution" data-material-resolution="${m.uid}" aria-label="材质下载精度" title="材质贴图下载精度（已下载精度会标注）">${['1K','2K','4K','8K'].map(r=>`<option value="${r}"${(m.materialResolution||'2K')===r?' selected':''}>${r}${downloadedRes.has(r)?'（已下载）':''}</option>`).join('')}</select>`;
}
/** Civitai 同一版本常有多个文件（safetensors / 预览图 / 配置），下载前就地选，选择写回模型对象。 */
function civitaiFileSelect(m){
 if(m.platform!=='civitai'||!Array.isArray(m.civitaiFiles)||m.civitaiFiles.length<2)return '';
 const current=m.fileId||m.civitaiFiles[0].id;
 return `<select class="civitai-file" data-civitai-file="${esc(m.uid)}" aria-label="Civitai 下载文件" title="选择这个版本要下载的文件">${m.civitaiFiles.map(file=>`<option value="${esc(file.id)}"${String(file.id)===String(current)?' selected':''}>${esc(String(file.name||file.id).slice(0,60))}</option>`).join('')}</select>`;
}
function card(m,{gallery=false}={}){
 if(m.albumPackage&&albumCard)return albumCard(m);
 const pictureMode=state.route==='discover'&&m.platform==='artstation'&&!state.modelOnly;
 const art=m.platform==='artstation',art3d=art&&artstationUI().has3dScene(m),saved=state.favorites.has(m.uid),selected=state.selected.has(m.uid),backendJobs=downloadsUI()?.jobs||[],task=backendJobs.findLast(t=>t.uid===m.uid)||state.tasks.findLast(t=>t.uid===m.uid);
 // 所有模型平台（含 ArtStation 图片模式）都登记成可收藏目标：图片模式以前不画心形键，
 // 现在统一补上，且 collect() 能通过 findModel 的兜底真正把这条记录留在资产库里。
 registerFavoriteTarget(m.uid,m);
 // 有精度选择的资产（材质/HDRI/天空盒），「已下载」必须按精度对上：8K 下载过不代表 2K 也
 // 有了。历史任务没记精度的一律视为默认 2K，老记录不会集体变灰。
 const hasResSelect=isMaterial(m)||isHdri(m)||isFsSkybox(m);
 const savedJob=backendJobs.findLast(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.id&&(!hasResSelect||sameMaterialTier(t,m)));
 const pulse=queuePulse.has(m.uid)&&Date.now()-queuePulse.get(m.uid)<6000;
 const busy=pulse||task&&['queued','held','retry_wait','running','transferring','validating','saving','cancelling'].includes(task.state),downloaded=!!savedJob||task&&task.fileExists!==false&&['saved','sent'].includes(task.state)&&(!hasResSelect||sameMaterialTier(task,m));
 // 已下载的精度集合：喂给精度下拉打勾用。与 savedJob 同一判据（saved + 文件还在），
 // 只是不收窄到当前所选精度——四档里哪几档下过都要标出来。SBSAR 与 JPG 分开计。
 const fmt=materialFormat(m);
 const downloadedRes=hasResSelect?new Set(backendJobs.filter(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.id&&(t.options?.textureFormat||'JPG')===fmt).map(t=>t.options?.resolution||'2K')):new Set();
 // 媒体区的入口两种视图都有：有 Marmoset 场景的开 3D 预览弹窗，纯图片作品直接开官方作品页
 // ——没有场景的图片套一层弹窗等于白点，用户要的是这张图的出处。
 // Poly Haven 只有 models 有网格可转，HDRI 是全景图、贴图是平铺图，转不了视角就别写「3D 预览」。
 // FreeStylized 的资源包 / Alpha / 智能材质里没有可渲染的东西（点开是官方页面），角标跟着改。
 const fsNoScene=m.platform==='freestylized'&&!isFsSkybox(m)&&!['models','textures'].includes(m.assetType||'models');
 // 本地素材（拖入导入 / 导入文件夹入库，platform='local'）根本没有 3D 场景可转，
 // 按资产形态给实话：图片就写「查看图片」，视频「播放视频」，其余「打开文件」。
 // 例外是能在内置查看器里转的模型格式（glb/gltf/fbx/obj/stl/ply/3mf）—— 它们现在真的能预览，
 // 文案还写「打开文件」等于把用户赶去系统看图器。
 const localModel=m.platform==='local'&&canPreviewModelInViewer(m.ext||m.name);
 const localLabel=m.platform==='local'?(m.assetType==='video'?'播放视频':m.assetType==='image'?'查看图片':localModel?'3D 预览':'打开文件'):'';
 const previewLabel=localLabel||(art&&!art3d?'查看作品图片':fsNoScene?'打开官方页面':'交互式 3D 预览');
 // 「加入模型库」徽标和「打开下载文件夹」小图标已收进右键菜单：封面上只留预览热区、
 // 收藏心形、选择方块与资源类型角标，别让四个角各摆一颗带中文的按钮。
 // savedJob 仍供下面的导出控件 / 下载态判定使用。
 // 「发送到」控件：先挑目标（按键上显示软件名），再点旁边的图标键才真正导出。
 // 访客只能把整包模型推给自己电脑上的 Blender，由 applicableTargets 过滤掉其余。
 // 类名不用 card-download：那套样式是「下载键」的（34px 圆形、灰底），会让发送键变成看不懂的图标。
 const exportControl=sendControl({job:savedJob,isVisitor,className:'card-export'});
 // 封面图下载功能已移除：卡片不再提供单独的「下载封面图」入口。
 // ambientCG 卡片在下载键左边带一个精度选择：选择写回模型对象（materialResolution），
 // 重渲染后原样回填；下载时队列从模型上读，整批取第一张的选择（服务端会再校验一次）。
 // 卡片底栏一律图标化（2026-10-28）：文案收进 <span> 由 CSS 隐藏，保留在 DOM 里给无障碍与测试读。
 // 标签键已移除：平台标签现在自动读取、AI 标签后台生成，卡片上不再需要「标签」入口。
    const materialResolution=materialFormatSelect(m)+materialResolutionSelect(m,downloadedRes)+civitaiFileSelect(m);
 // 访客的下载键永远是「下载到我这台电脑」：主机上已有副本只意味着这次可以直传、不用重新下载，
 // 不该把按钮变成「已下载」并禁用——那会让访客以为文件已经在自己的电脑里。
 const dlBusy=busy,dlDisabled=busy||(!isVisitor&&downloaded);
 const dlTitle=busy?'队列中':isVisitor?(savedJob?'主机已有副本，直接传输到这台电脑':'下载到这台电脑'):'下载到本地';
 const dlLabel=busy?'队列':isVisitor?'下载到本机':'下载';
 const dlAria=isVisitor?'下载到这台电脑':busy?'队列中':'下载到本地';
 // 已下载的资产不再显示那个不能点的「✓ 已下载」键（2026-10-29 用户要求）：
 // 封面上只剩一个「发送到」键 —— 已下载的资产唯一还需要做的就是导出到别的软件。
 // 本地素材（platform='local'）文件就在本机，没有「下载」这个动作可做：给它一颗点了必然失败的键
// 只会误导，直接不渲染 —— 打开/预览走封面热区。
const downloadButton=(downloaded&&!isVisitor)||m.platform==='local'?'':`<button class="card-download${dlBusy?' busy':''}" data-action="download" data-uid="${m.uid}" ${dlDisabled?'disabled':''} title="${dlTitle}" aria-label="${dlAria}">${icon(busy?'clock':'download')}<span>${dlLabel}</span></button>`;
 // 发现页瀑布流：`.card-bottom` 整块是 display:none，底栏那颗下载键会跟着消失，
 // 于是封面右下角补一颗悬浮键。沿用封面上其它图标（收藏 / 信息）的语言 ——
 // 无底无边框、只在卡片 hover（或选中 / 键盘聚焦）时浮现，已下载与本地素材不再给键。
 const galleryDownload=gallery&&state.route==='discover'&&!(downloaded&&!isVisitor)&&m.platform!=='local'
  ?`<button class="card-dl${dlBusy?' busy':''}" data-action="download" data-uid="${m.uid}" ${dlDisabled?'disabled':''} title="${dlTitle}" aria-label="${dlAria}">${icon(dlBusy?'clock':'download')}</button>`:'';
 // meta 一行化：作者与平台标签重复时（如 ambientCG）不再显示，只留「标题 · 作者 · 许可」。
 const byline=m.author&&m.author.trim()!==platformLabel(m.platform)?authorButton(m,'card-byline'):'';
 // 左上角只放资源类型标志（模型/材质/HDRI/天空盒…）。下载与导出状态由左下角「已加入模型库」、
 // 右下角文件夹键和底部下载键各自表达，不再挤占类型位（2026-10-16 用户要求）。
 // 类型角标：先按资产形态（图片/视频/材质/HDRI/模型/资源包）判，再让平台特例覆盖。
 // 采集进库的图站资产以前一律落到 '3D ASSET'，看着像模型、预览又打不开；现在按 assetType 归位。
 const KIND_LABELS={image:'图片',images:'图片',video:'视频',textures:'PBR 材质',hdris:'HDRI',models:'3D 模型',packs:'资源包',alphas:'Alpha',smart:'智能材质',skybox:'天空盒',uielement:'UI 动效'};
 const imageLike=art&&!art3d||['image','images','video'].includes(m.assetType);
 // UI 元素有自己的图标：它既不是图片也不是模型，用 cube 会误导。
 const uiElement=m.assetType==='uielement'||m.platform==='uiverse';
 const typeText=art?(art3d?'MARMOSET 3D':'ARTSTATION 图片')
  :uiElement?'UI 动效'
  :isHdri(m)?'HDRI'
  :isMaterial(m)?'PBR 材质'
  :m.platform==='kenney'?'资源包'
  :KIND_LABELS[m.assetType]||'3D ASSET';
 const typeLabel='';
 // 来源平台：采集进库的卡片必须能一眼看出「这张是从哪个平台收来的」。
 // Sketchfab 是默认来源，占绝大多数，逐张标等于噪声，所以只在非默认来源时出现。
 const sourceName=platformLabel(m.platform)||'';
 const sourceBadge='';
 // 收藏键不再看 pictureMode：所有平台、所有视图共用心形键与同一条 toggleFavorite 链路。
 const favoriteButton=favoriteButtonHtml({uid:m.uid,saved,icon,esc});
 // 多选方块按 2026-11-12 反馈不再显示（app.css 里 .card-media>.card-select{display:none}）。
 // DOM 与 data-select 仍保留：range-select 的框选 / Shift 连选契约认这个节点，恢复只需改一行样式。
 const selectLabel=`<label class="card-select"><input type="checkbox" data-select="${m.uid}" aria-label="选择 ${esc(m.name)}" ${selected?'checked':''}></label>`;
 // 许可在这行里只是一颗说明键：全称（「ArtStation 作品 · 需确认授权」）会把标题和作者挤成
 // 两个都读不全的省略号，悬停才给出完整许可文案（2026-10-21 用户要求）。
 const licenseTip=`${m.license||'查看许可'} · 可下载不代表可商用`;
 const licenseHint='';
 // 我的评分：有分才显示，备注折进 title 供悬停速览（完整编辑在标签面板）。
 const meta=userMetaFor(state,m.uid);
 const ratingMark=meta.rating?`<div class="card-rating" title="我的评分 ${meta.rating} 星${meta.note?` · ${esc(meta.note.slice(0,120))}`:''}"><span class="stars">${Array.from({length:5},(_,i)=>`<span class="${i<meta.rating?'on':''}">${icon('star')}</span>`).join('')}</span></div>`:'';
 const factLines=[typeText,sourceName&&m.platform!=='sketchfab'?sourceName:'',m.license||''].filter(Boolean);
 const factsBtn=`<button type="button" class="card-facts-btn" data-card-facts title="查看信息" aria-label="查看信息">${icon('help')}</button><div class="card-facts">${factLines.map(line=>`<p>${esc(line)}</p>`).join('')}${ratingMark}</div>`;
 // 回收站视图（筛选=回收站）里给「放回模型库 / 彻底删除」一对，访客没有写身份，整块不给。
 // 正常视图下的「从模型库移除」键已按用户要求撤掉（2026-10-29）：封面上只留导出动作，
 // 移除走详情面板 / 模型库筛选页，不再占用卡片寸土。
 const trashActions=state.filter==='trash'?`<button class="remove-model restore-model" data-action="restore" data-uid="${m.uid}" title="放回模型库" aria-label="放回模型库">${icon('rotate')}</button><button class="remove-model purge-model" data-action="purge" data-uid="${m.uid}" title="彻底删除记录（不会删除已下载文件）" aria-label="彻底删除记录">${icon('close')}</button>`:'';
 // 结构统一走 card-shell：卡片的 DOM 只有一份，远端资产和本地素材包长得一样。
// 这里只负责算出「填什么」，不再拼 article 骨架。
  // UI 元素（Uiverse）没有可用的封面图（官方 CDN 在很多网络下连不上），
  // 而且它的价值就是「会动」—— 所以封面直接是现场渲染的动效，不是静态图。
  const isUiElement=m.assetType==='uielement'||m.platform==='uiverse';
  const thumbRel=localThumbRel(m.thumbnail);
  const thumbKind=thumbRel?formatKind(thumbRel):'';
  // 能被出封面的 3D 格式：glb/gltf/fbx/obj/stl/ply/3mf 由前端 three.js 渲，
  // .blend / .usd* 由服务端出图（见 server/model-cover.mjs）。这里只决定要不要出 <img>。
  // .blend 在注册表里 kind 是 other，不能只看 kind，否则它会被当成「无封面」直接占位。
  const modelCover=!!thumbRel&&/\.(glb|gltf|fbx|obj|stl|ply|3mf|blend|usd|usda|usdc|usdz)$/i.test(thumbRel);
  const noCover=NON_IMAGE_KINDS.has(thumbKind)&&!modelCover;
  const coverText=noCover?'该格式不生成缩略图':'暂无缩略图';
  const media=isUiElement?uiElementSlot(m,{esc})
    :m.thumbnail&&!noCover?cardMedia({src:esc(imageUrl(m,{gallery})),alt:esc(m.name),className:modelCover?'thumbnail model-thumb':'thumbnail'}):cardMedia({icon:icon('cube'),text:coverText});
  // UI 元素卡片的封面上不能盖热区：那层 .preview-hit 会把指针全吃掉，组件本身就点不动了。
  // 交互留给组件自己（悬停 / 按下都有真实反馈），打开信息弹窗走这颗悬浮键 —— 只占底部一小条，
  // 不挡组件的中部操作；标题键同样能开弹窗，键盘与触屏都有入口。
  const uiOpen=isUiElement?`<button class="ui-element-open" data-action="preview" data-uid="${m.uid}" title="查看 UI 信息并复制代码" aria-label="查看 ${esc(m.name)} 的信息与代码">${icon('scan')}<span>查看信息 · 代码</span></button>`:'';
  const previewHit=isUiElement?uiOpen:`<button class="preview-hit" data-action="preview" data-uid="${m.uid}" aria-label="${previewLabel} ${esc(m.name)}"></button>`;
  return assetCard({
  keyName:'uid',
  keyValue:m.uid,
  className:[selected?'selected':'',needsFullThumb(m)?'thumb-contain':'',isUiElement?'ui-element-card':''].filter(Boolean).join(' '),
  media,
 overlay:`${previewHit}${typeLabel}${favoriteButton}${selectLabel}${factsBtn}`,
 titleAttrs:`title="${esc(m.name)}" data-action="preview" data-uid="${m.uid}"`,
 title:esc(m.name),
 // 图片类资产常常没有作者，占位「未知作者」不如直接让位给来源平台名。
 byline:((imageLike&&!(m.author||'').trim())?'':byline)+sourceBadge,
 side:'',
 // 材质格式 / 精度这些次要控件留在缩略图下方常驻区（标签键已移除，平台标签自动读取、AI 标签后台生成）。
 // 导出控件移到卡片底部动作行、与下载键同处一行：未下载时显示「下载」，下载完成后原地变成
 // 「软件选择 + 导出」——软件选择始终在导出键左边，底部因此不再多占一行。
 metaActions:materialResolution+galleryDownload,
 // 「发送到」是库专属动作（要有本地文件才能发到 Blender 等），发现页一律不显示；发现页只留下载。
 actions:`${state.route!=='discover'?exportControl:''}${downloadButton}${state.route!=='discover'&&!isVisitor?trashActions:''}`,
});
}
 return {imageUrl,card,materialResolutionSelect,materialFormatSelect,civitaiFileSelect};
}
