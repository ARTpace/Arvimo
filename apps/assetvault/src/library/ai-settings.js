import {icon} from './icon-set.js';
export function createAISettings({$,toast}){
 const key=$('#ai-key'),toggle=$('#ai-key-toggle');
 let hasKey=false,savedRevealed=false,revision=0;
 function visibility(visible){key.type=visible?'text':'password';toggle.innerHTML=icon(visible?'eye-off':'eye');toggle.setAttribute('aria-pressed',String(visible));toggle.setAttribute('aria-label',visible?'隐藏密钥':'显示密钥');toggle.title=visible?'隐藏密钥':'显示密钥';}
 function hide(){revision++;if(savedRevealed){key.value='';savedRevealed=false;}visibility(false);toggle.disabled=$('#ai-clear-key').checked;}
 key.addEventListener('input',()=>{revision++;savedRevealed=false;toggle.disabled=$('#ai-clear-key').checked;});
 $('#ai-clear-key').addEventListener('change',()=>{hide();key.disabled=$('#ai-clear-key').checked;});
 $('#settings-dialog')?.addEventListener('close',hide);
 toggle.onclick=async()=>{
  if(key.type==='text'){hide();return;}
  if(key.value){visibility(true);return;}
  if(!hasKey){status('尚未保存密钥，可以先输入 API Key。');return;}
  const request=++revision;toggle.disabled=true;
  try{const result=await api('key',{});if(request!==revision)return;key.value=result.apiKey;savedRevealed=true;visibility(true);}
  catch(error){if(request===revision)status(error.message);}
  finally{if(request===revision)toggle.disabled=$('#ai-clear-key').checked;}
 };
 visibility(false);
 const status=message=>{$('#ai-status').textContent=message;};
 const input=()=>({enabled:$('#ai-enabled').checked,baseUrl:$('#ai-base-url').value.trim(),model:$('#ai-model').value.trim(),embedModel:$('#ai-embed-model')?.value.trim()||'',apiKey:$('#ai-key').value,clearKey:$('#ai-clear-key').checked});
 async function api(route,payload){
  const response=await fetch('/api/ai/'+route,{method:payload?'POST':'GET',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
  let data;try{data=await response.json();}catch{throw Error('AI 服务尚未更新，请重新启动工具');}
  if(!response.ok)throw Error(data.error||'AI 请求失败');return data;
 }
 function apply(config){
  hide();hasKey=config.hasKey;key.disabled=false;toggle.disabled=false;
  $('#ai-enabled').checked=config.enabled;$('#ai-base-url').value=config.baseUrl;$('#ai-model').value=config.model;
  const embed=$('#ai-embed-model');if(embed)embed.value=config.embedModel||'';
  key.value='';key.placeholder=hasKey?'••••••••••••（已保存）':'无密钥服务可留空';$('#ai-clear-key').checked=false;
 }
async function run(action){
  const buttons=['#ai-test','#ai-models','#ai-build-index'];buttons.forEach(id=>{const el=$(id);if(el)el.disabled=true;});
  try{await action();}catch(error){status(error.message);}finally{buttons.forEach(id=>{const el=$(id);if(el)el.disabled=false;});}
}
async function load(){
  ensureSemanticFields();
  status('正在读取设置…');
  $('#ai-test').disabled=$('#ai-models').disabled=true;
  try{apply(await api('settings'));status('兼容 Chat Completions 接口；可接入 FreeLLMAPI 或其他兼容服务。');$('#ai-test').disabled=$('#ai-models').disabled=false;}
  catch(error){status(error.message);}
}
/* 自动保存：这一页同样没有保存键。开关与勾选改完立即写；地址、模型、密钥在 change（失焦或回车）时写一次，
   不跟着每一下按键发请求，免得把打到一半的地址写进后端。失败只把原因写在状态行，不弹窗打断。 */
let autoSaving=false;
async function autoSave(){
 if(autoSaving)return;
 autoSaving=true;
 try{apply(await api('settings',input()));status('已自动保存 · 改动即时生效');}
 catch(error){status(error.message);}
 finally{autoSaving=false;}
}
for(const selector of ['#ai-enabled','#ai-base-url','#ai-model','#ai-embed-model','#ai-key','#ai-clear-key']){
 const field=$(selector);if(field)field.addEventListener('change',autoSave);
}
/* 语义索引（ADR-15）：向量模型与对话模型分开填 —— 支持 /embeddings 的服务里两者几乎从不相同。
   字段与按钮都在这里动态插入，避免再去动 index.html 里那一整行超长的 AI 卡片。 */
function ensureSemanticFields(){
 const modelLabel=$('#ai-model')?.closest('label');
 if(modelLabel&&!$('#ai-embed-model')){
  const field=document.createElement('label');
  field.className='field';
  field.innerHTML='<span>向量模型</span><input id="ai-embed-model" type="text" placeholder="text-embedding-3-small" spellcheck="false" autocomplete="off"><small>语义搜索与「找相似」用它；留空则关闭这两个功能。服务需支持 /embeddings。</small>';
  modelLabel.after(field);
  $('#ai-embed-model').addEventListener('change',autoSave);
 }
 const actions=document.querySelector('#ai-models')?.parentElement;
 if(actions&&!$('#ai-build-index')){
  const button=document.createElement('button');
  button.id='ai-build-index';button.type='button';button.className='secondary';button.textContent='构建语义索引';
  actions.appendChild(button);
  button.onclick=()=>run(buildIndex);
 }
}
async function postSemantic(body){
 const response=await fetch('/api/library/semantic/build',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
 let data;try{data=await response.json();}catch{throw Error('语义接口尚未更新，请重新启动工具');}
 if(!response.ok)throw Error(data.error||'构建语义索引失败');
 return data;
}
async function buildIndex(){
 if(!$('#ai-enabled').checked)throw Error('请先启用 AI 功能');
 if(!$('#ai-embed-model')?.value.trim())throw Error('请先填写向量模型并保存');
 apply(await api('settings',input()));
 let total=0;
 for(;;){
  status(`正在构建语义索引 · 已向量化 ${total} 个…`);
  const data=await postSemantic({batch:16,maxBatches:8});
  total+=Number(data.embedded)||0;
  const left=Number(data.status?.pending)||0;
  if(data.error)throw Error(data.error);
  if(!left){status(`语义索引已就绪 · ${data.status?.vectors||total} 个资产可语义检索`);return;}
  if(!data.embedded)throw Error('这一轮没有写入任何向量，请确认服务端支持 /embeddings');
 }
}
$('#ai-test').onclick=()=>run(async()=>{
  if(!$('#ai-enabled').checked)throw Error('请先启用 AI 功能');
  status('正在保存并发送测试请求…');apply(await api('settings',input()));
  const result=await api('test',{});status(`连接成功 · ${result.model}`);
 });
 $('#ai-models').onclick=()=>run(async()=>{
  status('正在读取模型列表…');const data=await api('models',input());
  $('#ai-model-options').replaceChildren(...data.models.map(id=>Object.assign(document.createElement('option'),{value:id})));
  status(`已读取 ${data.models.length} 个模型，可在模型输入框中选择或手动填写。`);
 });
 return {load};
}
