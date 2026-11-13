// 帮助与反馈面板：问题反馈 / 功能建议 / 其他，附带诊断摘要一键提交。
// 草稿会落 localStorage，误关窗口或提交失败都不用重写。

import {collectDiagnostics,formatDiagnostics,hookDiagnostics,installId,rememberError} from './diagnostics.js';
import {openHelp} from './help-panel.js';

// 提交走同源 /api/feedback，由本地服务转发到收集端（feedback-worker）：
// 页面 CSP 的 connect-src 只放行 'self'，前端直连外部域会被浏览器拦掉。
// 服务端没配收集地址时（AV_FEEDBACK_ENDPOINT 与 server 里的常量都为空），
// 面板退化成「复制内容」，让用户自己贴到微信 / 邮件，功能不至于废掉。
const FEEDBACK_URL='/api/feedback';

const DRAFT_KEY='av:feedback-draft';
const TYPES=[['bug','问题反馈'],['feature','功能建议'],['other','其他']];

// 反馈表单现在住在合并面板（#help-dialog）的第二个页签里，标记是 index.html 的静态部分。
// 这里只找它、绑一次事件，不再自己 createElement 造 dialog。
let panel=null;
let wired=false;
let draftReady=false;

function ensureDialog(){
 if(panel&&panel.isConnected)return panel;
 panel=document.getElementById('help-panel-feedback');
 if(!panel)return null;
 if(!wired){
  wired=true;
  panel.querySelector('.feedback-types')?.addEventListener('click',event=>{
   const btn=event.target.closest('[data-feedback-type]');
   if(!btn)return;
   panel.querySelectorAll('[data-feedback-type]').forEach(node=>node.setAttribute('aria-pressed',String(node===btn)));
   saveDraft();
  });
  panel.querySelector('#feedback-submit')?.addEventListener('click',submit);
  panel.querySelector('#feedback-copy')?.addEventListener('click',()=>copyPayload(true));
  panel.addEventListener('input',()=>{setStatus('');scheduleDraft();});
 }
 return panel;
}

let draftTimer=0;
function scheduleDraft(){
 clearTimeout(draftTimer);
 draftTimer=setTimeout(saveDraft,300);
}

function readPayload(){
 const root=ensureDialog();
 const type=root.querySelector('[data-feedback-type][aria-pressed="true"]')?.dataset.feedbackType||'bug';
 return {
  type,
  title:root.querySelector('#feedback-title').value.trim(),
  body:root.querySelector('#feedback-body').value.trim(),
  contact:root.querySelector('#feedback-contact').value.trim(),
  withContext:root.querySelector('#feedback-with-context').checked,
  honeypot:root.querySelector('#feedback-honeypot').value,
 };
}

function saveDraft(){
 const p=readPayload();
 try{localStorage.setItem(DRAFT_KEY,JSON.stringify(p));}catch{/* 隐私模式禁写就算了 */}
}

function restoreDraft(){
 const root=ensureDialog();
 if(!root||draftReady)return;
 draftReady=true;
 try{
  const draft=JSON.parse(localStorage.getItem(DRAFT_KEY)||'null');
  if(draft){
   const type=TYPES.some(([v])=>v===draft.type)?draft.type:'bug';
   root.querySelectorAll('[data-feedback-type]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.feedbackType===type)));
   root.querySelector('#feedback-title').value=draft.title||'';
   root.querySelector('#feedback-body').value=draft.body||'';
   root.querySelector('#feedback-contact').value=draft.contact||'';
   root.querySelector('#feedback-with-context').checked=draft.withContext!==false;
  }
 }catch{/* 草稿坏了就当没有 */}
 probeEndpoint().then(ready=>{
  if(!ready)setStatus('服务端还没配置反馈收集地址：提交时会先把内容复制到剪贴板，粘到微信 / 邮件发给我即可。');
 });
}

/** 问一下服务端配没配收集地址；没配就把提交动作降级成复制。 */
async function probeEndpoint(){
 try{
  const res=await fetch(FEEDBACK_URL,{headers:{'x-sfx-local':'1'}});
  if(!res.ok)return false;
  const data=await res.json();
  return !!data.configured;
 }catch{return false;}
}

function setStatus(text,tone=''){
 const node=ensureDialog().querySelector('#feedback-status');
 if(!node)return;
 node.textContent=text;
 node.dataset.tone=tone;
}

async function buildText(){
 const p=readPayload();
 const lines=[`【${TYPES.find(([v])=>v===p.type)?.[1]||'反馈'}】${p.title||'(未填标题)'}`,'',p.body||'(未填描述)'];
 if(p.contact)lines.push('',`联系方式：${p.contact}`);
 if(p.withContext){
  try{
   const ctx=await collectDiagnostics();
   lines.push('','— 环境 —',formatDiagnostics(ctx));
   if(!ctx.recent?.length)lines.push('（最近没有失败请求）');
  }catch{/* 诊断拿不到不影响正文 */}
 }
 return lines.join('\n');
}

async function copyPayload(silent=false){
 const text=await buildText();
 try{
  await navigator.clipboard.writeText(text);
 }catch{
  // 剪贴板 API 在部分 WebView 里要用户手势；退回到临时 textarea 的选区复制。
  const area=document.createElement('textarea');
  area.value=text;
  area.style.cssText='position:fixed;left:-9999px;top:0';
  document.body.append(area);
  area.select();
  try{document.execCommand('copy');}catch{}
  area.remove();
 }
 if(!silent)setStatus('已复制到剪贴板，粘到微信 / 邮箱发给我就行。','ok');
 return text;
}

async function submit(){
 const root=ensureDialog();
 const p=readPayload();
 if(!p.title){setStatus('先写个标题吧，「预览点开是黑的」这种一句就够。','error');root.querySelector('#feedback-title').focus();return;}
 if(!p.body){setStatus('详细描述还空着，说一下怎么操作、看到什么。','error');root.querySelector('#feedback-body').focus();return;}
 const btn=root.querySelector('#feedback-submit');
 const saved=btn.innerHTML;
 btn.disabled=true;btn.textContent='提交中…';
 try{
  const context=p.withContext?await collectDiagnostics():null;
  const res=await fetch(FEEDBACK_URL,{
   method:'POST',
   headers:{'Content-Type':'application/json','x-sfx-local':'1'},
   body:JSON.stringify({type:p.type,title:p.title,body:p.body,contact:p.contact,installId:installId(),honeypot:p.honeypot,context}),
  });
  const data=await res.json().catch(()=>({}));
  if(res.status===503){
   // 服务端没配收集地址：降级成复制，别让用户白填一遍。
   await copyPayload(true);
   setStatus('服务端还没配置反馈收集地址，内容已复制到剪贴板，粘到微信 / 邮件发我就行。','ok');
   return;
  }
  if(!res.ok)throw new Error(data.error||`提交失败（${res.status}）`);
  try{localStorage.removeItem(DRAFT_KEY);}catch{}
  root.querySelector('#feedback-title').value='';
  root.querySelector('#feedback-body').value='';
  root.querySelector('#feedback-contact').value='';
  setStatus(`已收到，编号 ${String(data.id||'').slice(0,8)}。谢谢！`,'ok');
  setTimeout(()=>document.getElementById('help-dialog')?.close(),1800);
 }catch(error){
  await copyPayload(true);
  setStatus(`${error.message||'提交失败'}。内容已复制到剪贴板，可以直接发给我。`,'error');
 }finally{
  btn.disabled=false;btn.innerHTML=saved;
 }
}

/** 打开反馈面板。message 通常来自一次报错，自动填进描述里省得用户复述。 */
export function openFeedback({type,message}={}){
 hookDiagnostics();
 if(message)rememberError(message);
 const root=ensureDialog();
 if(!root)return;
 restoreDraft();
 if(type&&TYPES.some(([v])=>v===type)){
  root.querySelectorAll('[data-feedback-type]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.feedbackType===type)));
 }
 if(message){
  const body=root.querySelector('#feedback-body');
  if(!body.value.trim())body.value=`${String(message).trim()}\n\n---\n复现步骤：\n1. \n2. \n期望结果：\n`;
 }
 openHelp('feedback');
 setTimeout(()=>root.querySelector('#feedback-title').focus(),80);
}
