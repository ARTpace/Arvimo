// Polyfork 的参数面板：把 -params.json 里的旋钮变成能拖的控件，接到 3D 预览上。
//
// 两类旋钮在这里分开处理，这条分界线是整个面板的核心 —— 混着做会又卡又烧额度：
//   颜色（kind: color / preset）→ gltfPreview.setPolyforkColors()，就地改顶点色，实时、零请求；
//   几何（kind: geometry）      → gltfPreview.bakePolyfork()，回服务端重建，几秒。
// range 只在松手（change）时才重建，拖动过程中只更新数字，否则拖一次就是几十次烘焙。
import {esc} from './html-esc.js';
import {labelOf,valueOf,describeOf} from './polyfork-zh.js';

// 中文名分两层：polyfork-zh.js 里的规则词表先兜（零请求），服务端翻好的字典到了再覆盖。
// 这里不保存任何译名，面板渲染只认 zh 参数。

const decimals=step=>{
 const text=String(step??'');
 const dot=text.indexOf('.');
 return dot<0?0:Math.min(3,text.length-dot-1);
};

let opener=0;      // 打开序号：等待期间用户换了资产/关了弹窗，回包就作废
let panel=null;    // 当前面板状态 {model, schema, values, root}

/** 关弹窗时清干净，避免下一次预览读到上一个资产的参数。 */
export function resetPolyforkDetails(){
 opener++;
 panel=null;
}

export function polyforkPanelOpen(){
 return Boolean(panel);
}

function shell(details,model){
 const faces=Number(model.faces)||Number(model.triangles)||0;
 const note='程序化资产：几何由参数生成，这份预览是按当前参数实时构建出来的。';
 details.innerHTML=`
  <div class="eyebrow">POLYFORK · 参数化低模</div>
  <h2>${esc(model.name)}</h2>
  <p class="pf-meta">${faces?`${esc(faces.toLocaleString('en-US'))} 面 · `:''}商用免署名 · 可调参数</p>
  <div class="pf-panel" id="pf-params"><div class="pf-note">正在读取参数清单…</div></div>
  <div class="pf-status" id="pf-status" role="status"></div>
  <div class="detail-license"><strong>${esc(model.license||'Polyfork 低模许可')}</strong><p>${esc(note)}允许商用与修改，禁止把文件本身再分发。</p></div>
  <button class="secondary" data-action="collect" data-uid="${esc(model.uid)}">加入我的模型库</button>
  <button class="primary" data-action="download" data-uid="${esc(model.uid)}">导出到本地</button>
  <a class="source-link" href="${esc(model.url||`https://polyfork.dev/asset/${model.assetId}`)}" target="_blank" rel="noopener noreferrer">在 Polyfork 打开原始页面</a>`;
}

function presetDots(presets,name){
 const colors=Object.values(presets?.[name]||{}).slice(0,5);
 return colors.map(hex=>`<i style="background:${esc(hex)}"></i>`).join('');
}

export function panelHtml(schema,values,zh){
 const presets=schema.params.filter(p=>p.kind==='preset');
 const colors=schema.params.filter(p=>p.kind==='color');
 const geometry=schema.params.filter(p=>p.kind==='geometry');
 const blocks=[];

 if(presets.length){
  blocks.push(`<div class="pf-group-title">配色方案</div><div class="pf-presets">${presets.map(param=>
   param.options.map(name=>{
    const on=String(values[param.key])===name;
    return `<button type="button" class="pf-preset${on?' on':''}" data-pf-preset="${esc(param.key)}" data-pf-value="${esc(name)}">
     <span class="pf-dots">${presetDots(schema.presets,name)}</span><span class="pf-preset-name">${esc(valueOf(name,zh).replace(/-/g,' '))}</span></button>`;
   }).join(''),
  ).join('')}</div>`);
 }

 if(colors.length){
  blocks.push(`<div class="pf-group-title">色区</div>${colors.map(param=>`
   <label class="pf-field" title="${esc(describeOf(param,zh))}">
    <span data-pf-label="${esc(param.key)}">${esc(labelOf(param,zh))}</span>
    <em data-pf-hex="${esc(param.key)}">${esc(String(values[param.key]||param.default))}</em>
    <input type="color" data-pf-color="${esc(param.key)}" value="${esc(String(values[param.key]||param.default))}">
   </label>`).join('')}`);
 }

 if(geometry.length){
  blocks.push(`<div class="pf-group-title">造型</div>${geometry.map(param=>{
   if(param.type==='range'){
    const step=Number(param.step)||0.01;
    return `<label class="pf-field" title="${esc(describeOf(param,zh))}">
     <span data-pf-label="${esc(param.key)}">${esc(labelOf(param,zh))}</span>
     <input type="range" data-pf-range="${esc(param.key)}" min="${param.min}" max="${param.max}" step="${step}" value="${Number(values[param.key]??param.default)}">
     <b data-pf-out="${esc(param.key)}">${Number(values[param.key]??param.default).toFixed(decimals(step))}</b>
    </label>`;
   }
   // toggle 也是几何旋钮（例如「已清空」会抽走箱内的瓶子），漏了它这一项会整个从面板消失。
   if(param.type==='toggle'){
    const on=Boolean(values[param.key]??param.default);
    return `<div class="pf-field" title="${esc(describeOf(param,zh))}">
     <span data-pf-label="${esc(param.key)}">${esc(labelOf(param,zh))}</span>
     <span class="pf-seg" data-pf-group="${esc(param.key)}">
      <button type="button" data-pf-toggle="${esc(param.key)}" data-pf-value="true" class="${on?'on':''}">开</button>
      <button type="button" data-pf-toggle="${esc(param.key)}" data-pf-value="false" class="${on?'':'on'}">关</button>
     </span>
    </div>`;
   }
   return `<div class="pf-field" title="${esc(describeOf(param,zh))}">
    <span data-pf-label="${esc(param.key)}">${esc(labelOf(param,zh))}</span>
    <span class="pf-seg" data-pf-group="${esc(param.key)}">${param.options.map(option=>
     `<button type="button" data-pf-choice="${esc(param.key)}" data-pf-value="${esc(option)}" class="${String(values[param.key])===option?'on':''}">${esc(valueOf(option,zh))}</button>`,
    ).join('')}</span>
   </div>`;
  }).join('')}`);
 }

 blocks.push('<div class="pf-note">颜色实时生效；几何改动会请官方重新生成，需要几秒（走匿名烘焙额度）。</div>');
 return blocks.join('');
}

/** 这次会话里已经问过的译名（含「没有」），开关预览不必反复问服务端。 */
const ZH_CACHE=new Map();

function applyZh(root,schema,zh){
 for(const param of schema.params){
  // labelOf 自带「规则层优先、字典补空缺」的判断，这里直接用，别在两处各写一份。
  const node=root.querySelector(`[data-pf-label="${CSS.escape(param.key)}"]`);
  const text=labelOf(param,zh);
  if(node&&text)node.textContent=text;
  const describe=zh.describes?.[param.key];
  const field=node?.closest('.pf-field');
  if(describe&&field)field.title=describe;
 }
 for(const button of root.querySelectorAll('[data-pf-choice],[data-pf-preset]')){
  const text=valueOf(button.dataset.pfValue,zh);
  if(!text)continue;
  const name=button.querySelector('.pf-preset-name');
  if(name)name.textContent=text;
  else button.textContent=text;   // choice 按钮的文字就是它自己的值，直接换
 }
}

/**
 * 要一份服务端翻好的字典，到了就地把英文换成中文。
 * 不动控件、不重渲染 —— 用户可能正拖着滑杆，重渲染会把拖动掐断。
 */
async function refineZh(assetId,assetName,schema,root,alive){
 if(!assetId)return;
 let zh=ZH_CACHE.get(assetId);
 if(zh===undefined){
  try{
   const query=`id=${encodeURIComponent(assetId)}&n=${encodeURIComponent(assetName||'')}`;
   const res=await fetch(`/api/polyfork/zh?${query}`,{headers:{'x-sfx-local':'1'},cache:'no-store'});
   zh=res.ok?(await res.json())?.zh||null:null;
  }catch{zh=null;}
  ZH_CACHE.set(assetId,zh);
 }
 if(!zh||!alive())return;
 applyZh(root,schema,zh);
}

/** 把当前 values 回写到控件上（配色方案一键改七个色区后，色块必须跟着变）。 */
function syncControls(root,schema,values){
 for(const param of schema.params){
  if(param.kind==='color'){
   const input=root.querySelector(`[data-pf-color="${param.key}"]`);
   const hex=root.querySelector(`[data-pf-hex="${param.key}"]`);
   const value=String(values[param.key]||param.default);
   if(input)input.value=value;
   if(hex)hex.textContent=value;
  }
  if(param.kind==='range'){
   const input=root.querySelector(`[data-pf-range="${param.key}"]`);
   const out=root.querySelector(`[data-pf-out="${param.key}"]`);
   const value=Number(values[param.key]??param.default);
   if(input)input.value=String(value);
   if(out)out.textContent=value.toFixed(decimals(Number(param.step)||0.01));
  }
  if(param.type==='choice'&&param.kind==='geometry'){
   for(const button of root.querySelectorAll(`[data-pf-choice="${param.key}"]`)){
    button.classList.toggle('on',button.dataset.pfValue===String(values[param.key]));
   }
  }
  if(param.type==='toggle'){
   const on=Boolean(values[param.key]??param.default);
   for(const button of root.querySelectorAll(`[data-pf-toggle="${param.key}"]`)){
    button.classList.toggle('on',(button.dataset.pfValue==='true')===on);
   }
  }
  if(param.kind==='preset'){
   for(const button of root.querySelectorAll(`[data-pf-preset="${param.key}"]`)){
    button.classList.toggle('on',button.dataset.pfValue===String(values[param.key]));
   }
  }
 }
}

function bindPanel(root,schema,ctx){
 const {gltfPreview,toast}=ctx;
 const status=()=>document.getElementById('pf-status');
 const say=text=>{const node=status();if(node)node.textContent=text||'';};
 // 本地生成器可用时，拖动滑杆就是每帧重算一遍几何（实测 4~20ms），不必等松手。
 // 用 rAF 合并：一次拖动会来几十个 input 事件，一帧只重建一次。
 const livePreview=()=>typeof gltfPreview.polyforkLive==='function'&&gltfPreview.polyforkLive();
 let liveFrame=0,liveKey='',liveValue=null;
 const scheduleLive=(key,value)=>{
  liveKey=key;liveValue=value;
  if(liveFrame)return;
  liveFrame=requestAnimationFrame(()=>{
   liveFrame=0;
   gltfPreview.bakePolyfork({[liveKey]:liveValue},{live:true});
  });
 };

 root.addEventListener('input',event=>{
  const target=event.target;
  if(target.matches('[data-pf-color]')){
   const key=target.dataset.pfColor;
   // 手改单色意味着离开预设配色：把高亮摘掉，别让界面说谎。
   root.querySelectorAll('.pf-preset.on').forEach(button=>button.classList.remove('on'));
   if(!panel)return;
   panel.values[key]=target.value;
   const hex=root.querySelector(`[data-pf-hex="${key}"]`);
   if(hex)hex.textContent=target.value;
   gltfPreview.setPolyforkColors({[key]:target.value});
   return;
  }
  if(target.matches('[data-pf-range]')){
   const key=target.dataset.pfRange;
   const out=root.querySelector(`[data-pf-out="${key}"]`);
   if(out)out.textContent=Number(target.value).toFixed(decimals(Number(target.step)||0.01));
   if(panel)panel.values[key]=Number(target.value);
   // 有本地生成器就边拖边重建；没有的话拖动中一个请求都不发（1.5 秒 + 一次烘焙额度）。
   if(livePreview()&&panel)scheduleLive(key,Number(target.value));
  }
 });

 // range 的 change 只在松手时触发；input 期间不请求，否则拖一下能烧掉一小时额度。
 root.addEventListener('change',async event=>{
  const target=event.target;
  if(!panel||!target.matches('[data-pf-range]'))return;
  const key=target.dataset.pfRange;
  const value=Number(target.value);
  panel.values[key]=value;
  const instant=livePreview();
  if(!instant)say('正在重建几何…');
  const ok=await gltfPreview.bakePolyfork({[key]:value});
  say(ok?'':'重建失败，已保留上一档几何');
 });

 root.addEventListener('click',async event=>{
  if(!panel)return;
  const preset=event.target.closest('[data-pf-preset]');
  if(preset){
   const key=preset.dataset.pfPreset,name=preset.dataset.pfValue;
   const colors=schema.presets?.[name];
   if(!colors)return;
   panel.values[key]=name;
   Object.assign(panel.values,colors);
   gltfPreview.setPolyforkColors(colors);
   syncControls(root,schema,panel.values);
   return;
  }
  const choice=event.target.closest('[data-pf-choice]');
  const toggle=event.target.closest('[data-pf-toggle]');
  if(toggle){
   const key=toggle.dataset.pfToggle,value=toggle.dataset.pfValue==='true';
   if(Boolean(panel.values[key])===value)return;
   panel.values[key]=value;
   syncControls(root,schema,panel.values);
   if(!livePreview())say('正在重建几何…');
   const ok=await gltfPreview.bakePolyfork({[key]:value});
   say(ok?'':'重建失败，已保留上一档几何');
   return;
  }
  if(choice){
   const key=choice.dataset.pfChoice,value=choice.dataset.pfValue;
   if(String(panel.values[key])===value)return;
   panel.values[key]=value;
   syncControls(root,schema,panel.values);
   if(!livePreview())say('正在重建几何…');
   const ok=await gltfPreview.bakePolyfork({[key]:value});
   say(ok?'':'重建失败，已保留上一档几何');
  }
 });

 return {say};
}

/**
 * 打开 Polyfork 的预览：先画详情栏骨架，取到参数清单后渲染控件，再让 3D 预览按参数加载。
 * 调用方负责 showModal（canvas 得先有真实尺寸）。
 */
export async function openPolyforkPreview(model,ctx){
 const {gltfPreview}=ctx;
 const mine=++opener;
 const details=document.getElementById('model-details');
 if(!details)return;
 shell(details,model);
 panel={model,schema:null,values:{}};

 let schema=null;
 try{
  schema=await gltfPreview.fetchPolyforkParams(model.assetId);
 }catch(err){
  if(mine!==opener)return;
  const holder=document.getElementById('pf-params');
  if(holder)holder.innerHTML=`<div class="pf-note">参数清单读取失败：${esc(err.message)}。仍可正常预览与下载。</div>`;
 }
 if(mine!==opener)return;

 const result=await (schema?gltfPreview.loadPolyfork(model.assetId,{schema}):gltfPreview.loadPolyfork(model.assetId));
 if(mine!==opener)return;
 if(!result){panel=null;return;}

 const {values}=result;
 panel={model,schema:result.schema,values:{...values}};
 const root=document.getElementById('pf-params');
 if(!root)return;

 if(!result.schema.remixable){
  root.innerHTML='<div class="pf-note">这个资产没有开放参数旋钮，只能按原样预览与导出。</div>';
  return;
 }
 root.innerHTML=panelHtml(result.schema,values);
 bindPanel(root,result.schema,ctx);
 // 先让面板能拖（中文规则词表已经上屏），译名字典随后到、就地换字。
 refineZh(model.assetId,model.name,result.schema,root,()=>mine===opener);
}
