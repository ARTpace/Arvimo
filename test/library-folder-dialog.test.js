import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {nativeFolderPicker} from '../server/folder-dialog.mjs';

test('Windows picker has a foreground owner, preserves cancel and surfaces failures',{skip:process.platform!=='win32'},async()=>{
 const original=childProcess.execFile;
 let outcome='ok',script;
 childProcess.execFile=(file,args,options,callback)=>{
  assert.equal(file,'powershell.exe');assert.equal(options.windowsHide,true);
  script=args.at(-1);
  callback(outcome==='ok'?null:{code:outcome==='cancel'?2:1,message:'failed'},'C:\\Assets',outcome==='fail'?'picker failed':'');
 };
 syncBuiltinESMExports();
 try{
  assert.equal(await nativeFolderPicker(process.cwd()),'C:\\Assets');
  assert.match(script,/\$owner\.TopMost = \$true/);
  assert.ok(script.indexOf('$owner.Show()')<script.indexOf('$dialog.ShowDialog($owner)'));
  assert.match(script,/finally \{ \$dialog\.Dispose\(\); \$owner\.Dispose\(\) \}/);
  outcome='cancel';assert.equal(await nativeFolderPicker(process.cwd()),null);
  outcome='fail';await assert.rejects(nativeFolderPicker(process.cwd()),/picker failed/);
 }finally{childProcess.execFile=original;syncBuiltinESMExports();}
});
