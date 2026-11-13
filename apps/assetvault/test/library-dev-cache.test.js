import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sourceStamp,needsBuild} from '../sketchfab-exporter-tauri/scripts/dev-cache.mjs';
test('development cache reuses outputs and invalidates source edits, additions, deletions and missing outputs',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arvimo-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.join(root,'src');fs.mkdirSync(source);const file=path.join(source,'app.js'),out=path.join(root,'app.bundle.js');
 fs.writeFileSync(file,'old');fs.writeFileSync(out,'bundle');fs.utimesSync(out,new Date(Date.now()+1000),new Date(Date.now()+1000));
 const before=sourceStamp([source]);
 assert.equal(needsBuild(before,undefined,[out]),false,'existing fresh build can be adopted');
 assert.equal(needsBuild(before,before.key,[out]),false,'unchanged source skips builds');
 fs.writeFileSync(file,'changed source');assert.equal(needsBuild(sourceStamp([source]),before.key,[out]),true);
 fs.writeFileSync(path.join(source,'new.js'),'new');const added=sourceStamp([source]);assert.notEqual(added.key,before.key);
 fs.unlinkSync(file);assert.equal(needsBuild(sourceStamp([source]),added.key,[out]),true);
 fs.unlinkSync(out);assert.equal(needsBuild(before,before.key,[out]),true);
});
