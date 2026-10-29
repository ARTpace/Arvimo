import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('online platform results preserve loaded card nodes while inserting and reordering',()=>{
 const source=readFileSync(new URL('../src/library/library-view.js',import.meta.url),'utf8');
 let rebuilds=0;
 const grid={
  children:[],
  get firstElementChild(){return this.children[0]||null;},
  querySelectorAll(selector){return selector.includes('data-uid')?[...this.children]:[];},
  set innerHTML(html){rebuilds++;this.children=[];this.insertAdjacentHTML('beforeend',html);},
  insertAdjacentHTML(position,html){
   for(const match of html.matchAll(/\[([^\]]+)\]/g)){
    const node={dataset:{uid:match[1]},
     get nextElementSibling(){return grid.children[grid.children.indexOf(this)+1]||null;},
     remove(){grid.children.splice(grid.children.indexOf(this),1);},
     set outerHTML(value){throw Error('Unchanged card must not be replaced');},
    };
    this.children.push(node);
   }
  },
  insertBefore(node,cursor){
   const old=this.children.indexOf(node);if(old>=0)this.children.splice(old,1);
   const index=cursor?this.children.indexOf(cursor):this.children.length;
   this.children.splice(index,0,node);
  },
 };
 const context={$:()=>grid,state:{sort:'recent',compact:false},extraCards:()=>[],cardView:{card:model=>`[${model.uid}]`}};
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
});
