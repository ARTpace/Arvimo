import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveDataDir,resolveUserPaths} from '../server/data-dir.mjs';
test('startup modes share user storage and preserve absolute overrides without merging profiles',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-paths-'));
 try{
  const env={APPDATA:root},next=path.join(root,'AssetVault'),legacy=path.join(root,'com.assetvault.desktop');
  assert.deepEqual(resolveUserPaths(env),{base:next,activeStoreId:null,accountsDir:path.join(next,'accounts'),dataDir:path.join(next,'data'),downloadDir:path.join(next,'downloads')});
  fs.mkdirSync(legacy);assert.equal(resolveUserPaths(env).base,legacy);
  fs.mkdirSync(next);assert.equal(resolveUserPaths(env).base,legacy);
  fs.rmdirSync(legacy);fs.symlinkSync(next,legacy,process.platform==='win32'?'junction':'dir');
  assert.equal(resolveUserPaths(env).base,next);
  assert.equal(resolveUserPaths({...env,SFX_DATA_DIR:path.join(root,'custom')}).dataDir,path.join(root,'custom'));
  assert.throws(()=>resolveUserPaths({...env,SFX_DATA_DIR:'relative'}),/absolute/);
  assert.throws(()=>resolveUserPaths({...env,SFX_DOWNLOAD_DIR:'relative'}),/absolute/);
  // resolveDataDir 不接 env 参数，只能临时改进程环境；否则它会去解析真实的
  // %APPDATA%，顺带把真实账号文件迁移一遍 —— 测试不许碰用户数据。
  const savedAppData=process.env.APPDATA,savedDataDir=process.env.SFX_DATA_DIR;
  process.env.APPDATA=root;delete process.env.SFX_DATA_DIR;
  try{assert.equal(resolveDataDir(root).dir,path.join(next,'data'));}
  finally{
   if(savedAppData===undefined)delete process.env.APPDATA;else process.env.APPDATA=savedAppData;
   if(savedDataDir!==undefined)process.env.SFX_DATA_DIR=savedDataDir;
  }
  fs.unlinkSync(legacy);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
