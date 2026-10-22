import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assetStorageCategory} from '../server/asset-storage.mjs';
import {organizeDownloads,rollbackOrganization} from '../scripts/organize-downloads.mjs';

test('资源类型优先于名称，模型用途保守分类',()=>{
 assert.equal(assetStorageCategory({kind:'images',name:'car'}),'图片');
 assert.equal(assetStorageCategory({platform:'freestylized',kind:'pack',assetType:'skybox'}),'环境');
 assert.equal(assetStorageCategory({kind:'ambientcg',name:'wood'}),'材质');
 assert.equal(assetStorageCategory({kind:'kenney',name:'city'}),'资源包');
 assert.equal(assetStorageCategory({name:'Porsche_911-textures'}),path.join('模型','载具'));
 assert.equal(assetStorageCategory({name:'Unknown'}),path.join('模型','未分类'));
});

test('整体迁移保留内容、更新记录且可回撤，不覆盖冲突',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-organize-'));
 try{
  const root=path.join(temp,'downloads'),dataDir=path.join(temp,'data');
  fs.mkdirSync(path.join(root,'car','textures'),{recursive:true});fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(root,'car','textures','color.png'),'original');
  const store={version:1,jobs:[{name:'car',kind:'sketchfab',filePath:path.join(root,'car'),downloadDir:root}],settings:{folder:root}};
  fs.writeFileSync(path.join(dataDir,'tasks.json'),JSON.stringify(store));
  const preview=organizeDownloads({root,dataDir});assert.equal(preview.moves.length,1);assert.ok(fs.existsSync(path.join(root,'car')));
  const result=organizeDownloads({root,dataDir,apply:true});
  const updated=JSON.parse(fs.readFileSync(path.join(dataDir,'tasks.json')));
  assert.equal(fs.readFileSync(path.join(updated.jobs[0].filePath,'textures','color.png'),'utf8'),'original');
  assert.equal(updated.jobs[0].downloadRoot,root);assert.equal(updated.settings.folder,root);
  assert.equal(organizeDownloads({root,dataDir}).moves.length,0);
  fs.mkdirSync(path.join(root,'car'));
  assert.throws(()=>organizeDownloads({root,dataDir,apply:true}),/目标存在/);
  fs.rmdirSync(path.join(root,'car'));
  rollbackOrganization(result.journalPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir,'tasks.json'))),store);
  assert.equal(fs.readFileSync(path.join(root,'car','textures','color.png'),'utf8'),'original');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
