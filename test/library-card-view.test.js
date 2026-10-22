import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCardView} from '../src/library/card-view.js';
import {platformLabel} from '../src/library/platforms.js';

const css=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','src','library','app.css'),'utf8');

// 卡片 meta 单行化后只渲染「标题 · 作者（与来源不同名时） · 许可」，统计/平台标签行已移除。
// 这里用最小桩构造视图，验证单行结构与许可渲染，不牵动真正的 state / Blender 桥。
const build=(state={favorites:new Set(),models:[],selected:new Set(),tasks:[]},downloadsUI=()=>({jobs:[]}),isVisitor=false)=>createCardView({
 icon:name=>`<i class="${name}"></i>`,
 esc:s=>s==null?'':String(s),
 fmt:n=>(n??0).toLocaleString('en-US'),
 state,
 queuePulse:new Map(),
 imageDownload:{button:()=>'<button class="card-icon-action download-images" data-action="download-images">img</button>'},
 blenderSendButton:()=>'',
 platformLabel,
 artstationUI:()=>({has3dScene:()=>false}),
 downloadsUI,
 isVisitor,
});

const render=model=>build().card(model);

test('ambientCG models hide texture tiers and recognise existing model files at any resolution',()=>{
 for(const sourceType of ['terrain','3d-model']){
  const model={uid:'a'.repeat(32),name:'Model',platform:'ambientcg',assetType:'models',sourceType,materialResolution:'2K',materialFormat:'PNG'};
  const job={id:'local',uid:model.uid,state:'saved',fileExists:true,options:{resolution:'1K',textureFormat:'JPG'}};
  const html=build(undefined,()=>({jobs:[job]})).card(model);
  assert.doesNotMatch(html,/data-material-resolution/);
  assert.match(html,/aria-label="已下载到本地"/);
  assert.match(html,/data-action="reveal-download"/);
  const missing=build(undefined,()=>({jobs:[{...job,fileExists:false}]})).card(model);
  assert.doesNotMatch(missing,/aria-label="已下载到本地"/);
 }
});

test('SBSAR has no resolution selector but is distinct from baked texture downloads',()=>{
 const model={uid:'b'.repeat(32),name:'Substance',platform:'ambientcg',assetType:'textures',sourceType:'substance',materialResolution:'8K'};
 const job={id:'sbsar',uid:model.uid,state:'saved',fileExists:true,options:{resolution:'2K',textureFormat:'SBSAR'}};
 const html=build(undefined,()=>({jobs:[job]})).card(model);
 assert.doesNotMatch(html,/data-material-resolution/);
 assert.match(html,/aria-label="已下载到本地"/);
 const baked=build(undefined,()=>({jobs:[{...job,options:{textureFormat:'JPG'}}]})).card(model);
 assert.doesNotMatch(baked,/aria-label="已下载到本地"/);
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
 // 「已下载」的判据看下载键（disabled + 文案），typeLabel 已不再显示导出状态。
 const downloadedKey=html=>(/<button class="card-download"[^>]*\sdisabled/.test(html))&&html.includes('>已下载<');
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
 const badge=html.match(/<div class="card-type">.*?<\/div>/s)?.[0]||'';
 assert.ok(badge.includes('PBR 材质'),'类型位只放资源类型');
 assert.equal(/card-type">[^<]*check/.test(html),false,'已下载也不该把类型图标换成对勾');
});

test('the resolution picker marks which tiers are already downloaded',()=>{
 // 只下载过 4K：下拉里 4K 打勾，其余档位不标（与下载键同一判据）。
 const tex={uid:'t'.repeat(32),name:'Aerial Asphalt 01',author:'Poly Haven',platform:'polyhaven',assetType:'textures',thumbnail:'',license:'CC0',downloadable:true,materialResolution:'4K'};
 const jobs=[{id:'j4',uid:tex.uid,kind:'polyhaven',state:'saved',fileExists:true,options:{output:'folder',resolution:'4K',textureFormat:'JPG'}}];
 const picker=build(undefined,()=>({jobs})).card(tex).match(/<select class="material-resolution"[^>]*>.*?<\/select>/s)?.[0];
 assert.ok(picker,'材质卡片要有精度选择');
 assert.ok(picker.includes('<option value="4K" selected>4K ✓</option>'),'已下载的 4K 要打勾');
 assert.ok(!picker.includes('2K ✓')&&!picker.includes('8K ✓'),'没下载过的档位不能误标');
 // 没有任务的卡片四档都不标，默认 2K 选中（select 的 title 说明里也有 ✓ 字样，只查 option 文本）
 const fresh=render({uid:'u'.repeat(32),name:'Bricks',author:'ambientCG',platform:'ambientcg',assetId:'Bricks',thumbnail:'',license:'CC0',downloadable:true});
 assert.ok(!fresh.includes('>1K ✓<')&&!fresh.includes('>2K ✓<'),'未下载时不打勾');
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
 assert.ok(html.includes('card-license'),'许可在同一行内显示');
 // 动作行必须是 card-meta 的兄弟：meta 变成 flex 布局后，误嵌套会把按钮拉进信息行
 assert.match(html,/<\/div><\/div><div class="card-bottom">/,'card-bottom 必须与 card-meta 平级，不能嵌在信息行里');
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

test('library and folder affordances live on the thumbnail corners, not the bottom row',()=>{
 const model={uid:'c'.repeat(32),name:'Ground 054',author:'ambientCG',platform:'ambientcg',assetId:'Ground054',thumbnail:'',license:'CC0',downloadable:true};
 const mediaOf=html=>html.slice(html.indexOf('card-media'),html.indexOf('card-meta'));
 // 未加入：左下角是可点的「加入模型库」；底部不再有 collect 图标键
 const plain=build();
 const html=plain.card(model);
 assert.ok(mediaOf(html).includes('collect-badge'),'加入模型库标识应在缩略图内');
 assert.ok(mediaOf(html).includes('加入模型库'),'未加入时要显示可点的加入文案');
 assert.equal(html.includes('collect-button'),false,'底部的旧加入模型库图标键应已移除');
 // 已加入：同一位置显示「已加入模型库」，且置为不可点
 const joined=build({favorites:new Set(),models:[{uid:model.uid}],selected:new Set(),tasks:[]});
 const joinedHtml=joined.card(model);
 assert.ok(mediaOf(joinedHtml).includes('collect-badge collected'),'已加入时标识应带 collected 状态');
 assert.ok(mediaOf(joinedHtml).includes('已加入模型库'));
 // 打开文件夹：已下载的卡片上出现在缩略图内（右下角），不在底部行
 const saved=build(undefined,()=>({jobs:[{uid:model.uid,state:'saved',fileExists:true,id:'job-1'}]}));
 const savedHtml=saved.card(model);
 assert.ok(mediaOf(savedHtml).includes('open-folder'),'打开文件夹按键应落在缩略图内');
 assert.ok(savedHtml.includes('data-action="reveal-download"'));
});

test('compact view moves the thumbnail overlays into the info column',()=>{
 const model={uid:'g'.repeat(32),name:'Ground 054',author:'ambientCG',platform:'ambientcg',assetId:'Ground054',thumbnail:'https://x/t.jpg',license:'CC0',downloadable:true};
 const html=build({favorites:new Set(),models:[],selected:new Set(),tasks:[],compact:true}).card(model);
 const controls=html.slice(html.indexOf('card-controls'),html.indexOf('card-meta'));
 for(const cls of ['card-type','favorite','card-select','collect-badge','compact-preview']){
  assert.ok(controls.includes(cls),`紧凑视图的 ${cls} 应在信息栏内`);
 }
 const media=html.slice(html.indexOf('card-media'),html.indexOf('card-controls'));
 for(const cls of ['favorite','card-select','collect-badge','preview-hit','card-type']){
  assert.equal(media.includes(cls),false,`缩略图上不该再叠 ${cls}`);
 }
 assert.ok(html.includes('thumbnail'),'缩略图本身要保留');
});

test('the gallery view keeps overlays on the thumbnail even when compact was toggled before',()=>{
 const model={uid:'h'.repeat(32),name:'Ground 054',author:'ambientCG',platform:'ambientcg',assetId:'Ground054',thumbnail:'https://x/t.jpg',license:'CC0',downloadable:true};
 const html=build({favorites:new Set(),models:[],selected:new Set(),tasks:[],compact:true}).card(model,{gallery:true});
 assert.equal(html.includes('card-controls'),false,'画廊视图不应渲染紧凑控件行');
 const media=html.slice(html.indexOf('card-media'),html.indexOf('card-meta'));
 assert.ok(media.includes('preview-hit')&&media.includes('favorite'),'画廊视图控件仍叠在缩略图上');
});

test('an already downloaded card cannot be downloaded again',()=>{
 const model={uid:'i'.repeat(32),name:'Wood 096',author:'ambientCG',platform:'ambientcg',assetId:'Wood096',thumbnail:'',license:'CC0',downloadable:true};
 const saved=build(undefined,()=>({jobs:[{uid:model.uid,state:'saved',fileExists:true,id:'job-1'}]}));
 const html=saved.card(model);
 assert.match(html,/<button class="card-download"[^>]*\sdisabled/,'已有导出记录时下载键必须禁用，防重复下载');
 assert.ok(html.includes('已下载'),'下载键文案要改成已下载');
 assert.ok(html.includes('无需重复下载'),'禁用态要说明原因');
 // 队列任务结束（saved）同样按已下载处理
 const taskDone=build({favorites:new Set(),models:[],selected:new Set(),tasks:[{uid:model.uid,state:'saved'}]});
 assert.match(taskDone.card(model),/<button class="card-download"[^>]*\sdisabled/,'本地任务已 saved 时也要禁用');
 // 没下载过的照常可点
 const fresh=render(model);
 assert.equal(/<button class="card-download"[^>]*\sdisabled/.test(fresh),false,'未下载的卡片下载键必须可点');
});

test('the meta row drops the downloadable tag and folds the license into a hint key',()=>{
 // 2026-10-21：许可不再占一行文字（会把标题与作者一起挤成省略号），收成一枚 ? 键，悬停看全文。
 const html=render({uid:'l'.repeat(32),name:'Aerial Asphalt 01',author:'Rob Tuytel',platform:'polyhaven',assetType:'textures',thumbnail:'',license:'CC0 1.0 通用公共领域贡献',downloadable:true});
 assert.equal(html.includes('license-tag'),false,'「● 可下载」标识去掉');
 assert.ok(html.includes('license-hint'),'许可变成说明键');
 assert.equal(/>CC0</.test(html),false,'许可缩写不再直接铺在信息行里');
 assert.ok(html.includes('CC0 1.0 通用公共领域贡献 · 可下载不代表可商用'),'完整许可说明留在 title 里');
 // 任何许可全称都要能被悬停读到，不能截断
 const by=render({uid:'m'.repeat(32),name:'X',author:'a',thumbnail:'',license:'CC BY-NC-SA 4.0',downloadable:true});
 assert.ok(by.includes('CC BY-NC-SA 4.0 · 可下载不代表可商用'),'CC BY-NC-SA 全文进 title');
 // 标题固定单行：长名字一律省略号截断，不再撑到两行把卡片拉高（2026-10-16 用户要求）
 assert.equal(/-webkit-line-clamp/.test(css),false,'标题不再允许两行');
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
 assert.match(build(undefined,()=>({jobs:[job]})).card(model),/<span>已下载<\/span>/);
});

// 入库角标和底部移除键都在改主机的资产库，访客的卡片上不该出现这两个入口。
test('LAN visitors see no library-membership badge or remove button',()=>{
 const model={uid:'d'.repeat(32),name:'Fox',platform:'sketchfab',assetType:'model'};
 const guest=build({favorites:new Set(),models:[model],selected:new Set(),tasks:[]},()=>({jobs:[]}),true).card(model);
 assert.doesNotMatch(guest,/collect-badge/);
 assert.doesNotMatch(guest,/data-action="remove"/);
 assert.match(build({favorites:new Set(),models:[model],selected:new Set(),tasks:[]},()=>({jobs:[]})).card(model),/collect-badge/);
});
test('有评分才在卡片显示星级；回收站筛选下移除键换成恢复/彻底删除，访客没有写身份',()=>{
 const m={uid:'c'.repeat(32),platform:'sketchfab',name:'Rated',license:'CC0'};
 assert.doesNotMatch(build().card(m),/card-rating/);
 const rated=build({favorites:new Set(),models:[],selected:new Set(),tasks:[],userMeta:{[m.uid]:{rating:4,note:'x'}}}).card(m);
 assert.match(rated,/class="card-rating"/);
 assert.match(rated,/★★★★/);
 const trashed=build({favorites:new Set(),models:[],selected:new Set(),tasks:[],filter:'trash'}).card(m);
 assert.match(trashed,/data-action="restore"/);
 assert.match(trashed,/data-action="purge"/);
 assert.doesNotMatch(trashed,/data-action="remove"/);
 assert.doesNotMatch(build({favorites:new Set(),models:[],selected:new Set(),tasks:[],filter:'trash'},()=>({jobs:[]}),true).card(m),/data-action="restore"/);
});
