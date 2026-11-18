import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCardImageWindow} from '../src/library/card-image-window.js';

test('离屏释放图片，回到视口恢复原资源且不删除卡片',()=>{
 const {document}=parseHTML('<div id="grid"><article><img src="/a.png" srcset="/a2.png 2x"></article></div>');
 const grid=document.getElementById('grid'),card=grid.firstElementChild,img=card.firstElementChild;
 let callback;const observed=new Set();
 class Observer{constructor(cb){callback=cb;}observe(n){observed.add(n);}unobserve(n){observed.delete(n);}}
 class Mutations{observe(){}}
 const api=createCardImageWindow(grid,{Observer,Mutations});
 callback([{target:card,isIntersecting:false}]);
 assert.equal(img.hasAttribute('src'),false);assert.equal(img.hasAttribute('srcset'),false);assert.equal(grid.firstElementChild,card);
 callback([{target:card,isIntersecting:true}]);
 assert.equal(img.getAttribute('src'),'/a.png');assert.equal(img.getAttribute('srcset'),'/a2.png 2x');
 card.remove();api.refresh();assert.equal(observed.size,0);assert.equal(img.hasAttribute('src'),false);
 grid.append(card);api.refresh();callback([{target:card,isIntersecting:true}]);assert.equal(img.getAttribute('src'),'/a.png');
});
