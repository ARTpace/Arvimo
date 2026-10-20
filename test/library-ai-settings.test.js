import test from 'node:test';
import assert from 'node:assert/strict';
import {createAISettings} from '../src/library/ai-settings.js';

function setup(t){
 const elements=new Map();
 const $=selector=>{
  if(!elements.has(selector))elements.set(selector,{value:'',checked:false,disabled:false,type:'password',attributes:{},events:{},
   addEventListener(name,handler){this.events[name]=handler;},setAttribute(name,value){this.attributes[name]=value;}});
  return elements.get(selector);
 };
 const requests=[];let saved='fixture-secret',fail=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  requests.push({url,...options});
  if(url.endsWith('/key'))return new Response(JSON.stringify(fail?{error:'无法读取密钥'}:{apiKey:saved}),{status:fail?500:200});
  if(options.method==='POST'){
   const input=JSON.parse(options.body);
   if(input.clearKey)saved='';else if(input.apiKey)saved=input.apiKey;
  }
  return new Response(JSON.stringify({enabled:true,baseUrl:'http://127.0.0.1:31415/v1',model:'auto',hasKey:!!saved}));
 });
 return {$,requests,ui:createAISettings({$,toast(){}}),saved:()=>saved,fail:()=>{fail=true;}};
}

test('saved key stays masked, reveals on demand, hides and survives an unchanged save',async t=>{
 const {$,requests,ui,saved}=setup(t);await ui.load();
 const key=$('#ai-key'),toggle=$('#ai-key-toggle');
 assert.equal(key.type,'password');assert.equal(key.value,'');assert.match(key.placeholder,/••/);
 assert.equal(requests.some(r=>r.url.endsWith('/key')),false);
 await toggle.onclick();
 assert.equal(key.type,'text');assert.equal(key.value,'fixture-secret');assert.equal(toggle.attributes['aria-pressed'],'true');
 await toggle.onclick();
 assert.equal(key.type,'password');assert.equal(key.value,'');
 await $('#ai-save').onclick();
 assert.equal(saved(),'fixture-secret');
 assert.equal(JSON.parse(requests.at(-1).body).apiKey,'');
 await toggle.onclick();$('#settings-dialog').events.close();
 assert.equal(key.type,'password');assert.equal(key.value,'');
 key.value='replacement-key';key.events.input();await toggle.onclick();
 assert.equal(key.type,'text');await toggle.onclick();assert.equal(key.value,'replacement-key');
 await $('#ai-save').onclick();assert.equal(saved(),'replacement-key');assert.equal(key.value,'');
});

test('clear saved key disables reveal and failures remain retryable',async t=>{
 const {$,ui,saved,fail}=setup(t);await ui.load();
 const toggle=$('#ai-key-toggle'),clear=$('#ai-clear-key');
 fail();await toggle.onclick();
 assert.equal(toggle.disabled,false);assert.equal($('#ai-key').type,'password');assert.equal($('#ai-status').textContent,'无法读取密钥');
 clear.checked=true;clear.events.change();assert.equal(toggle.disabled,true);
 await $('#ai-save').onclick();assert.equal(saved(),'');assert.match($('#ai-key').placeholder,/无密钥/);
});

test('closing settings during reveal discards a late key response',async t=>{
 const {$,ui}=setup(t);await ui.load();let respond;
 t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{respond=resolve;}));
 const pending=$('#ai-key-toggle').onclick();
 $('#settings-dialog').events.close();
 respond(new Response(JSON.stringify({apiKey:'late-fixture-key'})));await pending;
 assert.equal($('#ai-key').value,'');assert.equal($('#ai-key').type,'password');assert.equal($('#ai-key-toggle').disabled,false);
});
