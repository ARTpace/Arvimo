import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('large mixed libraries render only the sorted visible page',()=>{
 const source=readFileSync(new URL('../src/library/library-view.js',import.meta.url),'utf8');
 const rendered=[];
 const grid={firstElementChild:null,innerHTML:''};
 const extras=Array.from({length:10000},(_,i)=>({key:`extra${i}`,mtime:i,get html(){rendered.push(`extra${i}`);return `[extra${i}]`;}}));
 const context={$:()=>grid,state:{sort:'recent'},extraCards:()=>extras,
  pageRows:rows=>rows.slice(0,60),cardView:{card:model=>{rendered.push(model.uid);return `[${model.uid}]`;}}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('let cardHtml='),source.indexOf('function renderDisplayButtons')),context);
 const visible=context.paintGrid([{uid:'newest',addedAt:10001},{uid:'old',addedAt:0}],false,false,false);
 assert.equal(visible.count,60,'empty state includes local files, packages and sequences');
 assert.deepEqual(Array.from(visible.models,model=>model.uid),['newest'],'UI previews reuse the mixed page without a second paging pass');
 assert.equal(rendered.length,60,'offscreen models and file cards must not generate HTML');
 assert.equal(rendered[0],'newest');
 assert.equal(rendered[1],'extra9999');
 assert.equal(rendered.at(-1),'extra9941');
 assert.equal(rendered.includes('old'),false);
 assert.equal(vm.runInContext('cardHtml.size',context),60,'retained HTML stays limited to the rendered page');
});

test('online platform results preserve loaded card nodes while inserting and reordering',()=>{
 const source=readFileSync(new URL('../src/library/library-view.js',import.meta.url),'utf8');
 let rebuilds=0;
 const makeNode=uid=>({dataset:{uid},
  get nextElementSibling(){return grid.children[grid.children.indexOf(this)+1]||null;},
  remove(){grid.children.splice(grid.children.indexOf(this),1);},
  querySelector(){return null;},
  replaceWith(node){grid.children.splice(grid.children.indexOf(this),1,node);},
  set outerHTML(value){throw Error('Unchanged card must not be replaced');},
 });
 // 增量对齐用 <template> 把卡片 HTML 变成节点：这里给 vm 一个等价的最小实现。
 const document={createElement(tag){
  assert.equal(tag,'template');
  const template={content:{firstElementChild:null}};
  Object.defineProperty(template,'innerHTML',{set(html){
   const match=/\[([^\]]+)\]/.exec(html);
   template.content.firstElementChild=match?makeNode(match[1]):null;
  }});
  return template;
 }};
 const grid={
  children:[],
  get firstElementChild(){return this.children[0]||null;},
  querySelectorAll(selector){return selector.includes('data-uid')?[...this.children]:[];},
  set innerHTML(html){rebuilds++;this.children=[];this.insertAdjacentHTML('beforeend',html);},
  insertAdjacentHTML(position,html){
   for(const match of html.matchAll(/\[([^\]]+)\]/g))this.children.push(makeNode(match[1]));
  },
  insertBefore(node,cursor){
   if(cursor&&!this.children.includes(cursor))throw Error('NotFoundError: reference node is no longer a child');
   const old=this.children.indexOf(node);if(old>=0)this.children.splice(old,1);
   const index=cursor?this.children.indexOf(cursor):this.children.length;
   this.children.splice(index,0,node);
  },
 };
 const context={$:()=>grid,document,state:{sort:'recent'},extraCards:()=>[],cardView:{card:model=>`[${model.uid}]`}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('let cardHtml='),source.indexOf('function renderDisplayButtons')),context);
 const paint=ids=>context.paintGrid(ids.map(uid=>({uid})),false,true,true);
 paint(['a','c']);
 const [a,c]=grid.children;
 paint(['b','a','c']);
 assert.equal(grid.children[1],a);assert.equal(grid.children[2],c);
 paint(['c','b','a','d']);
 assert.deepEqual(grid.children.map(node=>node.dataset.uid),['c','b','a','d']);
 assert.equal(grid.children[0],c);assert.equal(grid.children[2],a);
 paint(['d','a']);
 assert.equal(grid.children[1],a);
 assert.deepEqual(grid.children.map(node=>node.dataset.uid),['d','a']);
 assert.equal(rebuilds,1);
 // Updating a card in place must advance the cursor to its replacement,
 // including when a refresh also appends a newly imported asset.
 context.cardView.card=model=>`[${model.uid}] updated`;
 paint(['d','a','new']);
 assert.deepEqual(grid.children.map(node=>node.dataset.uid),['d','a','new']);
 context.masonry={flush(){}};
 context.cardView.card=model=>`[${model.uid}] ${model.revision||0}`;
 context.paintGrid([{uid:'d'},{uid:'a'}],true,true,false);
 const unchanged=grid.children[1];
 context.paintGrid([{uid:'d',revision:1},{uid:'a'},{uid:'fresh'}],true,true,false);
 assert.deepEqual(grid.children.map(node=>node.dataset.uid),['d','a','fresh']);
 assert.equal(grid.children[1],unchanged,'masonry refresh preserves unchanged loaded cards');
});

test('failed online covers retain the asset card after the original-image fallback',()=>{
 const source=readFileSync(new URL('../src/library/library-view.js',import.meta.url),'utf8');
 let onError,removed=false,broken=false;
 class HTMLImageElement {}
 class HTMLVideoElement {}
 const grid={dataset:{},addEventListener:(event,handler)=>{assert.equal(event,'error');onError=handler;}};
 const context={grid,HTMLImageElement,HTMLVideoElement,encodeURIComponent};
 vm.createContext(context);
 const start=source.indexOf('if(!grid.dataset.brokenHook)');
 vm.runInContext(source.slice(start,source.indexOf('// 视频卡片悬停',start)),context);
 const image=new HTMLImageElement();
 image.dataset={url:'https://hf-mirror.com/datasets/nvidia/simready-assets/resolve/main/chair/cover.png'};
 image.closest=selector=>selector==='.card-media'?{classList:{add:value=>{broken=value==='is-broken';}}}:{remove:()=>{removed=true;}};
 onError({target:image});assert.match(image.src,/full=1/);assert.equal(broken,false);
 onError({target:image});assert.equal(broken,true);assert.equal(removed,false);
 assert.equal(image.dataset.failed,'1');
});
