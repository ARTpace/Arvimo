import test from 'node:test';
import assert from 'node:assert/strict';
import {rankSimilar,similarRequest,createSimilarAssets} from '../src/library/similar-assets.js';

test('同类型不能单独入选，排除自己与重复项，AI 标签参与匹配',()=>{
 const model={uid:'current',name:'Road',assetType:'textures',tags:['sand']};
 const state={aiTags:{best:['sand']}};
 const rows=[model,{uid:'type',assetType:'textures'},{uid:'best',assetType:'models'}, {uid:'best',tags:['sand']}];
 assert.deepEqual(rankSimilar(model,rows,state).map(row=>row.model.uid),['best']);
 assert.equal(rankSimilar(model,rows,state,1)[0].reason,'相似标签');
});

test('通用制作标签不构成相关性，主题标签优先查询且去重计分',()=>{
 const model={uid:'car',name:'Porsche car',tags:['3D','low-poly','photorealistic','car']};
 const rows=[{uid:'dinosaur',name:'Dinosaur',tags:['3d','low-poly','photorealistic']},{uid:'eye',name:'Realistic eye',tags:['3d']},{uid:'vehicle',name:'Sports car',tags:[' CAR ','car']},{uid:'plain',name:'Unknown'}];
 const matches=rankSimilar(model,rows,{});
 assert.deepEqual(matches.map(item=>item.model.uid),['vehicle']);
 assert.equal(matches[0].score,17);
 assert.equal(similarRequest(model,{}).payload.q,'car');
 assert.equal(rankSimilar({uid:'cn',name:'汽车'},[{uid:'cn2',name:'汽车'}],{}).length,1);
});
test('推荐复用对应平台的接口并保留资产类型',()=>{
 const request=similarRequest({platform:'polyhaven',assetType:'textures',tags:['sand'],name:'Road'},{});
 assert.match(request.endpoint,/polyhaven/);assert.equal(request.payload.type,'textures');assert.equal(request.payload.q,'sand');
 assert.equal(similarRequest({platform:'artstation',name:'Free Robot'},{}).payload.assetType,'marmoset');
});
test('切换预览或关闭后迟到的推荐不覆盖新列表，在线推荐可点击切换预览',async t=>{
 const sections=[];const document={createElement:()=>{const section={hidden:true,events:{},setAttribute(){},addEventListener(name,fn){this.events[name]=fn;}};sections.push(section);return section;}};
 const previous=globalThis.document;globalThis.document=document;t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const dialog={open:true,events:{},append(){},addEventListener(name,fn){this.events[name]=fn;}};
 const requests=[],clicked=[];
 const ui=createSimilarAssets({dialog,state:{},candidates:()=>[],imageUrl:()=>'/fixture.png',onPreview:uid=>clicked.push(uid),fetchImpl:(_url,options)=>new Promise(resolve=>requests.push({options,resolve}))});
 const first=ui.show({uid:'a',name:'Tree'}),second=ui.show({uid:'b',name:'Rock'});
 assert.equal(requests[0].options.signal.aborted,true);
 requests[1].resolve({ok:true,json:async()=>({models:[{uid:'new',name:'Rock cliff',thumbnail:'image'}]})});await second;
 const html=sections[0].innerHTML;assert.match(html,/Rock cliff/);
 assert.doesNotMatch(html,/<header>|<strong>/);assert.match(html,/similar-asset-info/);assert.match(html,/aria-label=/);
 requests[0].resolve({ok:true,json:async()=>({models:[{uid:'old',name:'Old tree'}]})});await first;
 assert.equal(sections[0].innerHTML,html);assert.equal(ui.find('new').uid,'new');
 sections[0].events.click({target:{closest:()=>({dataset:{similarUid:'new'}})}});assert.deepEqual(clicked,['new']);
 const list={scrollWidth:1200,clientWidth:600,scrollLeft:0};let prevented=0;
 const wheel={target:{closest:()=>list},deltaX:0,deltaY:120,deltaMode:0,preventDefault(){prevented++;}};
 sections[0].events.wheel(wheel);assert.equal(list.scrollLeft,120);assert.equal(prevented,1);
 sections[0].events.wheel({...wheel,deltaY:-200});assert.equal(list.scrollLeft,0);
 sections[0].events.wheel({...wheel,deltaY:2,deltaMode:1});assert.equal(list.scrollLeft,32);
 sections[0].events.wheel({...wheel,ctrlKey:true});assert.equal(list.scrollLeft,32);
 const third=ui.show({uid:'c',name:'Sand'});dialog.open=false;dialog.events.close();
 requests[2].resolve({ok:true,json:async()=>({models:[{uid:'late',name:'Late'}]})});await third;
 assert.equal(sections[0].hidden,true);assert.equal(ui.find('late'),undefined);
});
