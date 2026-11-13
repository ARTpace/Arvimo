// ponytail: a bounded in-memory queue; no framework or persisted notification history.
export function createAssistantMessages({render,canManageUpdates=false,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 const messages=new Map(),dismissed=new Set();
 let current=null,timer;
 const signature=message=>JSON.stringify([message.text,message.title,message.expression,message.effect,message.priority,message.duration,message.actions?.map(action=>[action.label,!!action.disabled])]);
 function refresh(){
  clearTimer(timer);
  const time=now();
  for(const [id,message] of messages)if(message.expires<=time)messages.delete(id);
  const next=[...messages.values()].sort((a,b)=>b.priority-a.priority||b.order-a.order)[0]||null;
  if(next!==current){current=next;render(next);}
  const expires=Math.min(...[...messages.values()].map(message=>message.expires));
  if(Number.isFinite(expires))timer=setTimer(refresh,Math.max(1,expires-time));
 }
 let order=0;
 return {
  inspect(){
   const time=now();
   return [...messages.values()].filter(message=>message.expires>time).sort((a,b)=>b.priority-a.priority||b.order-a.order).map(message=>({id:message.id,text:message.text,expression:message.expression||'idle',effect:message.effect||'none',priority:message.priority,remaining:message.expires===Infinity?null:Math.max(0,message.expires-time),current:message===current}));
  },
  publish({id='hint',text,priority=10,duration=2200,audience='all',force=false,...rest}){
   if(!text||audience==='desktop-admin'&&!canManageUpdates)return false;
   if(force)dismissed.delete(id);
   if(dismissed.has(id))return false;
   const message={...rest,id,text,priority,duration,order:++order,expires:duration>0?now()+duration:Infinity};
   const old=messages.get(id);
   if(old&&signature(old)===signature(message))return false;
   messages.set(id,message);
   if(messages.size>16){const oldest=[...messages.values()].sort((a,b)=>a.priority-b.priority||a.order-b.order)[0];messages.delete(oldest.id);}
   refresh();return true;
  },
  dismiss(id=current?.id){
   const message=messages.get(id);
   if(message?.rememberDismissal){dismissed.add(id);if(dismissed.size>64)dismissed.delete(dismissed.values().next().value);}
   messages.delete(id);refresh();
  },
  clear(id){messages.delete(id);refresh();},
  dispose(){clearTimer(timer);messages.clear();dismissed.clear();current=null;render(null);},
 };
}
