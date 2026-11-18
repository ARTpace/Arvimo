import test from 'node:test';
import assert from 'node:assert/strict';
import {createAISettings} from '../src/library/ai-settings.js';

/* ai-settings 既用注入的 $，也有直接摸 document 的路径（动态建元素）。
   node --test 没有 DOM，补最小桩，让被测代码走真实分支而不是抛 ReferenceError。 */
globalThis.document ??= {
 querySelector: () => null,
 createElement: () => ({className:'',innerHTML:'',after(){},addEventListener(){}}),
};

const SETTINGS={
 models:[
  {id:'m1',name:'qwen3.5-9b',baseUrl:'http://127.0.0.1:31415/v1',apiKey:'secret',hasKey:true},
  {id:'m1b',name:'embed-v3',baseUrl:'http://127.0.0.1:31415/v1',apiKey:'',hasKey:true},
  {id:'m2',name:'glm-4.6',baseUrl:'https://open.bigmodel.cn/api/paas/v4',apiKey:'',hasKey:false},
 ],
 roles:{text:'m1',translate:'',vision:'',embed:''},
};

function setup(t){
 const elements=new Map();
 const $=selector=>{
  if(!elements.has(selector))elements.set(selector,{value:'',checked:false,disabled:false,hidden:false,type:'text',attributes:{},events:{},innerHTML:'',
   addEventListener(name,handler){this.events[name]=handler;},setAttribute(name,value){this.attributes[name]=value;},
   closest(){return null;},after(){},parentElement:null});
  return elements.get(selector);
 };
 const requests=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  requests.push({url,...options});
  const input=options?.method==='POST'?JSON.parse(options.body):{};
  return new Response(JSON.stringify({...SETTINGS,...input,hasKey:true}));
 });
 return {$,requests,ui:createAISettings({$,toast(){}})};
}

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('load renders the model list with each model endpoint and the role assignments',async t=>{
 const {$,ui}=setup(t);await ui.load();
 const list=$('#ai-model-list').innerHTML;
 assert.match(list,/qwen3\.5-9b/);assert.match(list,/glm-4\.6/);
 assert.match(list,/127\.0\.0\.1:31415/);assert.match(list,/open\.bigmodel\.cn/);
 /* 同一个接口的多个模型只占一行：两个网关模型 + 一个智谱模型 = 两行。 */
 assert.equal((list.match(/class="ai-model"/g)||[]).length,2);
 assert.equal($('#ai-model-empty').hidden,true);
 assert.match($('#ai-roles').innerHTML,/对话与整理/);
 assert.equal($('#ai-status').textContent,'');
});

test('deleting an endpoint submits only the remaining models and roles — no legacy default endpoint',async t=>{
 const {$,requests,ui}=setup(t);await ui.load();requests.length=0;
 const del={dataset:{aiDel:'1'}};
 $('#ai-model-list').events.click({target:{closest:selector=>selector==='[data-ai-del]'?del:null}});
 await tick();
 const body=JSON.parse(requests.at(-1).body);
 assert.deepEqual(body.models.map(model=>model.id),['m1','m1b']);
 assert.equal('baseUrl' in body,false);
 assert.equal('apiKey' in body,false);
 assert.equal(body.roles.text,'m1');
});
