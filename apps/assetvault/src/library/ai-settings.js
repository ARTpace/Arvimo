import {icon} from './icon-set.js';
import {esc} from './html-esc.js';

/* 服务商预设：只填「OpenAI 兼容的 /v1 地址」，密钥还是要用户自己贴。
   地址一律可在下面手动改 —— 预设只是省掉一次复制粘贴，不是白名单。 */
const PROVIDERS=Object.freeze([
  {id:'gateway',label:'本地网关（默认）',baseUrl:'http://127.0.0.1:31415/v1'},
  {id:'deepseek',label:'DeepSeek 深度求索',baseUrl:'https://api.deepseek.com/v1'},
  {id:'zhipu',label:'智谱开放平台',baseUrl:'https://open.bigmodel.cn/api/paas/v4'},
  {id:'kimi',label:'月之暗面 Kimi',baseUrl:'https://api.moonshot.cn/v1'},
  {id:'siliconflow',label:'硅基流动',baseUrl:'https://api.siliconflow.cn/v1'},
  {id:'dashscope',label:'阿里云百炼',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  {id:'ark',label:'火山方舟',baseUrl:'https://ark.cn-beijing.volces.com/api/v3'},
  {id:'openai',label:'OpenAI',baseUrl:'https://api.openai.com/v1'},
  {id:'custom',label:'自定义接口',baseUrl:''},
]);

const ROLES=Object.freeze([
  {id:'text',label:'对话与整理',icon:'sparkle',hint:'翻译、打标签、整理文本'},
  {id:'translate',label:'搜索翻译',icon:'type',hint:'搜索词的翻译与扩写'},
  {id:'vision',label:'视觉理解',icon:'image',hint:'看图、以图搜索'},
  {id:'embed',label:'语义检索',icon:'layers',hint:'向量索引与找相似'},
]);

export function createAISettings({$,toast}){
 const modal=$('#ai-model-dialog');
 /* 弹窗挪进设置弹窗内部：--st-* 主题变量都在那一层，颜色才和整页一致。
    它自己也走 showModal，位于 top layer，不会被设置弹窗的 overflow 裁掉。 */
 const modalHost=$('#settings-dialog');
 if(modal&&modalHost&&typeof modalHost.append==='function'&&modal.parentElement!==modalHost)modalHost.append(modal);
 /* 当前内存里的配置视图：模型库与角色表都从它渲染，改动后立即整份回写。 */
 let config={models:[],roles:{}};
 /* 弹窗编辑的是「一个接口」：地址 + Key + 多行模型名。 */
 let editingBase='';
 let rows=[{name:''}];
 let probeNames=[],probeToken=0,pickIndex=-1,pickGroup='';

 const status=message=>{const node=$('#ai-status');if(node)node.textContent=message;};
 const sheetStatus=message=>{const node=$('#ai-new-status');if(node)node.textContent=message;};

 async function api(route,payload){
  const response=await fetch('/api/ai/'+route,{method:payload?'POST':'GET',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
  let data;try{data=await response.json();}catch{throw Error('AI 服务尚未更新，请重新启动工具');}
  if(!response.ok)throw Error(data.error||'AI 请求失败');return data;
 }

 /* ── 渲染 ───────────────────────────────────────────────────────────── */

 function hostOf(baseUrl){
  if(!baseUrl)return '未设地址';
  try{return new URL(baseUrl).host;}catch{return '自定义接口';}
 }

 /* 模型库里按接口聚合：同一个 API 只占一行，副标题列出它挂的模型。
    之前按模型逐条列，同一地址的 3 个模型就是 3 行重复的地址，纯噪声。 */
 function endpoints(){
  const map=new Map();
  for(const model of config.models||[]){
   const key=model.baseUrl||'';
   if(!map.has(key))map.set(key,{base:key,models:[]});
   map.get(key).models.push(model);
  }
  return [...map.values()];
 }

 function groupTitle(base,all){
  if(!base)return '未设地址';
  try{
   const url=new URL(base);
   const same=all.filter(group=>{try{return new URL(group.base).host===url.host;}catch{return false;}}).length;
   return same>1?url.host+url.pathname.replace(/\/$/,''):url.host;
  }catch{return base;}
 }

 function renderModels(){
  const list=$('#ai-model-list'),empty=$('#ai-model-empty');
  const groups=endpoints();
  if(list)list.innerHTML=groups.map((group,index)=>{
   const names=group.models.map(model=>model.name).join(' · ');
   const ids=group.models.map(model=>model.id);
   const roles=ROLES.filter(role=>ids.includes((config.roles||{})[role.id])).map(role=>role.label);
   const hasKey=group.models.some(model=>model.hasKey);
   const title=groupTitle(group.base,groups);
   return `<li class="ai-model" data-group="${index}">
    <i class="ai-model-dot${hasKey?' on':''}" aria-hidden="true"></i>
    <span class="ai-model-main"><b>${esc(title)}</b><small>${esc(names)}${roles.length?` · 用于 ${esc(roles.join(' / '))}`:''}</small></span>
    <span class="ai-model-acts">
      <button class="ai-icon" type="button" data-ai-edit="${index}" title="编辑接口与模型" aria-label="编辑 ${esc(title)}">${icon('edit')}</button>
      <button class="ai-icon" type="button" data-ai-del="${index}" title="删除这个接口" aria-label="删除 ${esc(title)}">${icon('trash')}</button>
    </span>
   </li>`;
  }).join('');
  if(empty)empty.hidden=groups.length>0;
 }

 function roleOptions(role){
  const current=(config.roles||{})[role]||'';
  const seen=new Set(),duplicate=new Set();
  for(const model of config.models){if(seen.has(model.name))duplicate.add(model.name);seen.add(model.name);}
  const labelOf=model=>duplicate.has(model.name)?`${model.name} · ${hostOf(model.baseUrl)}`:model.name;
  const optionOf=model=>`<option value="${esc(model.id)}">${esc(labelOf(model))}</option>`;
  /* 语义检索只认真向量模型：对话模型（deepseek-flash 之类）没有 /embeddings 端点，选错必 404。
     这里不硬过滤 —— 名字猜错的向量模型会被藏起来，用户就没法选了；改成显式分组标注。 */
  let options='';
  if(role==='embed'){
   const vectors=config.models.filter(model=>groupOfModel(model.name)==='embed');
   const others=config.models.filter(model=>groupOfModel(model.name)!=='embed');
   options+=`<optgroup label="向量模型">${vectors.map(optionOf).join('')||'<option value="" disabled>接口里还没有向量模型</option>'}</optgroup>`;
   if(others.length)options+=`<optgroup label="其他模型（通常不支持向量化）">${others.map(optionOf).join('')}</optgroup>`;
  }else options=config.models.map(optionOf).join('');
  if(current&&!config.models.some(model=>model.id===current||model.name===current))options=`<option value="${esc(current)}">${esc(current)}（未入库）</option>`+options;
  options=`<option value="">${role==='embed'?'不启用':'跟随对话模型'}</option>`+options;
  return options;
 }

 function renderRoles(){
  const host=$('#ai-roles');if(!host)return;
  host.innerHTML=ROLES.map(role=>{
   const value=(config.roles||{})[role.id]||'';
   /* 非向量角色留空时会回落到对话模型，所以只要库里有模型就能测；向量角色必须显式指定。 */
   const ready=role.id==='embed'?!!value:!!(value||config.models.length||config.model);
   /* 构建索引只在语义检索真的配了向量模型后才出现 —— 没配时它是颗死按钮，不该占版面。 */
   const build=role.id==='embed'&&value?`<button class="ai-test" type="button" data-ai-build="1" title="把资产向量化，供语义搜索与找相似使用">构建索引</button>`:'';
   return `<div class="ai-role-row" data-role="${role.id}">
    <span class="ai-role-name">${icon(role.icon)}<b>${role.label}</b><small>${role.hint}</small></span>
    <span class="ai-role-acts">
      <select data-ai-role="${role.id}" aria-label="${role.label}">${roleOptions(role.id)}</select>
      ${build}
      <button class="ai-test" type="button" data-ai-test="${role.id}"${ready?'':' disabled'} title="${ready?'用这个模型发一次最小请求':'先选一个模型'}">测试</button>
    </span>
   </div>`;
  }).join('');
  for(const role of ROLES){
   const select=host.querySelector?.(`[data-ai-role="${role.id}"]`);
   if(!select)continue;
   select.value=(config.roles||{})[role.id]||'';
  }
 }

 function apply(next){
  config={...(next||{}),models:Array.isArray(next?.models)?next.models.map(item=>({...item})):[],roles:{...(next?.roles||{})}};
  renderModels();renderRoles();
 }

 /* ── 提交 ───────────────────────────────────────────────────────────── */

 function input(){
  return {
   models:config.models.map(model=>({id:model.id,name:model.name,baseUrl:model.baseUrl||'',...(model.apiKey?{apiKey:model.apiKey}:{})})),
   roles:{...(config.roles||{})},
  };
 }

 let autoSaving=false;
 async function autoSave(){
  if(autoSaving)return;
  autoSaving=true;
  try{apply(await api('settings',input()));status('已自动保存 · 改动即时生效');}
  catch(error){status(error.message);}
  finally{autoSaving=false;}
 }

 /* 模型类型：纯按名字猜，只用于列表分组，不参与任何请求参数。 */
const MODEL_GROUPS=Object.freeze([
 ['chat','对话 / 通用'],
 ['vision','视觉理解'],
 ['embed','向量嵌入'],
 ['rerank','重排序'],
 ['image','图像生成'],
 ['video','视频生成'],
 ['audio','语音音频'],
 ['other','其他'],
]);
function groupOfModel(name){
 const n=String(name||'').toLowerCase();
 if(/rerank/.test(n))return 'rerank';
 if(/embed/.test(n)||/^(bge|gte|jina|voyage)[-_.]/.test(n))return 'embed';
 if(/whisper|tts|speech|audio|voice|realtime|asr|cosyvoice|sensevoice/.test(n))return 'audio';
 if(/veo|sora|kling|hailuo|cogvideo|t2v|i2v|text-to-video|(^|[-_.])(video|wan|pika|runway)([-_.]|$)/.test(n))return 'video';
 if(/dall-?e|flux|stable-diffusion|sdxl|imagen|kolors|seedream|seededit|qwen-image|gpt-image|midjourney|(^|[-_.])(image|imagen)([-_.]|$)/.test(n))return 'image';
 if(/(^|[-_.])(vl|vision)([-_.]|$)|llava|pixtral|internvl|minicpm-v|omni|multimodal/.test(n))return 'vision';
 return 'chat';
}

 /* ── 弹窗：一个接口 + 多行模型 ─────────────────────────────────────── */

 function pickNote(text){const node=$('#ai-pick-note');if(node)node.textContent=text;}

 function newId(){return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;}

 function renderRows(focus=-1){
  const host=$('#ai-model-rows');if(!host)return;
  host.innerHTML=rows.map((row,index)=>`<div class="ai-mrow" data-row="${index}">
    <input class="ai-mrow-input" type="text" value="${esc(row.name)}" placeholder="模型名称，可从列表选择" spellcheck="false" autocomplete="off" aria-label="第 ${index+1} 个模型">
    <button class="ai-icon ai-mrow-pick" type="button" data-pick-row="${index}" title="从接口读到的模型列表里选择" aria-label="选择模型" aria-haspopup="listbox" aria-expanded="${pickIndex===index}">${icon('chevron')}</button>
    <button class="ai-icon ai-mrow-del" type="button" data-del-row="${index}" title="${rows.length<2?'至少保留一行':'删除这一行'}" aria-label="删除这一行"${rows.length<2?' disabled':''}>${icon('close')}</button>
   </div>`).join('');
  if(focus>=0)host.querySelector?.(`[data-row="${focus}"] .ai-mrow-input`)?.focus();
 }

 function renderGroups(){
  const host=$('#ai-pick-groups');if(!host)return;
  const current=String(rows[pickIndex]?.name||'').trim();
  const used=new Set(rows.map(row=>String(row.name||'').trim()).filter(Boolean));
  const keyword=String($('#ai-pick-search')?.value||'').trim().toLowerCase();
  const names=probeNames.filter(name=>!keyword||name.toLowerCase().includes(keyword));
  const buckets=new Map();
  for(const name of names){const id=groupOfModel(name);if(!buckets.has(id))buckets.set(id,[]);buckets.get(id).push(name);}
  /* 分类用 tab 切换：300+ 个模型摊成一列没法扫，tab 只渲染当前这一类。 */
  const groups=MODEL_GROUPS.filter(([id])=>buckets.has(id));
  if(!buckets.has(pickGroup))pickGroup=groups.length?groups[0][0]:'chat';
  const tabs=$('#ai-pick-tabs');
  if(tabs)tabs.innerHTML=groups.map(([id,label])=>`<button class="ai-cat" type="button" role="tab" data-pick-tab="${id}" aria-selected="${id===pickGroup}"><span>${label}</span><small>${buckets.get(id).length}</small></button>`).join('');
  host.innerHTML=(buckets.get(pickGroup)||[]).map(name=>{
   const on=name===current,inUse=!on&&used.has(name);
   return `<button class="ai-choice" type="button" role="option" data-pick="${esc(name)}" aria-selected="${on}"><span>${esc(name)}</span>${inUse?'<small class="ai-choice-tag">已加</small>':''}<i class="ai-choice-tick">${icon('check')}</i></button>`;
  }).join('');
  pickNote(names.length?(keyword?`匹配 ${names.length} 个`:`共 ${probeNames.length} 个`):(probeNames.length?'没有匹配的模型':''));
 }

 /* 读列表只借接口地址 + 已存的密钥，不改任何配置。 */
 async function probe(){
  const base=($('#ai-new-base').value||'').trim();
  if(!base){pickNote('先填接口地址');return;}
  const token=++probeToken;
  pickNote('正在读取模型列表…');
  try{
   const hint=config.models.find(model=>(model.baseUrl||'')===base&&model.hasKey)||config.models.find(model=>(model.baseUrl||'')===base);
   const data=await api('probe-models',{baseUrl:base,apiKey:($('#ai-new-key').value||'').trim(),modelId:hint?.id||''});
   if(token!==probeToken)return;
   probeNames=Array.isArray(data.models)?data.models:[];
   renderGroups();
   if(!probeNames.length)pickNote('接口没有返回列表，直接在输入框里填');
  }catch(error){
   if(token!==probeToken)return;
   probeNames=[];renderGroups();pickNote(error.message||'读取失败，可以直接填');
  }
 }

 /* 浮动列表：贴在那一行下面（下方放不下就翻到上方），不换页、不遮整屏。 */
 function openPop(index){
  const pop=$('#ai-pick-pop');if(!pop||!modal)return;
  const rowEl=modal.querySelector?.(`[data-row="${index}"]`);if(!rowEl)return;
  pickIndex=index;
  pop.hidden=false;
  const rect=rowEl.getBoundingClientRect();
  const body=modal.querySelector?.('.ai-modal-body');
  const width=Math.min(430,Math.max(290,body?body.getBoundingClientRect().width:360));
  const vw=globalThis.innerWidth||1024,vh=globalThis.innerHeight||768;
  pop.style.width=width+'px';
  pop.style.left=Math.max(10,Math.min(rect.right-width,vw-width-10))+'px';
  const height=Math.min(300,vh-24);
  let top=rect.bottom+4;
  if(top+Math.min(height,220)>vh-10)top=Math.max(10,rect.top-height-4);
  pop.style.top=top+'px';
  const search=$('#ai-pick-search');if(search)search.value='';
  modal.querySelectorAll?.('[data-pick-row]').forEach(button=>button.setAttribute('aria-expanded',String(Number(button.dataset.pickRow)===index)));
  pickNote(probeNames.length?`共 ${probeNames.length} 个`:'正在读取模型列表…');
  if(probeNames.length)renderGroups();else probe();
 }

 function closePop(){
  const pop=$('#ai-pick-pop');
  if(pop)pop.hidden=true;
  pickIndex=-1;
  modal?.querySelectorAll?.('[data-pick-row]').forEach(button=>button.setAttribute('aria-expanded','false'));
 }

 /* 传接口地址就是编辑这台接口；不传是新增。 */
 function openSheet(base){
  editingBase=typeof base==='string'?base:'';
  probeNames=[];probeToken++;closePop();
  const models=config.models.filter(model=>(model.baseUrl||'')===editingBase);
  const editing=!!editingBase;
  const title=$('#ai-sheet-title');if(title)title.textContent=editing?'编辑接口':'添加接口';
  const baseUrl=editing?editingBase:(PROVIDERS[0].baseUrl||'');
  const provider=$('#ai-new-provider');
  if(provider){
   provider.innerHTML=PROVIDERS.map(item=>`<option value="${item.id}">${esc(item.label)}</option>`).join('');
   const preset=PROVIDERS.find(item=>item.baseUrl&&item.baseUrl===baseUrl);
   provider.value=editing?(preset?preset.id:'custom'):'gateway';
  }
  const baseField=$('#ai-new-base');if(baseField)baseField.value=baseUrl;
  const keyField=$('#ai-new-key');
  if(keyField){keyField.value='';keyField.placeholder=models.some(model=>model.hasKey)?'已保存，留空不修改':'粘贴服务商给的 Key';}
  rows=editing&&models.length?models.map(model=>({name:model.name})):[{name:''}];
  renderRows();sheetStatus('');
  if(modal&&!modal.open)modal.showModal();
 }

 function closeSheet(){
  editingBase='';probeToken++;closePop();
  rows=[{name:''}];
  if(modal?.open)modal.close();
 }

 if($('#ai-model-add'))$('#ai-model-add').onclick=()=>openSheet();
 if($('#ai-sheet-close'))$('#ai-sheet-close').onclick=closeSheet;
 if($('#ai-sheet-cancel'))$('#ai-sheet-cancel').onclick=closeSheet;
 if($('#ai-mrow-add'))$('#ai-mrow-add').onclick=()=>{rows.push({name:''});renderRows(rows.length-1);};

 if($('#ai-new-provider'))$('#ai-new-provider').addEventListener('change',()=>{
  const preset=PROVIDERS.find(item=>item.id===$('#ai-new-provider').value);
  const base=$('#ai-new-base');if(base&&preset)base.value=preset.baseUrl;
  /* 换了地址，之前那份列表就不对应了。 */
  probeNames=[];
  if(pickIndex>=0)probe();
 });
 if($('#ai-new-base'))$('#ai-new-base').addEventListener('input',()=>{probeNames=[];});

 if($('#ai-model-rows'))$('#ai-model-rows').addEventListener('input',event=>{
  const input=event.target.closest?.('.ai-mrow-input');if(!input)return;
  const index=Number(input.closest('[data-row]')?.dataset.row);
  if(rows[index])rows[index].name=input.value;
 });

 if($('#ai-model-rows'))$('#ai-model-rows').addEventListener('click',event=>{
  const pick=event.target.closest?.('[data-pick-row]');
  if(pick){const index=Number(pick.dataset.pickRow);if(index===pickIndex)closePop();else openPop(index);return;}
  const del=event.target.closest?.('[data-del-row]');
  if(!del||del.disabled)return;
  rows.splice(Number(del.dataset.delRow),1);
  if(!rows.length)rows=[{name:''}];
  closePop();renderRows();
 });

 if($('#ai-pick-tabs'))$('#ai-pick-tabs').addEventListener('click',event=>{
  const tab=event.target.closest?.('[data-pick-tab]');if(!tab)return;
  pickGroup=tab.dataset.pickTab;renderGroups();
 });

 if($('#ai-pick-groups'))$('#ai-pick-groups').addEventListener('click',event=>{
  const button=event.target.closest?.('[data-pick]');if(!button)return;
  const index=pickIndex;if(index<0||!rows[index])return;
  rows[index].name=button.dataset.pick;
  const input=modal?.querySelector?.(`[data-row="${index}"] .ai-mrow-input`);
  if(input)input.value=rows[index].name;
  closePop();
 });

 if($('#ai-pick-search'))$('#ai-pick-search').addEventListener('input',renderGroups);
 if($('#ai-pick-refresh'))$('#ai-pick-refresh').onclick=()=>{probeNames=[];probe();};

 /* 点浮层外面收起它；在弹窗里按 Esc 也先收浮层，再按一次才关弹窗。 */
 if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',event=>{
  if(pickIndex<0)return;
  const pop=$('#ai-pick-pop');
  /* 分类 tab / 列表项点一下会重建内部 HTML，冒泡到这里时 event.target 已脱离文档，
     contains() 会误判成「点了外面」把浮层收掉。改用 composedPath 认原始祖先链。 */
  const path=typeof event.composedPath==='function'?event.composedPath():[];
  if(pop&&(path.includes(pop)||pop.contains?.(event.target)))return;
  if(path.length?path.some(node=>node?.matches?.('[data-pick-row]')):event.target.closest?.('[data-pick-row]'))return;
  closePop();
 });
 if(modal&&modal.addEventListener)modal.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&pickIndex>=0){event.preventDefault();closePop();}
 });

 /* 保存：把多行模型名整组写回这台接口，删掉的行同步下线。 */
 function save(){
  const base=($('#ai-new-base').value||'').trim();
  if(!base){sheetStatus('请填写接口地址');return;}
  const names=[...new Set(rows.map(row=>String(row.name||'').trim()).filter(Boolean))];
  if(!names.length){sheetStatus('请至少填写一个模型名');return;}
  const typedKey=($('#ai-new-key').value||'').trim();
  const oldBase=editingBase;
  const pool=oldBase?config.models.filter(model=>(model.baseUrl||'')===oldBase):[];
  const rest=oldBase?config.models.filter(model=>(model.baseUrl||'')!==oldBase):config.models;
  /* 同一台接口新增的模型，沿用兄弟条目的密钥 —— 一个 Key 管整台接口，不必逐个再贴。 */
  const siblingKey=(config.models.find(model=>(model.baseUrl||'')===base&&model.apiKey)||pool.find(model=>model.apiKey)||{}).apiKey||'';
  const next=[];
  for(const name of names){
   const previous=pool.find(model=>model.name===name)||config.models.find(model=>model.name===name&&(model.baseUrl||'')===base);
   const entry={id:previous?.id||newId(),name,baseUrl:base,hasKey:typedKey?true:!!previous?.hasKey};
   if(typedKey)entry.apiKey=typedKey;
   else if(!previous&&siblingKey)entry.apiKey=siblingKey;
   next.push(entry);
  }
  const removed=pool.filter(model=>!next.some(entry=>entry.id===model.id));
  config.models=[...rest,...next];
  for(const role of ROLES)if(removed.some(model=>model.id===config.roles[role.id]))config.roles[role.id]='';
  if(!config.roles.text&&config.models.length)config.roles.text=config.models[0].id;
  closeSheet();renderModels();renderRoles();autoSave();
 }

 if($('#ai-sheet-save'))$('#ai-sheet-save').onclick=save;

 const listHost=$('#ai-model-list');
 if(listHost)listHost.addEventListener('click',event=>{
  const groups=endpoints();
  const edit=event.target.closest?.('[data-ai-edit]');
  if(edit){const group=groups[Number(edit.dataset.aiEdit)];if(group)openSheet(group.base);return;}
  const del=event.target.closest?.('[data-ai-del]');
  if(!del)return;
  const group=groups[Number(del.dataset.aiDel)];
  if(!group)return;
  const ids=group.models.map(model=>model.id);
  config.models=config.models.filter(model=>!ids.includes(model.id));
  for(const role of ROLES)if(ids.includes(config.roles[role.id]))config.roles[role.id]='';
  renderModels();renderRoles();autoSave();
 });

 const rolesHost=$('#ai-roles');
 if(rolesHost)rolesHost.addEventListener('change',event=>{
  const select=event.target.closest?.('[data-ai-role]');
  if(!select)return;
  config.roles[select.dataset.aiRole]=select.value;
  /* 重建一遍：测试键的可用状态、语义检索行的「构建索引」都跟着这次的赋值走。 */
  renderRoles();autoSave();
 });
 if(rolesHost)rolesHost.addEventListener('click',event=>{
  const test=event.target.closest?.('[data-ai-test]');
  if(test){testRole(test.dataset.aiTest,test);return;}
  const build=event.target.closest?.('[data-ai-build]');
  if(build)run(buildIndex,build);
 });

 /* ── 索引 ───────────────────────────────────────────────────────────── */

 async function load(){
  status('正在读取设置…');
  try{apply(await api('settings'));status('');}
  catch(error){status(error.message);}
 }

 async function run(action,button){
  /* 按下的那颗按钮标成忙碌（转圈 + 禁用），结束复位，避免“点了没反应”。 */
  const busy=flag=>{if(!button)return;button.disabled=flag;if(flag)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');};
  busy(true);
  try{await action();}catch(error){status(error.message);}finally{busy(false);}
 }

 /* 每个功能一条最小请求：对话/翻译发一句短 prompt，视觉带一张 1×1 图，
    语义检索直接算一条向量并报维度 —— 验的是「这个角色真能干活」，不只是端口通。 */
 async function testRole(role,button){
  const item=ROLES.find(entry=>entry.id===role);
  const label=item?item.label:role;
  if(button)button.disabled=true;
  status(`正在测试「${label}」…`);
  try{
   const result=await api('test',{role});
   const extra=result.dimension?` · ${result.dimension} 维向量`:'';
   status(`「${label}」可用 · ${result.model||'默认模型'}${extra}${result.note?` · ${result.note}`:''}`);
  }catch(error){status(`「${label}」测试失败 · ${error.message}`);}
  finally{if(button)button.disabled=false;}
 }

 async function postSemantic(body){
  const response=await fetch('/api/library/semantic/build',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
  let data;try{data=await response.json();}catch{throw Error('语义接口尚未更新，请重新启动工具');}
  if(!response.ok)throw Error(data.error||'构建语义索引失败');
  return data;
 }
 async function buildIndex(){
  if(!(config.roles||{}).embed)throw Error('请先在「功能分配」里给语义检索选一个向量模型');
  /* 先把当前配置落盘，但不整页重渲染 —— 否则正在转圈的按钮会被重建掉。 */
  await api('settings',input());
  let total=0;
  for(;;){
   status(`正在构建语义索引 · 已向量化 ${total} 个…`);
   const data=await postSemantic({batch:16,maxBatches:8});
   total+=Number(data.embedded)||0;
   const left=Number(data.status?.pending)||0;
   if(data.error)throw Error(data.error);
   if(!left){status(`语义索引已就绪 · ${data.status?.vectors||total} 个资产可语义检索`);return;}
   if(!data.embedded)throw Error('这一轮没有写入任何向量，请确认向量模型支持 /embeddings');
  }
 }
 return {load};
}
