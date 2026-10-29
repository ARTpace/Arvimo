import test from 'node:test';
import assert from 'node:assert/strict';
import {masonryPositions} from '../src/library/masonry.js';

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
