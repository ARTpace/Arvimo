import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {withRemovalMotion,boardPositions,animateBoardPositions} from '../src/library/removal-motion.js';
function fixture(t){
 const {document}=parseHTML('<html><body><article id="card"><img id="cover" src="cover.png"></article></body></html>');
 const node=document.querySelector('article');let finish,cancelled=0,frames;
 const animation={finished:new Promise(resolve=>{finish=resolve;}),cancel(){cancelled++;}};
 node.getBoundingClientRect=()=>({left:10,top:20,width:200,height:160,bottom:180});node.animate=()=>{};
 const clone=node.cloneNode.bind(node);
 node.cloneNode=(...args)=>{const ghost=clone(...args);ghost.animate=(keyframes)=>{frames=keyframes;return animation;};return ghost;};
 const previous=globalThis.window;globalThis.window={matchMedia:()=>({matches:false})};
 t.after(()=>{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;});
 return {document,node,finish:()=>finish(),cancelled:()=>cancelled,frames:()=>frames};
}
test('删除时使用独立视觉副本，重绘移除原节点也能完成退场，结束清理',async t=>{
 const f=fixture(t);let committed=false;
 const pending=withRemovalMotion([f.node],async()=>{committed=true;f.node.remove();return 'deleted';});
 assert.equal(committed,true);const ghost=f.document.querySelector('.removal-ghost');assert.ok(ghost);
 assert.equal(ghost.getAttribute('aria-hidden'),'true');assert.equal(ghost.querySelector('[id]'),null);
 assert.equal(f.frames().at(-1).opacity,0);
 f.finish();assert.equal(await pending,'deleted');assert.equal(f.document.querySelector('.removal-ghost'),null);assert.equal(f.cancelled(),1);
});
test('删除失败立即清掉副本并恢复原卡片，不等动画结束',async t=>{
 const f=fixture(t);f.node.style.visibility='visible';
 await assert.rejects(withRemovalMotion([f.node],async()=>{throw Error('删除失败');}),/删除失败/);
 assert.equal(f.node.style.visibility,'visible');assert.equal(f.node.isConnected,true);
 assert.equal(f.document.querySelector('.removal-ghost'),null);
});
test('减少动态效果模式直接执行，不生成副本、不延迟操作',async t=>{
 const f=fixture(t);globalThis.window.matchMedia=()=>({matches:true});
 assert.equal(await withRemovalMotion([f.node],async()=>42),42);
 assert.equal(f.document.querySelector('.removal-ghost'),null);assert.equal(f.frames(),undefined);
});
test('画板补位按稳定ID匹配，新建画板不从错误坐标飞入',async t=>{
 const f=fixture(t);const node=f.node;node.dataset.bdOpen='board-1';
 const before=boardPositions(f.document.body);let frames;
 node.getBoundingClientRect=()=>({left:220,top:20,width:200,height:160,bottom:180});node.animate=keyframes=>{frames=keyframes;};
 animateBoardPositions(f.document.body,before);
 assert.deepEqual(frames,[{translate:'-210px 0px'},{translate:'0px 0px'}]);
});
