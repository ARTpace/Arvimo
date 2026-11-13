import test from 'node:test';
import assert from 'node:assert/strict';
import {createSetupWizard} from '../src/library/setup-wizard.js';

test('setup reuses download settings, preserves edits, saves before finish and keeps failures open',async()=>{
 const nodes=new Map();
 const $=id=>{
  if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},disabled:false,open:false,
   addEventListener(){},querySelector(){return null;},showModal(){this.open=true;},close(){this.open=false;}});
  return nodes.get(id);
 };
 const originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push(options.body);return {ok:true,json:async()=>({items:[],ready:true})};};
 try{
  let fail=false,picked=null;
  const downloads={settings:{folder:'C:\\Assets'},refresh:async()=>{},pickFolder:async()=>picked,
   saveSettings:async({folder})=>{if(fail)throw Error('不可写');downloads.settings.folder=folder;}};
  const wizard=createSetupWizard({$,esc:String,icon:()=>'',toast:()=>{},downloads});
  wizard.setup();await wizard.refresh();
  const input=$('#setup-download-folder'),dialog=$('#setup-dialog');
  assert.equal(input.value,'C:\\Assets');
  input.value='D:\\Models';await wizard.refresh();assert.equal(input.value,'D:\\Models');
  await $('#setup-browse-folder').onclick();assert.equal(input.value,'D:\\Models');
  picked='E:\\Library';await $('#setup-browse-folder').onclick();assert.equal(input.value,picked);
  dialog.showModal();fail=true;await $('#setup-finish').onclick();
  assert.equal(dialog.open,true);assert.match($('#setup-folder-hint').textContent,/不可写/);
  assert.equal(calls.some(body=>body?.includes('finish')),false);
  fail=false;await $('#setup-finish').onclick();
  assert.equal(downloads.settings.folder,'E:\\Library');assert.equal(dialog.open,false);
  assert.equal(calls.some(body=>body?.includes('finish')),true);
 }finally{globalThis.fetch=originalFetch;}
});
