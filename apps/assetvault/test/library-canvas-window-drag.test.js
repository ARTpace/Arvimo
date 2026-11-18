import test from 'node:test';
import assert from 'node:assert/strict';
import {bindCanvasWindowDrag} from '../src/library/artflow-embed.js';
const event=(type,props={})=>Object.assign(new Event(type,{cancelable:true}),props);
function setup(){
 const doc=new EventTarget(),win=new EventTarget();doc.defaultView=win;let moves=0;
 const dispose=bindCanvasWindowDrag(doc,()=>{moves++;});
 return {doc,win,dispose,moves:()=>moves};
}
test('右键单击保留菜单，超过阈值只启动一次窗口拖动',async()=>{
 const {doc,win,moves,dispose}=setup();
 doc.dispatchEvent(event('mousedown',{button:2,buttons:2,screenX:10,screenY:10}));
 win.dispatchEvent(event('mousemove',{buttons:2,screenX:13,screenY:12}));
 win.dispatchEvent(event('mouseup',{button:2}));
 const clickMenu=event('contextmenu');win.dispatchEvent(clickMenu);
 assert.equal(clickMenu.defaultPrevented,false);assert.equal(moves(),0);
 doc.dispatchEvent(event('mousedown',{button:2,buttons:2,screenX:10,screenY:10}));
 for(let x=20;x<100;x++)win.dispatchEvent(event('mousemove',{buttons:2,screenX:x,screenY:10}));
 await Promise.resolve();assert.equal(moves(),1);
 const dragMenu=event('contextmenu');win.dispatchEvent(dragMenu);assert.equal(dragMenu.defaultPrevented,true);
 dispose();
});
test('左键、编辑框和清理后的事件不会启动拖窗',async()=>{
 const {doc,win,moves,dispose}=setup();
 doc.dispatchEvent(event('mousedown',{button:0,buttons:1,screenX:0,screenY:0}));
 win.dispatchEvent(event('mousemove',{buttons:1,screenX:100,screenY:100}));
 doc.closest=()=>({});
 doc.dispatchEvent(event('mousedown',{button:2,buttons:2,screenX:0,screenY:0}));
 win.dispatchEvent(event('mousemove',{buttons:2,screenX:100,screenY:100}));
 dispose();doc.closest=()=>null;
 doc.dispatchEvent(event('mousedown',{button:2,buttons:2,screenX:0,screenY:0}));
 win.dispatchEvent(event('mousemove',{buttons:2,screenX:100,screenY:100}));
 await Promise.resolve();assert.equal(moves(),0);
});
