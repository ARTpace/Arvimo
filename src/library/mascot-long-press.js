// ponytail: pointer events and one timer; no gesture dependency or public shortcut.
export function bindMascotLongPress(node,{enabled,onOpen,setTimer=setTimeout,clearTimer=clearTimeout,host=window,doc=document}){
 if(!enabled)return ()=>{};
 let timer,point=null,suppress=false;
 const listeners=[];
 const listen=(target,type,fn,capture=false)=>{target.addEventListener(type,fn,capture);listeners.push(()=>target.removeEventListener(type,fn,capture));};
 const cancel=()=>{clearTimer(timer);timer=undefined;point=null;};
 node.setAttribute('data-developer-entry','');
 listen(node,'pointerdown',event=>{
  if(event.button!==0||event.isPrimary===false)return;
  cancel();suppress=false;point={x:event.clientX,y:event.clientY,id:event.pointerId};
  timer=setTimer(()=>{timer=undefined;point=null;suppress=true;onOpen();},5000);
 });
 listen(node,'pointermove',event=>{if(point&&(point.id!==event.pointerId||Math.hypot(event.clientX-point.x,event.clientY-point.y)>8))cancel();});
 for(const type of ['pointerleave','pointercancel','lostpointercapture','dragstart'])listen(node,type,cancel);
 listen(host,'pointerup',cancel,true);listen(host,'blur',cancel);
 listen(doc,'visibilitychange',cancel);
 listen(node,'contextmenu',event=>event.preventDefault());
 listen(node,'click',event=>{if(suppress&&event.detail!==0){suppress=false;event.preventDefault();event.stopImmediatePropagation();}},true);
 return ()=>{cancel();listeners.forEach(remove=>remove());node.removeAttribute('data-developer-entry');};
}
