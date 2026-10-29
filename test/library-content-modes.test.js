import test from 'node:test';
import assert from 'node:assert/strict';
import {ALL,platformsForMode} from '../src/library/platforms.js';
import {CONTENT_MODES,modeById,activeMode,modeTarget,createContentModes} from '../src/library/content-modes.js';

test('image platform selector offers individual sites without the merged option',()=>{
 const images=platformsForMode('image').map(item=>item.id);
 assert.ok(!images.includes(ALL));
 assert.ok(images.includes('artstation'));
 assert.ok(images.includes('500px'));
 assert.ok(platformsForMode('model').some(item=>item.id===ALL));
 assert.ok(platformsForMode('').some(item=>item.id===ALL));
});

// 按钮高亮是从 state 推出来的：模型模式=全部平台且只要 3D；图片模式=A 站瀑布流。
// 状态对不上就都不亮，而不是顺手亮第一个。
test('content modes: the highlighted mode follows the state, not the last click',()=>{
 assert.equal(activeMode({platform:ALL,modelOnly:true}),'model');
 assert.equal(activeMode({platform:ALL}),'');
 assert.equal(activeMode({platform:'artstation',gallery:true}),'image');
 assert.equal(activeMode({platform:'artstation'}),'');
 assert.equal(activeMode({platform:'sketchfab'}),'');
 assert.equal(activeMode({platform:'web'}),'');
 assert.equal(activeMode({}),'');
 assert.equal(activeMode(null),'');
});

test('content modes: model mode keeps every platform, image mode owns ArtStation, clicking again backs out',()=>{
 // 从任何地方点「模型模式」：停在全部平台、锁 A 站类型为 Marmoset、不要瀑布流。
 assert.deepEqual(modeTarget('model',{platform:ALL}),{platform:ALL,gallery:false,modelOnly:true});
 assert.deepEqual(modeTarget('model',{platform:'sketchfab'}),{platform:ALL,gallery:false,modelOnly:true});
 assert.deepEqual(modeTarget('model',{platform:'artstation',gallery:true}),{platform:ALL,gallery:false,modelOnly:true});
 // 再点当前那个＝退出：留在全部平台，解锁 A 站类型。
 assert.deepEqual(modeTarget('model',{platform:ALL,modelOnly:true}),{platform:ALL,gallery:false,modelOnly:false});
 // 图片模式照旧：A 站 + 瀑布流；退出回全部平台并关瀑布流。
 assert.deepEqual(modeTarget('image',{platform:ALL}),{platform:'artstation',gallery:true,modelOnly:false});
 assert.deepEqual(modeTarget('image',{platform:'artstation',gallery:true}),{platform:ALL,gallery:false,modelOnly:false});
 assert.equal(CONTENT_MODES.find(mode=>mode.id==='model').gallery,false);
 assert.equal(modeTarget('不存在',{platform:ALL}),null);
 assert.equal(modeById('image').platform,'artstation');
});

test('content modes: rendering writes the pressed state onto both buttons',()=>{
 const make=id=>({
  dataset:{contentMode:id},
  classes:new Set(),
  pressed:null,
  handlers:[],
  classList:{toggle(name,on){on?this.owner.classes.add(name):this.owner.classes.delete(name);}},
  setAttribute(name,value){if(name==='aria-pressed')this.pressed=value;},
  addEventListener(type,handler){this.handlers.push({type,handler});},
 });
 const buttons=[make('model'),make('image')];
 for(const button of buttons)button.classList.owner=button;
 const state={platform:ALL,modelOnly:false,gallery:false};
 const picks=[];
 const modes=createContentModes({state,onPick:id=>picks.push(id),buttons});
 const snapshot=()=>({model:buttons[0].classes.has('active'),image:buttons[1].classes.has('active'),pressed:buttons.map(b=>b.pressed)});
 assert.deepEqual(snapshot(),{model:false,image:false,pressed:['false','false']},'全部平台普通浏览时两个都不亮');
 state.modelOnly=true;modes.render();
 assert.deepEqual(snapshot(),{model:true,image:false,pressed:['true','false']});
 state.modelOnly=false;state.platform='artstation';state.gallery=true;modes.render();
 assert.deepEqual(snapshot(),{model:false,image:true,pressed:['false','true']});
 // 点击只把 id 交给 app.js —— 模式模块自己不碰 state、也不自己切平台。
 for(const button of buttons)for(const {handler} of button.handlers)handler();
 assert.deepEqual(picks,['model','image']);
});
