import test from 'node:test';
import assert from 'node:assert/strict';
import {createLanSharingSettings} from '../src/library/lan-sharing.js';

// 只验证状态和按钮行为，布局由现有设置面板承载。
test('冲突时隐藏失效链接；主动换端口后显示新链接，确认后清除提醒',async t=>{
 function element(){
  const nodes=new Map();
  // 端口表单走浏览器原生校验（实现里 submit 先问 checkValidity），桩要跟上：
  // 这里返回 true 表示「输入合法」，校验分支本身由浏览器负责，不是本测试要覆盖的。
  return {children:[],addEventListener(){},checkValidity(){return true;},reportValidity(){},
   querySelector(selector){if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);},
   append(...children){this.children.push(...children);},replaceChildren(){this.children=[];},
  };
 }
 const previous=globalThis.document;
 globalThis.document={createElement:element};
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 let data={enabled:true,hasPassword:true,sharingPort:4178,port:5000,portConflict:true,portChanged:false,available:false,addresses:[]};
 const requests=[],notices=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/lan/clients')return {ok:true,json:async()=>({clients:[],total:0,online:0})};
  if(options.body){
   const input=JSON.parse(options.body);requests.push(input);
   if(input.sharingPort)data={...data,sharingPort:input.sharingPort,previousPort:4178,portConflict:false,available:true,portChanged:true,addresses:[`http://192.168.1.10:${input.sharingPort}/`]};
   if(input.acknowledgePortChange)data={...data,portChanged:false};
  }
  return {ok:true,json:async()=>data};
 });
 const sharing=createLanSharingSettings({toast:text=>notices.push(text)}),get=selector=>sharing.card.querySelector(selector);
 await sharing.load();
 assert.equal(get('[data-lan-change-port]').hidden,false);
 assert.equal(get('[data-lan-addresses]').children.length,0);
 assert.match(get('[data-lan-port-notice]').textContent,/4178.*分享已暂停/);
 assert.equal(requests.length,0,'读取状态不会自动更换分享端口');
 await get('[data-lan-change-port]').onclick();
 assert.equal(requests[0].sharingPort,undefined,'重试不能擅自改分享端口');
 assert.equal(get('[data-lan-change-port]').hidden,false);
 get('[data-lan-port]').value='6000';
 await get('form').onsubmit({preventDefault(){}});
 assert.equal(requests[1].sharingPort,6000);
 assert.equal(get('[data-lan-change-port]').hidden,true);
 assert.equal(get('[data-lan-ack-port]').hidden,false);
 assert.match(get('[data-lan-port-notice]').textContent,/旧链接已失效/);
 assert.equal(get('[data-lan-addresses]').children[0].children[0].href,'http://192.168.1.10:6000/');
 assert.match(notices.at(-1),/重新分享/);
 await get('[data-lan-ack-port]').onclick();
 assert.equal(requests[2].acknowledgePortChange,true);
 assert.equal(get('[data-lan-port-notice]').hidden,true);
});
