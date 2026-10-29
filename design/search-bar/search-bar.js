// 仅演示外观交互，不连接 AssetVault 后端或调用 AI。
const form=document.querySelector('#asset-search-form');
const input=document.querySelector('#asset-query');
const platform=document.querySelector('#search-platform');
platform.addEventListener('change',()=>{input.placeholder=`搜索 ${platform.value}，或粘贴模型 / 作者 / 合集链接`;});
document.querySelectorAll('[data-topic]').forEach(button=>button.addEventListener('click',()=>{input.value=button.dataset.topic;input.focus();}));
form.addEventListener('submit',event=>{event.preventDefault();form.dispatchEvent(new CustomEvent('asset-search',{bubbles:true,detail:{platform:platform.value,query:input.value}}));});
document.querySelector('#theme-breakdown-btn').addEventListener('click',()=>form.dispatchEvent(new CustomEvent('asset-ai-breakdown',{bubbles:true,detail:{query:input.value}})));
