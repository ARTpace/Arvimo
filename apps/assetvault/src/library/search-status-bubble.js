// Keep the original status nodes as data sources; only the mascot presents their text.
export function createStatusRotation({publish,clear,setTimer=setTimeout,clearTimer=clearTimeout}){
 let texts=[],index=0,timer;
 const show=()=>{
  publish(texts[index]);
  if(texts.length>1)timer=setTimer(()=>{index=(index+1)%texts.length;show();},2000);
 };
 return {
  update(next){
   next=[...new Set(next.map(text=>text.trim()).filter(Boolean))];
   if(JSON.stringify(next)===JSON.stringify(texts))return;
   clearTimer(timer);texts=next;index=0;
   if(texts.length)show();else clear();
  },
  dispose(){clearTimer(timer);clear();},
 };
}

export function bindSearchStatusBubble({notify,doc=document}){
 const rotation=createStatusRotation({
  publish:text=>notify({type:'message',message:{id:'search-status',text:compactSearchStatus(text),title:text,priority:35,duration:0}}),
  clear:()=>notify({type:'clear-message',id:'search-status'}),
 });
 const nodes=['scan-status','discovery-translation','local-translation'].map(id=>doc.getElementById(id)).filter(Boolean);
 const sync=()=>{
  const route=doc.body.dataset.route;
  const active=route==='discover'||route==='library';
  rotation.update(active?nodes.filter(node=>!node.hidden&&(node.id==='local-translation'?route==='library':route==='discover')).flatMap(node=>
   node.id==='scan-status'?[...node.children].filter(child=>child.tagName!=='BUTTON').map(child=>child.textContent):node.textContent.split(' · ')
  ):[]);
 };
 const observer=new MutationObserver(sync);
 nodes.forEach(node=>observer.observe(node,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden']}));
 observer.observe(doc.body,{attributes:true,attributeFilter:['data-route']});sync();
 return ()=>{observer.disconnect();rotation.dispose();};
}

export function compactSearchStatus(text){
 if(text.includes(' → '))return '关键词已翻译，正在搜索';
 if(text.startsWith('AI 解析：'))return '搜索条件已解析';
 return text.length>44?`${text.slice(0,43)}…`:text;
}
