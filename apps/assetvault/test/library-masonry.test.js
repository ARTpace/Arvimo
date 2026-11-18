import test from 'node:test';
import assert from 'node:assert/strict';
import {masonryPositions,masonryCardSpan} from '../src/library/masonry.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

test('1600 张混合跨列卡片仍保持优化前的排序和空隙回填结果',()=>{
 const heights=Array.from({length:1600},(_,i)=>100+(i*71)%397),spans=heights.map((_,i)=>1+i%3);
 const result=masonryPositions(heights,8,14,spans);
 assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'),'518e26e3f2e6c0e066e1d644404bce5c3db75288b1172232cc8e0388f50eb3cf');
});

test('图集和图集文件夹统一为整列宽度，不再产生半列窄洞',()=>{
 const card=classes=>({classList:{contains:name=>classes.includes(name)}});
 for(const type of ['pkg-collection','album-folder-card']){
  assert.equal(masonryCardSpan(card([type,'pkg-c4']),8),1);
  assert.equal(masonryCardSpan(card([type,'pkg-c6']),8),1);
  assert.equal(masonryCardSpan(card([type,'pkg-c6','pkg-wide']),8),2);
  assert.equal(masonryCardSpan(card([type,'pkg-c9']),8),2);
  assert.equal(masonryCardSpan(card([type,'pkg-c9']),1),1);
 }
 const spans=[2,1,1,2,1,1];
 const {positions}=masonryPositions([300,150,150,300,150,150],4,12,spans);
 positions.forEach((p,i)=>{assert.equal(p.span,spans[i]);assert.equal(p.column%1,0);});
});

test('动画视觉高度不污染瀑布流布局高度缓存',()=>{
 const source=readFileSync(new URL('../src/library/masonry.js',import.meta.url),'utf8');
 const card={offsetHeight:360,getBoundingClientRect:()=>({height:180})};
 const context={cards:[card],previous:[card],sizes:new WeakMap(),dirty:new Set([card]),root:{},grid:{},resized:false,changed:false};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('   const heights=cards.map'),source.indexOf('   const paintHeights=')),context);
 assert.equal(context.sizes.get(card),360);
 assert.equal(context.changed,true);
});

test('九宫占三个半列，普通卡占两个半列，扩大后不重叠',()=>{
 const heights=[360,240,240,360,240],spans=[3,2,2,3,2];
 const {positions}=masonryPositions(heights,6,12,spans);
 for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){
  const a=positions[i],b=positions[j];
  const shared=a.column<b.column+b.span&&b.column<a.column+a.span;
  if(shared)assert.ok(b.top>=a.top+heights[i]+12||a.top>=b.top+heights[j]+12);
 }
 const base=230,gap=10,half=(base-gap)/2;
 assert.equal(3*(half+gap)-gap,350);
 assert.equal((350-2*gap)/3,(base-gap)/2);
});

test('后续卡片回填宽卡上方空洞，宽卡优先配对避免半列留白',()=>{
 const packed=masonryPositions([300,100,100,80],2,12,[1,1,2,1]);
 assert.equal(packed.positions[3].column,1);
 assert.equal(packed.positions[3].top,112);
 assert.equal(packed.height,412);
 const paired=masonryPositions([360,240,240,360,240],6,12,[3,2,2,3,2]);
 assert.equal(paired.positions[0].top,0);
 assert.equal(paired.positions[3].top,0);
 assert.equal(paired.positions[3].column,3);
});

test('pagination appends below existing cards without moving their positions',()=>{
 const heights=[240,380,180,260,210,340];
 const before=masonryPositions(heights,3,18);
 const after=masonryPositions([...heights,300,150,400],3,18);
 assert.deepEqual(after.positions.slice(0,heights.length),before.positions);
 for(const next of after.positions.slice(heights.length)){
  const previous=before.positions.map((p,i)=>({...p,height:heights[i]})).filter(p=>p.column===next.column);
  assert.ok(previous.every(p=>next.top>=p.top+p.height+18));
 }
 assert.ok(after.height>before.height);
 assert.deepEqual(masonryPositions([],3,18),{positions:[],height:0});
});

test('masonry: cards span one column by default, landscape ones can take two',()=>{
 const heights=[120,300,90,260,180];
 const plain=masonryPositions(heights,4,14);
 assert.ok(plain.positions.every(p=>p.span===1),'不给 spans 时每张卡都占一列');
 const spans=[2,1,1,2,1];
 const wide=masonryPositions(heights,4,14,spans);
 assert.deepEqual(wide.positions.map(p=>p.span),spans);
 // 跨两列的卡片占住相邻两列：这两列里排在它后面的卡片都得在它下面，不能压在一起
 for(const [index,position] of wide.positions.entries()){
  if(position.span!==2)continue;
  assert.ok(position.column+1<4,'跨两列的卡片必须放得下');
  for(let column=position.column;column<position.column+2;column++){
   const next=wide.positions.find((p,i)=>i>index&&p.column===column);
   if(next)assert.ok(next.top>=position.top+heights[index]+14,`第 ${index} 张跨列卡和同列后续卡片重叠了`);
  }
 }
 // 跨列的卡取两列里更高的那条底线起步，下面的邻居才不会顶上来
 const first=wide.positions[0];
 assert.ok(first.top>=0);
 assert.ok(wide.height>=Math.max(...heights));
});

test('masonry: appending cards keeps the earlier cross-column cards in place',()=>{
 const heights=[120,300,90];
 const before=masonryPositions(heights,4,14,[2,1,1]);
 const after=masonryPositions([...heights,200,160],4,14,[2,1,1,1,1]);
 assert.deepEqual(after.positions.slice(0,heights.length),before.positions);
});
