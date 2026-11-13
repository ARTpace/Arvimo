import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {detectSoftware} from '../server/software-detection.mjs';
import {installDcc} from '../server/dcc-import.mjs';
import {exportSettingsHtml,selectSoftwareTab} from '../src/library/export-settings.js';

test('software detection verifies executable files, not leftover profile or installation folders',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-software-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const options={home,programFiles:path.join(home,'Programs'),useRegistry:false,appData:path.join(home,'Roaming'),localAppData:path.join(home,'Local')};
 const dir=path.join(options.programFiles,'Autodesk','Maya2025','bin');await fs.mkdir(dir,{recursive:true});
 assert.equal((await detectSoftware('maya',options)).softwareInstalled,false);
 await fs.writeFile(path.join(dir,'maya.exe'),'executable fixture');
 const result=await detectSoftware('maya',options);assert.equal(result.softwareInstalled,true);assert.equal(result.installations[0].version,'2025');
 const updates=[];
 await installDcc(path.join(home,'data'),'maya',{...options,onProgress:update=>updates.push(update)});
 assert.deepEqual(updates.map(update=>update.percent),[5,25,30,95,100]);
 assert.match(updates.at(-1).message,/安装完成/);
 assert.match(await fs.readFile(path.join(home,'Documents','maya','2025','scripts','userSetup.py'),'utf8'),/AssetVault import receiver/);
});

test('software tabs render a single selected panel and distinguish software, scripts and connection',()=>{
 const html=exportSettingsHtml([{id:'blender',label:'Blender',kind:'bridge'},{id:'maya',label:'Maya',kind:'dcc',softwareInstalled:true,installed:false,profiles:[],installations:[{version:'2025',executable:'C:/Maya/bin/maya.exe'}]}],{esc:String,icon:()=>'',active:'maya'});
 assert.match(html,/role="tablist"/);assert.match(html,/data-software-panel="blender" hidden/);
 assert.match(html,/data-software-panel="maya" >/);assert.match(html,/已检测到 Maya · 2025/);assert.match(html,/接收脚本未安装/);
 assert.match(html,/software-state bridge-status/);assert.match(html,/data-tone="ok"/);
 assert.match(html,/自动安装接收脚本/);assert.doesNotMatch(html,/data-dcc-install="maya" disabled/);
});

test('software installation cache survives restart and explicit refresh invalidates it',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-detection-cache-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const options={dataDir:path.join(home,'data'),programFiles:path.join(home,'Programs'),useRegistry:false};
 const bin=path.join(options.programFiles,'Autodesk','Maya2025','bin');await fs.mkdir(bin,{recursive:true});
 const file=path.join(bin,'maya.exe');await fs.writeFile(file,'fixture');
 assert.equal((await detectSoftware('maya',options)).softwareInstalled,true);
 await fs.unlink(file);
 assert.equal((await detectSoftware('maya',options)).softwareInstalled,true);
 assert.equal((await detectSoftware('maya',{...options,refresh:true})).softwareInstalled,false);
});

test('Houdini installation includes detected new versions even when older profiles exist',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-houdini-versions-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const programFiles=path.join(home,'Programs');
 await fs.mkdir(path.join(home,'Documents','houdini20.5'),{recursive:true});
 const bin=path.join(programFiles,'Side Effects Software','Houdini21.0.596','bin');await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'houdini.exe'),'fixture');
 const result=await installDcc(path.join(home,'data'),'houdini',{home,programFiles,useRegistry:false});
 assert.equal(result.profiles.length,2);
 assert.match(await fs.readFile(path.join(home,'Documents','houdini21.0','scripts','456.py'),'utf8'),/AssetVault import receiver/);
});

test('switching tabs changes visibility and keyboard focus without rebuilding or resetting inputs',()=>{
 const tab=id=>({dataset:{softwareTab:id},classList:{toggle(){}},setAttribute(){},focus(){this.focused=true;}});
 const tabs=[tab('maya'),tab('houdini')],panels=[{dataset:{softwarePanel:'maya'},hidden:false},{dataset:{softwarePanel:'houdini'},hidden:true}];
 const root={querySelectorAll:selector=>selector==='[data-software-tab]'?tabs:panels};
 selectSoftwareTab(root,'houdini',{focus:true});
 assert.deepEqual(panels.map(p=>p.hidden),[true,false]);assert.equal(tabs[1].focused,true);assert.equal(tabs[0].tabIndex,-1);assert.equal(tabs[1].tabIndex,0);
});
