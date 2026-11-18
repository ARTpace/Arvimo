import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchTranslator} from '../server/ai-search.mjs';
import {createTagSuggester} from '../src/library/search-translation.js';

test('视觉标签发送图片而非文件名猜测，不同图片不共用缓存', async () => {
 const calls=[];
 const ai=createSearchTranslator({settings:async()=>({enabled:true}),complete:async(messages,options)=>{
  calls.push({messages,options});return {text:'{"tags":["人物","手绘","人物"]}'};
 }});
 const input={name:'建筑.png',existing:['建筑'],image:'data:image/jpeg;base64,YQ=='};
 assert.deepEqual((await ai.tagAssets(input)).tags,['人物','手绘']);
 const user=calls[0].messages.at(-1).content;
 assert.equal(user[1].image_url.url,input.image);
 assert.ok(!JSON.stringify(user).includes('建筑'));
 assert.equal(calls[0].options.timeoutMs,120000);
 await ai.tagAssets(input);
 assert.equal(calls.length,1);
 await ai.tagAssets({...input,image:'data:image/jpeg;base64,Yg=='});
 assert.equal(calls.length,2);
 await assert.rejects(ai.tagAssets({...input,image:'https://example.com/a.png'}),/格式/);
});

test('视觉标签前端传图，模型失败可重试且不退回文字推测',async()=>{
 let sent;
 const suggest=createTagSuggester({fetchImpl:async(url,options)=>{
  sent=JSON.parse(options.body);return {ok:true,json:async()=>({tagged:true,tags:['人物']})};
 }});
 await suggest({name:'1.png',image:'data:image/jpeg;base64,YQ=='});
 assert.equal(sent.image,'data:image/jpeg;base64,YQ==');
 let attempts=0;
 const ai=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>{attempts++;throw Error('HTTP 400');}});
 const input={name:'1.png',image:sent.image};
 assert.match((await ai.tagAssets(input)).reason,/支持图片/);
 await ai.tagAssets(input);
 assert.equal(attempts,2);
});


test('先按资产类型选识别维度，再把主体大类与细标签合并且去重',async()=>{
 const calls=[];
 const ai=createSearchTranslator({settings:async()=>({enabled:true}),complete:async(messages)=>{
  calls.push(messages);return {text:JSON.stringify({category:'材质',tags:['木材','材质','手绘']})};
 }});
 const input={name:'source.png',kind:'material',image:'data:image/jpeg;base64,YQ=='};
 assert.deepEqual((await ai.tagAssets(input)).tags,['材质','木材','手绘']);
 assert.match(calls[0][0].content,/材质：优先材料种类/);
 assert.equal(calls[0].at(-1).content[1].image_url.detail,'auto');
 await ai.tagAssets({...input,kind:'models'});
 assert.equal(calls.length,2,'同图不同资产类型不能复用标签缓存');
 assert.match(calls[1][0].content,/3D 模型：优先主体类别/);
});

test('不确定或非法大类不作为标签写入，旧版仅返回tags仍兼容',async()=>{
 for(const category of ['其他','未登记类别','<script>']){
  const ai=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>({text:JSON.stringify({category,tags:['木材']})})});
  assert.deepEqual((await ai.tagAssets({name:'a',image:'data:image/jpeg;base64,YQ=='})).tags,['木材']);
 }
});

test('识别请求避开卡片压缩，本地使用独立的高精度预览且不改变卡片地址',async()=>{
 const {thumbSrc,visualTagSrc}=await import('../src/library/image-src.js');
 const remote=visualTagSrc('https://cdna.artstation.com/p/assets/images/a.jpg');
 assert.ok(!remote.includes('card=1'));
 assert.ok(remote.includes('rendition=large'));
 const local='/api/local/thumb?root=folder&rel=image.psd';
 assert.equal(new URL(visualTagSrc(local),'http://localhost').searchParams.get('purpose'),'tags');
 assert.equal(thumbSrc(local),local);
 assert.equal(visualTagSrc(''),'');
});
