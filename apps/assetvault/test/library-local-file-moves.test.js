import test from 'node:test';
import assert from 'node:assert/strict';
import {applyLocalFileMoves} from '../src/library/local-file-moves.js';

test('已提交移动更新本地卡片名称、定位和 URL，保留自定义封面和标注',()=>{
  const models=[{uid:'a',name:'a.png',url:'/api/local/file?root=old&rel=a.png',thumbnail:'/api/local/thumb?w=512&root=old&rel=a.png',rating:5},
    {uid:'b',name:'自定义标题',thumbnail:'/custom-cover.png'},{uid:'c',name:'other'}];
  const result={root:'H:\\素材',changes:[{uid:'a',from:'a.png',to:'分类/new.png'},{uid:'b',from:'b.png',to:'分类/b.png'}]};
  assert.equal(applyLocalFileMoves(models,result),2);
  assert.equal(models[0].name,'new.png');assert.equal(models[0].filePath,'H:\\素材\\分类\\new.png');assert.equal(models[0].rating,5);
  assert.equal(new URL(models[0].thumbnail,'http://local').searchParams.get('rel'),'分类/new.png');
  assert.equal(new URL(models[0].thumbnail,'http://local').searchParams.get('w'),'512');
  assert.equal(models[1].name,'自定义标题');assert.equal(models[1].thumbnail,'/custom-cover.png');assert.equal(models[2].name,'other');
});
