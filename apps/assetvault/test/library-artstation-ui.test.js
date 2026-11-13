import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtstationUI} from '../src/library/artstation-ui.js';

// 「这个作品该不该进 3D 预览弹窗」和「该不该去官方作品页」是同一条判据的两面：
// 判据错一个字，就会变成「按钮写着预览、点下去跳外链」。所以边界单独钉住。
const makeUI=()=>{
 const toasts=[];
 const ui=createArtstationUI({$:()=>null,icon:()=>'',esc:String,toast:message=>toasts.push(message),state:{models:[]},requestFeed:()=>{}});
 return {ui,toasts};
};

test('artstation: a work only counts as 3D when it carries a Marmoset scene',()=>{
 const {ui}=makeUI();
 assert.equal(ui.has3dScene({platform:'artstation',hasMarmoset:true}),true);
 // 搜索行不给这个字段时按「有场景」处理：不能因为缺字段就把 3D 作品降级成图片。
 assert.equal(ui.has3dScene({platform:'artstation'}),true);
 assert.equal(ui.has3dScene({platform:'artstation',hasMarmoset:false}),false);
 // Sketchfab 模型跟 ArtStation 的入口无关，别被顺手带进去。
 assert.equal(ui.has3dScene({uid:'x',platform:'sketchfab'}),false);
 assert.equal(ui.has3dScene(null),false);
});

test('artstation: no artwork address means saying so, not opening a blank tab',()=>{
 const {ui,toasts}=makeUI();
 const opened=[];
 const realWindow=globalThis.window;
 globalThis.window={open:(...args)=>opened.push(args)};
 try{
  ui.openArtwork({platform:'artstation',artId:'abc123'});
  assert.equal(opened.length,1);
  assert.equal(opened[0][0],'https://www.artstation.com/artwork/abc123');
  // 新标签页要摘掉 opener，否则被打开的站点能顺着 window.opener 摸回来。
  assert.match(opened[0][2],/noopener/);
  // 作品页地址已存在模型上时直接用它，不再照着 artId 拼一个。
  ui.openArtwork({platform:'artstation',artId:'abc123',artworkUrl:'https://www.artstation.com/artwork/zzz'});
  assert.equal(opened[1][0],'https://www.artstation.com/artwork/zzz');
  ui.openArtwork({platform:'artstation'});
  assert.equal(opened.length,2,'没有地址时不该开标签页');
  assert.match(toasts.at(-1),/没有可访问/);
 }finally{
  if(realWindow===undefined)delete globalThis.window;else globalThis.window=realWindow;
 }
});
