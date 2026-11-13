import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {migrateProjectData,mergeLegacyLibrary} from '../scripts/migrate-project-data.mjs';
test('legacy import keeps current metadata and trash decisions, adding unique models and favorites',()=>{
 const key='sfx-library-v2';
 const result=JSON.parse(mergeLegacyLibrary({[key]:JSON.stringify({models:[{uid:'a',name:'current'}],trashed:[{uid:'c'}],options:{format:'fbx'}})},{[key]:JSON.stringify({models:[{uid:'a',name:'old'},{uid:'b'},{uid:'c'}],favorites:['b','c'],options:{format:'glb'}})})[key]);
 assert.deepEqual(result.models,[{uid:'a',name:'current'},{uid:'b'}]);assert.deepEqual(result.favorites,['b']);assert.equal(result.options.format,'fbx');
});
test('migration previews, verifies files, preserves conflicting assets and archives profile before relocation',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'av-migrate-'));
 try{
  const project=path.join(temp,'project'),base=path.join(temp,'user'),dataDir=path.join(base,'data'),downloadDir=path.join(base,'downloads');
  for(const dir of [path.join(project,'downloads'),path.join(project,'.assetvault'),dataDir,downloadDir])await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(project,'downloads/a.glb'),'old asset');await fs.writeFile(path.join(downloadDir,'a.glb'),'current asset');
  const values={'sfx-library-v2':JSON.stringify({models:[{uid:'b',filePath:path.join(project,'downloads/a.glb')}],favorites:['b']})};
  await fs.writeFile(path.join(project,'.assetvault/library-state.json'),JSON.stringify(values));
  await fs.writeFile(path.join(dataDir,'library-state.json'),JSON.stringify({'sfx-library-v2':JSON.stringify({models:[{uid:'a'}]})}));
  const paths={base,dataDir,downloadDir};
  const plans=await migrateProjectData(project,paths);assert.equal(plans.length,2);await fs.access(path.join(project,'downloads/a.glb'));
  await migrateProjectData(project,paths,{apply:true});
  await assert.rejects(fs.access(path.join(project,'downloads')));
  const state=JSON.parse(JSON.parse(await fs.readFile(path.join(dataDir,'library-state.json'),'utf8'))['sfx-library-v2']);
  assert.equal(state.models.length,2);assert.equal(await fs.readFile(state.models.find(m=>m.uid==='b').filePath,'utf8'),'old asset');
  assert.equal(await fs.readFile(path.join(downloadDir,'a.glb'),'utf8'),'current asset');
  const archive=plans.find(p=>p.source.endsWith('.assetvault')).destination;await fs.access(path.join(archive,'library-state.json'));
  await fs.symlink(downloadDir,path.join(project,'downloads'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(migrateProjectData(project,paths),/Unsafe source/);await fs.unlink(path.join(project,'downloads'));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
