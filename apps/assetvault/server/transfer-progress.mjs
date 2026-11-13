/** Counts proxy response-body bytes (after content decoding), not estimated overall conversion work. */
export class TransferProgress {
 constructor(publish,{now=()=>Date.now()}={}){this.publish=publish;this.now=now;this.active=new Set();this.received=0;this.requests=0;this.completed=0;this.failed=0;this.samples=[];this.lastPublish=0;}
 open(length){const item={received:0,total:Number.isSafeInteger(length)&&length>0?length:null,closed:false};this.active.add(item);this.requests++;this.emit(true);
  return {chunk:bytes=>{if(item.closed)return;item.received+=bytes;this.received+=bytes;this.samples.push({at:this.now(),bytes});this.emit(false);},finish:ok=>{if(item.closed)return;item.closed=true;this.active.delete(item);ok?this.completed++:this.failed++;this.emit(true);}};
 }
 snapshot(){const now=this.now();this.samples=this.samples.filter(s=>now-s.at<2000);const items=[...this.active],known=items.length>0&&items.every(i=>i.total!==null&&i.received<=i.total);return {received:this.received,requests:this.requests,completed:this.completed,failed:this.failed,active:items.length,activeReceived:items.reduce((n,i)=>n+i.received,0),activeTotal:known?items.reduce((n,i)=>n+i.total,0):null,rate:items.length&&this.samples.length?Math.round(this.samples.reduce((n,s)=>n+s.bytes,0)/Math.max(1,(now-this.samples[0].at)/1000)):0,updatedAt:now};}
 emit(force){if(!force&&this.now()-this.lastPublish<250)return;this.lastPublish=this.now();this.publish(this.snapshot());}
}
