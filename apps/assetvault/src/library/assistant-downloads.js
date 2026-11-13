import {ACTIVE,WAITING} from './download-progress.js';

// First snapshot is history, not new activity. Only observed transitions notify.
export function createAssistantDownloads(notify){
 let previous=null;
 let completedTotal=0,failedTotal=0;
 const pending=state=>state!=='cancelling'&&(ACTIVE.has(state)||WAITING.has(state));
 return jobs=>{
  const next=new Map(jobs.map(job=>[job.id,job.state]));
  if(previous){
   if(![...previous.values()].some(pending)){completedTotal=0;failedTotal=0;}
   let started=0,completed=0,failed=0;
   for(const job of jobs){
    const before=previous.get(job.id);
    if(before===job.state)continue;
    if(pending(job.state)&&!pending(before))started++;
    if(before&&job.state==='saved')completed++;
    if(before&&job.state==='failed')failed++;
   }
   const active=jobs.filter(job=>pending(job.state)).length;
   if(started)notify({type:'download',phase:'started',count:active||started});
   completedTotal+=completed;failedTotal+=failed;
   if(completed)notify({type:'download',phase:'completed',count:completedTotal});
   if(failed)notify({type:'download',phase:'failed',count:failedTotal});
  }
  previous=next;
 };
}
