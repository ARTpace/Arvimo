import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import {createAutostartCard} from '../src/library/desktop-settings.js';

test('autostart commands are registered and permitted for the main window',()=>{
 const base=new URL('../sketchfab-exporter-tauri/src-tauri/',import.meta.url);
 const permissions=readFileSync(new URL('permissions/desktop.toml',base),'utf8');
 const main=readFileSync(new URL('src/main.rs',base),'utf8');
 const capability=JSON.parse(readFileSync(new URL('capabilities/default.json',base),'utf8'));
 assert.ok(capability.permissions.includes('desktop-controls'));
 for(const command of ['autostart_status','autostart_set']){
  assert.ok(permissions.includes('"'+command+'"'));
  assert.ok(main.slice(main.indexOf('.invoke_handler(')).includes(command));
 }
});

test('autostart reads actual state, writes both directions, and restores state on failure',async()=>{
 const {document,window}=parseHTML('<html><body></body></html>');
 const previous=new Map(['window','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 try{
  let enabled=false,fail=false;const calls=[];
  window.__TAURI__={core:{async invoke(command,args){calls.push([command,args]);if(fail)throw Error('denied');if(command==='autostart_set')enabled=args.enabled;return {supported:true,enabled,command:enabled?'arvimo --autostart':null};}}};
  for(const [key,value] of Object.entries({window,document}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const {card,refresh}=createAutostartCard();
  const toggle=card.querySelector('input');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(toggle.disabled,false);assert.equal(toggle.checked,false);
  const change=async value=>{toggle.checked=value;toggle.dispatchEvent(new window.Event('change'));await new Promise(resolve=>setImmediate(resolve));};
  await change(true);assert.equal(enabled,true);assert.equal(toggle.checked,true);assert.equal(toggle.disabled,false);
  await change(false);assert.equal(enabled,false);assert.equal(toggle.checked,false);
  fail=true;await change(true);assert.equal(toggle.checked,false);assert.match(card.querySelector('#autostart-note').textContent,/设置失败/);
  await refresh();assert.equal(toggle.disabled,true);assert.match(card.querySelector('#autostart-note').textContent,/读取开机自启状态失败/);
  fail=false;await refresh();assert.equal(toggle.disabled,false);
  assert.deepEqual(calls.filter(([command])=>command==='autostart_set').map(([,args])=>args.enabled),[true,false,true]);
 }finally{for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
});
