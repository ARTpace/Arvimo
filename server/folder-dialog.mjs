// Download-folder validation and the native Windows folder picker.
//
// Everything here exists because the "where do files land" answer has to be checked *before* a job
// starts: a queue whose target directory vanished will otherwise run a full download only to fail at
// the saving step. Keeping it out of DownloadManager leaves that class responsible for jobs, not for
// the filesystem dialogue that chooses where jobs write.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

const isDir=p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}};

/** Escape one value for single-quoted PowerShell. A quote can still appear inside a filename. */
function psQuote(value){return "'"+String(value??'').replace(/'/g,"''").replace(/[\r\n]/g,' ')+"'";}
/** Walk up to the closest directory that still exists, so the picker can open somewhere sensible
 *  even when the configured folder was deleted or sits on an unplugged drive. */
function nearestExistingDir(value){
  let current='';try{current=path.resolve(String(value||''));}catch{return '';}
  while(current&&!isDir(current)){const parent=path.dirname(current);if(parent===current)return '';current=parent;}
  return current;
}

/**
 * The only machine-level check that decides whether the default download folder is usable: it must
 * be an absolute local path, already exist, and be writable. The `code` is what the UI maps to a
 * human sentence, so adding a failure mode means adding a code, not a second prose string in the UI.
 */
export function inspectFolder(folder){
  const value=typeof folder==='string'?folder.trim():'';
  if(!value)return {ok:false,code:'empty',message:'未设置默认保存目录，请指定下载路径。'};
  if(!path.isAbsolute(value)||/^(\\|\/\/)/.test(value)||value.includes('\0'))return {ok:false,code:'invalid',folder:value,message:'默认保存目录不是有效的本机绝对路径，请重新设置。'};
  const resolved=path.resolve(value);
  try{
    const stat=fs.statSync(resolved);
    if(!stat.isDirectory())return {ok:false,code:'not-directory',folder:resolved,message:'默认保存路径不是文件夹，请重新设置。'};
    fs.accessSync(resolved,fs.constants.W_OK);
    return {ok:true,code:'ok',folder:resolved,message:''};
  }catch(e){
    const missing=e&&['ENOENT','ENOTDIR'].includes(e.code);
    return {ok:false,code:missing?'missing':'inaccessible',folder:resolved,message:missing?'默认保存目录不存在或磁盘未连接，请重新设置下载路径。':'默认保存目录无法访问：'+(e.message||String(e))};
  }
}

/**
 * Resolves to the picked absolute path, or null when the user cancelled.
 * `windowsHide` is mandatory: the background service has no console, and without it PowerShell
 * allocates one of its own and every folder pick flashes a black window. That flag hides the child
 * console only — the folder dialogue is its own window and is unaffected.
 */
export function nativeFolderPicker(initial){
  if(process.platform!=='win32')throw Error('当前系统暂只支持 Windows 文件夹选择器，请手动输入完整路径。');
  const selected=nearestExistingDir(initial);
  const script=`Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 AssetVault 下载目录'
$dialog.ShowNewFolderButton = $true
$initial = ${psQuote(selected)}
if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) } else { exit 2 }`;
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-Command',script],{windowsHide:true,encoding:'utf8',timeout:120000},(error,stdout,stderr)=>{
    if(error){if(error.code===2)return resolve(null);return reject(Error((stderr||'').trim()||error.message));}
    resolve(String(stdout||'').trim()||null);
  }));
}
