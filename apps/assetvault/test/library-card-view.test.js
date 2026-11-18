import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCardView} from '../src/library/card-view.js';
import {platformLabel} from '../src/library/platforms.js';
import {favoriteUid,registerFavoriteTarget,favoriteTarget,favoriteSkipsCollect,favoriteButtonHtml} from '../src/library/favorite-targets.js';

const css=assembleLibraryStyles();

// 卡片 meta 单行化后只渲染「标题 · 作者（与来源不同名时） · 许可」，统计/平台标签行已移除。
// 这里用最小桩构造视图，验证单行结构与许可渲染，不牵动真正的 state / Blender 桥。
const build=(state={favorites:new Set(),models:[],selected:new Set(),tasks:[]},downloadsUI=()=>({jobs:[]}),isVisitor=false)=>createCardView({
 icon:name=>`<i class="${name}"></i>`,
 esc:s=>s==null?'':String(s),
 fmt:n=>(n??0).toLocaleString('en-US'),
 state,
 queuePulse:new Map(),
 imageDownload:{button:()=>'<button class="card-icon-action download-images" data-action="download-images">img</button>'},
 sendControl:()=>'',
 platformLabel,
 artstationUI:()=>({has3dScene:()=>false}),
 downloadsUI,
 isVisitor,
});

const render=model=>build().card(model);

test('image discovery cards keep the local preview but always offer favorite (2026-11-12)',()=>{
 const state={route:'discover',platform:'artstation',modelOnly:false,favorites:new Set(),models:[],selected:new Set(),tasks:[]};
 const model={uid:'a'.repeat(32),platform:'artstation',name:'Picture',thumbnail:'https://example.com/image.jpg'};
 for(const options of [{},{gallery:true}]){
  const html=build(state).card(model,options);
  // 图片作品不摆「加入模型库」角标，但收藏键现在全平台都要有，不再被 pictureMode 吃掉。
  assert.doesNotMatch(html,/data-action="collect"/);
  assert.match(html,/data-action="favorite"/);
  assert.match(html,/查看作品图片/);
  assert.match(html,/data-action="preview"/);
 }
 state.modelOnly=true;
 // 入库角标已收进右键菜单，卡片上不再出现 data-action="collect"。
 assert.doesNotMatch(build(state).card(model),/data-action="collect"/);
});

test('every model platform gets the same favorite button and a collectable target',()=>{
 const state={route:'discover',platform:'sketchfab',modelOnly:false,favorites:new Set(),models:[],selected:new Set(),tasks:[]};
 for(const platform of ['sketchfab','artstation','polyhaven','ambientcg','kenney','freestylized','uiverse']){
  const model={uid:'b'.repeat(32),platform,name:'Asset',thumbnail:'https://example.com/a.jpg'};
  const html=build(state).card(model);
  assert.match(html,/data-action="favorite"/,`${platform} 缺收藏键`);
  assert.match(html,/class="favorite"/,`${platform} 收藏键类名不统一`);
 }
 const saved=build({...state,favorites:new Set(['b'.repeat(32)])}).card({uid:'b'.repeat(32),platform:'sketchfab',name:'Asset'});
 assert.match(saved,/class="favorite saved"/,'已收藏要回填高亮态');
});

test('ambientCG models hide texture tiers and recognise existing model files at any resolution',()=>{
 for(const sourceType of ['terrain','3d-model']){
  const model={uid:'a'.repeat(32),name:'Model',platform:'ambientcg',assetType:'models',sourceType,materialResolution:'2K',materialFormat:'PNG'};
  const job={id:'local',uid:model.uid,state:'saved',fileExists:true,options:{resolution:'1K',textureFormat:'JPG'}};
  const html=build(undefined,()=>({jobs:[job]})).card(model);
  assert.doesNotMatch(html,/data-material-resolution/);
  assert.doesNotMatch(html,/data-action="download"/,'已下载的模型卡不再显示下载键，只留发送到');
  assert.doesNotMatch(html,/data-action="reveal-download"/,'打开下载文件夹已收进右键菜单');
  const missing=build(undefined,()=>({jobs:[{...job,fileExists:false}]})).card(model);
  assert.match(missing,/data-action="download"/,'文件不在时应能重新下载');
 }
});

test('SBSAR has no resolution selector but is distinct from baked texture downloads',()=>{
 const model={uid:'b'.repeat(32),name:'Substance',platform:'ambientcg',assetType:'textures',sourceType:'substance',materialResolution:'8K'};
 const job={id:'sbsar',uid:model.uid,state:'saved',fileExists:true,options:{resolution:'2K',textureFormat:'SBSAR'}};
 const html=build(undefined,()=>({jobs:[job]})).card(model);
 assert.doesNotMatch(html,/data-material-resolution/);
 assert.doesNotMatch(html,/data-action="download"/,'SBSAR 已下载 → 不显示下载键');
 const baked=build(undefined,()=>({jobs:[{...job,options:{textureFormat:'JPG'}}]})).card(model);
 assert.match(baked,/data-action="download"/,'烘焙贴图未下过 → 仍有下载键');
 assert.doesNotMatch(render({...model,sourceType:'material',materialFormat:'SBSAR'}),/data-material-resolution/);
});

test('a saved job whose file is missing allows downloading again',()=>{
 const model={uid:'m'.repeat(32),name:'Missing chair',platform:'sketchfab',license:'CC0'};
 const html=build(undefined,()=>({jobs:[{id:'missing',uid:model.uid,state:'saved',fileExists:false}]})).card(model);
 assert.doesNotMatch(html,/<button class="card-download"[^>]*\sdisabled/);
 assert.doesNotMatch(html,/class="card-icon-action open-folder"/);
});

test('downloaded state follows the selected resolution, not just the asset',()=>{
 // 2026-10-15：只下载过 8K 的天空盒，切到 2K 不允许再显示「已下载」。
 const skybox={uid:'s'.repeat(32),name:'Sky 133',author:'FreeStylized',platform:'freestylized',assetType:'skybox',thumbnail:'',license:'CC0',downloadable:true,materialResolution:'2K'};
 const jobs8k=[{id:'j8',uid:skybox.uid,kind:'freestylized',state:'saved',fileExists:true,options:{output:'folder',format:'glb',resolution:'8K'}}];
 const jobs2k=[{id:'j2',uid:skybox.uid,kind:'freestylized',state:'saved',fileExists:true,options:{output:'folder',format:'glb',resolution:'2K'}}];
 const jobsLegacy=[{id:'jl',uid:skybox.uid,kind:'freestylized',state:'saved',fileExists:true,options:{output:'folder',format:'glb'}}];
 const withJobs=jobs=>build(undefined,()=>({jobs}));
 // 「已下载」的判据改成「没有下载键」：2026-10-29 起已下载的卡片直接不显示下载键，只留「发送到」。
 const downloadedKey=html=>!html.includes('data-action="download"');
 // 8K 任务在手，但卡片选的是 2K → 不算已下载。
 assert.equal(downloadedKey(withJobs(jobs8k).card(skybox)),false,'8K 已下载 ≠ 2K 已下载');
 // 精度对上才算。
 assert.ok(downloadedKey(withJobs(jobs2k).card(skybox)),'2K 任务匹配 2K 选择');
 // 历史任务没记精度 → 视为默认 2K，不至于集体变灰。
 assert.ok(downloadedKey(withJobs(jobsLegacy).card(skybox)),'无精度的老任务按默认 2K 匹配');
 // 无精度选择的资产（普通模型）不看精度。
 const robot={uid:'r'.repeat(32),name:'Robot',author:'studio',platform:'sketchfab',thumbnail:'',license:'CC0',downloadable:true};
 assert.ok(downloadedKey(withJobs([{id:'jr',uid:robot.uid,kind:'sketchfab',state:'saved',fileExists:true,options:{}}]).card(robot)),'模型类不受精度判定影响');
});

test('the top-left corner shows only the asset type, never download or export state',()=>{
 // 2026-10-16：左上角只保留资源类型标志，「已有导出记录」这类状态标识全部撤掉。
 const model={uid:'i'.repeat(32),name:'Wood 096',author:'ambientCG',platform:'ambientcg',assetId:'Wood096',thumbnail:'',license:'CC0',downloadable:true};
 const saved=build(undefined,()=>({jobs:[{uid:model.uid,state:'saved',fileExists:true,id:'job-1'}]}));
 const html=saved.card(model);
 assert.equal(html.includes('已有导出记录'),false,'左上角不得再显示导出记录');
 // 2026-11 起类型角标整块撤掉：类型与许可一起收进封面上的 card-facts 弹层，
 // 左上角只剩那颗信息键，不再有任何状态角标。
 assert.equal(html.includes('card-type'),false,'类型角标已移除');
 assert.ok(html.includes('card-facts-btn')&&html.includes('PBR 材质'),'类型文案收进信息弹层');
 assert.equal(/card-type">[^<]*check/.test(html),false,'已下载也不该把类型图标换成对勾');
});

test('the resolution picker marks which tiers are already downloaded',()=>{
 // 只下载过 4K：下拉里 4K 打勾，其余档位不标（与下载键同一判据）。
 const tex={uid:'t'.repeat(32),name:'Aerial Asphalt 01',author:'Poly Haven',platform:'polyhaven',assetType:'textures',thumbnail:'',license:'CC0',downloadable:true,materialResolution:'4K'};
 const jobs=[{id:'j4',uid:tex.uid,kind:'polyhaven',state:'saved',fileExists:true,options:{output:'folder',resolution:'4K',textureFormat:'JPG'}}];
 const picker=build(undefined,()=>({jobs})).card(tex).match(/<select class="material-resolution"[^>]*>.*?<\/select>/s)?.[0];
 assert.ok(picker,'材质卡片要有精度选择');
 assert.ok(picker.includes('<option value="4K" selected>4K（已下载）</option>'),'已下载的 4K 要打勾');
 assert.ok(!picker.includes('2K（已下载）')&&!picker.includes('8K（已下载）'),'没下载过的档位不能误标');
 // 没有任务的卡片四档都不标，默认 2K 选中（select 的 title 说明里也有 ✓ 字样，只查 option 文本）
 const fresh=render({uid:'u'.repeat(32),name:'Bricks',author:'ambientCG',platform:'ambientcg',assetId:'Bricks',thumbnail:'',license:'CC0',downloadable:true});
 assert.ok(!fresh.includes('>1K（已下载）<')&&!fresh.includes('>2K（已下载）<'),'未下载时不打勾');
});

test('platformLabel resolves every known platform and never impersonates another',()=>{
 assert.equal(platformLabel('polyhaven'),'Poly Haven','Poly Haven 必须能叫出自己的名字');
 assert.equal(platformLabel('sketchfab'),'Sketchfab');
 assert.equal(platformLabel('artstation'),'ArtStation');
 // Sketchfab 结果归一化后没有 platform 字段，缺省即 Sketchfab（历史数据形状）。
 assert.equal(platformLabel(undefined),'Sketchfab','缺省来源是 Sketchfab');
 assert.equal(platformLabel(null),'Sketchfab');
 // 不认识的来源给中性叫法，绝不套用任何已知平台的名字。
 assert.equal(platformLabel('mystery'),'3D 资产');
});

test('cards no longer print a platform label row; a Poly Haven asset is never mislabelled',()=>{
 // Poly Haven 资产没有面数也没有点赞数（faces:null, 无 views/likes）。
 const html=render({uid:'ph-1',name:'Wood Chair',author:'Poly Haven',platform:'polyhaven',faces:null,thumbnail:'',license:'CC0',downloadable:true});
 assert.equal(html.includes('Sketchfab'),false,'Poly Haven 绝不可以被写成 Sketchfab');
 // 作者与来源同名时不再重复显示（单行化：作者=平台标签就只留一处）
 assert.equal(html.includes('card-byline'),false,'作者与来源同名时不重复显示作者');
 // 没有点赞数/浏览数时，统计末格（眼睛/爱心）不该渲染空白统计。
 assert.equal(html.includes('icon(\'eye\')')||html.includes('i="eye"'),false,'Poly Haven 没有浏览/点赞数据，不显示空统计');
});

test('a Sketchfab asset keeps the author in the single-row meta when it differs from the platform',()=>{
 const html=render({uid:'sf-1',name:'Robot',author:'stud',thumbnail:'',license:'CC0',downloadable:true});
 assert.ok(html.includes('Robot'),'标题要显示');
 assert.ok(html.includes('card-byline')&&html.includes('stud'),'作者与来源不同名时保留作者');
});

test('meta is a single row: title + license, no separate stats row',()=>{
 const html=render({uid:'sf-2',name:'Rock',author:'studio',platform:'sketchfab',faces:1234,views:1200,likes:34,thumbnail:'',license:'CC0',downloadable:true});
 assert.equal(html.includes('card-stats'),false,'统计行已随单行化移除');
 assert.equal(html.includes('card-license'),false,'许可说明键已撤，不再占信息行');
 assert.ok(html.includes('card-facts')&&html.includes('CC0'),'许可全文收进封面信息弹层');
 // 动作行必须是 card-meta 的兄弟：meta 变成 flex 布局后，误嵌套会把按钮拉进信息行
 assert.match(html,/<\/div><div class="card-bottom">/,'card-bottom 必须与 card-meta 平级，不能嵌在信息行里');
});

test('ambientCG cards carry a resolution picker left of the download button, others do not',()=>{
 const acg=render({uid:'a'.repeat(32),name:'Ground 054',author:'ambientCG',platform:'ambientcg',assetId:'Ground054',thumbnail:'',license:'CC0',downloadable:true});
 const picker=acg.match(/<select class="material-resolution"[^>]*data-material-resolution="[^"]*"[^>]*>.*?<\/select>/s)?.[0];
 assert.ok(picker,`ambientCG 卡片应带精度选择，实际：${acg.match(/card-primary-actions">.{0,160}/s)?.[0]||acg}`);
 // 默认 2K 选中，四档齐全
 assert.ok(picker.includes('>1K<')&&picker.includes('>2K<')&&picker.includes('>4K<')&&picker.includes('>8K<'));
 assert.match(picker,/<option value="2K" selected>2K<\/option>/);
 // 出现在下载键之前（左边）
 assert.ok(acg.indexOf('material-resolution')<acg.indexOf('card-download'),'精度选择必须在下载键左侧');
 // 模型卡片没有这个选择器
 const sketchfab=render({uid:'sf-4',name:'Rock',author:'s',thumbnail:'',license:'CC0',downloadable:true});
 assert.equal(sketchfab.includes('material-resolution'),false,'非材质卡片不该出现精度选择');
 const model=render({uid:'ph-model',name:'Chair',author:'Poly Haven',platform:'polyhaven',assetType:'models',thumbnail:'',license:'CC0',downloadable:true});
 assert.equal(model.includes('material-resolution'),false,'Poly Haven 模型不带材质精度');
 const texture=render({uid:'ph-tex',name:'Aerial Rocks',author:'Poly Haven',platform:'polyhaven',assetType:'textures',thumbnail:'',license:'CC0',downloadable:true});
 assert.ok(texture.includes('material-resolution'),'Poly Haven 材质与 ambientCG 一样带精度选择');
 assert.equal(texture.includes('download-images'),false,'材质卡片不提供高清图下载');
});

test('the resolution picker reflects the model choice, defaulting to 2K',()=>{
 const html=render({uid:'b'.repeat(32),name:'Bricks',author:'ambientCG',platform:'ambientcg',assetId:'Bricks',thumbnail:'',license:'CC0',downloadable:true,materialResolution:'8K'});
 assert.match(html,/<option value="8K" selected>8K<\/option>/, '已选精度要回填，重渲染后不丢');
 assert.equal(/<option value="2K" selected>/.test(html),false,'2K 不再选中');
});

test('入库 / 打开文件夹已收进右键菜单，封面四角不再摆按钮',()=>{
 const model={uid:'c'.repeat(32),name:'Ground 054',author:'ambientCG',platform:'ambientcg',assetId:'Ground054',thumbnail:'',license:'CC0',downloadable:true};
 const html=build().card(model);
 assert.doesNotMatch(html,/collect-badge/,'入库角标不再画在卡片上');
 assert.doesNotMatch(html,/data-action="collect"/);
 assert.doesNotMatch(html,/collect-button/);
 // 已下载的卡片同样不摆「打开下载文件夹」小图标，动作由右键菜单按任务号给出。
 const saved=build(undefined,()=>({jobs:[{uid:model.uid,state:'saved',fileExists:true,id:'job-1'}]})).card(model);
 assert.doesNotMatch(saved,/open-folder/);
 assert.doesNotMatch(saved,/data-action="reveal-download"/);
});

test('compact list view is gone: overlays stay on the thumbnail in both remaining views',()=>{
 // 紧凑视图已移除。这里特意保留 state.compact:true，验证旧持久化字段不会再把控件搬进信息栏。
 const state={favorites:new Set(),models:[],selected:new Set(),tasks:[],compact:true};
 const model={uid:'g'.repeat(32),name:'Ground 054',author:'ambientCG',platform:'ambientcg',assetId:'Ground054',thumbnail:'https://x/t.jpg',license:'CC0',downloadable:true};
 for(const options of [{},{gallery:true}]){
  const html=build(state).card(model,options);
  assert.equal(html.includes('card-controls'),false,'不应再渲染紧凑视图的独立控件行');
  assert.equal(html.includes('compact-preview'),false,'紧凑视图专属预览键应已移除');
  const media=html.slice(html.indexOf('card-media'),html.indexOf('card-meta'));
  assert.ok(media.includes('preview-hit')&&media.includes('favorite')&&media.includes('card-facts-btn'),'角标与按键仍叠在缩略图上');
  assert.ok(html.includes('thumbnail'),'缩略图本身要保留');
 }
});

test('an already downloaded card shows no download button, only the export one',()=>{
 // 2026-10-29 用户要求：已下载的资产不再显示那个不能点的「✓ 已下载」键，卡片上只留「发送到」。
 const model={uid:'i'.repeat(32),name:'Wood 096',author:'ambientCG',platform:'ambientcg',assetId:'Wood096',thumbnail:'',license:'CC0',downloadable:true};
 const saved=build(undefined,()=>({jobs:[{uid:model.uid,state:'saved',fileExists:true,id:'job-1'}]}));
 const html=saved.card(model);
 assert.doesNotMatch(html,/data-action="download"/,'已下载的卡片不该再出现下载键');
 // 队列任务结束（saved）同样按已下载处理
 const taskDone=build({favorites:new Set(),models:[],selected:new Set(),tasks:[{uid:model.uid,state:'saved'}]});
 assert.doesNotMatch(taskDone.card(model),/data-action="download"/,'本地任务已 saved 时也不该有下载键');
 // 没下载过的照常可点
 const fresh=render(model);
 assert.match(fresh,/data-action="download"/,'未下载的卡片必须有下载键');
 assert.doesNotMatch(fresh,/data-action="download"[^>]*\sdisabled/,'未下载的卡片下载键必须可点');
});

test('the meta row drops the downloadable tag and folds the license into a hint key',()=>{
 // 2026-10-21：许可不再占一行文字（会把标题与作者一起挤成省略号），收成一枚 ? 键，悬停看全文。
 const html=render({uid:'l'.repeat(32),name:'Aerial Asphalt 01',author:'Rob Tuytel',platform:'polyhaven',assetType:'textures',thumbnail:'',license:'CC0 1.0 通用公共领域贡献',downloadable:true});
 assert.equal(html.includes('license-tag'),false,'「● 可下载」标识去掉');
 assert.equal(html.includes('license-hint'),false,'说明键已撤：许可不再占信息行');
 assert.equal(/>CC0</.test(html),false,'许可缩写不再直接铺在信息行里');
 assert.ok(html.includes('card-facts')&&html.includes('CC0 1.0 通用公共领域贡献'),'完整许可全文进信息弹层');
 // 任何许可全称都要能在弹层里读到，不能截断
 const by=render({uid:'m'.repeat(32),name:'X',author:'a',thumbnail:'',license:'CC BY-NC-SA 4.0',downloadable:true});
 assert.ok(by.includes('CC BY-NC-SA 4.0'),'CC BY-NC-SA 全文进信息弹层');
 // 标题固定单行：长名字一律省略号截断，不再撑到两行把卡片拉高（2026-10-16 用户要求）
 // 只约束资产卡标题自身：图站搜索卡与图片包脚注标题另有两行截断需求，不该被全局断言误伤。
 const cardTitleRule=(css.match(/\.card-title\{[^}]*\}/)||[])[0]||'';
 assert.equal(/-webkit-line-clamp/.test(cardTitleRule),false,'资产卡标题不再允许两行');
 assert.ok(/\.card-title\{[^}]*white-space:nowrap/.test(css),'标题强制单行');
 assert.ok(/\.card-title\{[^}]*text-overflow:ellipsis/.test(css),'单行溢出用省略号');
 // 下载键所在的动作行也必须保持一行：行与行内分组都不换行，按键文案 nowrap
 assert.ok(/\.card-bottom\{[^}]*flex-wrap:nowrap/.test(css),'动作行不换行');
 assert.ok(/\.card-bottom \.card-download\{[^}]*white-space:nowrap/.test(css),'下载键文案不换行');
 assert.ok(/\.card-bottom \.card-download span\{[^}]*white-space:nowrap/.test(css),'下载键 label 不换行');
});

test('no card shows the cover-image download button (feature removed)',()=>{
 // 2026-10-15 用户明确不要「下载封面图」功能：任何平台的卡片都不再出现该按键。
 for(const m of [
  {uid:'e'.repeat(32),name:'Fabric 085',author:'ambientCG',platform:'ambientcg',assetId:'Fabric085',assetType:'textures',thumbnail:'',license:'CC0',downloadable:true},
  {uid:'f'.repeat(32),name:'Robot',author:'studio',platform:'sketchfab',thumbnail:'',license:'CC0',downloadable:true},
  {uid:'1'.repeat(32),name:'Trowel 01',author:'FreeStylized',platform:'freestylized',assetType:'models',thumbnail:'',license:'CC0',downloadable:true},
 ]){
  assert.equal(render(m).includes('download-images'),false,`${m.platform} 卡片不应显示下载封面图按键`);
 }
});

// Poly Haven 的缩略图是官方按资产形状排的竖幅/横幅（实测 models 137×256~256×140、hdris 256×192、
// textures 255×256），配 1:1 容器 + object-fit:cover 会切掉模型上半或全景两端。
// 归类必须跟「是不是贴图」分开：models/hdris 不是 material，但同样不能裁。
test('thumbnails that must stay whole get the contain marker, crops stay default',()=>{
 const withClass=(m,label)=>{const c=render(m);assert.ok(c.includes('thumb-contain'),`${label} 的缩略图必须完整显示`);};
 withClass({uid:'1'.repeat(32),name:'Arm Chair 01',platform:'polyhaven',assetType:'models',thumbnail:'',license:'CC0',downloadable:true},'Poly Haven 模型（竖幅）');
 withClass({uid:'2'.repeat(32),name:'Dawn 2',platform:'polyhaven',assetType:'hdris',thumbnail:'',license:'CC0',downloadable:true},'Poly Haven HDRI（横幅）');
 withClass({uid:'3'.repeat(32),name:'Fabric 085',platform:'ambientcg',assetType:'textures',thumbnail:'',license:'CC0',downloadable:true},'ambientCG 贴图');
 withClass({uid:'4'.repeat(32),name:'Robot',platform:'sketchfab',thumbnail:'',license:'CC0',downloadable:true},'Sketchfab 横幅效果图');
 // 其他平台继续保留原有展示方式。
 for(const m of [
  {uid:'5'.repeat(32),name:'Scene',platform:'artstation',thumbnail:'',license:'CC0',downloadable:true},
  {uid:'6'.repeat(32),name:'Chair',platform:'kenney',thumbnail:'',license:'CC0',downloadable:true},
 ])assert.equal(render(m).includes('thumb-contain'),false,`${m.platform} 不该被标成完整显示`);
});

// 访客看到的是主机的资产库：主机「已下载」不等于文件到了访客电脑上，所以那个键不能禁用，
// 打开的文件夹也是主机的，访客不该有点不到的入口。
test('LAN visitors download to their own computer instead of a disabled 已下载',()=>{
 const model={uid:'c'.repeat(32),name:'Fox',platform:'sketchfab',assetType:'model'};
 const job={id:'saved-1',uid:model.uid,state:'saved',fileExists:true};
 const guest=build(undefined,()=>({jobs:[job]}),true).card(model);
 assert.match(guest,/<span>下载到本机<\/span>/);
 assert.doesNotMatch(guest,/<button class="card-download" data-action="download"[^>]*disabled/);
 assert.doesNotMatch(guest,/data-action="reveal-download"/);
 // 主机用户：已下载 → 不再显示下载键（连「已下载」文案一起撤掉），只留「发送到」。
 assert.doesNotMatch(build(undefined,()=>({jobs:[job]})).card(model),/data-action="download"/,'已下载的卡片不再显示下载键');
});

// 入库角标和底部移除键都在改主机的资产库，访客的卡片上不该出现这两个入口。
test('LAN visitors see no library-membership badge or remove button',()=>{
 const model={uid:'d'.repeat(32),name:'Fox',platform:'sketchfab',assetType:'model'};
 const guest=build({favorites:new Set(),models:[model],selected:new Set(),tasks:[]},()=>({jobs:[]}),true).card(model);
 assert.doesNotMatch(guest,/collect-badge/);
 assert.doesNotMatch(guest,/data-action="remove"/);
 assert.doesNotMatch(build({favorites:new Set(),models:[model],selected:new Set(),tasks:[]},()=>({jobs:[]})).card(model),/collect-badge/,'主机卡片也不再摆入库角标');
});
test('有评分才在卡片显示星级；回收站筛选下移除键换成恢复/彻底删除，访客没有写身份',()=>{
 const m={uid:'c'.repeat(32),platform:'sketchfab',name:'Rated',license:'CC0'};
 assert.doesNotMatch(build().card(m),/card-rating/);
 const rated=build({favorites:new Set(),models:[],selected:new Set(),tasks:[],userMeta:{[m.uid]:{rating:4,note:'x'}}}).card(m);
 assert.match(rated,/class="card-rating"/);
 assert.equal((rated.match(/<span class="on">/g)||[]).length,4);
 assert.equal((rated.match(/<i class="star">/g)||[]).length,5);
 const trashed=build({favorites:new Set(),models:[],selected:new Set(),tasks:[],filter:'trash'}).card(m);
 assert.match(trashed,/data-action="restore"/);
 assert.match(trashed,/data-action="purge"/);
 assert.doesNotMatch(trashed,/data-action="remove"/);
 assert.doesNotMatch(build({favorites:new Set(),models:[],selected:new Set(),tasks:[],filter:'trash'},()=>({jobs:[]}),true).card(m),/data-action="restore"/);
});

/* ══ 全平台统一收藏 + 撤下选择方块（2026-11-12）══ */
const src=name=>fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','library',name),'utf8');

test('可收藏目标：稳定 32 位 uid、登记可读、素材包跳过入库',()=>{
 const uid=favoriteUid('picture','huaban:https://example.com/a.jpg');
 assert.match(uid,/^[a-f0-9]{32}$/i,'uid 必须过 library-state 的 UID 校验');
 assert.equal(favoriteUid('picture','huaban:https://example.com/a.jpg'),uid,'同一个资产每次算出同一个 uid');
 assert.notEqual(favoriteUid('picture','huaban:https://example.com/b.jpg'),uid);
 assert.equal(favoriteTarget(uid),null);
 registerFavoriteTarget(uid,{uid,name:'A',platform:'huaban'});
 assert.equal(favoriteTarget(uid).name,'A');
 assert.equal(favoriteSkipsCollect(uid),false,'在线资产要 collect 进模型库');
 const pkg=favoriteUid('package','root|folder');
 registerFavoriteTarget(pkg,{uid:pkg,name:'Pack'},{skipCollect:true});
 assert.equal(favoriteSkipsCollect(pkg),true,'本地素材包已在库里，不能再塞一份模型卡');
 assert.equal(registerFavoriteTarget('not-a-uid',{uid:'x'}),'not-a-uid','非法 uid 不该登记');
});

test('统一心形键：同一份 HTML，已收藏回填高亮与 aria-pressed',()=>{
 const icon=name=>`<i class="${name}"></i>`;
 const off=favoriteButtonHtml({uid:'a'.repeat(32),saved:false,icon});
 const on=favoriteButtonHtml({uid:'a'.repeat(32),saved:true,icon});
 assert.match(off,/data-action="favorite"/);
 assert.match(off,/class="favorite"/);
 assert.match(off,/aria-pressed="false"/);
 assert.match(on,/class="favorite saved"/);
 assert.match(on,/aria-pressed="true"/);
 assert.match(on,/<i class="heart">/);
});

test('图站单图 / 本地素材包都画心形键，模型卡不再有 pictureMode 例外',()=>{
 const view=src('library-view.js'),local=src('local-files.js'),card=src('card-view.js');
 assert.match(view,/favoriteButtonHtml\(\{uid:favUid/,'图站卡片要有收藏键');
 assert.match(view,/registerFavoriteTarget\(favUid/,'图站资产要登记成可收藏目标');
 assert.match(local,/favoriteButtonHtml\(\{uid:favUid/,'素材包卡片要有收藏键');
 assert.match(local,/skipCollect:true/,'素材包不能重复入库');
 assert.match(card,/const favoriteButton=favoriteButtonHtml/);
 assert.doesNotMatch(card,/favoriteButton=pictureMode/,'收藏键不能被图片模式屏蔽');
});

test('收藏链路与选择方块：findModel 兜底、skipCollect 生效、方块只隐藏不删节点',()=>{
 const app=src('app.js');
 assert.match(app,/favoriteTarget\(uid\)/,'findModel 要能找到登记过的图站资产');
 assert.match(app,/favoriteSkipsCollect\(uid\)/,'本地素材包跳过 collect');
 assert.match(app,/favorites:\(\)=>state\.favorites/,'素材包卡片要能读到收藏状态');
 assert.match(css,/\.card-media>\.card-select\{display:none!important\}/,'右上角方块不再显示');
 assert.match(src('card-view.js'),/data-select=/,'DOM 与 data-select 契约仍保留给框选 / Shift 连选');
});

// 本地资产的封面热区无可见文字，可访问名称仍跟随预览能力：图片给「查看图片」，能在内置 3D 查看器里
// 转的模型给「3D 预览」，其余才是「打开文件」（2026-11-14 用户反馈本地模型点开被甩给系统）。
test('本地资产整张封面可点击，无中间文字，保留准确的可访问名称',()=>{
 const base={uid:'c'.repeat(32),platform:'local',name:'asset',thumbnail:'/api/local/thumb?w=512&root=x&rel=y'};
 const label = model => {
  const html=build().card(model);
  const hit=html.match(/class="preview-hit"[^>]*aria-label="([^"]+)"[^>]*>(.*?)<\/button>/s);
  assert.ok(hit);assert.equal(hit[2],'');
  return hit[1].replace(/ asset$/,'');
 };
 assert.equal(label({...base,assetType:'image',ext:'png'}),'查看图片');
 assert.equal(label({...base,assetType:'model',ext:'glb'}),'3D 预览');
 assert.equal(label({...base,assetType:'model',ext:'fbx'}),'3D 预览');
 // .blend / .usd 只能出封面图，内置查看器打不开，文案要老实
 assert.equal(label({...base,assetType:'model',ext:'blend'}),'打开文件');
 assert.equal(label({...base,assetType:'other',ext:''}),'打开文件');
 // 老记录 assetType 还是 other，但格式已经能认出是 glb：也按能预览处理
 assert.equal(label({...base,assetType:'other',ext:'glb'}),'3D 预览');
});
