// 问题反馈页签：面板里填标题 / 描述 / 截图，点一次就把 GitHub 新建 issue 页带着参数打开，
// 截图顺手写进系统剪贴板 —— 到 GitHub 正文框 Ctrl+V 就直接上传，用户最后只剩点 Create。
//
// 为什么停在「Ctrl+V + Create」这两步：GitHub 没有免登录的建 issue 接口，图片也没法走 URL 参数，
// 第三方网页里的最后一次点击更不可能代劳。能自动的都自动到这一层，剩下的动作各剩一次。
// 一律走 openExternal：打包后的 WebView 不认 target="_blank" / window.open（见 open-url.js）。

import {collectDiagnostics,currentError,formatDiagnostics,hookDiagnostics,rememberError} from './diagnostics.js';
import {openHelp} from './help-panel.js';
import {icon} from './icon-set.js';
import {openExternal} from './open-url.js';

const REPO='ARTpace/Arvimo';
export const ISSUES_URL=`https://github.com/${REPO}/issues`;
export const REPO_URL=`https://github.com/${REPO}`;
// 诊断要读一次版本号（走 Tauri invoke），慢了就先不等，别让按钮像卡死。
const ENV_TIMEOUT=1200;
// GitHub 对新建 issue 的地址有长度上限，超了直接 414。留出余量后按需裁掉描述尾部。
export const URL_LIMIT=6800;
// 截图合成：太宽在 GitHub 正文里看不清，太高会把内存和粘贴体积一起拉满。
const SHOT_MAX_WIDTH=1600;
const SHOT_MAX_HEIGHT=9000;
const SHOT_MAX_COUNT=6;
const SHOT_GAP=12;
const DRAFT_KEY='av:feedback-draft-v1';
// 描述被链接长度裁过时贴在正文里的说明 —— 它的长度也要算进预算，不然裁完又超。
const TRIM_NOTE='\n\n…（超出链接长度上限，剩下的请直接在 GitHub 里补）';

// labels 只在仓库里已存在同名标签时生效，不存在 GitHub 会静默忽略，不影响新建。
const KINDS={
 bug:{labels:'bug',prefix:'[Bug] ',title:'一句话说清现象，例：导出 GLB 卡在 90%',detail:'怎么复现、期望是什么。空着也能发 —— 环境信息会自动带进正文'},
 feature:{labels:'enhancement',prefix:'[Feature] ',title:'一句话说清想要什么，例：支持直接导出 USDZ',detail:'想要的功能、什么场景下用得上。空着也能发 —— 环境信息会自动带进正文'},
};

// 标记住在 index.html 的合并面板（#help-dialog）第二页，这里只找它、绑一次。
let panel=null;
let wired=false;
let pendingError='';
let kind='bug';
let shots=[];
let shotSeq=0;

function ensurePanel(){
 if(panel&&panel.isConnected)return panel;
 panel=document.getElementById('help-panel-feedback');
 if(!panel)return null;
 if(!wired){
  wired=true;
  panel.addEventListener('click',onPanelClick);
  panel.addEventListener('input',onPanelInput);
  panel.addEventListener('dragover',onDragOver);
  panel.addEventListener('dragleave',onDragLeave);
  panel.addEventListener('drop',onDrop);
  // 面板打开时焦点可能不在输入框上，粘图要能兜住，所以挂到 document 再判可见性。
  document.addEventListener('paste',onPaste);
  const picker=panel.querySelector('#feedback-shot-input');
  picker?.addEventListener('change',()=>{addFiles(picker.files);picker.value='';});
  paintIcons(panel);
  restoreDraft();
  paintKind();
 }
 return panel;
}

/** 供 app.js 启动时绑一次；重复调用无副作用。 */
export function initFeedbackPanel(){
 hookDiagnostics();
 return ensurePanel();
}

function setStatus(text,tone=''){
 const node=ensurePanel()?.querySelector('#feedback-status');
 if(!node)return;
 node.textContent=text;
 node.dataset.tone=tone;
}

/** 最近一次报错：优先用 openFeedback 带进来的，其次用 diagnostics 记下的那条。 */
function errorText(){
 return pendingError||String(currentError()?.message||'').trim();
}

function withTimeout(promise,ms){
 return new Promise(resolve=>{
  const timer=setTimeout(()=>resolve(null),ms);
  promise.then(
   value=>{clearTimeout(timer);resolve(value);},
   ()=>{clearTimeout(timer);resolve(null);},
  );
 });
}

async function envBlock(){
 const ctx=await withTimeout(collectDiagnostics(),ENV_TIMEOUT);
 if(!ctx)return '';
 const lines=[formatDiagnostics(ctx)];
 if(!ctx.recent?.length)lines.push('（最近没有失败请求）');
 return lines.join('\n');
}

/** 正文模板。标题 / 描述由用户填，环境块自动补 —— 模板本身导出，测试直接断言它。 */
export function issueBody(kind,{detail='',env='',shotCount=0}={}){
 const text=String(detail||'').trim();
 const lines=kind==='feature'
  ?['### 想要什么','',text,'','### 现在是怎么绕的','','']
  :['### 发生了什么','',text,'','### 期望结果','','','### 复现步骤','1. ','2. ',''];
 if(shotCount>0){
  lines.push('### 截图',`本次带了 ${shotCount} 张截图，已经复制到剪贴板 —— 点一下正文末尾按 Ctrl+V 就自动上传。`,'');
 }
 if(env)lines.push('---','','### 运行环境（自动填写，可删）','','```',env,'```','');
 return lines.join('\n');
}

function composeUrl(meta,title,detail,env,shotCount){
 const query=new URLSearchParams({
  labels:meta.labels,
  title,
  body:issueBody(meta.kind,{detail,env,shotCount}),
 });
 return `${ISSUES_URL}/new?${query}`;
}

function encodedLength(text){
 return encodeURIComponent(String(text||'')).length;
}

/** 按编码后的字节预算截一段文本：中文 1 字 9 字符、ASCII 1 字 1 字符，纯比例估不准，所以要收敛。 */
function fitDetail(text,budget){
 const raw=String(text||'');
 if(!raw||budget<=0)return '';
 if(encodedLength(raw)<=budget)return raw;
 const ratio=budget/encodedLength(raw);
 let hi=Math.min(raw.length,Math.max(1,Math.ceil(raw.length*ratio)+8));
 let lo=0;
 while(lo<hi){
  const mid=Math.ceil((lo+hi)/2);
  if(encodedLength(raw.slice(0,mid))<=budget)lo=mid;else hi=mid-1;
 }
 let cut=raw.slice(0,lo);
 // 别把 emoji 的代理对切成半个，GitHub 那边会显示成问号。
 if(/[\uD800-\uDBFF]$/.test(cut))cut=cut.slice(0,-1);
 return cut;
}

/**
 * 拼 GitHub 新建 issue 的地址（导出仅为可测：模板与参数一旦走偏，用户就白写一遍）。
 * 标题为空时只留类型前缀；正文超长时先保描述、再保环境块，裁过就在正文里说明。
 */
export function issueUrl({kind='bug',title='',detail='',env='',shotCount=0}={}){
 const key=KINDS[kind]?kind:'bug';
 const meta={...KINDS[key],kind:key};
 const cleanTitle=String(title||'').trim();
 const head=cleanTitle?`${meta.prefix}${cleanTitle}`:meta.prefix;
 const raw=String(detail||'').trim();
 let envText=String(env||'');
 // 环境块是自动补的：它把预算吃光时先让它让位，用户手写的内容不该被挤掉。
 if(raw&&URL_LIMIT-composeUrl(meta,head,'',envText,shotCount).length<=0)envText='';
 const budget=URL_LIMIT-composeUrl(meta,head,'',envText,shotCount).length;
 let body=fitDetail(raw,budget);
 if(body.length<raw.length){
  body=`${fitDetail(raw,budget-encodedLength(TRIM_NOTE)).trimEnd()}${TRIM_NOTE}`.trim();
 }
 return composeUrl(meta,head,body,envText,shotCount);
}

function loadImage(blob){
 return new Promise((resolve,reject)=>{
  const url=URL.createObjectURL(blob);
  const img=new Image();
  img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
  img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('截图解码失败'));};
  img.src=url;
 });
}

/** 多张截图纵向拼成一张 PNG：GitHub 正文一次 Ctrl+V 只会贴一张，拼好才不用来回切。 */
async function composeShotImage(){
 const images=[];
 for(const shot of shots)images.push(await loadImage(shot.blob));
 const width=Math.max(1,Math.min(SHOT_MAX_WIDTH,...images.map(img=>img.naturalWidth||1)));
 const gap=images.length>1?SHOT_GAP:0;
 const parts=images.map(img=>{
  const w=width;
  const h=Math.max(1,Math.round((img.naturalHeight||1)*width/(img.naturalWidth||1)));
  return {img,w,h};
 });
 const rawHeight=parts.reduce((sum,part)=>sum+part.h,0)+gap*(parts.length-1);
 const scale=rawHeight>SHOT_MAX_HEIGHT?SHOT_MAX_HEIGHT/rawHeight:1;
 const canvas=document.createElement('canvas');
 canvas.width=Math.max(1,Math.round(width*scale));
 canvas.height=Math.max(1,Math.round(rawHeight*scale));
 const ctx=canvas.getContext('2d');
 // 截图里常有透明 PNG，先铺白底，免得深色模式下看不清。
 ctx.fillStyle='#fff';
 ctx.fillRect(0,0,canvas.width,canvas.height);
 let y=0;
 for(const part of parts){
  const h=Math.round(part.h*scale);
  ctx.drawImage(part.img,0,y,Math.round(part.w*scale),h);
  y+=h+Math.round(gap*scale);
 }
 return await new Promise((resolve,reject)=>{
  canvas.toBlob(blob=>{blob?resolve(blob):reject(new Error('截图合成失败'));},'image/png');
 });
}

/** 把截图塞进系统剪贴板：GitHub 的正文框只认粘贴进来的图，URL 参数带不了二进制。 */
async function stageClipboard(){
 if(!shots.length)return {ok:false,count:0,reason:'empty'};
 if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined'){
  return {ok:false,count:shots.length,reason:'unsupported'};
 }
 try{
  const blob=await composeShotImage();
  await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  return {ok:true,count:shots.length};
 }catch(error){
  console.warn('截图写剪贴板失败，用户仍可手动拖进 GitHub：',error);
  return {ok:false,count:shots.length,reason:'denied'};
 }
}

function openHint(clip){
 if(!clip.count)return '已在浏览器打开 GitHub，标题和正文都填好了，点 Create issue 就提交。';
 if(clip.ok)return `已打开 GitHub，并把 ${clip.count} 张截图复制到剪贴板：点一下正文末尾按 Ctrl+V，图会自动上传，再点 Create issue。`;
 return `已打开 GitHub，但 ${clip.count} 张截图没能自动复制 —— 把它们从面板拖进正文框，效果一样。`;
}

async function submit(){
 const node=ensurePanel();
 if(!node)return;
 const button=node.querySelector('#feedback-submit');
 if(!button||button.dataset.busy)return;
 const title=String(node.querySelector('#feedback-title')?.value||'').trim();
 const detail=String(node.querySelector('#feedback-body')?.value||'').trim();
 if(!title&&!detail&&!errorText()){
  setStatus('先写一句标题或描述，不然 GitHub 那边只有一个空模板。','error');
  node.querySelector('#feedback-title')?.focus();
  return;
 }
 button.dataset.busy='true';
 setStatus(shots.length?'正在打包截图…':'正在整理环境信息…');
 try{
  // 先动剪贴板：写图片要求用户手势，拖到 await 环境信息之后就容易被浏览器拒。
  const clip=await stageClipboard();
  setStatus('正在整理环境信息…');
  const env=await envBlock();
  openExternal(issueUrl({kind,title,detail:detail||errorText(),env,shotCount:shots.length}));
  setStatus(openHint(clip),clip.count&&!clip.ok?'warn':'ok');
 }catch(error){
  console.warn('打开 GitHub 新建 issue 失败：',error);
  setStatus(`没能唤起浏览器，手动打开 ${ISSUES_URL} 新建 issue 也一样。`,'error');
 }finally{
  delete button.dataset.busy;
 }
}

function paintKind(){
 const node=ensurePanel();
 if(!node)return;
 for(const btn of node.querySelectorAll('[data-feedback-kind]')){
  const on=btn.dataset.feedbackKind===kind;
  btn.classList.toggle('active',on);
  btn.setAttribute('aria-checked',String(on));
 }
 const meta=KINDS[kind];
 const titleEl=node.querySelector('#feedback-title');
 const bodyEl=node.querySelector('#feedback-body');
 if(titleEl)titleEl.placeholder=meta.title;
 if(bodyEl)bodyEl.placeholder=meta.detail;
}

function pickKind(next){
 if(!KINDS[next]||next===kind)return;
 kind=next;
 paintKind();
 saveDraft();
}

function paintIcons(root){
 for(const el of root.querySelectorAll('[data-icon]')){
  el.innerHTML=icon(el.dataset.icon).replace(/^<i>|<\/i>$/g,'');
 }
}

function renderShots(){
 const node=ensurePanel();
 if(!node)return;
 const list=node.querySelector('#feedback-shot-list');
 if(!list)return;
 const items=[];
 for(const shot of shots){
  const item=document.createElement('li');
  item.className='gh-shot';
  const thumb=document.createElement('img');
  thumb.src=shot.url;
  thumb.alt='截图预览';
  const remove=document.createElement('button');
  remove.type='button';
  remove.className='gh-shot-del';
  remove.dataset.shotRemove=shot.id;
  remove.setAttribute('aria-label','移除这张截图');
  remove.textContent='×';
  item.append(thumb,remove);
  items.push(item);
 }
 list.replaceChildren(...items);
 const empty=node.querySelector('#feedback-shot-empty');
 if(empty)empty.hidden=shots.length>0;
}

function dropZone(){
 return ensurePanel()?.querySelector('#feedback-shots')||null;
}

async function addFiles(fileList){
 const files=Array.from(fileList||[]).filter(file=>/^image\//.test(file.type||''));
 if(!files.length)return;
 const room=SHOT_MAX_COUNT-shots.length;
 if(room<=0){
  setStatus(`最多带 ${SHOT_MAX_COUNT} 张截图，先删一张再加。`,'warn');
  return;
 }
 const accepted=files.slice(0,room);
 for(const file of accepted){
  const shot={id:`shot-${++shotSeq}`,blob:file,url:URL.createObjectURL(file),width:0,height:0};
  shots.push(shot);
  try{
   const img=await loadImage(file);
   shot.width=img.naturalWidth;
   shot.height=img.naturalHeight;
  }catch{
   /* 解不开的图先留着，合成时再单独报错 */
  }
 }
 renderShots();
 setStatus(`已加入 ${accepted.length} 张截图，点「带去 GitHub 填写」时会自动复制到剪贴板。`,'ok');
}

function removeShot(id){
 shots=shots.filter(shot=>shot.id!==id);
 renderShots();
 setStatus(shots.length?`还剩 ${shots.length} 张截图。`:'');
}

function saveDraft(){
 const node=ensurePanel();
 if(!node)return;
 try{
  localStorage.setItem(DRAFT_KEY,JSON.stringify({
   kind,
   title:String(node.querySelector('#feedback-title')?.value||''),
   detail:String(node.querySelector('#feedback-body')?.value||''),
  }));
 }catch{
  /* 隐私模式写不了 localStorage，草稿丢了也不影响提交 */
 }
}

function restoreDraft(){
 const node=ensurePanel();
 if(!node)return;
 let draft=null;
 try{
  draft=JSON.parse(localStorage.getItem(DRAFT_KEY)||'null');
 }catch{
  draft=null;
 }
 if(draft&&KINDS[draft.kind])kind=draft.kind;
 const titleEl=node.querySelector('#feedback-title');
 const bodyEl=node.querySelector('#feedback-body');
 // 报错带进来的信息优先：它就是用户点「反馈」的理由，别被旧草稿盖掉。
 const fallback=errorText();
 if(titleEl)titleEl.value=String(draft?.title||'');
 if(bodyEl)bodyEl.value=String(draft?.detail||fallback||'');
}

function onPanelInput(event){
 if(event.target.closest('#feedback-title, #feedback-body'))saveDraft();
}

function onPanelClick(event){
 const kindBtn=event.target.closest('[data-feedback-kind]');
 if(kindBtn){pickKind(kindBtn.dataset.feedbackKind);return;}
 const remove=event.target.closest('[data-shot-remove]');
 if(remove){removeShot(remove.dataset.shotRemove);return;}
 if(event.target.closest('#feedback-submit')){submit();return;}
 if(event.target.closest('#feedback-star-repo')){starRepo();return;}
 if(event.target.closest('#feedback-open-list')){openExternal(ISSUES_URL);return;}
 if(event.target.closest('#feedback-shots'))ensurePanel()?.querySelector('#feedback-shot-input')?.click();
}

function onPaste(event){
 const node=ensurePanel();
 if(!node||node.hidden)return;
 const items=event.clipboardData?.items;
 if(!items)return;
 const files=[];
 for(const item of items){
  if(item.kind!=='file'||!/^image\//.test(item.type||''))continue;
  const file=item.getAsFile();
  if(file)files.push(file);
 }
 if(!files.length)return;
 // 面板里粘图一律当截图收，别让图片被粘进标题框变成乱码。
 event.preventDefault();
 addFiles(files);
}

function onDragOver(event){
 if(!event.dataTransfer?.types?.includes('Files'))return;
 event.preventDefault();
 event.dataTransfer.dropEffect='copy';
 dropZone()?.classList.add('drop');
}

function onDragLeave(event){
 if(event.target===dropZone())dropZone()?.classList.remove('drop');
}

function onDrop(event){
 const zone=dropZone();
 zone?.classList.remove('drop');
 const files=event.dataTransfer?.files;
 if(!zone||!event.target.closest('#feedback-shots')||!files?.length)return;
 event.preventDefault();
 addFiles(files);
}

/** 加 Star 关注仓库：GitHub 没有免登录的 star 接口，只能把人送到仓库页点右上角 Star。 */
function starRepo(){
 try{
  openExternal(REPO_URL);
  setStatus('已在浏览器打开仓库页，点右上角 Star 就关注好了。','ok');
 }catch{
  setStatus(`没能唤起浏览器，手动打开 ${REPO_URL} 也能加 Star。`,'error');
 }
}

/** 打开反馈页签。message 通常来自一次报错，会预填进描述框省得用户复述。 */
export function openFeedback({message}={}){
 hookDiagnostics();
 if(message){
  pendingError=String(message).trim();
  rememberError(pendingError);
 }
 const node=ensurePanel();
 if(!node)return;
 // 启动时就建过面板的话草稿已经回填过了，这里只补「报错带进来的那句话」。
 const bodyEl=node.querySelector('#feedback-body');
 if(pendingError&&bodyEl&&!bodyEl.value.trim())bodyEl.value=pendingError;
 openHelp('feedback');
}
