import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {captureDownloadFlight} from '../src/library/download-flight.js';

test('成功后调用才投递，动画结束移除临时图片，不复制整张卡片',async()=>{
 const {document}=parseHTML('<html><body data-route="discover"><aside id="sidebar"><button data-route="downloads"></button></aside><div id="grid"><article data-uid="a"><img src="/thumb.png"></article></div></body></html>');
 const target=document.querySelector('button'),card=document.querySelector('article');
 target.getBoundingClientRect=()=>({left:10,top:400,width:40,height:40});card.getBoundingClientRect=()=>({left:300,top:200,width:180,height:200});
 let finish;const proto=Object.getPrototypeOf(document.createElement('img'));
 proto.animate=()=>({finished:new Promise(resolve=>finish=resolve)});
 try{
  const fly=captureDownloadFlight([{uid:'a'}],document);
  assert.equal(document.querySelectorAll('body>img').length,0);
  fly();assert.equal(document.querySelectorAll('body>img').length,1);
  finish();await Promise.resolve();assert.equal(document.querySelectorAll('body>img').length,0);
 }finally{delete proto.animate;}
});
