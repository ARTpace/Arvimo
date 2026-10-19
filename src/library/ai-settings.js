export function createAISettings({$,toast}){
 const status=message=>{$('#ai-status').textContent=message;};
 const input=()=>({enabled:$('#ai-enabled').checked,baseUrl:$('#ai-base-url').value.trim(),model:$('#ai-model').value.trim(),apiKey:$('#ai-key').value,clearKey:$('#ai-clear-key').checked});
 async function api(route,payload){
  const response=await fetch('/api/ai/'+route,{method:payload?'POST':'GET',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
  let data;try{data=await response.json();}catch{throw Error('AI 服务尚未更新，请重新启动工具');}
  if(!response.ok)throw Error(data.error||'AI 请求失败');return data;
 }
 function apply(config){
  $('#ai-enabled').checked=config.enabled;$('#ai-base-url').value=config.baseUrl;$('#ai-model').value=config.model;
  $('#ai-key').value='';$('#ai-key').placeholder=config.hasKey?'已保存密钥，留空保持不变':'无密钥服务可留空';$('#ai-clear-key').checked=false;
 }
 async function run(action){
  const buttons=['#ai-save','#ai-test','#ai-models'];buttons.forEach(id=>{$(id).disabled=true;});
  try{await action();}catch(error){status(error.message);}finally{buttons.forEach(id=>{$(id).disabled=false;});}
 }
 async function load(){
  status('正在读取设置…');
  $('#ai-save').disabled=$('#ai-test').disabled=$('#ai-models').disabled=true;
  try{apply(await api('settings'));status('兼容 Chat Completions 接口；可接入 FreeLLMAPI 或其他兼容服务。');$('#ai-save').disabled=$('#ai-test').disabled=$('#ai-models').disabled=false;}
  catch(error){status(error.message);}
 }
 $('#ai-save').onclick=()=>run(async()=>{apply(await api('settings',input()));status('设置已保存。');toast('AI 接入设置已保存');});
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
